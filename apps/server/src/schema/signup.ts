import type { PieceSchema } from '../db.js';

/**
 * Owned by Segment 2 piece 2A (sign-up and onboarding: email verification, outbox). Tables and columns this piece adds go here, never in db.ts.
 * Runs on every start after the core schema: use CREATE ... IF NOT EXISTS, and guard ALTERs with PRAGMA table_info.
 * Use db.exec / db.prepare directly (db.ts imports this file, so don't rely on its helpers at load time).
 */
export const schema: PieceSchema = {
  sql: '',
};
