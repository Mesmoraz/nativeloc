import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, getUser, run, type DB, type Member, type ProjectRow, type Role } from '../src/db.js';
import { COMMUNITY, NEW_VOLUNTEER_FLAGS_COUNT, queue, reviewRight } from '../src/services.js';

// Segment 2C: the adaptive 3–5 round community review, the poster's "Ready to publish" list, XP and quality labels.

let app: FastifyInstance;
let db: DB;
let dir: string;
let org: number;
const cookies: Record<string, string> = {};
const pw = hashPassword('pw-12345678');
const ids: Record<string, number> = {};

/** A user with a membership in the test org; `tier` writes their es tier (no row: new). */
async function user(name: string, role: Role, tier?: 'new' | 'trusted' | 'lead') {
  const email = `${name}@rv.test`;
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
const member = (name: string): Member => {
  const u = getUser(db, ids[name])!;
  const m = get<{ role: Role }>(db, 'SELECT role FROM memberships WHERE user_id = ? AND org_id = ?', u.id, org)!;
  return { ...u, orgId: org, role: m.role };
};
const projectRow = (id: number) => get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!;

let n = 0;
function project(mode: 'standard' | 'community', peerApprovals = 0) {
  const id = Number(
    run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, peer_approvals, review_mode) VALUES (?, ?, 'en', ?, ?, ?)", org, `p${++n}`, `rv_${n}`, peerApprovals, mode).lastInsertRowid,
  );
  run(db, "INSERT INTO project_locales (project_id, locale) VALUES (?, 'es')", id);
  return id;
}
const key = (projectId: number, name = `k${++n}`) => Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', projectId, name, `Source ${name}`).lastInsertRowid);

const put = (who: string, keyId: number, text: string, approve = false) =>
  app.inject({ method: 'PUT', url: `/api/v1/translations/${keyId}/es`, headers: as(who), payload: { text, approve } });
const approve = (who: string, keyId: number) => app.inject({ method: 'POST', url: `/api/v1/translations/${keyId}/es/approve`, headers: as(who) });
const flag = (who: string, keyId: number, reason = 'meaning', note?: string) =>
  app.inject({ method: 'POST', url: `/api/v1/translations/${keyId}/es/flag`, headers: as(who), payload: { reason, note } });
const status = (keyId: number) => get<{ status: string }>(db, "SELECT status FROM translations WHERE key_id = ? AND locale = 'es'", keyId)?.status;
const ledger = (keyId: number) =>
  all<{ e: string }>(db, "SELECT u.name || ' ' || x.kind || ' ' || x.status AS e FROM xp_events x JOIN users u ON u.id = x.user_id WHERE x.key_id = ? ORDER BY x.id", keyId).map((r) => r.e);
const reviewQueue = (who: string, projectId: number) =>
  app.inject({ url: `/api/v1/projects/${projectId}/queue?locale=es&mode=review&limit=50`, headers: as(who) });

/** Approvals by peers v1, v2, … until `count`, asserting each succeeds. */
async function approveBy(keyId: number, names: string[]) {
  let last;
  for (const v of names) {
    last = await approve(v, keyId);
    expect(last.statusCode, `${v}: ${last.body}`).toBe(200);
  }
  return last!.json();
}

const peers = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
  org = Number(run(db, "INSERT INTO orgs (name) VALUES ('Review')").lastInsertRowid);
  await user('admin', 'admin', 'lead');
  await user('rev', 'reviewer', 'lead');
  await user('author', 'localizer', 'trusted');
  await user('lead', 'localizer', 'lead');
  await user('newbie', 'localizer', 'new');
  await user('fresh', 'localizer'); // no row: new
  for (const v of peers) await user(v, 'localizer', 'trusted');
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reviewRight', () => {
  it('community: org reviewers and admins approve, trusted and lead volunteers vote, new volunteers do not review', () => {
    const p = projectRow(project('community'));
    expect(reviewRight(db, p, member('admin'), 'es')).toBe('approve');
    expect(reviewRight(db, p, member('rev'), 'es')).toBe('approve');
    expect(reviewRight(db, p, member('lead'), 'es')).toBe('vote');
    expect(reviewRight(db, p, member('v1'), 'es')).toBe('vote');
    expect(reviewRight(db, p, member('newbie'), 'es')).toBeNull();
    expect(reviewRight(db, p, member('fresh'), 'es')).toBeNull();
  });

  it('standard: unchanged (leads approve, trusted peers vote only with peer review on)', () => {
    const peer = projectRow(project('standard', 2));
    const none = projectRow(project('standard', 0));
    expect(reviewRight(db, peer, member('rev'), 'es')).toBe('approve');
    expect(reviewRight(db, peer, member('lead'), 'es')).toBe('approve');
    expect(reviewRight(db, peer, member('v1'), 'es')).toBe('vote');
    expect(reviewRight(db, none, member('v1'), 'es')).toBeNull();
    expect(reviewRight(db, peer, member('newbie'), 'es')).toBeNull();
  });
});

describe('adaptive rounds', () => {
  let p: number;
  beforeAll(() => {
    p = project('community');
  });

  it('3 approvals of the current text reach consensus when every review approved: status ready, never approved', async () => {
    const k = key(p);
    expect((await put('author', k, 'Hola')).json()).toMatchObject({ status: 'review', review: { reviews: 0, approvals: 0, needed: 3 } });
    expect((await approve('v1', k)).json()).toMatchObject({ status: 'review', review: { reviews: 1, approvals: 1, flags: 0, needed: 3, escalated: false } });
    await approve('v2', k);
    const res = (await approve('v3', k)).json();
    expect(res).toMatchObject({ status: 'ready', review: { reviews: 3, approvals: 3, needed: 3 } });
    expect(status(k)).toBe('ready');
  });

  it("authors can't review their own text; approving twice is one review", async () => {
    const k = key(p);
    await put('author', k, 'Uno');
    expect((await approve('author', k)).statusCode).toBe(403);
    expect((await flag('author', k)).statusCode).toBe(403);
    await approve('v1', k);
    expect((await approve('v1', k)).json()).toMatchObject({ review: { reviews: 1, approvals: 1 }, xp: null });
    expect((await flag('v1', k)).statusCode).toBe(409);
  });

  it('a lead volunteer votes in community mode, and saving with approve does not approve outright', async () => {
    const k = key(p);
    expect((await put('lead', k, 'Dos', true)).json()).toMatchObject({ status: 'review' });
    const k2 = key(p);
    await put('author', k2, 'Tres');
    expect((await approve('lead', k2)).json()).toMatchObject({ status: 'review', review: { approvals: 1 } });
  });

  it('flags carry a reason; after a Flag the current text needs 5 approvals with at most one Flag', async () => {
    const k = key(p);
    await put('author', k, 'Cuatro');
    expect((await flag('v1', k, 'sarcasm')).statusCode).toBe(400);
    const f = (await flag('v1', k, 'tone', 'Too formal')).json();
    expect(f).toMatchObject({ status: 'review', review: { reviews: 1, approvals: 0, flags: 1, needed: 5 }, xp: { points: 5, status: 'pending' } });
    const r = await approveBy(k, ['v2', 'v3', 'v4', 'v5']);
    expect(r).toMatchObject({ status: 'review', review: { approvals: 4, needed: 5 } });
    expect((await approve('v6', k)).json()).toMatchObject({ status: 'ready', review: { reviews: 6, approvals: 5, flags: 1 } });
  });

  it('two Flags on the current text block consensus even with 5 approvals', async () => {
    const k = key(p);
    await put('author', k, 'Cinco');
    await flag('v1', k, 'grammar');
    await flag('v2', k, 'meaning');
    const r = await approveBy(k, ['v3', 'v4', 'v5', 'v6', 'v7']);
    expect(r).toMatchObject({ status: 'review', review: { reviews: 7, approvals: 5, flags: 2, needed: 5, escalated: false } });
  });

  it('an Improve counts as a review, resets approvals of the old text, and raises the bar to 5; reviews count across edits', async () => {
    const k = key(p);
    await put('author', k, 'Seis');
    await approveBy(k, ['v1', 'v2']);
    const imp = (await put('v3', k, 'Seis, mejor')).json();
    expect(imp).toMatchObject({ status: 'review', review: { reviews: 3, approvals: 0, needed: 5 } });
    // The earlier approvers may review the new wording; the improver is now its author.
    expect((await approve('v3', k)).statusCode).toBe(403);
    const r = await approveBy(k, ['v1', 'v2', 'v4', 'v5']);
    expect(r).toMatchObject({ status: 'review', review: { reviews: 7, approvals: 4 } });
    expect((await approve('v6', k)).json()).toMatchObject({ status: 'ready', review: { reviews: 8, approvals: 5 } });
  });

  it('after 8 reviews without consensus the string escalates: hidden below Trusted, and one Lead approval settles it', async () => {
    const k = key(p);
    await put('author', k, 'Siete');
    await flag('v1', k);
    await flag('v2', k);
    await approveBy(k, ['v3', 'v4', 'v5', 'v6', 'v7']);
    const r = (await approve('v8', k)).json();
    expect(r).toMatchObject({ status: 'review', review: { reviews: 8, approvals: 6, flags: 2, escalated: true } });
    // Trusted reviewers still see it; anyone below Trusted doesn't (reviewRight keeps them out of Review anyway).
    expect((await reviewQueue('v9', p)).json().items.map((i: { keyId: number }) => i.keyId)).toContain(k);
    expect((await reviewQueue('newbie', p)).statusCode).toBe(403);
    expect(queue(db, projectRow(p), 'es', 'review', { viewer: member('newbie') }).items.map((i) => i.keyId)).not.toContain(k);
    // A trusted vote doesn't settle it (2 flags still block); a lead's does, to 'ready'.
    expect((await approve('v9', k)).json()).toMatchObject({ status: 'review', review: { escalated: true } });
    expect((await approve('lead', k)).json()).toMatchObject({ status: 'ready' });
  });

  it(`flags from new volunteers ${NEW_VOLUNTEER_FLAGS_COUNT ? 'count' : "don't count"} as votes`, async () => {
    const k = key(p);
    await put('author', k, 'Ocho');
    const f = (await flag('newbie', k, 'offensive')).json();
    expect(f).toMatchObject({ status: 'review', review: { reviews: 0, flags: 0, needed: 3 }, xp: null });
    expect((await flag('fresh', k, 'grammar')).json()).toMatchObject({ review: { reviews: 0 } });
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM reviews WHERE key_id = ? AND kind = 'flag' AND counts = 0", k)!.n).toBe(2);
    expect((await approveBy(k, ['v1', 'v2', 'v3'])).status).toBe('ready');
  });

  it('review queues hide your own work and wording you already reviewed, and carry the community review state', async () => {
    const q = project('community');
    const a = key(q);
    const b = key(q);
    await put('author', a, 'A');
    await put('author', b, 'B');
    await approve('v1', a);
    const items = (await reviewQueue('v1', q)).json().items;
    expect(items.map((i: { keyId: number }) => i.keyId)).toEqual([b]);
    expect(items[0]).toMatchObject({ review: { reviews: 0, approvals: 0, needed: 3, escalated: false }, approvals: { count: 0, needed: 3 } });
    expect((await reviewQueue('author', q)).json().items).toEqual([]);
    // exclude keeps working (2E deals urgent keys with it).
    expect((await app.inject({ url: `/api/v1/projects/${q}/queue?locale=es&mode=review&exclude=${b}`, headers: as('v2') })).json().items.map((i: { keyId: number }) => i.keyId)).toEqual([a]);
  });

  it('flags are refused on standard projects, and standard queue items have review: null', async () => {
    const s = project('standard', 2);
    const k = key(s);
    await put('author', k, 'Estándar');
    expect((await flag('v1', k)).statusCode).toBe(409);
    expect((await reviewQueue('v1', s)).json().items[0]).toMatchObject({ review: null, approvals: { count: 0, needed: 2 } });
  });

  it('the rule numbers live in one constant', () => {
    expect(COMMUNITY).toEqual({ clean: 3, disputed: 5, maxFlags: 1, escalateAt: 8 });
  });
});

describe('XP in community review', () => {
  let p: number;
  beforeAll(() => {
    p = project('community');
  });

  it('pending XP becomes accepted at consensus (ready)', async () => {
    const k = key(p);
    await put('author', k, 'Gracias');
    await approveBy(k, ['v1', 'v2']);
    expect(ledger(k)).toEqual(['author translate pending', 'v1 review pending', 'v2 review pending']);
    expect((await approve('v3', k)).json()).toMatchObject({ status: 'ready', xp: { points: 5, status: 'accepted' } });
    expect(ledger(k)).toEqual(['author translate accepted', 'v1 review accepted', 'v2 review accepted', 'v3 review accepted']);
  });

  it('flags that match the final outcome earn review XP; approvals and flags that do not are voided', async () => {
    const k = key(p);
    await put('author', k, 'Mal');
    await approve('v1', k); // approves wording that won't survive
    await flag('v2', k, 'meaning'); // flags it: vindicated
    await put('v3', k, 'Bien'); // Improve: v3 is the new author
    await flag('v4', k, 'tone'); // flags the final wording: not vindicated
    await approveBy(k, ['v5', 'v6', 'v7', 'v8']);
    expect((await approve('v9', k)).json()).toMatchObject({ status: 'ready' });
    expect(ledger(k)).toEqual([
      'author translate voided',
      'v1 review voided',
      'v2 review accepted',
      'v3 translate accepted',
      'v4 review voided',
      'v5 review accepted',
      'v6 review accepted',
      'v7 review accepted',
      'v8 review accepted',
      'v9 review accepted',
    ]);
  });

  it('a later send-back never removes accepted XP, and reviewing again earns nothing extra', async () => {
    const k = key(p);
    await put('author', k, 'Listo');
    await approveBy(k, ['v1', 'v2', 'v3']);
    const sb = await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/ready/send-back`, headers: as('admin'), payload: { keyId: k, locale: 'es', note: 'Too formal' } });
    expect(sb.json()).toEqual({ status: 'review' });
    expect(ledger(k)).toEqual(['author translate accepted', 'v1 review accepted', 'v2 review accepted', 'v3 review accepted']);
    expect((await approve('v1', k)).json()).toMatchObject({ review: { approvals: 1, needed: 5 }, xp: null });
    expect(ledger(k)).toHaveLength(4);
  });
});

describe('poster: Ready to publish', () => {
  let p: number;
  let calm: number;
  let disputed: number;
  beforeAll(async () => {
    p = project('community');
    calm = key(p, 'calm');
    disputed = key(p, 'disputed');
    await put('author', calm, 'Tranquilo');
    await approveBy(calm, ['v1', 'v2', 'v3']);
    await put('author', disputed, 'Disputa');
    await flag('v1', disputed, 'tone');
    await approveBy(disputed, ['v2', 'v3', 'v4', 'v5', 'v6']);
  });

  it('lists ready text with review counts, flags and disagreement, for org admins only', async () => {
    const res = await app.inject({ url: `/api/v1/projects/${p}/ready?locale=es`, headers: as('admin') });
    expect(res.json()).toEqual({
      items: [
        { keyId: calm, key: 'calm', source: 'Source calm', locale: 'es', text: 'Tranquilo', review: { reviews: 3, approvals: 3, flags: 0, needed: 3, escalated: false }, flags: [], disagreement: false },
        {
          keyId: disputed, key: 'disputed', source: 'Source disputed', locale: 'es', text: 'Disputa',
          review: { reviews: 6, approvals: 5, flags: 1, needed: 5, escalated: false }, flags: [{ reason: 'tone', count: 1 }], disagreement: true,
        },
      ],
    });
    expect((await app.inject({ url: `/api/v1/projects/${p}/ready`, headers: as('v1') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/ready/approve`, headers: as('rev'), payload: {} })).statusCode).toBe(403);
  });

  it('ready text does not ship; bundles carry only approved text, with a community quality label', async () => {
    let res = await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/publish`, headers: as('admin') });
    expect(res.statusCode).toBe(200);
    const token = projectRow(p).bundle_token;
    let es = (await app.inject({ url: `/b/${token}/es.json` })).json();
    expect(es).toEqual({ calm: 'Source calm', disputed: 'Source disputed' });

    // Publish one.
    res = await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/ready/approve`, headers: as('admin'), payload: { items: [{ keyId: calm, locale: 'es' }] } });
    expect(res.json()).toEqual({ approved: 1 });
    expect(status(calm)).toBe('approved');
    expect(status(disputed)).toBe('ready');
    // Publish all.
    res = await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/ready/approve`, headers: as('admin'), payload: {} });
    expect(res.json()).toEqual({ approved: 1 });

    await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/publish`, headers: as('admin') });
    es = (await app.inject({ url: `/b/${token}/es.json` })).json();
    expect(es).toEqual({ calm: 'Tranquilo', disputed: 'Disputa' });
    const m = (await app.inject({ url: `/b/${token}/manifest.json` })).json();
    // v1–v6 reviewed the shipped text.
    expect(m.locales.es).toMatchObject({ quality: 'community', reviewers: 6, completeness: 1 });
    expect(m.locales.en).toMatchObject({ quality: 'community', reviewers: 0 });
  });

  it('send back puts ready text back in review with the note, and it then needs 5 approvals', async () => {
    const k = key(p);
    await put('author', k, 'Formal');
    await approveBy(k, ['v1', 'v2', 'v3']);
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/ready/send-back`, headers: as('admin'), payload: { keyId: calm, locale: 'es' } })).statusCode).toBe(409);
    const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/ready/send-back`, headers: as('admin'), payload: { keyId: k, locale: 'es', note: 'Use tú' } });
    expect(res.json()).toEqual({ status: 'review' });
    const item = (await reviewQueue('v4', p)).json().items.find((i: { keyId: number }) => i.keyId === k);
    expect(item).toMatchObject({ review: { reviews: 3, approvals: 0, needed: 5 }, sentBack: 'Use tú' });
  });

  it('edit: the poster saving text approves it outright', async () => {
    const k = key(p);
    await put('author', k, 'Editar');
    await approveBy(k, ['v1', 'v2', 'v3']);
    expect((await put('admin', k, 'Editado', true)).json()).toMatchObject({ status: 'approved' });
  });
});

describe('quality labels and outdated text', () => {
  it('standard projects are labelled verified, counting the people who approved', async () => {
    const s = project('standard', 0);
    const k = key(s);
    await put('author', k, 'Verificado');
    await approve('rev', k);
    await app.inject({ method: 'POST', url: `/api/v1/projects/${s}/publish`, headers: as('admin') });
    const m = (await app.inject({ url: `/b/${projectRow(s).bundle_token}/manifest.json` })).json();
    expect(m.locales.es).toMatchObject({ quality: 'verified', reviewers: 1 });
  });

  it('community text that goes outdated ships only if the poster published it before', async () => {
    const p = project('community');
    const shipped = key(p, 'shipped');
    const unshipped = key(p, 'unshipped');
    await put('author', shipped, 'Publicado');
    await put('admin', shipped, 'Publicado', true);
    await put('author', unshipped, 'Pendiente');
    await approveBy(unshipped, ['v1', 'v2', 'v3']); // ready, not published
    await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/publish`, headers: as('admin') });
    // The source changes: both go outdated.
    run(db, "UPDATE translations SET status = 'outdated' WHERE key_id IN (?, ?)", shipped, unshipped);
    await app.inject({ method: 'POST', url: `/api/v1/projects/${p}/publish`, headers: as('admin') });
    const es = (await app.inject({ url: `/b/${projectRow(p).bundle_token}/es.json` })).json();
    expect(es).toEqual({ shipped: 'Publicado', unshipped: 'Source unshipped' });
  });
});
