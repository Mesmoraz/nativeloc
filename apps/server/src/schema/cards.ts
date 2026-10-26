import type { FeatureSchema } from '../db.js';

/**
 * Spot the problem and Pick the better one (docs/segment-3c-card-types.md).
 * Runs on every start: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 */
export const schema: FeatureSchema = {
  sql: `
-- Spot the problem cards (cards/spot.ts): what was dealt, and the answer. Written when dealt, so the server knows
-- what it planted; answered_at stays NULL for a card that was skipped.
CREATE TABLE IF NOT EXISTS spot_checks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL,
  locale TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  role TEXT, -- the role the volunteer acts with in that project, for their activity record
  shown TEXT NOT NULL, -- the text on the card
  planted INTEGER NOT NULL, -- 1: a number was changed
  original TEXT, -- the number as it was, when planted
  changed TEXT, -- the number as shown, when planted
  verdict TEXT CHECK (verdict IN ('ok', 'problem')),
  correct INTEGER,
  dealt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS spot_checks_user ON spot_checks(user_id, key_id, locale);
-- Pick the better one (cards/pick.ts): which of two wordings a volunteer preferred. Advice only: shown to the
-- poster and the settling Lead, never counted as an approval.
CREATE TABLE IF NOT EXISTS picks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  chosen TEXT NOT NULL,
  other TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, key_id, locale)
);
`,
  migrate(db) {
    // An Improve keeps the wording it replaced, so Pick the better one can show both.
    const cols = (db.prepare('PRAGMA table_info(reviews)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('previous_text')) db.exec('ALTER TABLE reviews ADD COLUMN previous_text TEXT');
  },
};
