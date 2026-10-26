import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { all, get, run, type DB } from '../src/db.js';
import { awardBadges, badgesOf, markSeen } from '../src/badges.js';
import { localDay } from '../src/streaks.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
const cookies: Record<string, string> = {};
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
/** A signed-in user with no memberships; returns their id. */
async function user(name = `u${++n}`) {
  const email = `${name}@bg.test`;
  const id = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, name, pw, '["es"]').lastInsertRowid);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  expect(res.statusCode).toBe(200);
  cookies[id] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
  return id;
}
const as = (id: number) => ({ cookie: cookies[id] });
/** A project in a new org; returns the project id. */
function project(orgName = `org${++n}`) {
  const org = Number(run(db, 'INSERT INTO orgs (name) VALUES (?)', orgName).lastInsertRowid);
  return Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token) VALUES (?, ?, 'en', ?)", org, `p${++n}`, `bg_${n}`).lastInsertRowid);
}
/** An XP event, accepted at `settledAt` unless another status is given. Key ids are made up: XP has no foreign key. */
function xp(userId: number, projectId: number, opts: { kind?: 'translate' | 'review' | 'check' | 'pick'; locale?: string; key?: number; settledAt?: string; status?: string; createdAt?: string } = {}) {
  const status = opts.status ?? 'accepted';
  run(
    db,
    `INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at, settled_at) VALUES (?, ?, ?, ?, ?, 10, ?, ?, ?)`,
    userId, opts.kind ?? 'translate', opts.key ?? ++n, opts.locale ?? 'es', projectId, status,
    opts.createdAt ?? opts.settledAt ?? '2026-01-01 00:00:00', status === 'pending' ? null : (opts.settledAt ?? '2026-01-01 00:00:00'),
  );
}
const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const held = (userId: number) => Object.fromEntries(badgesOf(db, userId).map((b) => [b.id, b]));

describe('schema', () => {
  it('has the badge and certificate tables', () => {
    const cols = (t: string) => all<{ name: string }>(db, `PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols('volunteer_badges')).toEqual(['user_id', 'badge', 'detail', 'earned_at', 'seen_at']);
    expect(cols('volunteer_certificates')).toEqual(['code', 'user_id', 'name', 'period_from', 'period_to', 'minutes', 'translations', 'reviews', 'orgs', 'rates', 'issued_at', 'revoked_at']);
  });
});

describe('awarding badges', () => {
  it('awards First approved at the first accepted string, dated when it was accepted', async () => {
    const u = await user();
    const p = project();
    awardBadges(db, u);
    expect(held(u).approved_1).toBeUndefined();
    xp(u, p, { settledAt: '2026-03-04 05:06:07' });
    xp(u, p, { settledAt: '2026-03-05 00:00:00' });
    awardBadges(db, u);
    expect(held(u).approved_1).toMatchObject({ earnedAt: '2026-03-04 05:06:07', new: true });
  });

  it('awards 100 approved at the 100th distinct string', async () => {
    const u = await user();
    const p = project();
    for (let i = 0; i < 99; i++) xp(u, p, { key: 10_000 + i, settledAt: stamp(i) });
    // The same string accepted again (a later round) doesn't count twice.
    xp(u, p, { key: 10_000, settledAt: stamp(500) });
    awardBadges(db, u);
    expect(held(u).approved_100).toBeUndefined();
    xp(u, p, { key: 10_099, settledAt: stamp(99) });
    awardBadges(db, u);
    expect(held(u).approved_100?.earnedAt).toBe(stamp(99));
    expect(held(u).approved_1000).toBeUndefined();
  });

  it('awards Bridge builder at the 10th organization, counting reviews too', async () => {
    const u = await user();
    for (let i = 0; i < 9; i++) xp(u, project(), { settledAt: stamp(i) });
    awardBadges(db, u);
    expect(held(u).bridge_builder).toBeUndefined();
    xp(u, project(), { kind: 'review', settledAt: stamp(20) });
    awardBadges(db, u);
    expect(held(u).bridge_builder?.earnedAt).toBe(stamp(20));
  });

  it('awards Trusted and Lead from trust tiers, and keeps them after a demotion', async () => {
    const t = await user();
    run(db, "INSERT INTO user_languages (user_id, locale, tier) VALUES (?, 'es', 'trusted')", t);
    awardBadges(db, t);
    expect(Object.keys(held(t)).sort()).toEqual(['trusted']);

    const l = await user();
    run(db, "INSERT INTO user_languages (user_id, locale, tier) VALUES (?, 'fr', 'lead')", l);
    awardBadges(db, l);
    expect(Object.keys(held(l)).sort()).toEqual(['lead', 'trusted']);
    run(db, "UPDATE user_languages SET tier = 'new' WHERE user_id = ?", l);
    awardBadges(db, l);
    expect(Object.keys(held(l)).sort()).toEqual(['lead', 'trusted']);
  });

  describe('Rare voice', () => {
    const today = localDay(null);
    const ago = (d: number) => new Date(Date.parse(`${today}T00:00:00Z`) - d * 86_400_000).toISOString().slice(0, 10);
    const active = (userId: number, locale: string, day = today, role: string | null = 'localizer') =>
      run(db, "INSERT OR IGNORE INTO volunteer_activity (user_id, day, kind, key_id, locale, project_id, role) VALUES (?, ?, 'translate', 1, ?, 0, ?)", userId, day, locale, role);
    /** `others` more volunteers active in `locale` today. */
    const crowd = async (locale: string, others: number) => {
      for (let i = 0; i < others; i++) active(await user(), locale);
    };

    it('is earned with accepted work in a language with 5 or fewer active volunteers, and stays', async () => {
      const u = await user();
      xp(u, project(), { locale: 'xa' });
      active(u, 'xa');
      await crowd('xa', 4);
      awardBadges(db, u);
      expect(held(u).rare_voice).toMatchObject({ detail: 'xa' });
      await crowd('xa', 3);
      awardBadges(db, u);
      expect(held(u).rare_voice).toMatchObject({ detail: 'xa' });
    });

    it('is not earned with 6 active volunteers', async () => {
      const u = await user();
      xp(u, project(), { locale: 'xb' });
      active(u, 'xb');
      await crowd('xb', 5);
      awardBadges(db, u);
      expect(held(u).rare_voice).toBeUndefined();
    });

    it("doesn't count activity over 30 days old, or as an org admin or reviewer", async () => {
      const u = await user();
      xp(u, project(), { locale: 'xc' });
      active(u, 'xc');
      await crowd('xc', 4);
      for (let i = 0; i < 3; i++) active(await user(), 'xc', ago(31));
      active(await user(), 'xc', today, 'admin');
      active(await user(), 'xc', today, 'reviewer');
      awardBadges(db, u);
      expect(held(u).rare_voice).toMatchObject({ detail: 'xc' });
    });

    it('needs accepted work in that language', async () => {
      const u = await user();
      xp(u, project(), { locale: 'xd', status: 'pending' });
      active(u, 'xd');
      awardBadges(db, u);
      expect(held(u).rare_voice).toBeUndefined();
    });
  });

  it('gives nothing for pending or voided work', async () => {
    const u = await user();
    const p = project();
    xp(u, p, { status: 'pending' });
    xp(u, p, { status: 'voided' });
    awardBadges(db, u);
    expect(badgesOf(db, u)).toEqual([]);
  });

  it('adds nothing when run again, and seen clears new', async () => {
    const u = await user();
    xp(u, project(), {});
    awardBadges(db, u);
    awardBadges(db, u);
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM volunteer_badges WHERE user_id = ?', u)!.n).toBe(1);
    markSeen(db, u, ['approved_1']);
    expect(held(u).approved_1.new).toBe(false);
  });
});

describe('badges over HTTP', () => {
  const stats = async (u: number) => (await app.inject({ url: '/api/v1/volunteer/stats', headers: as(u) })).json();
  const seen = (u: number, payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/volunteer/badges/seen', headers: as(u), payload: payload as object });

  it('awards when stats load, and seen clears new', async () => {
    const u = await user();
    xp(u, project(), { settledAt: '2026-02-02 02:02:02' });
    expect((await stats(u)).badges).toEqual([{ id: 'approved_1', detail: null, earnedAt: '2026-02-02 02:02:02', new: true }]);
    expect((await seen(u, { ids: ['approved_1'] })).json()).toEqual({ ok: true });
    expect((await stats(u)).badges[0].new).toBe(false);
  });

  it("refuses ids that aren't badges, and can't touch someone else's", async () => {
    const a = await user();
    const b = await user();
    xp(b, project(), {});
    await stats(b);
    for (const body of [{}, { ids: 'approved_1' }, { ids: ['nope'] }]) expect((await seen(a, body)).statusCode).toBe(400);
    expect((await seen(a, { ids: ['approved_1'] })).statusCode).toBe(200);
    expect((await stats(b)).badges[0].new).toBe(true);
  });
});

describe('certificates', () => {
  const issue = (u: number, payload: object = {}) => app.inject({ method: 'POST', url: '/api/v1/volunteer/certificates', headers: as(u), payload });
  const pub = (code: string) => app.inject({ url: `/api/v1/certificates/${code}` });
  /** `t` accepted translations and `r` accepted reviews, done on `day`, in project `p`. */
  const work = (u: number, p: number, t: number, r: number, day = '2026-03-10') => {
    for (let i = 0; i < t; i++) xp(u, p, { createdAt: `${day} 12:00:00`, settledAt: `${day} 13:00:00` });
    for (let i = 0; i < r; i++) xp(u, p, { kind: 'review', createdAt: `${day} 12:00:00`, settledAt: `${day} 13:00:00` });
  };

  it('counts 2 minutes a translation and 1 a review, rounded down to the half hour', async () => {
    const cases: [number, number, number | null][] = [
      [14, 1, null], // 29 minutes
      [15, 0, 0.5], // 30
      [29, 1, 0.5], // 59
      [30, 0, 1], // 60
    ];
    for (const [t, r, hours] of cases) {
      const u = await user();
      work(u, project(), t, r);
      const res = await issue(u);
      if (hours === null) {
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe("There isn't half an hour of accepted work in that period yet.");
      } else {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ hours, translations: t, reviews: r, rates: { version: '2026-10', translate: 2, review: 1 } });
      }
    }
  });

  it("doesn't count pending or voided work", async () => {
    const u = await user();
    const p = project();
    work(u, p, 15, 0);
    for (let i = 0; i < 20; i++) xp(u, p, { status: 'pending', createdAt: '2026-03-10 12:00:00' });
    for (let i = 0; i < 20; i++) xp(u, p, { status: 'voided', createdAt: '2026-03-10 12:00:00' });
    expect((await issue(u)).json()).toMatchObject({ hours: 0.5, translations: 15, reviews: 0 });
  });

  it('counts work done in the period, accepted by now, and lists each org once', async () => {
    const u = await user();
    const a = project('Alpha Pantry');
    const b = project('Beta Shelter');
    work(u, b, 10, 0, '2026-03-01');
    work(u, a, 5, 0, '2026-03-31');
    work(u, a, 5, 0, '2026-02-28'); // before
    work(u, a, 5, 0, '2026-04-01'); // after
    // Done in March, accepted in May: counts.
    xp(u, b, { createdAt: '2026-03-15 10:00:00', settledAt: '2026-05-01 10:00:00' });
    const c = (await issue(u, { from: '2026-03-01', to: '2026-03-31' })).json();
    expect(c).toMatchObject({ periodFrom: '2026-03-01', periodTo: '2026-03-31', translations: 16, orgs: ['Alpha Pantry', 'Beta Shelter'] });
    expect((await issue(u, { to: '2026-03-31' })).json()).toMatchObject({ periodFrom: null, translations: 21 });
  });

  it('refuses bad periods', async () => {
    const u = await user();
    work(u, project(), 15, 0);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    for (const body of [{ to: tomorrow }, { from: '2026-03-02', to: '2026-03-01' }, { from: '2026-13-01' }, { to: 'soon' }, { from: '2026-02-30' }]) {
      expect((await issue(u, body)).statusCode).toBe(400);
    }
  });

  it('is public by code, stays as issued, and can be revoked by its owner only', async () => {
    const u = await user('Rosa Diaz');
    const other = await user();
    const p = project('Gamma Clinic');
    work(u, p, 15, 0);
    const c = (await issue(u)).json();
    expect(c.code).toMatch(/^vc_[\w-]{32}$/);
    const read = await pub(c.code);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(c);
    expect(read.json()).toMatchObject({ name: 'Rosa Diaz', hours: 0.5, revokedAt: null });

    work(u, p, 30, 0);
    expect((await pub(c.code)).json()).toEqual(c);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/volunteer/certificates/${c.code}`, headers: as(other) })).statusCode).toBe(404);
    const revoked = await app.inject({ method: 'DELETE', url: `/api/v1/volunteer/certificates/${c.code}`, headers: as(u) });
    expect(revoked.json().revokedAt).toBeTruthy();
    const after = (await pub(c.code)).json();
    expect(after).toEqual({ code: c.code, revoked: true, name: 'Rosa Diaz', periodFrom: null, periodTo: c.periodTo, issuedAt: c.issuedAt, revokedAt: revoked.json().revokedAt });
  });

  it('lists your certificates newest first, and 404s unknown or deleted ones', async () => {
    const u = await user();
    work(u, project(), 40, 0);
    const first = (await issue(u, { to: '2026-03-10' })).json();
    run(db, "UPDATE volunteer_certificates SET issued_at = '2026-01-01 00:00:00' WHERE code = ?", first.code);
    const second = (await issue(u)).json();
    const list = (await app.inject({ url: '/api/v1/volunteer/certificates', headers: as(u) })).json();
    expect(list.certificates.map((c: { code: string }) => c.code)).toEqual([second.code, first.code]);
    expect((await pub('vc_nope')).statusCode).toBe(404);
    run(db, 'DELETE FROM users WHERE id = ?', u);
    expect((await pub(second.code)).statusCode).toBe(404);
  });
});

describe('practice and picks', () => {
  it("doesn't count Spot the problem toward hours or Bridge builder, and counts picks as reviews", async () => {
    const u = await user();
    for (let i = 0; i < 40; i++) xp(u, project(), { kind: 'check', createdAt: '2026-03-10 12:00:00', settledAt: '2026-03-10 12:00:00' });
    awardBadges(db, u);
    expect(held(u).bridge_builder).toBeUndefined();
    const none = await app.inject({ method: 'POST', url: '/api/v1/volunteer/certificates', headers: as(u), payload: {} });
    expect(none.statusCode).toBe(422);

    for (let i = 0; i < 10; i++) xp(u, project(), { kind: 'pick', createdAt: '2026-03-10 12:00:00', settledAt: '2026-03-10 12:00:00' });
    for (let i = 0; i < 10; i++) xp(u, project(), { createdAt: '2026-03-10 12:00:00', settledAt: '2026-03-10 12:00:00' });
    awardBadges(db, u);
    expect(held(u).bridge_builder).toBeDefined();
    const c = (await app.inject({ method: 'POST', url: '/api/v1/volunteer/certificates', headers: as(u), payload: {} })).json();
    expect(c).toMatchObject({ translations: 10, reviews: 10, hours: 0.5 });
  });
});
