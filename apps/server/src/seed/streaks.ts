import { all, run, type DB } from '../db.js';
import { localDay } from '../streaks.js';
import type { Demo } from './types.js';

/**
 * Demo data for streaks and return rates (docs/segment-3a-streaks.md). Runs last, so the other seeds' saves are
 * already recorded on today. Days are UTC days relative to the seed date (demo users have no time zone yet), so:
 * the online demo's streaks age after a deploy (María's freezes carry hers two days, then it reads 0), and a browser
 * west of UTC in its evening sees her "yesterday" as today.
 *
 * - María: 15 days in a row ending yesterday (🔥 15, 🧊 2, today still to do), and once a week before that.
 * - Sam, Yuki: on and off over nine weeks, so the staff return rates aren't all 0% or 100%.
 * - Lucas, an org reviewer: every weekday. Return rates leave him out.
 */
export function seedStreaks(db: DB, demo: Demo) {
  const today = localDay(null);
  const ago = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const keys = all<{ id: number; project_id: number }>(db, 'SELECT id, project_id FROM keys WHERE project_id = ? ORDER BY id', demo.projects.pantry.id);
  const act = (userId: number, daysAgo: number, role: string, cards = 2, locale = 'es') => {
    for (let i = 0; i < cards; i++) {
      const k = keys[(daysAgo * 3 + i) % keys.length];
      run(
        db,
        "INSERT OR IGNORE INTO volunteer_activity (user_id, day, kind, key_id, locale, project_id, role) VALUES (?, ?, 'translate', ?, ?, ?, ?)",
        userId, ago(daysAgo), k.id, locale, k.project_id, role,
      );
    }
  };
  const { maria, sam, yuki, lucas } = demo.users;

  // María's saves in the review seed happened "today"; they become yesterday's, the end of her run.
  run(db, 'UPDATE OR IGNORE volunteer_activity SET day = ? WHERE user_id = ? AND day = ?', ago(1), maria, today);
  run(db, 'DELETE FROM volunteer_activity WHERE user_id = ? AND day = ?', maria, today);
  for (let d = 1; d <= 15; d++) act(maria, d, 'localizer');
  for (let d = 19; d <= 63; d += 7) act(maria, d, 'localizer', 1);

  // Two days a week, skipping a few weeks.
  for (const week of [1, 2, 3, 5, 6, 8]) for (const d of [1, 4]) act(sam, week * 7 + d, 'localizer');
  for (const week of [2, 4, 6, 8]) act(yuki, week * 7 + 2, 'localizer', 3, 'ja');

  for (let d = 1; d <= 63; d++) if (![0, 6].includes(new Date(`${ago(d)}T00:00:00Z`).getUTCDay())) act(lucas, d, 'reviewer', 3);
}
