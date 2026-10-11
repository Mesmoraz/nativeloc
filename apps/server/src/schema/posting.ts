import type { PieceSchema } from '../db.js';

/**
 * Owned by Segment 2 piece 2D (posting content: crawl jobs). Tables and columns this piece adds go here, never in db.ts.
 * Runs on every start after the core schema: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 * Use db.exec / db.prepare directly (db.ts imports this file, so don't rely on its helpers at load time).
 */
export const schema: PieceSchema = {
  sql: `
-- Website crawls run as background jobs (posting/crawlJobs.ts). A job left 'running' by a stopped server is marked
-- 'failed' on the next start; 'queued' jobs run then.
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  pages INTEGER NOT NULL DEFAULT 0,
  strings INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS crawl_jobs_project ON crawl_jobs(project_id, id);
CREATE INDEX IF NOT EXISTS crawl_jobs_status ON crawl_jobs(status, id);
`,
};
