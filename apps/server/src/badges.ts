import { all, get, run, type DB } from './db.js';
import { localDay } from './streaks.js';

/**
 * Badges (docs/segment-3b-badges.md): milestones of quality and reach, never raw submission counts. "Accepted" is
 * the XP ledger's status, so XP and badges always agree. A badge is stored the first time it's earned and never
 * removed, because some can stop being true (a demoted tier, a language that gains volunteers). New ones are checked
 * when the volunteer's stats load.
 */

/** `later`: shown as "coming", awarded once their data exists (Eagle eye: piece C; First responder: Segment 4). */
export const BADGES = [
  { id: 'approved_1' },
  { id: 'approved_100' },
  { id: 'approved_1000' },
  { id: 'bridge_builder' },
  { id: 'trusted' },
  { id: 'lead' },
  { id: 'rare_voice' },
  { id: 'eagle_eye', later: true },
  { id: 'first_responder', later: true },
] as const;
export type BadgeId = (typeof BADGES)[number]['id'];
export const BADGE_IDS: readonly BadgeId[] = BADGES.map((b) => b.id);

/** Rare voice: at most this many volunteers active in the language over the last RARE_DAYS days. */
export const RARE_MAX = 5;
export const RARE_DAYS = 30;
export const BRIDGE_ORGS = 10;

type Earned = { earnedAt: string; detail?: string } | null;
const nowStamp = (now: number) => new Date(now).toISOString().slice(0, 19).replace('T', ' ');

/** When the nth distinct string this person translated was accepted. */
const nthApproved = (db: DB, userId: number, nth: number): Earned => {
  const r = get<{ at: string }>(
    db,
    `SELECT at FROM (
       SELECT MIN(settled_at) AS at FROM xp_events
       WHERE user_id = ? AND kind = 'translate' AND status = 'accepted' GROUP BY key_id, locale
     ) ORDER BY at LIMIT 1 OFFSET ?`,
    userId, nth - 1,
  );
  return r ? { earnedAt: r.at } : null;
};

const CHECKS: Partial<Record<BadgeId, (db: DB, userId: number, now: number) => Earned>> = {
  approved_1: (db, u) => nthApproved(db, u, 1),
  approved_100: (db, u) => nthApproved(db, u, 100),
  approved_1000: (db, u) => nthApproved(db, u, 1000),
  bridge_builder: (db, u) => {
    const r = get<{ at: string }>(
      db,
      `SELECT at FROM (
         SELECT MIN(x.settled_at) AS at FROM xp_events x JOIN projects p ON p.id = x.project_id
         WHERE x.user_id = ? AND x.status = 'accepted' GROUP BY p.org_id
       ) ORDER BY at LIMIT 1 OFFSET ?`,
      u, BRIDGE_ORGS - 1,
    );
    return r ? { earnedAt: r.at } : null;
  },
  trusted: (db, u, now) => (get(db, "SELECT 1 FROM user_languages WHERE user_id = ? AND tier IN ('trusted', 'lead')", u) ? { earnedAt: nowStamp(now) } : null),
  lead: (db, u, now) => (get(db, "SELECT 1 FROM user_languages WHERE user_id = ? AND tier = 'lead'", u) ? { earnedAt: nowStamp(now) } : null),
  rare_voice: (db, u, now) => {
    // Days are local, so a day either side of UTC doesn't matter over a 30-day window.
    const since = new Date(Date.parse(`${localDay(null, now)}T00:00:00Z`) - (RARE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    // Volunteers as return rates count them: open pool and org localizers, not org admins or reviewers.
    const r = get<{ locale: string }>(
      db,
      `SELECT mine.locale FROM (
         SELECT DISTINCT locale FROM volunteer_activity
         WHERE user_id = ? AND day >= ? AND (role IS NULL OR role = 'localizer')
           AND locale IN (SELECT locale FROM xp_events WHERE user_id = ? AND status = 'accepted')
       ) mine
       WHERE (SELECT COUNT(DISTINCT v.user_id) FROM volunteer_activity v
              WHERE v.locale = mine.locale AND v.day >= ? AND (v.role IS NULL OR v.role = 'localizer')) <= ?
       ORDER BY mine.locale LIMIT 1`,
      u, since, u, since, RARE_MAX,
    );
    return r ? { earnedAt: nowStamp(now), detail: r.locale } : null;
  },
};

/** Stores any badge `userId` has newly earned. Badges already held aren't checked again. */
export function awardBadges(db: DB, userId: number, now = Date.now()) {
  const have = new Set(all<{ badge: string }>(db, 'SELECT badge FROM volunteer_badges WHERE user_id = ?', userId).map((r) => r.badge));
  for (const [id, check] of Object.entries(CHECKS)) {
    if (have.has(id)) continue;
    const earned = check!(db, userId, now);
    if (earned) run(db, 'INSERT OR IGNORE INTO volunteer_badges (user_id, badge, detail, earned_at) VALUES (?, ?, ?, ?)', userId, id, earned.detail ?? null, earned.earnedAt);
  }
}

export interface EarnedBadge {
  id: BadgeId;
  detail: string | null;
  earnedAt: string;
  /** Not shown to the volunteer yet. */
  new: boolean;
}

export function badgesOf(db: DB, userId: number): EarnedBadge[] {
  return all<{ badge: BadgeId; detail: string | null; earned_at: string; seen_at: string | null }>(
    db,
    'SELECT badge, detail, earned_at, seen_at FROM volunteer_badges WHERE user_id = ? ORDER BY earned_at, badge',
    userId,
  ).map((r) => ({ id: r.badge, detail: r.detail, earnedAt: r.earned_at, new: r.seen_at === null }));
}

export function markSeen(db: DB, userId: number, ids: readonly string[]) {
  for (const id of ids) run(db, 'UPDATE volunteer_badges SET seen_at = CURRENT_TIMESTAMP WHERE user_id = ? AND badge = ? AND seen_at IS NULL', userId, id);
}
