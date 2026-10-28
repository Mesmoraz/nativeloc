import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { deadlineBoost } from '../src/campaigns.js';
import { addMembership, all, get, getUser, openDb, run, type DB } from '../src/db.js';
import { buildSession } from '../src/pool/session.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
const cookies: Record<number, string> = {};
const pw = hashPassword('pw-12345678');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
/** A signed-in user with `tier` in `locales`, and a membership in `org` when given. */
async function user(locales: string[], org?: number, role: 'localizer' | 'reviewer' | 'admin' = 'localizer', name = `Vol${++n} Test`) {
  const email = `u${++n}@cp.test`;
  const id = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, name, pw, JSON.stringify(locales)).lastInsertRowid);
  if (org) addMembership(db, id, org, role);
  for (const l of locales) run(db, "INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, ?, 'trusted', 'test')", id, l);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  cookies[id] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
  return id;
}
const as = (id: number) => ({ cookie: cookies[id] });
const org = (name = `Org ${++n}`) => Number(run(db, 'INSERT INTO orgs (name) VALUES (?)', name).lastInsertRowid);
function project(orgId: number, locales: string[], name = `Proj ${++n}`) {
  const id = Number(
    run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, review_mode, visibility, moderation) VALUES (?, ?, 'en', ?, 'standard', 'public', 'approved')", orgId, name, `cp_${++n}`).lastInsertRowid,
  );
  for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
  return id;
}
const key = (p: number, source = `Source ${++n}`) => Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', p, `k${++n}`, source).lastInsertRowid);

describe('schema', () => {
  it('rebuilds an old volunteer_messages table with its rows, so launch messages fit', () => {
    const path = join(dir, 'old-messages.db');
    const old = openDb(path);
    const u = Number(run(old, "INSERT INTO users (email, name, password_hash) VALUES ('m@cp.test', 'm', 'x')").lastInsertRowid);
    const o = Number(run(old, "INSERT INTO orgs (name) VALUES ('O')").lastInsertRowid);
    run(old, "INSERT INTO volunteer_messages (user_id, org_id, kind, body) VALUES (?, ?, 'thanks', 'Hi')", u, o);
    old.exec(`
      CREATE TABLE vm_old (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('thanks', 'favorite', 'approved_reviewer')), body TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, seen_at TEXT);
      INSERT INTO vm_old SELECT * FROM volunteer_messages; DROP TABLE volunteer_messages; ALTER TABLE vm_old RENAME TO volunteer_messages;`);
    old.close();
    const db2 = openDb(path);
    expect(all(db2, 'SELECT kind, body FROM volunteer_messages')).toEqual([{ kind: 'thanks', body: 'Hi' }]);
    run(db2, "INSERT INTO volunteer_messages (user_id, org_id, kind) VALUES (?, ?, 'launch')", u, o);
    expect(get(db2, "SELECT 1 AS y FROM sqlite_master WHERE name = 'volunteer_messages_user'")).toEqual({ y: 1 });
    expect(all<{ name: string }>(db2, 'PRAGMA table_info(volunteer_prefs)').map((c) => c.name)).toContain('show_on_leaderboards');
    db2.close();
  });
});

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const put = (u: number, k: number, locale: string, text: string, approve = false) =>
  app.inject({ method: 'PUT', url: `/api/v1/translations/${k}/${locale}`, headers: as(u), payload: { text, approve } });
const approve = (u: number, k: number, locale: string) => app.inject({ method: 'POST', url: `/api/v1/translations/${k}/${locale}/approve`, headers: as(u) });

describe('campaigns', () => {
  /** A standard project in xa and xb with two strings, its admin and reviewer, and two volunteers. */
  async function setup() {
    const o = org('Campaign Org');
    const p = project(o, ['xa', 'xb'], 'Hours page');
    const [admin, rev] = [await user(['xa', 'xb'], o, 'admin'), await user(['xa', 'xb'], o, 'reviewer')];
    const [v1, v2] = [await user(['xa', 'xb']), await user(['xa', 'xb'], o, 'localizer')];
    const [k1, k2] = [key(p), key(p)];
    const create = (body: object, who = admin) => app.inject({ method: 'POST', url: `/api/v1/projects/${p}/campaign`, headers: as(who), payload: body });
    const view = async () => (await app.inject({ url: `/api/v1/projects/${p}/campaign`, headers: as(admin) })).json();
    return { o, p, admin, rev, v1, v2, k1, k2, create, view };
  }

  it('validates, allows one at a time, and can be cancelled', async () => {
    const { p, create, admin, v1, view } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    for (const body of [{ locales: [], deadline: tomorrow() }, { locales: ['zz'], deadline: tomorrow() }, { locales: ['xa'], deadline: today }, { locales: ['xa'], deadline: '2026-02-30' }]) {
      expect((await create(body)).statusCode).toBe(400);
    }
    expect((await create({ locales: ['xa'], deadline: tomorrow() }, v1)).statusCode).toBe(404);
    const c = (await create({ locales: ['xa', 'xa'], deadline: tomorrow() })).json();
    expect(c).toMatchObject({ name: 'Get Hours page live', daysLeft: 1, endedAt: null, locales: [{ locale: 'xa', total: 2, approved: 0, ready: 0, launchedAt: null }] });
    expect((await create({ locales: ['xb'], deadline: tomorrow() })).statusCode).toBe(409);
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${p}/campaign`, headers: as(admin) });
    expect(cancelled.json()).toMatchObject({ endedReason: 'cancelled' });
    expect((await view()).active).toBeNull();
    expect((await create({ name: '  Spring push ', locales: ['xb'], deadline: inDays(3) })).json()).toMatchObject({ name: 'Spring push', daysLeft: 3 });
  });

  it('launches a language at 100%, tells the volunteers who worked on it, and ends when all have', async () => {
    const { o, create, rev, v1, v2, k1, k2, view } = await setup();
    await create({ locales: ['xa', 'xb'], deadline: inDays(5) });
    await put(v1, k1, 'xa', 'Uno');
    expect((await approve(rev, k1, 'xa')).statusCode).toBe(200);
    expect((await view()).active.locales[0]).toMatchObject({ locale: 'xa', approved: 1, launchedAt: null });
    await put(v2, k2, 'xa', 'Dos');
    await approve(rev, k2, 'xa');
    const after = (await view()).active;
    expect(after.locales[0].launchedAt).toBeTruthy();
    expect(after.endedAt).toBeNull();
    const launches = all<{ user_id: number; body: string }>(db, "SELECT user_id, body FROM volunteer_messages WHERE kind = 'launch' AND org_id = ? ORDER BY user_id", o);
    expect(launches).toEqual([v1, v2].sort((a, b) => a - b).map((u) => ({ user_id: u, body: 'xa' })));

    // A reviewer saving with approve is another way in.
    await put(rev, k1, 'xb', 'Uno', true);
    await put(rev, k2, 'xb', 'Dos', true);
    const done = (await view());
    expect(done.active).toBeNull();
    expect(done.past[0]).toMatchObject({ endedReason: 'launched' });
    // The reviewer did the xb work: no launch message to them, or anyone, for xb.
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM volunteer_messages WHERE kind = 'launch' AND body = 'xb' AND org_id = ?", o)!.n).toBe(0);
  });

  it('ends quietly at the deadline, and refuses a language that is already done', async () => {
    const { p, create, view, rev, k1, k2 } = await setup();
    await create({ locales: ['xa'], deadline: tomorrow() });
    run(db, "UPDATE campaigns SET deadline = date('now', '-1 day') WHERE project_id = ?", p);
    const v = await view();
    expect(v.active).toBeNull();
    expect(v.past[0]).toMatchObject({ endedReason: 'deadline', locales: [{ approved: 0, total: 2 }] });

    await put(rev, k1, 'xb', 'Uno', true);
    await put(rev, k2, 'xb', 'Dos', true);
    expect((await create({ locales: ['xb'], deadline: tomorrow() })).statusCode).toBe(400);
  });
});

describe('the deadline boost', () => {
  it('rises from 0 to 72 hours over the last three days', () => {
    const end = Date.parse('2026-11-10T00:00:00Z') + 86_400_000;
    const at = (hoursLeft: number) => deadlineBoost('2026-11-10', end - hoursLeft * 3_600_000);
    expect(at(96)).toBe(0);
    expect(at(72)).toBe(0);
    expect(at(36)).toBe(36);
    expect(at(0.001)).toBeCloseTo(72, 2);
    expect(at(-1)).toBe(0);
  });

  it("lifts a campaign's cards above otherwise equal ones, and puts the campaign on the card", async () => {
    const o = org('Boost Org');
    const admin = await user(['xc'], o, 'admin');
    const [inCampaign, other] = [project(o, ['xc'], 'Campaign page'), project(o, ['xc'], 'Other page')];
    const [k1, k2] = [key(inCampaign), key(other)];
    run(db, "UPDATE keys SET created_at = datetime('now', '-10 hours') WHERE id = ?", k1);
    run(db, "UPDATE keys SET created_at = datetime('now', '-30 hours') WHERE id = ?", k2);
    const v = await user(['xc']);
    const first = () => buildSession(db, getUser(db, v)!, 1, false, Date.now(), { spotChance: 0 }).cards[0];
    expect(first()).toMatchObject({ project: { id: other }, campaign: null });
    await app.inject({ method: 'POST', url: `/api/v1/projects/${inCampaign}/campaign`, headers: as(admin), payload: { locales: ['xc'], deadline: tomorrow() } });
    expect(first()).toMatchObject({ project: { id: inCampaign }, campaign: { name: 'Get Campaign page live', daysLeft: 1, approved: 0, total: 1 } });
  });
});

describe('campaigns in volunteer stats', () => {
  it('lists running campaigns in the volunteer’s languages, with a bar per language', async () => {
    const o = org('Stats Org');
    const admin = await user(['xs', 'xt'], o, 'admin');
    const [p1, p2] = [project(o, ['xs', 'xt'], 'Flyer'), project(o, ['xs'], 'Site')];
    key(p1);
    key(p1);
    key(p2);
    const rev = await user(['xs'], o, 'reviewer');
    const k = key(p2);
    await put(rev, k, 'xs', 'Hecho', true);
    for (const [p, locales] of [[p1, ['xs', 'xt']], [p2, ['xs']]] as const) {
      await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/campaign`, headers: as(admin), payload: { locales, deadline: inDays(4) } });
    }
    const v = await user(['xs']);
    const stats = (await app.inject({ url: '/api/v1/volunteer/stats', headers: as(v) })).json();
    expect(stats.campaigns.map((c: { name: string; daysLeft: number; locales: unknown[] }) => [c.name, c.daysLeft, c.locales])).toEqual([
      ['Get Flyer live', 4, [{ locale: 'xs', total: 2, approved: 0, launched: false }]],
      ['Get Site live', 4, [{ locale: 'xs', total: 2, approved: 1, launched: false }]],
    ]);
    expect(stats.languageBars).toEqual([{ locale: 'xs', campaigns: 2, total: 4, approved: 1 }]);
  });
});
