import type { FastifyInstance } from 'fastify';
import { HttpError, requireUser } from '../auth.js';
import { get, run, type DB } from '../db.js';
import { BADGE_IDS, markSeen, type BadgeId } from '../badges.js';
import { buildSession } from '../pool/session.js';
import { DAILY_GOALS, dailyGoalOf, type DailyGoal } from '../streaks.js';
import { stats } from '../xp.js';

/** The user's saved "Nonprofits only" choice (off until they turn it on). */
const nonprofitsOnlyPref = (db: DB, userId: number) =>
  !!get<{ v: number }>(db, 'SELECT nonprofits_only AS v FROM volunteer_prefs WHERE user_id = ?', userId)?.v;

/** Saves the settings given; the others keep their saved (or default) values. */
function savePrefs(db: DB, userId: number, prefs: { nonprofitsOnly?: boolean; dailyGoal?: DailyGoal }) {
  const fields = { nonprofits_only: prefs.nonprofitsOnly === undefined ? undefined : prefs.nonprofitsOnly ? 1 : 0, daily_goal: prefs.dailyGoal };
  const set = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, number][];
  if (!set.length) return;
  run(
    db,
    `INSERT INTO volunteer_prefs (user_id, ${set.map(([c]) => c).join(', ')}) VALUES (?, ${set.map(() => '?').join(', ')})
     ON CONFLICT (user_id) DO UPDATE SET ${set.map(([c]) => `${c} = excluded.${c}`).join(', ')}, updated_at = CURRENT_TIMESTAMP`,
    userId, ...set.map(([, v]) => v),
  );
}

/** "1"/"true" and "0"/"false"; anything else (or nothing) means "use the saved choice". */
function flag(v: unknown): boolean | undefined {
  if (v === true || v === '1' || v === 'true') return true;
  if (v === false || v === '0' || v === 'false') return false;
  return undefined;
}

export function volunteerRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { size?: string; nonprofitsOnly?: string } }>('/api/v1/volunteer/session', async (req) => {
    const { user } = requireUser(db, req);
    const size = Math.min(Math.max(Math.trunc(Number(req.query.size)) || 5, 1), 10);
    // Passing the filter saves it, so the next session (on any device) starts the same way.
    const asked = flag(req.query.nonprofitsOnly);
    if (asked !== undefined) savePrefs(db, user.id, { nonprofitsOnly: asked });
    return buildSession(db, user, size, asked ?? nonprofitsOnlyPref(db, user.id));
  });

  app.get('/api/v1/volunteer/stats', async (req) => {
    const { user } = requireUser(db, req);
    return stats(db, user.id);
  });

  // The app showed these badges, so they're no longer new.
  app.post<{ Body: { ids?: unknown } }>('/api/v1/volunteer/badges/seen', async (req) => {
    const { user } = requireUser(db, req);
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => BADGE_IDS.includes(id as BadgeId))) throw new HttpError(400, 'ids must be a list of badge ids.');
    markSeen(db, user.id, ids as BadgeId[]);
    return { ok: true };
  });

  // The volunteer's card-session settings.
  const settings = (userId: number) => ({ nonprofitsOnly: nonprofitsOnlyPref(db, userId), dailyGoal: dailyGoalOf(db, userId) });
  app.get('/api/v1/volunteer/settings', async (req) => settings(requireUser(db, req).user.id));
  // Either setting, or both; the other keeps its value.
  app.put<{ Body: { nonprofitsOnly?: unknown; dailyGoal?: unknown } }>('/api/v1/volunteer/settings', async (req) => {
    const { user } = requireUser(db, req);
    const body = req.body ?? {};
    if (body.nonprofitsOnly === undefined && body.dailyGoal === undefined) throw new HttpError(400, 'Send nonprofitsOnly or dailyGoal.');
    const on = body.nonprofitsOnly === undefined ? undefined : flag(body.nonprofitsOnly);
    if (body.nonprofitsOnly !== undefined && on === undefined) throw new HttpError(400, 'nonprofitsOnly must be true or false.');
    const goal = body.dailyGoal;
    if (goal !== undefined && !DAILY_GOALS.includes(goal as DailyGoal)) throw new HttpError(400, 'Daily goal must be 3, 5, 10 or 20.');
    savePrefs(db, user.id, { nonprofitsOnly: on, dailyGoal: goal as DailyGoal | undefined });
    return settings(user.id);
  });
}
