import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, openDb, run, type DB, type Role } from '../src/db.js';
import { localDay, streakOf, validTimeZone } from '../src/streaks.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
let org: number;
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
const pw = hashPassword('pw-12345678');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
  org = Number(run(db, "INSERT INTO orgs (name) VALUES ('Streaks')").lastInsertRowid);
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A user with a membership in the test org; `tier` writes their es tier. */
async function user(name: string, role: Role, tier?: 'new' | 'trusted' | 'lead') {
  const email = `${name}@st.test`;
  const id = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, name, pw, '["es"]').lastInsertRowid);
  addMembership(db, id, org, role);
  if (tier) run(db, "INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, 'es', ?, 'test')", id, tier);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  expect(res.statusCode).toBe(200);
  cookies[name] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
  ids[name] = id;
  return id;
}
const as = (name: string) => ({ cookie: cookies[name] });
let n = 0;
function project(mode: 'standard' | 'community', peerApprovals = 0) {
  const id = Number(
    run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, peer_approvals, review_mode) VALUES (?, ?, 'en', ?, ?, ?)", org, `p${++n}`, `st_${n}`, peerApprovals, mode).lastInsertRowid,
  );
  run(db, "INSERT INTO project_locales (project_id, locale) VALUES (?, 'es')", id);
  return id;
}
const key = (projectId: number) => Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', projectId, `k${++n}`, `Source ${n}`).lastInsertRowid);
const put = (who: string, keyId: number, text: string, approve = false) =>
  app.inject({ method: 'PUT', url: `/api/v1/translations/${keyId}/es`, headers: as(who), payload: { text, approve } });
const approve = (who: string, keyId: number) => app.inject({ method: 'POST', url: `/api/v1/translations/${keyId}/es/approve`, headers: as(who) });
const flag = (who: string, keyId: number, reason = 'meaning') => app.inject({ method: 'POST', url: `/api/v1/translations/${keyId}/es/flag`, headers: as(who), payload: { reason } });
/** Activity on one string, as "who kind role day". */
const activity = (keyId: number) =>
  all<{ e: string }>(db, "SELECT u.name || ' ' || a.kind || ' ' || COALESCE(a.role, '-') || ' ' || a.day AS e FROM volunteer_activity a JOIN users u ON u.id = a.user_id WHERE a.key_id = ? ORDER BY a.created_at, u.name, a.kind", keyId).map((r) => r.e);

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** `n` consecutive days ending on `end`. */
const days = (n: number, end: string) => Array.from({ length: n }, (_, i) => addDays(end, -i));

describe('schema', () => {
  it('has the activity table and the new prefs columns', () => {
    const cols = (t: string) => all<{ name: string }>(db, `PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols('volunteer_activity')).toEqual(['user_id', 'day', 'kind', 'key_id', 'locale', 'project_id', 'role', 'created_at']);
    expect(cols('volunteer_prefs')).toEqual(expect.arrayContaining(['time_zone', 'daily_goal']));
  });

  it('only allows the preset goals', () => {
    const id = Number(run(db, "INSERT INTO users (email, name, password_hash) VALUES ('goal@x.test', 'g', 'x')").lastInsertRowid);
    expect(() => run(db, 'INSERT INTO volunteer_prefs (user_id, daily_goal) VALUES (?, 4)', id)).toThrow();
    run(db, 'INSERT INTO volunteer_prefs (user_id, daily_goal) VALUES (?, 10)', id);
    expect(get<{ g: number }>(db, 'SELECT daily_goal AS g FROM volunteer_prefs WHERE user_id = ?', id)!.g).toBe(10);
  });

  it('fills in history from xp_events once, on their UTC day', () => {
    const path = join(dir, 'fill.db');
    const old = openDb(path);
    const u = Number(run(old, "INSERT INTO users (email, name, password_hash) VALUES ('old@x.test', 'o', 'x')").lastInsertRowid);
    old.exec('DROP TABLE volunteer_activity');
    run(old, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at) VALUES (?, 'translate', 1, 'es', 1, 10, 'pending', '2026-10-01 23:30:00')", u);
    run(old, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at) VALUES (?, 'review', 2, 'es', 1, 5, 'voided', '2026-10-02 08:00:00')", u);
    old.close();
    const rows = () => {
      const d = openDb(path);
      const r = all<{ day: string; kind: string; role: string | null }>(d, 'SELECT day, kind, role FROM volunteer_activity ORDER BY day');
      d.close();
      return r;
    };
    const want = [
      { day: '2026-10-01', kind: 'translate', role: null },
      { day: '2026-10-02', kind: 'review', role: null },
    ];
    expect(rows()).toEqual(want);
    expect(rows()).toEqual(want);
  });
});

describe('days', () => {
  it('knows real time zones', () => {
    expect(validTimeZone('America/Los_Angeles')).toBe(true);
    for (const tz of ['Mars/Olympus', '', '-07:00']) expect(validTimeZone(tz)).toBe(false);
  });

  it('gives the local day, or the UTC day without a usable zone', () => {
    const at = Date.UTC(2026, 9, 21, 3);
    expect(localDay('America/Los_Angeles', at)).toBe('2026-10-20');
    expect(localDay(null, at)).toBe('2026-10-21');
    expect(localDay('Mars/Olympus', at)).toBe('2026-10-21');
  });
});

describe('streakOf', () => {
  const T = '2026-10-21';
  const Y = addDays(T, -1);
  const s = (d: string[]) => streakOf(d, T);

  it('starts empty', () => expect(s([])).toEqual({ current: 0, freezes: 0, activeToday: false, lastFreezeUsed: null }));
  it('counts today', () => expect(s([T])).toMatchObject({ current: 1, activeToday: true }));
  it('stays alive until today is over', () => expect(s([Y])).toMatchObject({ current: 1, activeToday: false }));
  it('resets on a missed day with no freeze', () => expect(s([...days(3, addDays(T, -2)), T])).toMatchObject({ current: 1, freezes: 0 }));
  it('earns a freeze every 7 days, up to 2', () => {
    expect(s(days(7, Y))).toMatchObject({ current: 7, freezes: 1 });
    expect(s(days(14, Y))).toMatchObject({ current: 14, freezes: 2 });
    expect(s(days(21, Y))).toMatchObject({ current: 21, freezes: 2 });
  });
  it('earns on today only once today is over', () => {
    expect(s(days(7, T))).toMatchObject({ current: 7, freezes: 0 });
    expect(streakOf(days(7, T), addDays(T, 1))).toMatchObject({ current: 7, freezes: 1 });
  });
  it('uses a freeze on a missed day and holds the count', () => {
    expect(s([...days(7, addDays(T, -2)), T])).toEqual({ current: 8, freezes: 0, activeToday: true, lastFreezeUsed: Y });
  });
  it('resets when the freezes run out', () => {
    expect(s([...days(14, addDays(T, -4)), T])).toMatchObject({ current: 1, freezes: 0 });
  });
  it("doesn't count a frozen day toward the next freeze", () => {
    expect(s([...days(7, addDays(T, -8)), ...days(6, Y)])).toMatchObject({ current: 13, freezes: 0 });
    expect(s([...days(7, addDays(T, -9)), ...days(7, Y)])).toMatchObject({ current: 14, freezes: 1 });
  });
  it('handles a recorded day after today (flying west)', () => {
    expect(s([...days(3, T), addDays(T, 1)])).toMatchObject({ current: 4, freezes: 0, activeToday: true });
  });
});

describe('recording activity', () => {
  const today = () => localDay(null);

  beforeAll(async () => {
    await user('ana', 'localizer', 'trusted');
    await user('ben', 'localizer', 'trusted');
    await user('cy', 'localizer', 'trusted');
    await user('rev', 'reviewer');
    await user('adm', 'admin');
    await user('newbie', 'localizer', 'new');
  });

  it('records saves once per card per day, and peer votes and outright approvals as reviews', async () => {
    const peer = project('standard', 2);
    const k = key(peer);
    expect((await put('ana', k, 'Hola')).statusCode).toBe(200);
    expect((await put('ana', k, 'Hola!')).statusCode).toBe(200);
    expect(activity(k)).toEqual([`ana translate localizer ${today()}`]);
    expect((await approve('ben', k)).statusCode).toBe(200);
    expect((await approve('ben', k)).statusCode).toBe(200);
    expect(activity(k)).toEqual([`ana translate localizer ${today()}`, `ben review localizer ${today()}`]);

    const staffed = project('standard');
    const k2 = key(staffed);
    await put('ana', k2, 'Adiós');
    expect((await approve('rev', k2)).statusCode).toBe(200);
    expect(activity(k2)).toContain(`rev review reviewer ${today()}`);
  });

  it('records community votes, flags (counted or not) and outright approvals', async () => {
    const c = project('community');
    const k = key(c);
    await put('ana', k, 'Hola');
    expect((await approve('ben', k)).statusCode).toBe(200);
    expect((await flag('cy', k)).statusCode).toBe(200);
    expect((await flag('newbie', k, 'tone')).statusCode).toBe(200);
    expect((await approve('adm', k)).statusCode).toBe(200);
    expect(activity(k).sort()).toEqual(
      [`adm review admin ${today()}`, `ana translate localizer ${today()}`, `ben review localizer ${today()}`, `cy review localizer ${today()}`, `newbie review localizer ${today()}`].sort(),
    );
  });

  it('records nothing for a refused action', async () => {
    const peer = project('standard', 2);
    const k = key(peer);
    await put('ana', k, 'Hola');
    expect((await approve('ana', k)).statusCode).toBe(403);
    expect(activity(k)).toEqual([`ana translate localizer ${today()}`]);
  });

  it("stamps the day in the person's time zone", async () => {
    // UTC+14 and UTC-11 are never both on UTC's date, so one of them always shows the zone is used.
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      run(db, 'INSERT INTO volunteer_prefs (user_id, time_zone) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET time_zone = excluded.time_zone', ids.cy, tz);
      const k = key(project('standard'));
      await put('cy', k, 'Hola');
      expect(activity(k)).toEqual([`cy translate localizer ${localDay(tz)}`]);
    }
  });
});

describe('stats', () => {
  const stats = async (who: string) => (await app.inject({ url: '/api/v1/volunteer/stats', headers: as(who) })).json();
  const addActivity = (who: string, day: string, keyId: number) =>
    run(db, "INSERT INTO volunteer_activity (user_id, day, kind, key_id, locale, project_id, role) VALUES (?, ?, 'translate', ?, 'es', 0, 'localizer')", ids[who], day, keyId);

  it('has the streak and the daily goal', async () => {
    await user('dee', 'localizer', 'trusted');
    const today = localDay(null);
    days(7, addDays(today, -1)).forEach((d, i) => addActivity('dee', d, -1 - i));
    const s = await stats('dee');
    expect(s.streak).toEqual({ current: 7, freezes: 1, activeToday: false, lastFreezeUsed: null });
    expect(s.goal).toEqual({ target: 5, done: 0 });

    const p = project('standard');
    await put('dee', key(p), 'Uno');
    await put('dee', key(p), 'Dos');
    const after = await stats('dee');
    expect(after.streak).toMatchObject({ current: 8, activeToday: true });
    expect(after.goal).toEqual({ target: 5, done: 2 });
  });

  it("counts today's XP from local midnight", async () => {
    await user('eve', 'localizer', 'trusted');
    // UTC-10 all year: local midnight is 10:00 UTC.
    run(db, "INSERT INTO volunteer_prefs (user_id, time_zone) VALUES (?, 'Etc/GMT+10')", ids.eve);
    const now = Date.now();
    const midnight = Date.parse(`${localDay('Etc/GMT+10', now)}T10:00:00Z`);
    const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    const xp = (t: number, keyId: number) =>
      run(db, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at) VALUES (?, 'translate', ?, 'es', 0, 10, 'pending', ?)", ids.eve, keyId, stamp(t));
    xp(midnight - 60_000, -100);
    xp(midnight + 60_000, -101);
    expect((await stats('eve')).today).toEqual({ accepted: 0, pending: 10 });
  });
});

describe('settings and time zone', () => {
  const settings = (who: string, payload?: unknown) =>
    app.inject({ method: payload === undefined ? 'GET' : 'PUT', url: '/api/v1/volunteer/settings', headers: as(who), ...(payload === undefined ? {} : { payload: payload as object }) });
  const setZone = (who: string | null, payload: unknown) =>
    app.inject({ method: 'PUT', url: '/api/v1/me/time-zone', headers: who ? as(who) : {}, payload: payload as object });

  beforeAll(async () => {
    await user('fay', 'localizer', 'trusted');
  });

  it('has a daily goal that defaults to 5 and saves without touching the filter', async () => {
    expect((await settings('fay')).json()).toEqual({ nonprofitsOnly: false, dailyGoal: 5 });
    expect((await settings('fay', { dailyGoal: 10 })).json()).toEqual({ nonprofitsOnly: false, dailyGoal: 10 });
    expect((await settings('fay', { nonprofitsOnly: true })).json()).toEqual({ nonprofitsOnly: true, dailyGoal: 10 });
    const s = await app.inject({ url: '/api/v1/volunteer/stats', headers: as('fay') });
    expect(s.json().goal.target).toBe(10);
  });

  it('refuses other goals and empty changes', async () => {
    for (const body of [{}, { dailyGoal: 4 }, { dailyGoal: 'five' }, { nonprofitsOnly: 'maybe' }]) {
      expect((await settings('fay', body)).statusCode).toBe(400);
    }
    expect((await settings('fay', { dailyGoal: 4 })).json().error).toBe('Daily goal must be 3, 5, 10 or 20.');
  });

  it('saves the time zone, and /me returns it', async () => {
    expect((await app.inject({ url: '/api/v1/me', headers: as('fay') })).json().timeZone).toBeNull();
    const res = await setZone('fay', { timeZone: 'Asia/Tokyo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ timeZone: 'Asia/Tokyo' });
    expect((await app.inject({ url: '/api/v1/me', headers: as('fay') })).json().timeZone).toBe('Asia/Tokyo');
  });

  it("only writes a zone that changed, and refuses ones it doesn't know", async () => {
    run(db, "UPDATE volunteer_prefs SET updated_at = '2000-01-01 00:00:00' WHERE user_id = ?", ids.fay);
    await setZone('fay', { timeZone: 'Asia/Tokyo' });
    expect(get<{ u: string }>(db, 'SELECT updated_at AS u FROM volunteer_prefs WHERE user_id = ?', ids.fay)!.u).toBe('2000-01-01 00:00:00');
    expect((await setZone('fay', { timeZone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await setZone('fay', { timeZone: 'Mars/Olympus' })).json().error).toBe("That isn't a time zone we know.");
    expect((await setZone('fay', {})).statusCode).toBe(400);
    expect((await setZone(null, { timeZone: 'Asia/Tokyo' })).statusCode).toBe(401);
  });
});
