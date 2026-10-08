import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { all, run, type DB } from '../src/db.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
const cookies: Record<string, string> = {};
const pw = hashPassword('pw-12345678');

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  expect(res.statusCode).toBe(200);
  cookies[email] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
}
const as = (email: string) => ({ cookie: cookies[email] });

/** A user in `org`; `tiers` adds user_languages rows (no row: trusted localizer). */
async function user(org: number, email: string, role: string, locales: string[], tiers: Record<string, string> = {}) {
  const id = Number(run(db, 'INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, ?, ?, ?, ?, ?)', org, email, email.split('@')[0], pw, role, JSON.stringify(locales)).lastInsertRowid);
  for (const [l, tier] of Object.entries(tiers)) run(db, "INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, ?, ?, 'test')", id, l, tier);
  await login(email);
  return id;
}
function project(org: number, name: string, locales: string[], opts: { peerApprovals?: number; requireReview?: number } = {}) {
  const id = Number(
    run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, require_review, peer_approvals) VALUES (?, ?, 'en', ?, ?, ?)", org, name, `pb_${name}`, opts.requireReview ?? 1, opts.peerApprovals ?? 0).lastInsertRowid,
  );
  for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
  return id;
}
const key = (projectId: number, name: string, source = `Source ${name}`) =>
  Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', projectId, name, source).lastInsertRowid);

const put = (email: string, keyId: number, text: string, approve = false) =>
  app.inject({ method: 'PUT', url: `/api/v1/translations/${keyId}/es`, headers: as(email), payload: { text, approve } });
const approve = (email: string, keyId: number) => app.inject({ method: 'POST', url: `/api/v1/translations/${keyId}/es/approve`, headers: as(email) });
const reject = (email: string, keyId: number) => app.inject({ method: 'POST', url: `/api/v1/translations/${keyId}/es/reject`, headers: as(email) });
const stats = async (email: string) => (await app.inject({ url: '/api/v1/volunteer/stats', headers: as(email) })).json();
/** The ledger for one string, as "who kind points status". */
const ledger = (keyId: number) =>
  all<{ e: string }>(db, "SELECT u.email || ' ' || x.kind || ' ' || x.points || ' ' || x.status AS e FROM xp_events x JOIN users u ON u.id = x.user_id WHERE x.key_id = ? ORDER BY x.id", keyId).map((r) => r.e);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('XP ledger', () => {
  let peer: number; // two peer approvals ship a translation
  let direct: number; // no review required

  beforeAll(async () => {
    const org = Number(run(db, "INSERT INTO orgs (name) VALUES ('XP')").lastInsertRowid);
    await user(org, 'admin@xp.test', 'admin', []);
    await user(org, 'rev@xp.test', 'reviewer', ['es']);
    for (const v of ['ana', 'ben', 'cy']) await user(org, `${v}@xp.test`, 'localizer', ['es']);
    await user(org, 'lea@xp.test', 'localizer', ['es'], { es: 'lead' });
    peer = project(org, 'peer', ['es'], { peerApprovals: 2 });
    direct = project(org, 'direct', ['es'], { requireReview: 0 });
  });

  it('books pending XP when a translation goes to review, once per string', async () => {
    const k = key(peer, 'pending');
    let res = await put('ana@xp.test', k, 'Uno');
    expect(res.json()).toMatchObject({ status: 'review', xp: { points: 10, status: 'pending' } });
    res = await put('ana@xp.test', k, 'Uno, mejor');
    expect(res.json()).toMatchObject({ status: 'review', xp: null }); // re-saving your own text doesn't stack
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 pending']);
    expect((await stats('ana@xp.test')).xp).toEqual({ accepted: 0, pending: 10 });
  });

  it('books nothing for a save that fails validation', async () => {
    const k = key(peer, 'invalid', 'Hello {name}');
    expect((await put('ana@xp.test', k, 'Hola')).statusCode).toBe(422);
    expect(ledger(k)).toEqual([]);
  });

  it('accepts XP at once for a save that is approved immediately', async () => {
    const k1 = key(direct, 'direct');
    expect((await put('ben@xp.test', k1, 'Directo')).json()).toMatchObject({ status: 'approved', xp: { points: 10, status: 'accepted' } });
    const k2 = key(peer, 'by-reviewer');
    expect((await put('rev@xp.test', k2, 'Revisado', true)).json()).toMatchObject({ status: 'approved', xp: { points: 10, status: 'accepted' } });
    const k3 = key(peer, 'by-lead');
    expect((await put('lea@xp.test', k3, 'Líder', true)).json()).toMatchObject({ status: 'approved', xp: { points: 10, status: 'accepted' } });
    expect([...ledger(k1), ...ledger(k2), ...ledger(k3)]).toEqual(['ben@xp.test translate 10 accepted', 'rev@xp.test translate 10 accepted', 'lea@xp.test translate 10 accepted']);
  });

  it('pays the author and the voters once enough peers approve', async () => {
    const k = key(peer, 'votes');
    await put('ana@xp.test', k, 'Votos');
    let res = await approve('ben@xp.test', k);
    expect(res.json()).toMatchObject({ status: 'review', xp: { points: 5, status: 'pending' } });
    res = await approve('ben@xp.test', k);
    expect(res.json()).toMatchObject({ status: 'review', approvals: { count: 1 }, xp: null }); // one vote, earned once
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 pending', 'ben@xp.test review 5 pending']);

    res = await approve('cy@xp.test', k);
    expect(res.json()).toMatchObject({ status: 'approved', xp: { points: 5, status: 'accepted' } });
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 accepted', 'ben@xp.test review 5 accepted', 'cy@xp.test review 5 accepted']);
  });

  it('gives a reviewer approving outright no XP, and accepts the author and voters', async () => {
    const k = key(peer, 'outright');
    await put('ana@xp.test', k, 'Directamente');
    await approve('ben@xp.test', k);
    let res = await approve('rev@xp.test', k);
    expect(res.json()).toEqual({ status: 'approved', xp: null });
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 accepted', 'ben@xp.test review 5 accepted']);

    const k2 = key(peer, 'outright-admin');
    await put('cy@xp.test', k2, 'Admin');
    res = await approve('admin@xp.test', k2);
    expect(res.json()).toEqual({ status: 'approved', xp: null });
    expect(ledger(k2)).toEqual(['cy@xp.test translate 10 accepted']);
  });

  it("gives a volunteer lead review XP for approving someone else's work", async () => {
    const k = key(peer, 'lead-review');
    await put('ana@xp.test', k, 'Por el líder');
    expect((await approve('lea@xp.test', k)).json()).toEqual({ status: 'approved', xp: { points: 5, status: 'accepted' } });
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 accepted', 'lea@xp.test review 5 accepted']);
    // Approving again, or approving your own text, earns nothing.
    expect((await approve('lea@xp.test', k)).json().xp).toBeNull();
    const own = key(peer, 'lead-own');
    await put('lea@xp.test', own, 'Mío');
    expect((await approve('lea@xp.test', own)).json().xp).toBeNull();
    expect(ledger(own)).toEqual(['lea@xp.test translate 10 accepted']);
  });

  it("voids pending XP when someone else changes the text", async () => {
    const k = key(peer, 'improved');
    await put('ana@xp.test', k, 'Malo');
    await approve('ben@xp.test', k);
    expect((await put('cy@xp.test', k, 'Bueno')).json()).toMatchObject({ status: 'review', xp: { points: 10, status: 'pending' } });
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 voided', 'ben@xp.test review 5 voided', 'cy@xp.test translate 10 pending']);
  });

  it('voids votes, but keeps the pending translation, when the author changes their own text', async () => {
    const k = key(peer, 'reworded');
    await put('ana@xp.test', k, 'Primero');
    await approve('ben@xp.test', k);
    expect((await put('ana@xp.test', k, 'Segundo')).json().xp).toBeNull();
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 pending', 'ben@xp.test review 5 voided']);
  });

  it('voids pending XP when a reviewer sends it back', async () => {
    const before = (await stats('ben@xp.test')).xp;
    const k = key(peer, 'rejected');
    await put('cy@xp.test', k, 'Rechazado');
    await approve('ben@xp.test', k);
    expect((await reject('rev@xp.test', k)).json()).toEqual({ status: 'outdated' });
    expect(ledger(k)).toEqual(['cy@xp.test translate 10 voided', 'ben@xp.test review 5 voided']);
    expect((await stats('ben@xp.test')).xp).toEqual(before); // never negative, just gone
  });

  it('never takes accepted XP back', async () => {
    const k = key(peer, 'kept');
    await put('ana@xp.test', k, 'Guardado');
    await approve('rev@xp.test', k);
    await put('cy@xp.test', k, 'Cambiado');
    await reject('rev@xp.test', k);
    expect(ledger(k)).toEqual(['ana@xp.test translate 10 accepted', 'cy@xp.test translate 10 voided']);
  });

  it('reports totals, today, approved strings and projects helped', async () => {
    const s = await stats('ana@xp.test');
    const accepted = all<{ points: number }>(db, "SELECT x.points FROM xp_events x JOIN users u ON u.id = x.user_id WHERE u.email = 'ana@xp.test' AND x.status = 'accepted'");
    expect(s.xp.accepted).toBe(accepted.reduce((n, r) => n + r.points, 0));
    expect(s.today).toEqual(s.xp); // everything here happened today
    expect(s.approvedStrings).toBe(accepted.length); // ana only earned translate XP
    expect(s.projectsHelped).toEqual([{ id: peer, name: 'peer' }]);
    expect((await app.inject({ url: '/api/v1/volunteer/stats' })).statusCode).toBe(401);
  });
});

describe('volunteer sessions', () => {
  let peer: number;
  let noPeer: number;
  const review: number[] = [];
  let noPeerReview: number;
  const session = async (email: string, size?: number) =>
    (await app.inject({ url: `/api/v1/volunteer/session${size ? `?size=${size}` : ''}`, headers: as(email) })).json();
  const types = (s: { cards: { type: string }[] }) => s.cards.map((c) => c.type[0].toUpperCase()).join('');

  beforeAll(async () => {
    const org = Number(run(db, "INSERT INTO orgs (name) VALUES ('Sessions')").lastInsertRowid);
    await user(org, 'author@s.test', 'localizer', ['es']);
    await user(org, 'peer@s.test', 'localizer', ['es']);
    await user(org, 'newbie@s.test', 'localizer', ['es'], { es: 'new' });
    await user(org, 'nolang@s.test', 'localizer', []);
    await user(org, 'german@s.test', 'localizer', ['de']);
    peer = project(org, 'Peer', ['es', 'fr'], { peerApprovals: 2 });
    noPeer = project(org, 'NoPeer', ['es']);
    for (let i = 0; i < 6; i++) key(peer, `t${i}`);
    for (let i = 0; i < 3; i++) review.push(key(peer, `r${i}`));
    for (const k of review) await put('author@s.test', k, `Texto ${k}`);
    key(noPeer, 'np0');
    noPeerReview = key(noPeer, 'np-review');
    await put('author@s.test', noPeerReview, 'Sin pares');
  });

  it('says why when there is nothing to show', async () => {
    expect(await session('nolang@s.test')).toEqual({ cards: [], empty: 'no_languages' });
    expect(await session('german@s.test')).toEqual({ cards: [], empty: 'nothing_to_do' });
    expect((await app.inject({ url: '/api/v1/volunteer/session' })).statusCode).toBe(401);
  });

  it('alternates Translate and Review, starting with Translate', async () => {
    const s = await session('peer@s.test', 6);
    expect(s.empty).toBeNull();
    expect(types(s)).toBe('TRTRTR');
    expect(s.cards[0]).toMatchObject({ id: `translate:${s.cards[0].item.keyId}:es`, type: 'translate', project: { id: peer, name: 'Peer' }, locale: 'es', item: { key: 't0', current: null } });
    expect(s.cards[1]).toMatchObject({ type: 'review', item: { keyId: review[0], current: { status: 'review' }, approvals: { count: 0, needed: 2 } } });
    // Queue order within each kind; only languages the volunteer has.
    expect(s.cards.filter((c: { type: string }) => c.type === 'translate').map((c: { item: { key: string } }) => c.item.key)).toEqual(['t0', 't1', 't2']);
    expect(s.cards.every((c: { locale: string }) => c.locale === 'es')).toBe(true);
  });

  it('fills with whichever kind is left, and keeps size between 1 and 10', async () => {
    // 3 Review cards exist (none on the project without peer review), then Translate fills the rest.
    const s = await session('peer@s.test', 10);
    expect(types(s)).toBe('TRTRTRTTTT');
    expect(s.cards.some((c: { item: { keyId: number } }) => c.item.keyId === noPeerReview)).toBe(false);
    expect(s.cards.map((c: { id: string }) => c.id)).toEqual([...new Set(s.cards.map((c: { id: string }) => c.id))]);
    expect((await session('peer@s.test', 50)).cards).toHaveLength(10);
    expect((await session('peer@s.test')).cards).toHaveLength(5);
    expect((await app.inject({ url: '/api/v1/volunteer/session?size=0', headers: as('peer@s.test') })).json().cards).toHaveLength(5);
  });

  it('gives new volunteers only Translate cards', async () => {
    expect(types(await session('newbie@s.test', 10))).toBe('TTTTTTT');
  });

  it("never offers your own work or work you already approved for review", async () => {
    expect(types(await session('author@s.test', 10))).toBe('TTTTTTT'); // only their own work is in review
    expect((await approve('peer@s.test', review[0])).json().status).toBe('review');
    const s = await session('peer@s.test', 10);
    expect(s.cards.filter((c: { type: string }) => c.type === 'review').map((c: { item: { keyId: number } }) => c.item.keyId)).toEqual([review[1], review[2]]);
  });

  it('says nothing_to_do once the work runs out', async () => {
    const org = Number(run(db, "INSERT INTO orgs (name) VALUES ('Done')").lastInsertRowid);
    await user(org, 'done@s.test', 'localizer', ['es']);
    const p = project(org, 'Done', ['es']);
    const k = key(p, 'only');
    expect(types(await session('done@s.test'))).toBe('T');
    await put('done@s.test', k, 'Hecho');
    expect(await session('done@s.test')).toEqual({ cards: [], empty: 'nothing_to_do' });
  });
});
