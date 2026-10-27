import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, getUser, run, type DB } from '../src/db.js';
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
async function user(locales: string[], org?: number, role: 'localizer' | 'reviewer' | 'admin' = 'localizer', tier: 'new' | 'trusted' | 'lead' = 'trusted') {
  const email = `u${++n}@ov.test`;
  const id = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, `Vol ${n}`, pw, JSON.stringify(locales)).lastInsertRowid);
  if (org) addMembership(db, id, org, role);
  for (const l of locales) run(db, 'INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, ?, ?, ?)', id, l, tier, 'test');
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  cookies[id] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
  return id;
}
const as = (id: number) => ({ cookie: cookies[id] });
const org = (name = `Org ${++n}`) => Number(run(db, 'INSERT INTO orgs (name) VALUES (?)', name).lastInsertRowid);
function project(orgId: number, locales: string[], mode: 'standard' | 'community' = 'community') {
  const id = Number(
    run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, review_mode, visibility, moderation) VALUES (?, ?, 'en', ?, ?, 'public', 'approved')", orgId, `p${++n}`, `ov_${n}`, mode).lastInsertRowid,
  );
  for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
  return id;
}
const accepted = (userId: number, projectId: number, kind = 'translate', createdAt = '2026-10-01 10:00:00') =>
  run(db, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at, settled_at) VALUES (?, ?, ?, 'xd', ?, 10, 'accepted', ?, ?)", userId, kind, ++n, projectId, createdAt, createdAt);

describe("the org's volunteer list", () => {
  it('lists volunteers with accepted work, not members, and not practice', async () => {
    const o = org();
    const p = project(o, ['xd']);
    const admin = await user(['xd'], o, 'admin');
    const a = await user(['xd']);
    const b = await user(['xd']);
    const practice = await user(['xd']);
    const member = await user(['xd'], o, 'localizer');
    accepted(a, p);
    accepted(a, p, 'review');
    accepted(b, p, 'pick');
    accepted(practice, p, 'check');
    accepted(member, p);
    const res = await app.inject({ url: '/api/v1/org/volunteers', headers: as(admin) });
    expect(res.json().volunteers.map((v: { id: number; accepted: number; tiers: object }) => [v.id, v.accepted, v.tiers])).toEqual([
      [a, 2, { xd: 'trusted' }],
      [b, 1, { xd: 'trusted' }],
    ]);
    expect((await app.inject({ url: '/api/v1/org/volunteers', headers: as(a) })).statusCode).toBe(403);
  });

  it('sets favorite and Approved Reviewer, telling the volunteer only when one turns on', async () => {
    const o = org();
    const p = project(o, ['xd']);
    const admin = await user(['xd'], o, 'admin');
    const v = await user(['xd']);
    accepted(v, p);
    const set = (body: object, who = admin, target = v) => app.inject({ method: 'PUT', url: `/api/v1/org/volunteers/${target}`, headers: as(who), payload: body });
    expect((await set({ favorite: true })).json()).toMatchObject({ id: v, favorite: true, approvedReviewer: false });
    expect((await set({ approvedReviewer: true })).json()).toMatchObject({ favorite: true, approvedReviewer: true });
    await set({ favorite: true });
    await set({ favorite: false });
    expect(all(db, 'SELECT kind FROM volunteer_messages WHERE user_id = ? ORDER BY id', v)).toEqual([{ kind: 'favorite' }, { kind: 'approved_reviewer' }]);
    for (const body of [{}, { favorite: 'yes' }]) expect((await set(body)).statusCode).toBe(400);
    expect((await set({ favorite: true }, admin, await user(['xd']))).statusCode).toBe(404);

    const otherAdmin = await user(['xd'], org(), 'admin');
    expect((await set({ favorite: true }, otherAdmin)).statusCode).toBe(404);
    expect(get(db, 'SELECT favorite FROM org_volunteers WHERE org_id = ? AND user_id = ?', o, v)).toEqual({ favorite: 0 });
  });
});

const put = (u: number, k: number, text: string) => app.inject({ method: 'PUT', url: `/api/v1/translations/${k}/xd`, headers: as(u), payload: { text } });
const approve = (u: number, k: number) => app.inject({ method: 'POST', url: `/api/v1/translations/${k}/xd/approve`, headers: as(u) });
const status = (k: number) => get<{ status: string }>(db, "SELECT status FROM translations WHERE key_id = ? AND locale = 'xd'", k)!.status;
const key = (p: number) => Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', p, `k${++n}`, `Source ${n}`).lastInsertRowid);
const makeAR = (o: number, u: number) =>
  run(db, 'INSERT INTO org_volunteers (org_id, user_id, approved_reviewer) VALUES (?, ?, 1) ON CONFLICT (org_id, user_id) DO UPDATE SET approved_reviewer = 1', o, u);

describe('Approved Reviewers at agreement', () => {
  /** A community project, its author, and three trusted volunteers. */
  async function setup() {
    const o = org();
    const p = project(o, ['xd']);
    const [author, a, b, c] = [await user(['xd']), await user(['xd']), await user(['xd']), await user(['xd'])];
    return { o, p, author, a, b, c };
  }

  it("ships at agreement when an Approved Reviewer's approval is among them", async () => {
    const { o, p, author, a, b, c } = await setup();
    makeAR(o, b);
    const k = key(p);
    await put(author, k, 'Hola');
    await approve(a, k);
    await approve(b, k);
    const last = await approve(c, k);
    expect(last.json().status).toBe('approved');
    expect(status(k)).toBe('approved');
    expect(get(db, 'SELECT user_id FROM approvers WHERE key_id = ?', k)).toEqual({ user_id: b });
    expect(all(db, 'SELECT user_id, via FROM publications WHERE key_id = ?', k)).toEqual([{ user_id: b, via: 'approved_reviewer' }]);
    // XP settled as usual.
    expect(get(db, "SELECT status FROM xp_events WHERE user_id = ? AND key_id = ? AND kind = 'translate'", author, k)).toEqual({ status: 'accepted' });
  });

  it("goes to the Ready list without one, with one who's only new, or with another org's", async () => {
    const { o, p, author, a, b, c } = await setup();
    const k1 = key(p);
    await put(author, k1, 'Uno');
    for (const v of [a, b, c]) await approve(v, k1);
    expect(status(k1)).toBe('ready');

    // An Approved Reviewer demoted to new before agreement no longer stands in.
    makeAR(o, a);
    const k2 = key(p);
    await put(author, k2, 'Dos');
    await approve(a, k2);
    run(db, "UPDATE user_languages SET tier = 'new' WHERE user_id = ?", a);
    for (const v of [b, c]) await approve(v, k2);
    expect(status(k2)).toBe('ready');

    // Another org's Approved Reviewer doesn't count here.
    const elsewhere = await user(['xd']);
    makeAR(org(), elsewhere);
    const k3 = key(p);
    await put(author, k3, 'Tres');
    for (const v of [b, c, elsewhere]) await approve(v, k3);
    expect(status(k3)).toBe('ready');
  });

  it("records the poster's click", async () => {
    const { o, p, author, a, b, c } = await setup();
    const admin = await user(['xd'], o, 'admin');
    const k = key(p);
    await put(author, k, 'Cuatro');
    for (const v of [a, b, c]) await approve(v, k);
    const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/ready/approve`, headers: as(admin), payload: {} });
    expect(res.json()).toEqual({ approved: 1 });
    expect(all(db, 'SELECT user_id, via FROM publications WHERE key_id = ?', k)).toEqual([{ user_id: admin, via: 'poster' }]);
  });
});

describe('Final check cards', () => {
  /** A community string on the Ready list, written by `author`, with `ar` as the org's Approved Reviewer. */
  async function readyString() {
    const o = org();
    const p = project(o, ['xd']);
    const [author, a, b, c, ar] = [await user(['xd']), await user(['xd']), await user(['xd']), await user(['xd']), await user(['xd'])];
    const k = key(p);
    await put(author, k, 'Listo');
    for (const v of [a, b, c]) await approve(v, k);
    expect(status(k)).toBe('ready');
    makeAR(o, ar);
    return { o, p, k, author, a, ar };
  }
  const finals = (u: number) => buildSession(db, getUser(db, u)!, 5, false, Date.now(), { spotChance: 0 }).cards.filter((c) => c.type === 'final');
  const decide = (u: number, k: number, decision: string, note?: string) =>
    app.inject({ method: 'POST', url: `/api/v1/translations/${k}/xd/final`, headers: as(u), payload: { decision, note } });

  it('is dealt only to the Approved Reviewer, for ready text they did not write', async () => {
    const { k, author, a, ar, o } = await readyString();
    const cards = finals(ar);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: `final:${k}:xd`, final: { keyId: k, text: 'Listo', review: { approvals: 3 } } });
    expect(finals(a)).toEqual([]);
    makeAR(o, author);
    expect(finals(author)).toEqual([]);
  });

  it('publishes, with credit and XP', async () => {
    const { k, ar } = await readyString();
    const res = await decide(ar, k, 'publish');
    expect(res.json()).toEqual({ status: 'approved', xp: { points: 5, status: 'accepted' } });
    expect(status(k)).toBe('approved');
    expect(all(db, 'SELECT user_id, via FROM publications WHERE key_id = ?', k)).toEqual([{ user_id: ar, via: 'approved_reviewer' }]);
    expect(get(db, 'SELECT 1 AS y FROM approvers WHERE key_id = ? AND user_id = ?', k, ar)).toEqual({ y: 1 });
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM volunteer_activity WHERE user_id = ? AND key_id = ?", ar, k)!.n).toBe(1);
    expect((await decide(ar, k, 'publish')).statusCode).toBe(409);
  });

  it('sends back with a note', async () => {
    const { k, ar } = await readyString();
    expect((await decide(ar, k, 'send_back', 'Use "usted"')).json().status).toBe('review');
    expect(status(k)).toBe('review');
    expect(get(db, "SELECT note FROM reviews WHERE key_id = ? AND kind = 'send_back'", k)).toEqual({ note: 'Use "usted"' });
  });

  it("refuses anyone else, and bad decisions", async () => {
    const { k, a, author, o, ar } = await readyString();
    expect((await decide(a, k, 'publish')).statusCode).toBe(403);
    makeAR(o, author);
    expect((await decide(author, k, 'publish')).statusCode).toBe(403);
    expect((await decide(ar, k, 'maybe')).statusCode).toBe(400);
    expect(status(k)).toBe('ready');
  });
});

describe('favorites', () => {
  it("rank the starring org's work first for the favorite, and say so on the card", async () => {
    const [oa, ob] = [org('Starring Org'), org('Other Org')];
    const [pa, pb] = [project(oa, ['xf'], 'standard'), project(ob, ['xf'], 'standard')];
    const adminA = await user(['xf'], oa, 'admin');
    const v = await user(['xf']);
    const other = await user(['xf']);
    accepted(v, pa);
    const ka = key(pa);
    const kb = key(pb);
    run(db, "UPDATE keys SET created_at = datetime('now', '-20 hours') WHERE id = ?", ka);
    run(db, "UPDATE keys SET created_at = datetime('now', '-30 hours') WHERE id = ?", kb);
    const first = (u: number) => buildSession(db, getUser(db, u)!, 1, false, Date.now(), { spotChance: 0 }).cards[0];

    expect(first(v)).toMatchObject({ project: { id: pb }, org: { favorite: false } });
    await app.inject({ method: 'PUT', url: `/api/v1/org/volunteers/${v}`, headers: as(adminA), payload: { favorite: true } });
    expect(first(v)).toMatchObject({ project: { id: pa }, org: { name: 'Starring Org', favorite: true } });
    // Someone else isn't boosted.
    expect(first(other)).toMatchObject({ project: { id: pb }, org: { favorite: false } });
  });
});

describe('thank-you notes', () => {
  it("go to volunteers since the last one, not to the org's admins and reviewers, or for practice", async () => {
    const o = org('Thankful Org');
    const p = project(o, ['xd']);
    const admin = await user(['xd'], o, 'admin');
    const rev = await user(['xd'], o, 'reviewer');
    const loc = await user(['xd'], o, 'localizer');
    const [a, b, practice] = [await user(['xd']), await user(['xd']), await user(['xd'])];
    for (const u of [a, rev, loc]) accepted(u, p, 'translate', '2026-10-01 10:00:00');
    accepted(practice, p, 'check');
    const status = async () => (await app.inject({ url: `/api/v1/projects/${p}/thanks`, headers: as(admin) })).json();
    const send = (body: unknown, who = admin) => app.inject({ method: 'POST', url: `/api/v1/projects/${p}/thanks`, headers: as(who), payload: { body } });

    expect(await status()).toEqual({ recipients: 2, lastSentAt: null, nextAllowedAt: null });
    for (const bad of ['', '   ', 'x'.repeat(281)]) expect((await send(bad)).statusCode).toBe(400);
    // Admin routes tell non-members the project doesn't exist, as elsewhere.
    expect((await send('Thanks!', a)).statusCode).toBe(404);
    expect((await send('  Thank you all!  ')).json()).toEqual({ recipients: 2 });
    const msgs = all<{ user_id: number; body: string; kind: string }>(db, 'SELECT user_id, body, kind FROM volunteer_messages WHERE project_id = ? ORDER BY user_id', p);
    expect(msgs).toEqual([
      { user_id: loc, body: 'Thank you all!', kind: 'thanks' },
      { user_id: a, body: 'Thank you all!', kind: 'thanks' },
    ].sort((x, y) => x.user_id - y.user_id));

    expect((await send('Again!')).statusCode).toBe(429);
    run(db, "UPDATE thank_yous SET created_at = datetime('now', '-2 days') WHERE project_id = ?", p);
    expect((await send('Nobody new')).statusCode).toBe(409);
    accepted(b, p, 'pick', new Date().toISOString().slice(0, 19).replace('T', ' '));
    expect((await send('Welcome, b!')).json()).toEqual({ recipients: 1 });
  });

  it('reach the volunteer through stats, once', async () => {
    const o = org('Inbox Org');
    const p = project(o, ['xd']);
    const admin = await user(['xd'], o, 'admin');
    const v = await user(['xd']);
    accepted(v, p);
    await app.inject({ method: 'PUT', url: `/api/v1/org/volunteers/${v}`, headers: as(admin), payload: { favorite: true } });
    await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/thanks`, headers: as(admin), payload: { body: 'Gracias' } });
    const stats = async () => (await app.inject({ url: '/api/v1/volunteer/stats', headers: as(v) })).json();
    const { messages } = await stats();
    expect(messages.map((m: { kind: string; org: { name: string }; body: string | null }) => [m.kind, m.org.name, m.body])).toEqual([
      ['favorite', 'Inbox Org', null],
      ['thanks', 'Inbox Org', 'Gracias'],
    ]);
    expect(messages[1].project).toMatchObject({ id: p });
    const seen = (ids: unknown) => app.inject({ method: 'POST', url: '/api/v1/volunteer/messages/seen', headers: as(v), payload: { ids } });
    expect((await seen('all')).statusCode).toBe(400);
    expect((await seen(messages.map((m: { id: number }) => m.id))).json()).toEqual({ ok: true });
    expect((await stats()).messages).toEqual([]);
  });
});

describe('staff measure', () => {
  it('splits recent publications by Approved Reviewer and poster, for orgs with Approved Reviewers', async () => {
    const o = org('Measured Org');
    const p = project(o, ['xd']);
    const v = await user(['xd']);
    makeAR(o, v);
    const pub = (via: string, at = "datetime('now')") => run(db, `INSERT INTO publications (key_id, locale, project_id, user_id, via, created_at) VALUES (1, 'xd', ?, NULL, ?, ${at})`, p, via);
    pub('approved_reviewer');
    pub('approved_reviewer');
    pub('poster');
    pub('poster', "datetime('now', '-40 days')");
    const staff = await user(['xd']);
    run(db, 'UPDATE users SET is_staff = 1 WHERE id = ?', staff);
    const res = (await app.inject({ url: '/api/v1/staff/engagement', headers: as(staff) })).json();
    expect(res.approvedReviewers.find((r: { org: { name: string } }) => r.org.name === 'Measured Org')).toEqual({ org: { id: o, name: 'Measured Org' }, viaApprovedReviewer: 2, viaPoster: 1 });
    expect(res.weeks).toHaveLength(8);
  });
});
