import { awardBadges, badgesOf } from './badges.js';
import { all, get, run, type DB } from './db.js';
import { dailyGoalOf, localDay, localMidnightUtc, streakOf, timeZoneOf } from './streaks.js';

/**
 * Volunteer XP, earned only when reviewers accept the work. Saving a translation or casting a peer vote
 * books pending XP; it turns accepted when the translation is approved, and is voided if the text is
 * replaced or sent back first. Accepted XP is never taken back. Callers run these inside the transaction
 * that changes the translation, so the ledger can't drift from it.
 */
export const XP = { translate: 10, review: 5 } as const;
/** Spot the problem (a correct answer) and Pick the better one: see cards/spot.ts and cards/pick.ts. */
export const CARD_XP = { check: 5, pick: 5 } as const;

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

// ---------- community review (review_mode 'community'; see services/review.ts) ----------
// Peers' pending XP waits for the outcome instead of being voided when the text changes: at consensus a review
// pays if it matched the final text (an approval of it, or a flag on wording that didn't survive).

/**
 * Community mode: a translation was saved with `status`. Someone else's pending translation was replaced, so it's
 * voided; pending review XP is left for settleCommunity. `finalText` is the saved text (used when it's approved).
 */
export function onCommunitySave(db: DB, userId: number, s: StringRef, status: 'review' | 'approved', finalText: string): XpAward {
  run(
    db,
    `UPDATE xp_events SET status = 'voided', settled_at = CURRENT_TIMESTAMP
     WHERE key_id = ? AND locale = ? AND status = 'pending' AND kind = 'translate' AND user_id IS NOT ?`,
    s.keyId, s.locale, userId,
  );
  const existing = pendingOf(db, userId, 'translate', s);
  if (status === 'approved') {
    settleCommunity(db, s, finalText);
    return existing ? { points: XP.translate, status: 'accepted' } : book(db, userId, 'translate', s, 'accepted');
  }
  return existing ? null : book(db, userId, 'translate', s, 'pending');
}

/**
 * A counted community review (approval or flag). Review XP is earned once per person per string: a second review
 * after an edit or a send-back doesn't book again.
 */
export function onCommunityReview(db: DB, userId: number, s: StringRef): XpAward {
  const had = get(db, "SELECT 1 FROM xp_events WHERE user_id = ? AND kind = 'review' AND key_id = ? AND locale = ? AND status <> 'voided'", userId, s.keyId, s.locale);
  return had ? null : book(db, userId, 'review', s, 'pending');
}

/**
 * Consensus (status 'ready') or an outright approval of `finalText`: the pending translation is accepted, and each
 * pending review is accepted if it matched the outcome (approved the final text, or flagged other wording), else voided.
 */
export function settleCommunity(db: DB, s: StringRef, finalText: string) {
  run(
    db,
    `UPDATE xp_events SET settled_at = CURRENT_TIMESTAMP, status = CASE WHEN EXISTS (
       SELECT 1 FROM reviews r WHERE r.key_id = xp_events.key_id AND r.locale = xp_events.locale AND r.user_id = xp_events.user_id AND r.counts = 1
         AND ((r.kind = 'approve' AND r.current = 1 AND r.text = ?) OR (r.kind = 'flag' AND r.text <> ?))
     ) THEN 'accepted' ELSE 'voided' END
     WHERE key_id = ? AND locale = ? AND status = 'pending' AND kind = 'review'`,
    finalText, finalText, s.keyId, s.locale,
  );
  settle(db, s);
}

/** What `userId` holds on a string right now (for responses after settling). */
export function awardOf(db: DB, userId: number, kind: XpKind, s: StringRef): XpAward {
  const r = get<{ points: number; status: 'pending' | 'accepted' }>(
    db,
    "SELECT points, status FROM xp_events WHERE user_id = ? AND kind = ? AND key_id = ? AND locale = ? AND status <> 'voided' ORDER BY id DESC LIMIT 1",
    userId, kind, s.keyId, s.locale,
  );
  return r ? { points: r.points, status: r.status } : null;
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

/** The volunteer home screen and session summary. "Today" is the volunteer's own day, in their time zone. */
export function stats(db: DB, userId: number, now = Date.now()) {
  const tz = timeZoneOf(db, userId);
  const today = localDay(tz, now);
  const activeDays = all<{ day: string }>(db, 'SELECT DISTINCT day FROM volunteer_activity WHERE user_id = ?', userId).map((r) => r.day);
  awardBadges(db, userId, now);
  return {
    xp: totals(db, userId),
    today: totals(db, userId, localMidnightUtc(tz, now)),
    streak: streakOf(activeDays, today),
    goal: {
      target: dailyGoalOf(db, userId),
      done: get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM volunteer_activity WHERE user_id = ? AND day = ?', userId, today)!.n,
    },
    badges: badgesOf(db, userId),
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
