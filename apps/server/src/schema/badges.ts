import type { FeatureSchema } from '../db.js';

/**
 * Badges and volunteer-hour certificates (docs/segment-3b-badges.md).
 * Runs on every start: use CREATE ... IF NOT EXISTS.
 */
export const schema: FeatureSchema = {
  sql: `
-- Badges a volunteer has earned (badges.ts). Rows are only ever added: a badge that stops being true stays.
CREATE TABLE IF NOT EXISTS volunteer_badges (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge TEXT NOT NULL,
  detail TEXT, -- e.g. the language for rare_voice
  earned_at TEXT NOT NULL, -- UTC, CURRENT_TIMESTAMP format
  seen_at TEXT, -- set once the app has shown it; NULL = new
  PRIMARY KEY (user_id, badge)
);
-- Volunteer-hour certificates (certificates.ts): a fixed copy of what was issued, so the public verify page shows
-- exactly what was printed. \`code\` is the unguessable public id.
CREATE TABLE IF NOT EXISTS volunteer_certificates (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  period_from TEXT, -- YYYY-MM-DD, NULL = from the start
  period_to TEXT NOT NULL, -- YYYY-MM-DD, inclusive
  minutes INTEGER NOT NULL,
  translations INTEGER NOT NULL,
  reviews INTEGER NOT NULL,
  orgs TEXT NOT NULL, -- JSON array of org names
  rates TEXT NOT NULL, -- JSON {version, translate, review}
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS volunteer_certificates_user ON volunteer_certificates(user_id);
`,
};
