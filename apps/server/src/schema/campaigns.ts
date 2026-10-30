import type { FeatureSchema } from '../db.js';

/**
 * Campaigns and org leaderboards (docs/segment-3e-campaigns-leaderboards.md).
 * Runs on every start: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 */
export const schema: FeatureSchema = {
  sql: `
-- Campaigns (campaigns.ts): get a project live in some languages by a deadline. Progress is computed, not stored.
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  deadline TEXT NOT NULL, -- YYYY-MM-DD; the campaign runs to the end of that day, UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IN ('launched', 'deadline', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS campaigns_project ON campaigns(project_id, ended_at);
CREATE TABLE IF NOT EXISTS campaign_locales (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  launched_at TEXT, -- when it reached 100% approved
  PRIMARY KEY (campaign_id, locale)
);
`,
  migrate(db) {
    // Launch messages: volunteer_messages (schema/orgVolunteers.ts) gained the 'launch' kind. SQLite can't change a
    // CHECK in place, so a table from before is rebuilt with its rows.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'volunteer_messages'").get() as { sql: string } | undefined)?.sql ?? '';
    if (sql && !sql.includes("'launch'")) {
      db.exec(`
        BEGIN;
        CREATE TABLE volunteer_messages_new (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          kind TEXT NOT NULL CHECK (kind IN ('thanks', 'favorite', 'approved_reviewer', 'launch')),
          body TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          seen_at TEXT
        );
        INSERT INTO volunteer_messages_new SELECT id, user_id, org_id, project_id, kind, body, created_at, seen_at FROM volunteer_messages;
        DROP TABLE volunteer_messages;
        ALTER TABLE volunteer_messages_new RENAME TO volunteer_messages;
        CREATE INDEX IF NOT EXISTS volunteer_messages_user ON volunteer_messages(user_id, seen_at);
        COMMIT;
      `);
    }
    // Leaderboards are opt-in (leaderboards.ts).
    const cols = (db.prepare('PRAGMA table_info(volunteer_prefs)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('show_on_leaderboards')) db.exec('ALTER TABLE volunteer_prefs ADD COLUMN show_on_leaderboards INTEGER NOT NULL DEFAULT 0');
  },
};
