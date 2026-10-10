import type { PieceSchema } from '../db.js';

/**
 * Owned by Segment 2 piece 2C (community review engine: review votes with Flag, escalation). Tables and columns this piece adds go here, never in db.ts.
 * Runs on every start after the core schema: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 * Use db.exec / db.prepare directly (db.ts imports this file, so don't rely on its helpers at load time).
 */
export const schema: PieceSchema = {
  sql: `
-- Community review (review_mode 'community'): every review of a translation in the current round, across edits.
-- A round starts when text is submitted for review and ends when it is approved (the next save starts a new one).
-- counts: 0 for votes that don't count (flags from 'new' volunteers, the poster's send-back).
-- current: 1 while the text it was about is still the translation's text (cleared by an Improve or a send-back).
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('approve', 'flag', 'improve', 'send_back')),
  reason TEXT CHECK (reason IN ('meaning', 'grammar', 'tone', 'offensive')),
  note TEXT,
  text TEXT NOT NULL,
  counts INTEGER NOT NULL DEFAULT 1,
  current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS reviews_string ON reviews(key_id, locale);
-- Who approved a string outright (org reviewers, admins, leads), for the manifest's "Checked by N native speakers".
CREATE TABLE IF NOT EXISTS approvers (
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, locale, user_id)
);
-- The quality label of each published bundle, frozen at publish time.
CREATE TABLE IF NOT EXISTS release_quality (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  locale TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('verified', 'community')),
  reviewers INTEGER NOT NULL,
  PRIMARY KEY (project_id, version, locale)
);
`,
};
