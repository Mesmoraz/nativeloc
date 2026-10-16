import type { DB, FeatureSchema } from '../db.js';

/**
 * Verification and moderation: the IRS EO-BMF table, screens, staff decisions and reports.
 * Runs on every start after the core schema: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 * Use db.exec / db.prepare directly (db.ts imports this file, so don't rely on its helpers at load time).
 */
export const schema: FeatureSchema = {
  sql: `
-- The IRS Exempt Organizations Business Master File, as imported by scripts/import-eo-bmf.ts. ein is 9 digits.
CREATE TABLE IF NOT EXISTS eo_bmf (
  ein TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT,
  subsection TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Every verification outcome, automatic or by staff. The latest row per org explains its current state.
CREATE TABLE IF NOT EXISTS org_verifications (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'verified', 'rejected')),
  source TEXT NOT NULL CHECK (source IN ('auto', 'staff')),
  note TEXT,
  staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS org_verifications_org ON org_verifications(org_id, id);
-- One row per automatic screen (each submit), with the reasons a project was held.
CREATE TABLE IF NOT EXISTS moderation_screens (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'pending')),
  reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS moderation_screens_project ON moderation_screens(project_id, id);
-- Staff decisions on projects. 'changes' leaves moderation 'rejected' and tells the poster what to fix.
CREATE TABLE IF NOT EXISTS moderation_decisions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes')),
  reason TEXT,
  staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS moderation_decisions_project ON moderation_decisions(project_id, id);
-- Volunteer reports. Open until a staff decision on the project resolves them. One open report per person per project.
CREATE TABLE IF NOT EXISTS project_reports (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_id INTEGER REFERENCES keys(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'commercial', 'harmful')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS project_reports_open ON project_reports(project_id, user_id) WHERE resolved_at IS NULL;
`,
  migrate(db: DB) {
    // The state an org says it is registered in, for the EIN + name + state match. The onboarding form sets it.
    const cols = db.prepare('PRAGMA table_info(orgs)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'state')) db.exec('ALTER TABLE orgs ADD COLUMN state TEXT');
  },
};
