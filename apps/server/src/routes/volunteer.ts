import type { FastifyInstance } from 'fastify';
import { HttpError, requireUser } from '../auth.js';
import { get, run, type DB } from '../db.js';
import { buildSession } from '../pool/session.js';
import { stats } from '../xp.js';

/** The user's saved "Nonprofits only" choice (off until they turn it on). */
const nonprofitsOnlyPref = (db: DB, userId: number) =>
  !!get<{ v: number }>(db, 'SELECT nonprofits_only AS v FROM volunteer_prefs WHERE user_id = ?', userId)?.v;

function saveNonprofitsOnly(db: DB, userId: number, on: boolean) {
  run(
    db,
    `INSERT INTO volunteer_prefs (user_id, nonprofits_only) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET nonprofits_only = excluded.nonprofits_only, updated_at = CURRENT_TIMESTAMP`,
    userId, on ? 1 : 0,
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
    if (asked !== undefined) saveNonprofitsOnly(db, user.id, asked);
    return buildSession(db, user, size, asked ?? nonprofitsOnlyPref(db, user.id));
  });

  app.get('/api/v1/volunteer/stats', async (req) => {
    const { user } = requireUser(db, req);
    return stats(db, user.id);
  });

  // The volunteer's card-session settings.
  const settings = (userId: number) => ({ nonprofitsOnly: nonprofitsOnlyPref(db, userId) });
  app.get('/api/v1/volunteer/settings', async (req) => settings(requireUser(db, req).user.id));
  app.put<{ Body: { nonprofitsOnly?: unknown } }>('/api/v1/volunteer/settings', async (req) => {
    const { user } = requireUser(db, req);
    const on = flag(req.body?.nonprofitsOnly);
    if (on === undefined) throw new HttpError(400, 'nonprofitsOnly must be true or false.');
    saveNonprofitsOnly(db, user.id, on);
    return settings(user.id);
  });
}
