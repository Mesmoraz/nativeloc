import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { awardBadges, badgesOf } from '../src/badges.js';
import { numbersIn, plant } from '../src/cards/spot.js';
import { addMembership, all, get, getUser, openDb, run, type DB } from '../src/db.js';
import { buildSession } from '../src/pool/session.js';
import { reviewOf } from '../src/services.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
const cookies: Record<number, string> = {};
const pw = hashPassword('pw-12345678');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
});

let n = 0;
/** A signed-in user, a member of `org` with `role` when given, with `tier` in their locales. */
async function user(locales: string[], org?: number, role: 'localizer' | 'reviewer' | 'admin' = 'localizer', tier: 'new' | 'trusted' | 'lead' = 'trusted') {
  const email = `u${++n}@cards.test`;
  const id = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, `U${n}`, pw, JSON.stringify(locales)).lastInsertRowid);
  if (org) addMembership(db, id, org, role);
  for (const l of locales) run(db, 'INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, ?, ?, ?)', id, l, tier, 'test');
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  cookies[id] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
  return id;
}
const as = (id: number) => ({ cookie: cookies[id] });
const org = (name = `org${++n}`) => Number(run(db, 'INSERT INTO orgs (name) VALUES (?)', name).lastInsertRowid);
function project(orgId: number, locales: string[], mode: 'standard' | 'community' = 'standard') {
  const id = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, review_mode) VALUES (?, ?, 'en', ?, ?)", orgId, `p${++n}`, `cd_${n}`, mode).lastInsertRowid);
  for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
  return id;
}
const key = (projectId: number, source: string) => Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', projectId, `k${++n}`, source).lastInsertRowid);
const translation = (keyId: number, locale: string, text: string, by: number, status = 'approved') =>
  run(db, 'INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, ?, ?, ?, ?)', keyId, locale, text, status, by);
/** A fixed sequence for `rand`, repeating its last value. */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[Math.min(i++, xs.length - 1)];
};

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ledger kinds', () => {
  it('rebuilds an old xp_events table, keeping its rows, so check and pick XP fit', () => {
    const path = join(dir, 'old-xp.db');
    const old = openDb(path);
    const u = Number(run(old, "INSERT INTO users (email, name, password_hash) VALUES ('x@c.test', 'x', 'x')").lastInsertRowid);
    run(old, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status) VALUES (?, 'translate', 1, 'es', 1, 10, 'accepted')", u);
    old.exec('PRAGMA foreign_keys = OFF');
    old.exec(`
      CREATE TABLE xp_old (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('translate', 'review')), key_id INTEGER NOT NULL, locale TEXT NOT NULL,
        project_id INTEGER NOT NULL, points INTEGER NOT NULL CHECK (points > 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'voided')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, settled_at TEXT);
      INSERT INTO xp_old SELECT * FROM xp_events; DROP TABLE xp_events; ALTER TABLE xp_old RENAME TO xp_events;`);
    old.close();

    const db2 = openDb(path);
    expect(all(db2, 'SELECT kind, points, status FROM xp_events')).toEqual([{ kind: 'translate', points: 10, status: 'accepted' }]);
    for (const kind of ['check', 'pick']) run(db2, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status) VALUES (?, ?, 1, 'es', 1, 5, 'pending')", u, kind);
    const indexes = all<{ name: string }>(db2, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'xp_events' AND name LIKE 'xp_%'").map((r) => r.name).sort();
    expect(indexes).toEqual(['xp_one_pending', 'xp_string', 'xp_user']);
    db2.close();
  });

  it('accepts the new kinds on a fresh database', () => {
    expect(get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE name = 'xp_events'")!.sql).toContain("'pick'");
  });
});

describe('numbers', () => {
  it('finds numbers in any digit script, by digit value', () => {
    expect(numbersIn('Call 555-0100 by 5 PM').map((n) => n.value)).toEqual(['555', '0100', '5']);
    expect(numbersIn('حتى الساعة ٥').map((n) => n.value)).toEqual(['5']);
    expect(numbersIn('午後５時まで').map((n) => n.value)).toEqual(['5']);
    expect(numbersIn('no numbers')).toEqual([]);
  });

  const once = () => 0; // always the first candidate

  it('changes one shared number, adding 1 to its last digit', () => {
    expect(plant('Open until 5 PM', 'Abierto hasta las 5 p. m.', once)).toEqual({ shown: 'Abierto hasta las 6 p. m.', original: '5', changed: '6' });
    expect(plant('Call 555-0109', 'Llame al 555-0109', () => 0.99)).toEqual({ shown: 'Llame al 555-0100', original: '0109', changed: '0100' });
  });

  it("keeps the digit's script", () => {
    expect(plant('Open until 5', 'مفتوح حتى ٥', once)).toEqual({ shown: 'مفتوح حتى ٦', original: '٥', changed: '٦' });
    expect(plant('Until 5', '５時まで', once)?.shown).toBe('６時まで');
  });

  it("won't plant a number the source also has, or without a shared number", () => {
    expect(plant('Open 5 to 6', 'Abierto de 5 a 6', () => 0)).toEqual({ shown: 'Abierto de 5 a 7', original: '6', changed: '7' });
    expect(plant('Open 5 or 6', 'Abierto 5', once)).toBeNull();
    expect(plant('Open until five', 'Abierto hasta las 5', once)).toBeNull();
    expect(plant('Hello', 'Hola', once)).toBeNull();
  });
});

describe('Spot the problem cards', () => {
  /** An org with one project in `xs` that has untranslated work and one approved string with a number. */
  async function setup() {
    const o = org();
    const p = project(o, ['xs']);
    const author = await user(['xs'], o);
    const vol = await user(['xs'], o);
    for (let i = 0; i < 4; i++) key(p, `Untranslated ${i}`);
    const k = key(p, 'Open until 5 PM');
    translation(k, 'xs', 'Abierto hasta las 5', author);
    return { o, p, author, vol, k };
  }
  const session = (userId: number, rand: () => number, spotChance = 1) => buildSession(db, getUser(db, userId)!, 5, false, Date.now(), { spotChance, rand });

  it('deals one, after the first card, in place of the last real card', async () => {
    const { vol, k } = await setup();
    // rand: chance, row order, control? (>= 0.5 plants), plant start, position.
    const s = session(vol, seq(0, 0, 0.9, 0, 0));
    expect(s.cards).toHaveLength(5);
    const spots = s.cards.filter((c) => c.type === 'spot');
    expect(spots).toHaveLength(1);
    expect(s.cards.findIndex((c) => c.type === 'spot')).toBe(1);
    expect(spots[0]).toMatchObject({ type: 'spot', locale: 'xs', spot: { source: 'Open until 5 PM', shown: 'Abierto hasta las 6' } });
    expect(get(db, 'SELECT planted, original, changed FROM spot_checks WHERE key_id = ?', k)).toEqual({ planted: 1, original: '5', changed: '6' });
  });

  it('never deals one by chance alone, with too little real work, or on your own translation', async () => {
    const { vol, author, p } = await setup();
    expect(session(vol, seq(0.5), 1 / 3).cards.some((c) => c.type === 'spot')).toBe(false);
    run(db, 'UPDATE keys SET archived = 1 WHERE project_id = ? AND source LIKE ?', p, 'Untranslated%');
    expect(session(vol, seq(0)).cards.some((c) => c.type === 'spot')).toBe(false);
    run(db, 'UPDATE keys SET archived = 0 WHERE project_id = ?', p);
    expect(session(author, seq(0)).cards.some((c) => c.type === 'spot')).toBe(false);
  });

  it('never shows the same text twice', async () => {
    const { vol } = await setup();
    // Control both times: the same text, so the second session can't use it.
    expect(session(vol, seq(0, 0, 0.1)).cards.some((c) => c.type === 'spot')).toBe(true);
    expect(session(vol, seq(0, 0, 0.1)).cards.some((c) => c.type === 'spot')).toBe(false);
    // Planted is a different text: still allowed.
    expect(session(vol, seq(0, 0, 0.9, 0, 0)).cards.some((c) => c.type === 'spot')).toBe(true);
  });

  const answer = (userId: number, checkId: number, verdict: string) => app.inject({ method: 'POST', url: `/api/v1/volunteer/checks/${checkId}`, headers: as(userId), payload: { verdict } });
  const dealt = (userId: number, rand: () => number) => {
    const c = session(userId, rand).cards.find((x) => x.type === 'spot');
    return c && 'spot' in c ? c.spot.checkId : null;
  };

  it('grades answers, books accepted check XP for a right one, and records activity', async () => {
    const { vol } = await setup();
    const planted = dealt(vol, seq(0, 0, 0.9, 0, 0))!;
    const right = await answer(vol, planted, 'problem');
    expect(right.json()).toEqual({ correct: true, planted: true, original: '5', changed: '6', xp: { points: 5, status: 'accepted' } });
    expect((await answer(vol, planted, 'ok')).statusCode).toBe(409);
    const control = dealt(vol, seq(0, 0, 0.1))!;
    expect((await answer(vol, control, 'problem')).json()).toMatchObject({ correct: false, planted: false, xp: null });
    expect(all(db, 'SELECT kind, points, status FROM xp_events WHERE user_id = ?', vol)).toEqual([{ kind: 'check', points: 5, status: 'accepted' }]);
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM volunteer_activity WHERE user_id = ? AND kind = 'review'", vol)!.n).toBe(1);
  });

  it("refuses someone else's card and bad verdicts", async () => {
    const { vol } = await setup();
    const other = await user(['xs']);
    const id = dealt(vol, seq(0, 0, 0.9, 0, 0))!;
    expect((await answer(other, id, 'problem')).statusCode).toBe(404);
    expect((await answer(vol, id, 'maybe')).statusCode).toBe(400);
  });

  it('awards Eagle eye at the 25th planted error caught, not from controls', async () => {
    const u = await user(['xs']);
    const check = (planted: number, correct: number, at: string) =>
      run(db, "INSERT INTO spot_checks (user_id, key_id, locale, project_id, shown, planted, verdict, correct, answered_at) VALUES (?, 1, 'xs', 1, 'x', ?, 'problem', ?, ?)", u, planted, correct, at);
    for (let i = 0; i < 30; i++) check(0, 1, '2026-01-01 00:00:00');
    for (let i = 0; i < 24; i++) check(1, 1, `2026-02-${String(i + 1).padStart(2, '0')} 00:00:00`);
    check(1, 0, '2026-02-28 00:00:00');
    awardBadges(db, u);
    expect(badgesOf(db, u).some((b) => b.id === 'eagle_eye')).toBe(false);
    check(1, 1, '2026-03-01 00:00:00');
    awardBadges(db, u);
    expect(badgesOf(db, u).find((b) => b.id === 'eagle_eye')?.earnedAt).toBe('2026-03-01 00:00:00');
  });
});

describe('Pick the better one cards', () => {
  const put = (u: number, k: number, text: string) => app.inject({ method: 'PUT', url: `/api/v1/translations/${k}/xp`, headers: as(u), payload: { text } });
  const pick = (u: number, k: number, chosen: string, other: string) => app.inject({ method: 'POST', url: `/api/v1/translations/${k}/xp/pick`, headers: as(u), payload: { chosen, other } });
  const picksIn = (u: number) => buildSession(db, getUser(db, u)!, 5, false, Date.now(), { spotChance: 0, rand: () => 0 }).cards.filter((c) => c.type === 'pick');

  /** A community string in review, written by `author` and Improved by `improver`. */
  async function improved(mode: 'community' | 'standard' = 'community') {
    const o = org();
    const p = project(o, ['xp'], mode);
    const [author, improver, a, b, rev] = [await user(['xp'], o), await user(['xp'], o), await user(['xp'], o), await user(['xp'], o), await user(['xp'], o, 'reviewer')];
    const k = key(p, 'Free groceries');
    expect((await put(author, k, 'Comida gratis')).statusCode).toBe(200);
    expect((await put(improver, k, 'Alimentos gratis')).statusCode).toBe(200);
    return { p, k, author, improver, a, b, rev };
  }

  it('keeps the replaced wording on an Improve', async () => {
    const { k, author } = await improved();
    expect(get(db, "SELECT text, previous_text, previous_by FROM reviews WHERE key_id = ? AND kind = 'improve'", k)).toEqual({ text: 'Alimentos gratis', previous_text: 'Comida gratis', previous_by: author });
  });

  it("deals it in a Review slot, but not to either writer, and not in standard review", async () => {
    const { k, author, improver, a } = await improved();
    const cards = picksIn(a);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: 'pick', id: `pick:${k}:xp`, pick: { keyId: k, source: 'Free groceries' } });
    const shown = cards[0].type === 'pick' ? [cards[0].pick.a, cards[0].pick.b].sort() : [];
    expect(shown).toEqual(['Alimentos gratis', 'Comida gratis']);
    expect(picksIn(author)).toEqual([]);
    expect(picksIn(improver)).toEqual([]);

    const std = await improved('standard');
    expect(picksIn(std.a)).toEqual([]);
  });

  it('saves a pick once, as advice, and settles its XP by the wording that wins', async () => {
    const { k, a, b, rev } = await improved();
    const res = await pick(a, k, 'Alimentos gratis', 'Comida gratis');
    expect(res.json()).toEqual({ ok: true, xp: { points: 5, status: 'pending' } });
    expect((await pick(a, k, 'Alimentos gratis', 'Comida gratis')).statusCode).toBe(409);
    expect(picksIn(a)).toEqual([]);
    await pick(b, k, 'Comida gratis', 'Alimentos gratis');
    expect(reviewOf(db, k, 'xp')).toMatchObject({ approvals: 0, picks: [{ text: 'Alimentos gratis', count: 1 }, { text: 'Comida gratis', count: 1 }] });
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM volunteer_activity WHERE key_id = ? AND user_id = ? AND kind = 'review'", k, a)!.n).toBe(1);

    expect((await app.inject({ method: 'POST', url: `/api/v1/translations/${k}/xp/approve`, headers: as(rev) })).statusCode).toBe(200);
    const xp = (u: number) => get<{ status: string }>(db, "SELECT status FROM xp_events WHERE user_id = ? AND key_id = ? AND kind = 'pick'", u, k)!.status;
    expect(xp(a)).toBe('accepted');
    expect(xp(b)).toBe('voided');
  });

  it('refuses a stale pair, a non-reviewer, and voids picks on a send-back', async () => {
    const { k, a, b, rev, improver } = await improved();
    expect((await pick(a, k, 'Comida gratis', 'Something else')).statusCode).toBe(409);
    const outsider = await user(['xp']);
    expect([403, 404]).toContain((await pick(outsider, k, 'Comida gratis', 'Alimentos gratis')).statusCode);
    await pick(b, k, 'Comida gratis', 'Alimentos gratis');
    await put(improver, k, 'Alimentos sin costo');
    expect((await pick(a, k, 'Alimentos gratis', 'Comida gratis')).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/v1/translations/${k}/xp/reject`, headers: as(rev) })).statusCode).toBe(200);
    expect(get<{ status: string }>(db, "SELECT status FROM xp_events WHERE user_id = ? AND key_id = ? AND kind = 'pick'", b, k)!.status).toBe('voided');
  });
});
