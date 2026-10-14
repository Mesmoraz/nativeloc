import type { PieceSchema } from '../db.js';

/**
 * Owned by Segment 2 piece 2E (open volunteer pool: e.g. urgent flags). Tables and columns this piece adds go here, never in db.ts.
 * Runs on every start after the core schema: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 * Use db.exec / db.prepare directly (db.ts imports this file, so don't rely on its helpers at load time).
 */
export const schema: PieceSchema = {
  sql: `
-- A volunteer's card-session settings. One row per user, written the first time they change one.
CREATE TABLE IF NOT EXISTS volunteer_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nonprofits_only INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`,
  migrate(db) {
    // Urgent strings come first in every volunteer's session. Segment 4 adds who may set it and the on-call side.
    const cols = (db.prepare('PRAGMA table_info(keys)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('urgent')) db.exec('ALTER TABLE keys ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0');
    // When the source text last changed (translations went outdated): how long an outdated string has waited.
    // Older rows only know when the key was last touched, so that stands in.
    if (!cols.includes('source_changed_at')) {
      db.exec('ALTER TABLE keys ADD COLUMN source_changed_at TEXT');
      db.exec('UPDATE keys SET source_changed_at = updated_at');
    }
    // Part of the card-order score (pool/score.ts). Org admins and staff set it.
    const pcols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name);
    if (!pcols.includes('priority')) db.exec("ALTER TABLE projects ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high'))");
  },
};
