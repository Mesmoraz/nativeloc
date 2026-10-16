import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app.js';
import { HttpError, projectAccess } from '../auth.js';
import { get, run } from '../db.js';
import { screenProject } from '../moderation/screen.js';
import { CrawlRunner, crawlJobJson, jobsOf, type CrawlJobRow } from '../posting/crawlJobs.js';
import { BlockedUrl, checkUrl } from '../posting/netguard.js';
import { assertMayPost, rescreenAfterChange } from '../posting/policy.js';
import { PasteTooLong, splitPaste } from '../posting/split.js';
import { projectLocales } from '../services/progress.js';
import { upsertEntries } from '../services/ingest.js';
import { intParam } from '../util.js';

/** Posting content: paste, website crawls, submit for moderation. Endpoints: docs/segment-2-contracts.md §3. */
export function postingRoutes(app: FastifyInstance, { db }: RouteDeps) {
  const crawls = new CrawlRunner(db);
  crawls.start();
  app.addHook('onClose', async () => crawls.stop());
  // Tests wait for the background queue through this.
  app.decorate('crawlsIdle', () => crawls.idle);

  /** Paste text: split into strings. `dryRun` returns the split without saving (the preview in the web flow). */
  app.post<{ Params: { id: string }; Body: { text?: unknown; context?: unknown; split?: unknown; dryRun?: unknown } }>('/api/v1/projects/:id/paste', async (req) => {
    const { project, actor } = projectAccess(db, req, intParam(req.params.id), 'admin');
    assertMayPost(db, project.org_id);
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Paste some text first.');
    const mode = req.body?.split ?? 'paragraphs';
    if (mode !== 'paragraphs' && mode !== 'sentences') throw new HttpError(400, 'Split by "paragraphs" or "sentences".');
    const context = typeof req.body?.context === 'string' ? req.body.context.trim().slice(0, 500) : '';
    let strings;
    try {
      strings = splitPaste(text, mode, project.source_locale);
    } catch (e) {
      if (e instanceof PasteTooLong) throw new HttpError(413, e.message);
      throw e;
    }
    if (!strings.length) throw new HttpError(400, 'There’s no text to translate in that paste.');
    if (req.body?.dryRun === true) {
      const existing = new Set(strings.filter((s) => get(db, 'SELECT 1 FROM keys WHERE project_id = ? AND name = ? AND archived = 0', project.id, s.key)).map((s) => s.key));
      return { created: strings.length - existing.size, unchanged: existing.size, updated: 0, keys: strings };
    }
    const res = upsertEntries(
      db,
      project,
      strings.map((s) => ({ key: s.key, source: s.source, description: context || undefined, meta: { origin: 'paste' } })),
      { userId: actor.kind === 'user' ? actor.user.id : undefined },
    );
    rescreenAfterChange(db, project.id, res.created + res.updated);
    return { created: res.created, unchanged: res.unchanged, updated: res.updated, keys: strings };
  });

  /** Website: queue a background crawl of up to CRAWL_PAGE_LIMIT pages, help pages first. */
  app.post<{ Params: { id: string }; Body: { url?: unknown } }>('/api/v1/projects/:id/crawl', async (req) => {
    const { project, actor } = projectAccess(db, req, intParam(req.params.id), 'admin');
    assertMayPost(db, project.org_id);
    let raw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!raw) throw new HttpError(400, 'Enter the website address.');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
    let url: URL;
    try {
      url = await checkUrl(raw);
    } catch (e) {
      if (e instanceof BlockedUrl) throw new HttpError(400, e.message);
      throw e;
    }
    const active = get<{ id: number }>(db, "SELECT id FROM crawl_jobs WHERE org_id = ? AND status IN ('queued', 'running')", project.org_id);
    if (active) throw new HttpError(409, 'A website is already being read for your organization. Try again when it finishes.');
    const id = Number(
      run(db, 'INSERT INTO crawl_jobs (project_id, org_id, url, created_by) VALUES (?, ?, ?, ?)', project.id, project.org_id, url.href, actor.kind === 'user' ? actor.user.id : null).lastInsertRowid,
    );
    const job = get<CrawlJobRow>(db, 'SELECT * FROM crawl_jobs WHERE id = ?', id)!;
    crawls.kick();
    return { job: crawlJobJson(job) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/crawl', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    return { jobs: jobsOf(db, project.id).map(crawlJobJson) };
  });

  /** Submit a public project for moderation: the automatic screen approves it or holds it for staff. */
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/submit', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    assertMayPost(db, project.org_id);
    if (project.visibility !== 'public') throw new HttpError(400, 'Only public projects go to volunteers. Make the project public first.');
    // Waiting for staff (or paused by reports), or already live: nothing to screen.
    if (project.moderation === 'pending' || project.moderation === 'approved') return { moderation: project.moderation, reasons: [] };
    const strings = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM keys WHERE project_id = ? AND archived = 0', project.id)!.n;
    if (!strings) throw new HttpError(400, 'Add some text before submitting.');
    if (!projectLocales(db, project.id).length) throw new HttpError(400, 'Pick at least one language to translate into.');
    const { decision, reasons } = screenProject(db, project);
    run(db, 'UPDATE projects SET moderation = ? WHERE id = ?', decision, project.id);
    return { moderation: decision, reasons };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    crawlsIdle: () => Promise<void>;
  }
}
