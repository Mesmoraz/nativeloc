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
function xp(userId: number, projectId: number, opts: { kind?: 'translate' | 'review'; locale?: string; key?: number; settledAt?: string; status?: string; createdAt?: string } = {}) {
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
