import { get, run, type DB, type Member } from './db.js';

/**
 * Streaks and the daily goal (docs/segment-3a-streaks.md). A day counts when the person saved a translation or a
 * review on it, pending or not; XP stays accepted-only. Each activity is stamped with the person's local day when it
 * happens and never recomputed, so changing time zone (travel) can't erase a day. Streaks and freezes are worked
 * out from those days when read, never stored.
 */

export const DAILY_GOALS = [3, 5, 10, 20] as const;
export type DailyGoal = (typeof DAILY_GOALS)[number];
export const DEFAULT_DAILY_GOAL: DailyGoal = 5;
/** A freeze is earned for every this many active days in a streak, and at most MAX_FREEZES are held. */
export const FREEZE_EVERY = 7;
export const MAX_FREEZES = 2;

/** An IANA zone name. Offsets like "-07:00" (which Intl also accepts) are refused: they're wrong half the year. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !/^[A-Za-z]/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const zoneOrUtc = (tz: string | null | undefined) => (tz && validTimeZone(tz) ? tz : 'UTC');

/** YYYY-MM-DD in `tz` (UTC when it's missing or unknown). */
export function localDay(tz: string | null | undefined, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zoneOrUtc(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * When today began in `tz`, as a UTC timestamp in CURRENT_TIMESTAMP's format. It's now minus the local time of day,
 * so on a daylight-saving changeover day it's an hour off; only "today's XP" uses it, not streaks or the goal.
 */
export function localMidnightUtc(tz: string | null | undefined, now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zoneOrUtc(tz), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const elapsed = ((n('hour') * 60 + n('minute')) * 60 + n('second')) * 1000 + (now % 1000);
  return new Date(now - elapsed).toISOString().slice(0, 19).replace('T', ' ');
}

export const timeZoneOf = (db: DB, userId: number) => get<{ tz: string | null }>(db, 'SELECT time_zone AS tz FROM volunteer_prefs WHERE user_id = ?', userId)?.tz ?? null;

export const dailyGoalOf = (db: DB, userId: number) =>
  (get<{ g: DailyGoal }>(db, 'SELECT daily_goal AS g FROM volunteer_prefs WHERE user_id = ?', userId)?.g ?? DEFAULT_DAILY_GOAL) as DailyGoal;

/** `user` saved or reviewed a string. Callers run it inside the transaction that made the change. */
export function recordActivity(db: DB, user: Member, kind: 'translate' | 'review', s: { projectId: number; keyId: number; locale: string }, now = Date.now()) {
  run(
    db,
    'INSERT OR IGNORE INTO volunteer_activity (user_id, day, kind, key_id, locale, project_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
    user.id, localDay(timeZoneOf(db, user.id), now), kind, s.keyId, s.locale, s.projectId, user.role,
  );
}

export interface Streak {
  /** Days in the current streak. Frozen days hold it without adding to it. */
  current: number;
  freezes: number;
  activeToday: boolean;
  /** The last day a freeze covered, so the app can say so. */
  lastFreezeUsed: string | null;
}

const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Replays the active days from the first one. Each active day adds 1, and every FREEZE_EVERY of them in a streak
 * earns a freeze (up to MAX_FREEZES). A missed day uses a freeze, or ends the streak. Today is never a miss: it isn't
 * over. A recorded day after `today` (someone flew west) is treated as today.
 */
export function streakOf(days: string[], today: string): Streak {
  const active = new Set(days);
  const sorted = [...active].sort();
  if (!sorted.length) return { current: 0, freezes: 0, activeToday: false, lastFreezeUsed: null };
  const last = sorted[sorted.length - 1];
  const end = last > today ? last : today;
  let current = 0;
  let freezes = 0;
  let sinceEarn = 0;
  let lastFreezeUsed: string | null = null;
  for (let d = sorted[0]; d < end; d = addDay(d)) {
    if (active.has(d)) {
      current += 1;
      if (++sinceEarn === FREEZE_EVERY) {
        freezes = Math.min(freezes + 1, MAX_FREEZES);
        sinceEarn = 0;
      }
    } else if (freezes > 0) {
      freezes -= 1;
      lastFreezeUsed = d;
    } else {
      current = 0;
      sinceEarn = 0;
    }
  }
  const activeToday = active.has(end);
  if (activeToday) current += 1;
  return { current, freezes, activeToday, lastFreezeUsed };
}
