import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, run, type DB } from '../src/db.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
const cookies: Record<string, string> = {};
const pw = hashPassword('pw-12345678');
const as = (email: string) => ({ cookie: cookies[email] });

async function user(email: string, locales: string[], tiers: Record<string, string> = {}, member?: [number, string]) {
  const id = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, email.split('@')[0], pw, JSON.stringify(locales)).lastInsertRowid);
  if (member) addMembership(db, id, member[0], member[1] as 'admin');
  for (const [l, t] of Object.entries(tiers)) run(db, "INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, ?, ?, 'test')", id, l, t);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  cookies[email] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
  return id;
}
const org = (name: string, type = 'small_org', verification = 'unverified') =>
  Number(run(db, 'INSERT INTO orgs (name, type, verification, description) VALUES (?, ?, ?, ?)', name, type, verification, `About ${name}`).lastInsertRowid);
function project(o: number, name: string, locales: string[], visibility = 'public', moderation = 'approved', peer = 0) {
  const id = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, visibility, moderation, peer_approvals) VALUES (?, ?, 'en', ?, ?, ?, ?)", o, name, `pb_${name}`, visibility, moderation, peer).lastInsertRowid);
  for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
  return id;
}
const key = (p: number, name: string, urgent = 0) => Number(run(db, 'INSERT INTO keys (project_id, name, source, urgent) VALUES (?, ?, ?, ?)', p, name, `Source ${name}`, urgent).lastInsertRowid);
const inReview = (k: number, by: number) => run(db, "INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, 'es', 'Texto', 'review', ?)", k, by);
const session = async (email: string, q = '') => (await app.inject({ url: `/api/v1/volunteer/session?size=10${q}`, headers: as(email) })).json();
type C = { type: string; project: { name: string }; org: { name: string }; item: { keyId: number } };

let ids: Record<string, number> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
  const nonprofit = org('Food Bank', 'nonprofit', 'verified');
  const claimed = org('Claimed NP', 'nonprofit', 'pending');
  const community = org('Garden Club');
  const home = org('Home Org');
  ids = {
    community: project(community, 'Community', ['es'], 'public', 'approved', 1),
    nonprofit: project(nonprofit, 'Nonprofit', ['es']),
    claimed: project(claimed, 'Claimed', ['es']),
    priv: project(nonprofit, 'Private', ['es'], 'private', 'none'),
    pending: project(nonprofit, 'Pending', ['es'], 'public', 'pending'),
    none: project(nonprofit, 'Unsubmitted', ['es'], 'public', 'none'),
    rejected: project(nonprofit, 'Rejected', ['es'], 'public', 'rejected'),
    german: project(nonprofit, 'German', ['de']),
    home: project(home, 'Home', ['es'], 'private', 'none'),
    homeOrg: home,
  };
  for (const p of ['community', 'nonprofit', 'claimed', 'priv', 'pending', 'none', 'rejected', 'german', 'home']) key(ids[p], `${p}-1`);
  ids.urgent = key(ids.community, 'community-urgent', 1);
  const author = await user('author@pool.test', ['es'], { es: 'trusted' });
  ids.reviewKey = key(ids.community, 'community-review');
  inReview(ids.reviewKey, author);
  await user('vol@pool.test', ['es'], { es: 'trusted' }, [home, 'localizer']);
  await user('newbie@pool.test', ['es']);
  // Risk 1: a requester who is admin of their own org, with languages but no trust rows.
  await user('requester@pool.test', ['es'], {}, [org('Requester Org', 'individual'), 'admin']);
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('open pool access', () => {
  it('lets non-members into public, approved projects in their languages, as localizers', async () => {
    expect((await app.inject({ url: `/api/v1/projects/${ids.nonprofit}`, headers: as('newbie@pool.test') })).statusCode).toBe(200);
    const k = key(ids.nonprofit, 'saved');
    const res = await app.inject({ method: 'PUT', url: `/api/v1/translations/${k}/es`, headers: as('newbie@pool.test'), payload: { text: 'Hola' } });
    expect(res.json().status).toBe('review');
    // Never admin or export.
    expect((await app.inject({ url: `/api/v1/projects/${ids.nonprofit}/export?format=json&locale=es`, headers: as('newbie@pool.test') })).statusCode).toBe(404);
  });

  it.each(['priv', 'pending', 'none', 'rejected', 'german'])('keeps the %s project at 404', async (p) => {
    expect((await app.inject({ url: `/api/v1/projects/${ids[p]}`, headers: as('vol@pool.test') })).statusCode).toBe(404);
  });
});

describe('pool sessions', () => {
  it('draws from the pool and member projects only, urgent first, then the verified-nonprofit boost', async () => {
    const s = await session('vol@pool.test', '&nonprofitsOnly=0');
    const names = s.cards.map((c: C) => c.project.name);
    expect(new Set(names)).toEqual(new Set(['Community', 'Nonprofit', 'Claimed', 'Home']));
    expect(s.cards[0].item.keyId).toBe(ids.urgent);
    const translate = s.cards.filter((c: C) => c.type === 'translate').map((c: C) => c.project.name);
    expect(translate[1]).toBe('Nonprofit'); // all new, so the +24 verified boost decides
    expect(s.cards.find((c: C) => c.project.name === 'Nonprofit').org).toEqual({ id: expect.any(Number), name: 'Food Bank', type: 'nonprofit', verified: true, description: 'About Food Bank' });
    expect(s.cards.find((c: C) => c.project.name === 'Claimed').org.verified).toBe(false);
  });

  it('filters to verified nonprofits and remembers the choice', async () => {
    const only = (s: { cards: C[] }) => [...new Set(s.cards.map((c) => c.org.name))];
    expect(only(await session('vol@pool.test', '&nonprofitsOnly=1'))).toEqual(['Food Bank']);
    expect(only(await session('vol@pool.test'))).toEqual(['Food Bank']);
    expect((await app.inject({ url: '/api/v1/volunteer/settings', headers: as('vol@pool.test') })).json()).toEqual({ nonprofitsOnly: true });
    await app.inject({ method: 'PUT', url: '/api/v1/volunteer/settings', headers: as('vol@pool.test'), payload: { nonprofitsOnly: false } });
    expect(only(await session('vol@pool.test')).length).toBeGreaterThan(1);
  });

  it('deals Review cards only where reviewRight allows', async () => {
    const reviews = (s: { cards: C[] }) => s.cards.filter((c) => c.type === 'review').map((c) => c.item.keyId);
    expect(reviews(await session('vol@pool.test'))).toEqual([ids.reviewKey]); // trusted, peer-review project
    expect(reviews(await session('newbie@pool.test'))).toEqual([]);
  });

  it("says on each Review card whether it's in community review, which is where the card offers Flag", async () => {
    const author = await user('it-author@pool.test', ['it']);
    await user('it-vol@pool.test', ['it'], { it: 'trusted' });
    const standard = project(org('It Standard'), 'ItStandard', ['it'], 'public', 'approved', 1);
    const community = project(org('It Community'), 'ItCommunity', ['it']);
    run(db, "UPDATE projects SET review_mode = 'community' WHERE id = ?", community);
    for (const p of [standard, community]) run(db, "INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, 'it', 'Testo', 'review', ?)", key(p, `it-${p}`), author);
    const cards: (C & { item: { review: unknown } })[] = (await session('it-vol@pool.test')).cards.filter((c: C) => c.type === 'review');
    const reviewOf = (name: string) => cards.find((c) => c.project.name === name)?.item.review;
    expect(reviewOf('ItStandard')).toBeNull();
    expect(reviewOf('ItCommunity')).toMatchObject({ reviews: 0, needed: 3 });
  });

  it("gives a requester-admin with no trust rows no Review cards, and won't let them approve public work", async () => {
    const s = await session('requester@pool.test');
    expect(s.cards.length).toBeGreaterThan(0);
    expect(s.cards.filter((c: C) => c.type === 'review')).toEqual([]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/translations/${ids.reviewKey}/es/approve`, headers: as('requester@pool.test') });
    expect(res.statusCode).toBe(403);
  });
});

// Card order: how long a string has waited, plus boosts (src/pool/score.ts). Each case uses its own language so it
// only sees its own projects.
describe('pool session score', () => {
  const age = (k: number, hours: number) => run(db, "UPDATE keys SET created_at = datetime('now', ?) WHERE id = ?", `-${hours} hours`, k);
  const first = async (email: string, n = 1) => (await session(email)).cards.slice(0, n).map((c: C) => c.project.name);

  it('puts a long-waiting community string ahead of a new verified-nonprofit one', async () => {
    const waiting = project(org('Fr Club'), 'FrWaiting', ['fr']);
    const fresh = project(org('Fr Charity', 'nonprofit', 'verified'), 'FrFresh', ['fr']);
    age(key(waiting, 'fr-w'), 200);
    key(fresh, 'fr-f');
    await user('fr@pool.test', ['fr']);
    expect(await first('fr@pool.test', 2)).toEqual(['FrWaiting', 'FrFresh']);
  });

  it('lets the verified-nonprofit boost win when the wait gap is smaller than the boost', async () => {
    const waiting = project(org('It Club'), 'ItWaiting', ['it']);
    const charity = project(org('It Charity', 'nonprofit', 'verified'), 'ItCharity', ['it']);
    age(key(waiting, 'it-w'), 10);
    key(charity, 'it-c');
    await user('it@pool.test', ['it']);
    expect(await first('it@pool.test')).toEqual(['ItCharity']);
  });

  it('still puts an urgent string first, even against a string that waited a long time', async () => {
    const old = project(org('Pt Old'), 'PtOld', ['pt']);
    const hot = project(org('Pt Hot'), 'PtHot', ['pt']);
    age(key(old, 'pt-old'), 600);
    key(hot, 'pt-hot', 1);
    await user('pt@pool.test', ['pt']);
    const s = await session('pt@pool.test');
    expect(s.cards[0].project.name).toBe('PtHot');
    expect(s.cards[0].urgent).toBe(true);
  });

  it('ranks a high-priority project above a normal one at equal wait, and low below', async () => {
    const [lo, hi, mid] = ['Low', 'High', 'Mid'].map((n) => project(org(`Ja ${n}`), `Ja${n}`, ['ja']));
    run(db, "UPDATE projects SET priority = 'high' WHERE id = ?", hi);
    run(db, "UPDATE projects SET priority = 'low' WHERE id = ?", lo);
    for (const p of [lo, hi, mid]) age(key(p, 'ja-k'), 100);
    await user('ja@pool.test', ['ja']);
    expect(await first('ja@pool.test', 3)).toEqual(['JaHigh', 'JaMid', 'JaLow']);
  });

  it('takes at most two cards per project while others have work, and relaxes when one project is left', async () => {
    const [a, b] = ['A', 'B'].map((n) => project(org(`Ko ${n}`), `Ko${n}`, ['ko']));
    for (let i = 0; i < 5; i++) {
      age(key(a, `ko-a${i}`), 300 + i); // A has waited longer, but the cap still lets B in
      key(b, `ko-b${i}`);
    }
    await user('ko@pool.test', ['ko']);
    const names = await first('ko@pool.test', 10);
    expect(names.slice(0, 4).filter((n: string) => n === 'KoA')).toHaveLength(2);
    expect(names.slice(0, 4).filter((n: string) => n === 'KoB')).toHaveLength(2);
    expect(names).toHaveLength(10);
    const solo = project(org('Sv Solo'), 'SvSolo', ['sv']);
    for (let i = 0; i < 5; i++) key(solo, `sv-${i}`);
    await user('sv@pool.test', ['sv']);
    expect(await first('sv@pool.test', 10)).toEqual(Array(5).fill('SvSolo'));
  });

  it('counts an outdated string from when its source changed', async () => {
    const p = project(org('Nl Club'), 'NlOne', ['nl']);
    const q = project(org('Nl Other'), 'NlTwo', ['nl']);
    const k = key(p, 'nl-old');
    age(k, 700); // created long ago, but its source changed just now
    run(db, "INSERT INTO translations (key_id, locale, text, status) VALUES (?, 'nl', 'x', 'outdated')", k);
    run(db, "UPDATE keys SET source_changed_at = datetime('now') WHERE id = ?", k);
    age(key(q, 'nl-q'), 50);
    await user('nl@pool.test', ['nl']);
    expect(await first('nl@pool.test', 2)).toEqual(['NlTwo', 'NlOne']);
  });

  it('lets org admins lower a project priority, and only staff raise it to high', async () => {
    const o = org('Pr Org');
    const p = project(o, 'PrProject', ['de']);
    await user('pradmin@pool.test', ['de'], {}, [o, 'admin']);
    const staff = await user('prstaff@pool.test', ['de']);
    run(db, 'UPDATE users SET is_staff = 1 WHERE id = ?', staff);
    const patch = (priority: string) => app.inject({ method: 'PATCH', url: `/api/v1/projects/${p}`, headers: as('pradmin@pool.test'), payload: { priority } });
    expect((await patch('high')).statusCode).toBe(403);
    expect((await patch('low')).json().project.priority).toBe('low');
    expect((await patch('urgent')).statusCode).toBe(400);
    const put = (email: string, priority: string) => app.inject({ method: 'PUT', url: `/api/v1/staff/projects/${p}/priority`, headers: as(email), payload: { priority } });
    expect((await put('pradmin@pool.test', 'low')).statusCode).toBe(403);
    expect((await put('prstaff@pool.test', 'high')).json().project.priority).toBe('high');
    expect((await app.inject({ url: `/api/v1/projects/${p}`, headers: as('pradmin@pool.test') })).json().project.priority).toBe('high');
    // The org can still lower what staff raised.
    expect((await patch('normal')).json().project.priority).toBe('normal');
  });
});
