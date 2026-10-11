import type { FastifyInstance } from 'fastify';
import { HttpError, requireUser } from '../auth.js';
import { all, get, run, type DB, type Member, type OrgRow, type ProjectRow, type Role, type UserRow } from '../db.js';
import { isVerifiedNonprofit, openPoolRole, passesNonprofitsOnly, poolRank } from '../pool/access.js';
import { projectLocales, queue, reviewRight } from '../services.js';
import { stats } from '../xp.js';

// Shapes are the contract in apps/web/src/volunteer/types.ts (and CardOrg in apps/web/src/contracts.ts).

type Item = ReturnType<typeof queue>['items'][number];
interface CardOrg {
  id: number;
  name: string;
  type: OrgRow['type'];
  verified: boolean;
  description: string | null;
}
interface Card {
  id: string;
  type: 'translate' | 'review';
  project: { id: number; name: string; sourceLocale: string };
  org: CardOrg;
  locale: string;
  /** The string is marked urgent; urgent strings come first. */
  urgent: boolean;
  item: Item;
}

/** A project the user can draw cards from, with the role they act with there. */
interface Source {
  project: ProjectRow;
  org: OrgRow;
  member: Member;
}

/**
 * Projects a session draws from: every project in the user's orgs, plus public, approved projects anywhere that
 * openPoolRole lets them into. Verified nonprofits first, then community orgs; oldest project first within each.
 */
function sources(db: DB, user: UserRow, nonprofitsOnly: boolean): Source[] {
  const roles = new Map(all<{ org_id: number; role: Role }>(db, 'SELECT org_id, role FROM memberships WHERE user_id = ?', user.id).map((m) => [m.org_id, m.role]));
  // The visibility/moderation test here only narrows the scan; openPoolRole decides who gets in.
  const projects = all<ProjectRow & { created_at: string }>(
    db,
    `SELECT p.* FROM projects p
     WHERE p.org_id IN (SELECT org_id FROM memberships WHERE user_id = ?) OR (p.visibility = 'public' AND p.moderation = 'approved')
     ORDER BY p.created_at, p.id`,
    user.id,
  );
  const orgs = new Map<number, OrgRow>();
  const out: (Source & { rank: number })[] = [];
  for (const project of projects) {
    const role = roles.get(project.org_id) ?? openPoolRole(db, user, project, 'translate');
    if (!role) continue;
    if (!orgs.has(project.org_id)) orgs.set(project.org_id, get<OrgRow>(db, 'SELECT id, name, type, verification, ein, website, description FROM orgs WHERE id = ?', project.org_id)!);
    const org = orgs.get(project.org_id)!;
    if (nonprofitsOnly && !passesNonprofitsOnly(org)) continue;
    // The user as they act in this project's org: their role decides what they may review.
    out.push({ project, org, member: { ...user, orgId: project.org_id, role }, rank: poolRank(org) });
  }
  // Stable: keeps oldest-first within each rank.
  return out.sort((a, b) => a.rank - b.rank);
}

const cardOrg = (org: OrgRow): CardOrg => ({ id: org.id, name: org.name, type: org.type, verified: isVerifiedNonprofit(org), description: org.description });

/**
 * A short session of cards, in the user's languages, from their orgs' projects and the open pool. Urgent strings
 * come first, then verified nonprofits, then community orgs; within a project, queue() keeps strings that share
 * a screenshot together, oldest first. Translate and Review alternate (Translate first) while both last.
 * Review cards appear only where reviewRight allows.
 */
export function buildSession(db: DB, user: UserRow, size: number, nonprofitsOnly = false): { cards: Card[]; empty: null | 'no_languages' | 'nothing_to_do' } {
  const locales = JSON.parse(user.locales) as string[];
  if (!locales.length) return { cards: [], empty: 'no_languages' };

  const piles: Record<Card['type'], Card[]> = { translate: [], review: [] };
  const deal = (type: Card['type'], s: Source, locale: string, urgent: boolean, exclude: number[]) => {
    if (piles[type].length >= size) return;
    const { project, org, member } = s;
    const { items } = queue(db, project, locale, type, { viewer: member, limit: size - piles[type].length, exclude });
    for (const item of items) {
      piles[type].push({ id: `${type}:${item.keyId}:${locale}`, type, project: { id: project.id, name: project.name, sourceLocale: project.source_locale }, org: cardOrg(org), locale, urgent, item });
    }
  };
  const keyIds = (projectId: number, urgent: boolean) => all<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ? AND archived = 0 AND urgent = ?', projectId, urgent ? 1 : 0).map((r) => r.id);

  const work = sources(db, user, nonprofitsOnly).flatMap((s) => {
    const offered = projectLocales(db, s.project.id);
    return locales.filter((l) => offered.includes(l)).map((locale) => ({ s, locale, review: !!reviewRight(db, s.project, s.member, locale) }));
  });
  // Two passes over the same order: urgent strings everywhere first (queue() offers only them when every other key
  // is excluded), then the rest.
  const urgentKeys = new Map(work.map(({ s }) => [s.project.id, keyIds(s.project.id, true)]));
  for (const { s, locale, review } of work) {
    if (!urgentKeys.get(s.project.id)!.length) continue;
    const others = keyIds(s.project.id, false);
    deal('translate', s, locale, true, others);
    if (review) deal('review', s, locale, true, others);
  }
  for (const { s, locale, review } of work) {
    const urgent = urgentKeys.get(s.project.id)!;
    deal('translate', s, locale, false, urgent);
    if (review) deal('review', s, locale, false, urgent);
  }

  const cards: Card[] = [];
  for (const urgent of [true, false]) {
    const t = piles.translate.filter((c) => c.urgent === urgent);
    const r = piles.review.filter((c) => c.urgent === urgent);
    for (let i = 0; cards.length < size && (t.length || r.length); i++) {
      cards.push((i % 2 === 0 ? t.shift() ?? r.shift() : r.shift() ?? t.shift())!);
    }
  }
  return { cards, empty: cards.length ? null : 'nothing_to_do' };
}

/** The user's saved "Nonprofits only" choice (off until they turn it on). */
export const nonprofitsOnlyPref = (db: DB, userId: number) =>
  !!get<{ v: number }>(db, 'SELECT nonprofits_only AS v FROM volunteer_prefs WHERE user_id = ?', userId)?.v;

function saveNonprofitsOnly(db: DB, userId: number, on: boolean) {
  run(
    db,
    `INSERT INTO volunteer_prefs (user_id, nonprofits_only) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET nonprofits_only = excluded.nonprofits_only, updated_at = CURRENT_TIMESTAMP`,
    userId, on ? 1 : 0,
  );
}

/** "1"/"true" and "0"/"false"; anything else (or nothing) means "use the saved choice". */
function flag(v: unknown): boolean | undefined {
  if (v === true || v === '1' || v === 'true') return true;
  if (v === false || v === '0' || v === 'false') return false;
  return undefined;
}

export function volunteerRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { size?: string; nonprofitsOnly?: string } }>('/api/v1/volunteer/session', async (req) => {
    const { user } = requireUser(db, req);
    const size = Math.min(Math.max(Math.trunc(Number(req.query.size)) || 5, 1), 10);
    // Passing the filter saves it, so the next session (on any device) starts the same way.
    const asked = flag(req.query.nonprofitsOnly);
    if (asked !== undefined) saveNonprofitsOnly(db, user.id, asked);
    return buildSession(db, user, size, asked ?? nonprofitsOnlyPref(db, user.id));
  });

  app.get('/api/v1/volunteer/stats', async (req) => {
    const { user } = requireUser(db, req);
    return stats(db, user.id);
  });

  // Card-session settings, and which card actions this server offers. Flag (2C) and Report (2B) are other pieces'
  // endpoints: the cards show those buttons only once the routes exist.
  const settings = (userId: number) => ({
    nonprofitsOnly: nonprofitsOnlyPref(db, userId),
    actions: {
      flag: app.hasRoute({ method: 'POST', url: '/api/v1/translations/:keyId/:locale/flag' }),
      report: app.hasRoute({ method: 'POST', url: '/api/v1/reports' }),
    },
  });
  app.get('/api/v1/volunteer/settings', async (req) => settings(requireUser(db, req).user.id));
  app.put<{ Body: { nonprofitsOnly?: unknown } }>('/api/v1/volunteer/settings', async (req) => {
    const { user } = requireUser(db, req);
    const on = flag(req.body?.nonprofitsOnly);
    if (on === undefined) throw new HttpError(400, 'nonprofitsOnly must be true or false.');
    saveNonprofitsOnly(db, user.id, on);
    return settings(user.id);
  });
}
