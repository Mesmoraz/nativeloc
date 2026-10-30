import type { FastifyInstance } from 'fastify';
import { HttpError, requireUser } from '../auth.js';
import { get, run, type DB } from '../db.js';
import { BADGE_IDS, markSeen, type BadgeId } from '../badges.js';
import { certificatesOf, issueCertificate, publicCertificate, revokeCertificate } from '../certificates.js';
import { answerSpot } from '../cards/spot.js';
import { markMessagesSeen } from '../org/messages.js';
import { buildSession, sources } from '../pool/session.js';
import { campaignsFor } from '../campaigns.js';
import { volunteerBoards } from '../leaderboards.js';
import { DAILY_GOALS, dailyGoalOf, type DailyGoal } from '../streaks.js';
import { stats } from '../xp.js';

/** The user's saved "Nonprofits only" choice (off until they turn it on). */
const nonprofitsOnlyPref = (db: DB, userId: number) =>
  !!get<{ v: number }>(db, 'SELECT nonprofits_only AS v FROM volunteer_prefs WHERE user_id = ?', userId)?.v;

/** Saves the settings given; the others keep their saved (or default) values. */
function savePrefs(db: DB, userId: number, prefs: { nonprofitsOnly?: boolean; dailyGoal?: DailyGoal; showOnLeaderboards?: boolean }) {
  const bit = (v?: boolean) => (v === undefined ? undefined : v ? 1 : 0);
  const fields = { nonprofits_only: bit(prefs.nonprofitsOnly), daily_goal: prefs.dailyGoal, show_on_leaderboards: bit(prefs.showOnLeaderboards) };
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
  app.get<{ Querystring: { size?: string; nonprofitsOnly?: string; spot?: string } }>('/api/v1/volunteer/session', async (req) => {
    const { user } = requireUser(db, req);
    const size = Math.min(Math.max(Math.trunc(Number(req.query.size)) || 5, 1), 10);
    // Passing the filter saves it, so the next session (on any device) starts the same way.
    const asked = flag(req.query.nonprofitsOnly);
    if (asked !== undefined) savePrefs(db, user.id, { nonprofitsOnly: asked });
    // ?spot=1 forces a Spot the problem card, so it can be tried without waiting for the 1-in-3 chance. Never in
    // production, where it would let anyone farm practice XP.
    const spotChance = req.query.spot === '1' && process.env.NODE_ENV !== 'production' ? 1 : undefined;
    return buildSession(db, user, size, asked ?? nonprofitsOnlyPref(db, user.id), Date.now(), { spotChance });
  });

  // Spot the problem: the answer, graded at once (cards/spot.ts).
  app.post<{ Params: { id: string }; Body: { verdict?: unknown } }>('/api/v1/volunteer/checks/:id', async (req) => {
    const { user } = requireUser(db, req);
    return answerSpot(db, user, Number(req.params.id), req.body?.verdict);
  });

  app.get('/api/v1/volunteer/stats', async (req) => {
    const { user } = requireUser(db, req);
    // Campaigns are added here, not in stats(): xp.ts can't import the session code without an import cycle.
    return { ...stats(db, user.id), ...campaignsFor(db, sources(db, user, false), JSON.parse(user.locales) as string[]) };
  });

  // The app showed these messages from orgs (org/messages.ts).
  app.post<{ Body: { ids?: unknown } }>('/api/v1/volunteer/messages/seen', async (req) => {
    const { user } = requireUser(db, req);
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) throw new HttpError(400, 'ids must be a list of message ids.');
    markMessagesSeen(db, user.id, ids as number[]);
    return { ok: true };
  });

  // The app showed these badges, so they're no longer new.
  app.post<{ Body: { ids?: unknown } }>('/api/v1/volunteer/badges/seen', async (req) => {
    const { user } = requireUser(db, req);
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => BADGE_IDS.includes(id as BadgeId))) throw new HttpError(400, 'ids must be a list of badge ids.');
    markSeen(db, user.id, ids as BadgeId[]);
    return { ok: true };
  });

  // This month's leaderboards for the orgs the volunteer has worked for (leaderboards.ts).
  app.get('/api/v1/volunteer/leaderboards', async (req) => {
    const { user } = requireUser(db, req);
    return { boards: volunteerBoards(db, user.id, onLeaderboards(user.id)) };
  });

  // Volunteer-hour certificates (certificates.ts). The public read needs no sign-in: it's how a school checks one.
  app.post<{ Body: { from?: unknown; to?: unknown } }>('/api/v1/volunteer/certificates', async (req) => {
    const { user } = requireUser(db, req);
    return issueCertificate(db, user, req.body ?? {});
  });
  app.get('/api/v1/volunteer/certificates', async (req) => ({ certificates: certificatesOf(db, requireUser(db, req).user.id) }));
  app.delete<{ Params: { code: string } }>('/api/v1/volunteer/certificates/:code', async (req) => revokeCertificate(db, requireUser(db, req).user.id, req.params.code));
  app.get<{ Params: { code: string } }>('/api/v1/certificates/:code', async (req) => publicCertificate(db, req.params.code));

  // The volunteer's card-session settings.
  const onLeaderboards = (userId: number) => !!get<{ v: number }>(db, 'SELECT show_on_leaderboards AS v FROM volunteer_prefs WHERE user_id = ?', userId)?.v;
  const settings = (userId: number) => ({ nonprofitsOnly: nonprofitsOnlyPref(db, userId), dailyGoal: dailyGoalOf(db, userId), showOnLeaderboards: onLeaderboards(userId) });
  app.get('/api/v1/volunteer/settings', async (req) => settings(requireUser(db, req).user.id));
  // Either setting, or both; the other keeps its value.
  app.put<{ Body: { nonprofitsOnly?: unknown; dailyGoal?: unknown; showOnLeaderboards?: unknown } }>('/api/v1/volunteer/settings', async (req) => {
    const { user } = requireUser(db, req);
    const body = req.body ?? {};
    if (body.nonprofitsOnly === undefined && body.dailyGoal === undefined && body.showOnLeaderboards === undefined) {
      throw new HttpError(400, 'Send nonprofitsOnly, dailyGoal or showOnLeaderboards.');
    }
    const board = body.showOnLeaderboards;
    if (board !== undefined && typeof board !== 'boolean') throw new HttpError(400, 'showOnLeaderboards must be true or false.');
    const on = body.nonprofitsOnly === undefined ? undefined : flag(body.nonprofitsOnly);
    if (body.nonprofitsOnly !== undefined && on === undefined) throw new HttpError(400, 'nonprofitsOnly must be true or false.');
    const goal = body.dailyGoal;
    if (goal !== undefined && !DAILY_GOALS.includes(goal as DailyGoal)) throw new HttpError(400, 'Daily goal must be 3, 5, 10 or 20.');
    savePrefs(db, user.id, { nonprofitsOnly: on, dailyGoal: goal as DailyGoal | undefined, showOnLeaderboards: board as boolean | undefined });
    return settings(user.id);
  });
}
