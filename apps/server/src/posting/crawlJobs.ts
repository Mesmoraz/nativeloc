import { crawl, siteEntries } from '@nativeloc/site';
import { all, get, run, type DB, type ProjectRow } from '../db.js';
import { upsertEntries } from '../services/ingest.js';
import { guardedFetch } from './netguard.js';
import { CRAWL_PAGE_LIMIT, rescreenAfterChange } from './policy.js';

/** Names us to site owners in their logs, and is the agent robots.txt rules are matched against. */
export const CRAWLER_USER_AGENT = 'NativeLocBot/0.1 (volunteer translation for nonprofits)';

export interface CrawlJobRow {
  id: number;
  project_id: number;
  org_id: number;
  url: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  pages: number;
  strings: number;
  error: string | null;
  created_at: string;
}

export const crawlJobJson = (j: CrawlJobRow) => ({
  id: j.id,
  url: j.url,
  status: j.status,
  pages: j.pages,
  strings: j.strings,
  error: j.error,
  createdAt: j.created_at.replace(' ', 'T') + 'Z',
});

export const RESTARTED = 'The server restarted while reading this site. Start it again.';

/**
 * Runs website crawls in the background, one at a time (so one site never gets two crawlers at once). Jobs live in
 * crawl_jobs: a job left 'running' when the server stopped is marked failed on the next start, and queued jobs run.
 */
export class CrawlRunner {
  private busy = false;
  private stopped = false;
  /** Resolves when the queue is empty (tests wait on it). */
  idle: Promise<void> = Promise.resolve();

  constructor(private db: DB) {}

  start() {
    run(this.db, "UPDATE crawl_jobs SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE status = 'running'", RESTARTED);
    this.kick();
  }

  stop() {
    this.stopped = true;
  }

  kick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.idle = this.loop().finally(() => {
      this.busy = false;
      // A job queued while the loop was finishing.
      if (!this.stopped && get(this.db, "SELECT 1 FROM crawl_jobs WHERE status = 'queued'")) this.kick();
    });
  }

  private async loop() {
    while (!this.stopped) {
      const job = get<CrawlJobRow>(this.db, "SELECT * FROM crawl_jobs WHERE status = 'queued' ORDER BY id LIMIT 1");
      if (!job) return;
      await this.runJob(job);
    }
  }

  private async runJob(job: CrawlJobRow) {
    const db = this.db;
    run(db, "UPDATE crawl_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", job.id);
    const finish = (status: 'done' | 'failed', fields: { strings?: number; error?: string | null }) => {
      if (this.stopped) return; // the database may be closed; the next start marks the job failed
      run(db, 'UPDATE crawl_jobs SET status = ?, strings = ?, error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?', status, fields.strings ?? 0, fields.error ?? null, job.id);
    };
    try {
      const result = await crawl(job.url, {
        maxPages: CRAWL_PAGE_LIMIT,
        delayMs: 0, // the network guard spaces requests per host
        userAgent: CRAWLER_USER_AGENT,
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          if (this.stopped) return Promise.reject(new Error('The server is stopping.'));
          return guardedFetch(input, init);
        }) as typeof fetch,
        onPage: (_page, n) => {
          if (!this.stopped) run(db, 'UPDATE crawl_jobs SET pages = ? WHERE id = ?', n, job.id);
        },
      });
      if (this.stopped) return;
      if (!result.pages.length) {
        const why = result.errors[0]?.error ?? (result.disallowed.length ? 'the site’s robots.txt asks crawlers not to read it' : 'no web pages were found there');
        return finish('failed', { error: `Couldn’t read any pages: ${why}.` });
      }
      const project = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', job.project_id);
      if (!project) return finish('failed', { error: 'The project was deleted.' });
      const { entries } = siteEntries(result.pages);
      const res = upsertEntries(db, project, entries);
      rescreenAfterChange(db, project.id, res.created + res.updated);
      finish('done', { strings: entries.length });
    } catch (e) {
      finish('failed', { error: (e as Error).message });
    }
  }
}

export const jobsOf = (db: DB, projectId: number) => all<CrawlJobRow>(db, 'SELECT * FROM crawl_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 20', projectId);
