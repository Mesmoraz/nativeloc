import type { FeatureSchema } from '../db.js';

/**
 * Streaks and the daily goal (docs/segment-3a-streaks.md): which days each person was active, and their goal and
 * time zone. Runs after the pool schema, whose volunteer_prefs it extends.
 * Use db.exec / db.prepare directly (db.ts imports this file, so don't rely on its helpers at load time).
 */
export const schema: FeatureSchema = {
  migrate(db) {
    // Created here rather than in `sql` so we know when it's new, and fill it in from history exactly once.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'volunteer_activity'").get()) {
      db.exec(`
-- What a person did, on which of their local days. One row per card per day: saving the same string twice in a
-- day counts once. Feeds streaks, the daily goal and staff return rates (see streaks.ts). key_id and project_id
-- have no foreign keys, as in xp_events, so activity outlives deleted strings.
CREATE TABLE volunteer_activity (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, -- YYYY-MM-DD in the person's time zone when they acted
  kind TEXT NOT NULL CHECK (kind IN ('translate', 'review')),
  key_id INTEGER NOT NULL,
  locale TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  role TEXT, -- the role they acted with; NULL = unknown (filled in from old XP)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, day, kind, key_id, locale)
);
-- Activity from before this table: XP events, on their UTC day (no time zone was known yet).
INSERT OR IGNORE INTO volunteer_activity (user_id, day, kind, key_id, locale, project_id, role, created_at)
  SELECT user_id, substr(created_at, 1, 10), kind, key_id, locale, project_id, NULL, created_at FROM xp_events;
`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS volunteer_activity_day ON volunteer_activity(day)');
    const cols = (db.prepare('PRAGMA table_info(volunteer_prefs)').all() as { name: string }[]).map((c) => c.name);
    // An IANA name, sent by the browser. NULL: UTC.
    if (!cols.includes('time_zone')) db.exec('ALTER TABLE volunteer_prefs ADD COLUMN time_zone TEXT');
    if (!cols.includes('daily_goal')) db.exec('ALTER TABLE volunteer_prefs ADD COLUMN daily_goal INTEGER NOT NULL DEFAULT 5 CHECK (daily_goal IN (3, 5, 10, 20))');
  },
};
