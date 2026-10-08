import { all, get, run, type DB } from './db.js';

/**
 * Volunteer XP, earned only when reviewers accept the work. Saving a translation or casting a peer vote
 * books pending XP; it turns accepted when the translation is approved, and is voided if the text is
 * replaced or sent back first. Accepted XP is never taken back. Callers run these inside the transaction
 * that changes the translation, so the ledger can't drift from it.
 */
export const XP = { translate: 10, review: 5 } as const;

export type XpKind = keyof typeof XP;
/** The `xp` field of the save and approve responses: what this action earned, or null. */
export type XpAward = { points: number; status: 'pending' | 'accepted' } | null;

interface StringRef {
  projectId: number;
  keyId: number;
  locale: string;
}

const pendingOf = (db: DB, userId: number, kind: XpKind, s: StringRef) =>
  get<{ id: number }>(db, "SELECT id FROM xp_events WHERE user_id = ? AND kind = ? AND key_id = ? AND locale = ? AND status = 'pending'", userId, kind, s.keyId, s.locale);

function book(db: DB, userId: number, kind: XpKind, s: StringRef, status: 'pending' | 'accepted'): XpAward {
  run(
    db,
    `INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${status === 'accepted' ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
    userId, kind, s.keyId, s.locale, s.projectId, XP[kind], status,
  );
  return { points: XP[kind], status };
}

/** Every pending event on a string becomes accepted: the author's translation and the votes for it. */
function settle(db: DB, s: StringRef) {
  run(db, "UPDATE xp_events SET status = 'accepted', settled_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ? AND status = 'pending'", s.keyId, s.locale);
}

/** Pending XP on a string disappears, except `keepUserId`'s own translate event (re-saving your own text). */
export function voidPending(db: DB, s: StringRef, keepUserId?: number) {
  run(
    db,
    `UPDATE xp_events SET status = 'voided', settled_at = CURRENT_TIMESTAMP
     WHERE key_id = ? AND locale = ? AND status = 'pending' AND NOT (kind = 'translate' AND user_id IS ?)`,
    s.keyId, s.locale, keepUserId ?? null,
  );
}

/**
 * A translation was saved with `status`. Votes were for the old wording, and someone else's pending
 * translation was replaced, so both are voided. The saver earns once per string while it waits for review.
 */
export function onSave(db: DB, userId: number, s: StringRef, status: 'review' | 'approved'): XpAward {
  voidPending(db, s, userId);
  const existing = pendingOf(db, userId, 'translate', s);
  if (status === 'approved') {
    if (!existing) return book(db, userId, 'translate', s, 'accepted');
    settle(db, s);
    return { points: XP.translate, status: 'accepted' };
  }
  return existing ? null : book(db, userId, 'translate', s, 'pending');
}

/**
 * Approved outright by a reviewer, admin or lead: everyone's pending XP on the string is accepted. `earns` says
 * whether the approver gets review XP too, accepted at once since nothing else has to agree.
 */
export function onApprove(db: DB, userId: number, s: StringRef, earns: boolean): XpAward {
  settle(db, s);
  return earns ? book(db, userId, 'review', s, 'accepted') : null;
}

/** A peer's vote counts toward approval; it pays out if the translation is approved, `approved` says whether it just was. */
export function onVote(db: DB, userId: number, s: StringRef, approved: boolean): XpAward {
  book(db, userId, 'review', s, 'pending');
  if (!approved) return { points: XP.review, status: 'pending' };
  settle(db, s);
  return { points: XP.review, status: 'accepted' };
}

export interface XpTotals {
  accepted: number;
  pending: number;
}

function totals(db: DB, userId: number, since?: string): XpTotals {
  // Pending counts from when it was earned; accepted from when it was accepted.
  const rows = all<{ status: 'pending' | 'accepted'; points: number }>(
    db,
    `SELECT status, COALESCE(SUM(points), 0) AS points FROM xp_events
     WHERE user_id = ? AND status IN ('pending', 'accepted')
       ${since ? "AND (CASE status WHEN 'accepted' THEN settled_at ELSE created_at END) >= ?" : ''}
     GROUP BY status`,
    userId, ...(since ? [since] : []),
  );
  const out: XpTotals = { accepted: 0, pending: 0 };
  for (const r of rows) out[r.status] = r.points;
  return out;
}

/** The volunteer home screen and session summary. "Today" is the server's UTC day. */
export function stats(db: DB, userId: number) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    xp: totals(db, userId),
    today: totals(db, userId, today),
    approvedStrings: get<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM (SELECT DISTINCT key_id, locale FROM xp_events WHERE user_id = ? AND kind = 'translate' AND status = 'accepted')",
      userId,
    )!.n,
    projectsHelped: all<{ id: number; name: string }>(
      db,
      `SELECT p.id, p.name FROM projects p
       WHERE p.id IN (SELECT project_id FROM xp_events WHERE user_id = ? AND status = 'accepted') ORDER BY p.name`,
      userId,
    ),
  };
}
