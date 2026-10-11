import type { DB, PieceSchema } from '../db.js';

/**
 * Owned by Segment 2 piece 2A (sign-up and onboarding: email verification, outbox). Tables and columns this piece adds go here, never in db.ts.
 * Runs on every start after the core schema: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 * Use db.exec / db.prepare directly (db.ts imports this file, so don't rely on its helpers at load time).
 */
export const schema: PieceSchema = {
  sql: `
-- One-time links sent by email (today only 'verify'). Only the hash is kept; the raw token is in the outbox body.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify')),
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);
-- Every email the platform sends, written before delivery (see signup/mailer.ts). sent_at stays NULL until the
-- mailer accepts it; error holds the last failure.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  provider TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_user ON outbox(user_id, kind, created_at);
`,
  migrate(db: DB) {
    const has = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    // Accounts made before sign-up existed, and rows inserted directly (seeds, fixtures), count as verified: the
    // default is 1. Self-serve sign-ups and join-link accounts are written with 0 until the link is opened.
    if (!has('users', 'email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
    // Orgs someone created for themselves through POST /api/v1/orgs. They vouch for nobody until verified (signup/gate.ts).
    if (!has('orgs', 'self_serve')) db.exec('ALTER TABLE orgs ADD COLUMN self_serve INTEGER NOT NULL DEFAULT 0');
    // The NativeLoc community org: owns the platform-wide placement check; its members grade those attempts.
    if (!has('orgs', 'platform')) db.exec('ALTER TABLE orgs ADD COLUMN platform INTEGER NOT NULL DEFAULT 0');
  },
};
