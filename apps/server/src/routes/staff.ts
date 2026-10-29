import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app.js';
import { HttpError, projectAccess, requireStaff, requireUser } from '../auth.js';
import { all, get, getOrg, ORG_COLUMNS, run, type OrgRow, type ProjectRow } from '../db.js';
import { lookupEin, normalizeEin } from '../moderation/eobmf.js';
import { fileReport, parseReport } from '../moderation/reports.js';
import { PRIORITIES } from '../pool/score.js';
import { checkOrg, decideVerification, latestVerification } from '../moderation/verify.js';
import { approvedReviewerUse } from '../org/volunteers.js';
import { returnRates } from '../streaks.js';
import { intParam } from '../util.js';
import { orgJson } from './auth.js';


/** The staff console: nonprofit verification, moderation and reports. Endpoints: docs/segment-2-contracts.md §3. */
export function staffRoutes(app: FastifyInstance, { db }: RouteDeps) {
  // ----- public EIN lookup (onboarding form) -----
  app.get<{ Params: { ein: string } }>('/api/v1/orgs/ein/:ein', async (req) => {
    const ein = normalizeEin(req.params.ein);
    if (!ein) throw new HttpError(400, 'An EIN is 9 digits, like 12-3456789.');
    return { match: lookupEin(db, ein) };
  });

  // ----- volunteer return rates (streaks.ts) -----
  app.get('/api/v1/staff/engagement', async (req) => {
    requireStaff(db, req);
    return { ...returnRates(db), approvedReviewers: approvedReviewerUse(db) };
  });

  // ----- verification queue -----
  app.get('/api/v1/staff/verifications', async (req) => {
    requireStaff(db, req);
    const orgs = all<OrgRow & { created_at: string }>(db, `SELECT ${ORG_COLUMNS}, created_at FROM orgs WHERE verification = 'pending' ORDER BY created_at, id`);
    return {
      orgs: orgs.map((o) => ({
        org: { ...orgJson(o), ein: o.ein, createdAt: o.created_at },
        match: lookupEin(db, normalizeEin(o.ein ?? '')),
        admins: all<{ name: string; email: string }>(db, "SELECT u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'admin' ORDER BY m.created_at", o.id),
        reason: latestVerification(db, o.id)?.note ?? checkOrg(db, o).reason,
      })),
    };
  });

  app.post<{ Params: { orgId: string }; Body: { decision?: string; note?: string } }>('/api/v1/staff/verifications/:orgId', async (req) => {
    const { user } = requireStaff(db, req);
    const org = getOrg(db, intParam(req.params.orgId, 'org id'));
    if (!org) throw new HttpError(404, 'Org not found.');
    const decision = req.body?.decision;
    if (decision !== 'verified' && decision !== 'rejected') throw new HttpError(400, 'decision must be verified or rejected.');
    decideVerification(db, org.id, user.id, decision, typeof req.body?.note === 'string' ? req.body.note.trim() || null : null);
    return { org: orgJson({ ...org, verification: decision }) };
  });

  // ----- moderation queue -----
  app.get('/api/v1/staff/moderation', async (req) => {
    requireStaff(db, req);
    const projects = all<ProjectRow>(db, "SELECT * FROM projects WHERE moderation = 'pending' ORDER BY id");
    return {
      projects: projects.map((p) => {
        const screen = get<{ reasons: string; created_at: string }>(db, 'SELECT reasons, created_at FROM moderation_screens WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
        const reports = all<{ reason: string; count: number }>(db, 'SELECT reason, COUNT(*) AS count FROM project_reports WHERE project_id = ? AND resolved_at IS NULL GROUP BY reason ORDER BY count DESC', p.id);
        const org = getOrg(db, p.org_id)!;
        const reasons: string[] = screen ? JSON.parse(screen.reasons) : [];
        if (reports.length && !reasons.includes('paused by volunteer reports')) reasons.push(`${reports.reduce((n, r) => n + r.count, 0)} open reports`);
        return {
          project: {
            id: p.id,
            name: p.name,
            visibility: p.visibility,
            priority: p.priority,
            strings: get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM keys WHERE project_id = ? AND archived = 0', p.id)!.n,
            submittedAt: screen?.created_at ?? null,
          },
          org: orgJson(org),
          reasons,
          reports,
          // Reported strings first, then the first few.
          sample: all<{ source: string }>(
            db,
            `SELECT source FROM keys WHERE project_id = ? AND archived = 0
             ORDER BY id IN (SELECT key_id FROM project_reports WHERE project_id = ? AND resolved_at IS NULL) DESC, id LIMIT 5`,
            p.id,
            p.id,
          ).map((k) => k.source),
        };
      }),
    };
  });

  app.post<{ Params: { projectId: string }; Body: { decision?: string; reason?: string } }>('/api/v1/staff/moderation/:projectId', async (req) => {
    const { user } = requireStaff(db, req);
    const project = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', intParam(req.params.projectId, 'project id'));
    if (!project) throw new HttpError(404, 'Project not found.');
    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'changes') throw new HttpError(400, 'decision must be approved, rejected or changes.');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() || null : null;
    if (decision !== 'approved' && !reason) throw new HttpError(400, 'Give the poster a reason.');
    const moderation = decision === 'approved' ? 'approved' : 'rejected';
    run(db, 'UPDATE projects SET moderation = ? WHERE id = ?', moderation, project.id);
    run(db, 'INSERT INTO moderation_decisions (project_id, decision, reason, staff_id) VALUES (?, ?, ?, ?)', project.id, decision, reason, user.id);
    run(db, 'UPDATE project_reports SET resolved_at = CURRENT_TIMESTAMP WHERE project_id = ? AND resolved_at IS NULL', project.id);
    return { project: { id: project.id, moderation } };
  });

  // Project priority is part of the card-order score (pool/score.ts). Org admins set it too, on the project.
  app.put<{ Params: { projectId: string }; Body: { priority?: string } }>('/api/v1/staff/projects/:projectId/priority', async (req) => {
    requireStaff(db, req);
    const project = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', intParam(req.params.projectId, 'project id'));
    if (!project) throw new HttpError(404, 'Project not found.');
    const priority = PRIORITIES.find((p) => p === req.body?.priority);
    if (!priority) throw new HttpError(400, 'priority must be low, normal or high.');
    run(db, 'UPDATE projects SET priority = ? WHERE id = ?', priority, project.id);
    return { project: { id: project.id, priority } };
  });

  // ----- the poster's view of their project's moderation (the Sharing tab) -----
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/moderation', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    const screen = get<{ reasons: string; created_at: string }>(db, 'SELECT reasons, created_at FROM moderation_screens WHERE project_id = ? ORDER BY id DESC LIMIT 1', project.id);
    const decision = get<{ decision: string; reason: string | null; created_at: string }>(db, 'SELECT decision, reason, created_at FROM moderation_decisions WHERE project_id = ? ORDER BY id DESC LIMIT 1', project.id);
    return {
      moderation: project.moderation,
      reasons: screen ? JSON.parse(screen.reasons) : [],
      submittedAt: screen?.created_at ?? null,
      decision: decision ? { decision: decision.decision, reason: decision.reason, at: decision.created_at } : null,
    };
  });

  // ----- volunteer reports -----
  app.post<{ Body: { projectId?: unknown; keyId?: unknown; reason?: unknown; note?: unknown } }>('/api/v1/reports', async (req) => {
    const { user } = requireUser(db, req);
    const { project } = projectAccess(db, req, intParam(req.body?.projectId, 'projectId'), 'read');
    const { paused } = fileReport(db, user.id, project, parseReport(db, project, req.body ?? {}));
    return { ok: true, paused };
  });
}
