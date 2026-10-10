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
  it('draws from the pool and member projects only, urgent first, then verified nonprofits, then community orgs', async () => {
    const s = await session('vol@pool.test', '&nonprofitsOnly=0');
    const names = s.cards.map((c: C) => c.project.name);
    expect(new Set(names)).toEqual(new Set(['Community', 'Nonprofit', 'Claimed', 'Home']));
    expect(s.cards[0].item.keyId).toBe(ids.urgent);
    const translate = s.cards.filter((c: C) => c.type === 'translate').map((c: C) => c.project.name);
    expect(translate.slice(1)).toEqual(['Nonprofit', 'Community', 'Claimed', 'Home']);
    expect(s.cards.find((c: C) => c.project.name === 'Nonprofit').org).toEqual({ id: expect.any(Number), name: 'Food Bank', type: 'nonprofit', verified: true, description: 'About Food Bank' });
    expect(s.cards.find((c: C) => c.project.name === 'Claimed').org.verified).toBe(false);
  });

  it('filters to verified nonprofits and remembers the choice', async () => {
    const only = (s: { cards: C[] }) => [...new Set(s.cards.map((c) => c.org.name))];
    expect(only(await session('vol@pool.test', '&nonprofitsOnly=1'))).toEqual(['Food Bank']);
    expect(only(await session('vol@pool.test'))).toEqual(['Food Bank']);
    // With 2B and 2C merged, both card actions are offered.
    expect((await app.inject({ url: '/api/v1/volunteer/settings', headers: as('vol@pool.test') })).json()).toMatchObject({ nonprofitsOnly: true, actions: { flag: true, report: true } });
    await app.inject({ method: 'PUT', url: '/api/v1/volunteer/settings', headers: as('vol@pool.test'), payload: { nonprofitsOnly: false } });
    expect(only(await session('vol@pool.test')).length).toBeGreaterThan(1);
  });

  it('deals Review cards only where reviewRight allows', async () => {
    const reviews = (s: { cards: C[] }) => s.cards.filter((c) => c.type === 'review').map((c) => c.item.keyId);
    expect(reviews(await session('vol@pool.test'))).toEqual([ids.reviewKey]); // trusted, peer-review project
    expect(reviews(await session('newbie@pool.test'))).toEqual([]);
  });

  it("gives a requester-admin with no trust rows no Review cards, and won't let them approve public work", async () => {
    const s = await session('requester@pool.test');
    expect(s.cards.length).toBeGreaterThan(0);
    expect(s.cards.filter((c: C) => c.type === 'review')).toEqual([]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/translations/${ids.reviewKey}/es/approve`, headers: as('requester@pool.test') });
    expect(res.statusCode).toBe(403);
  });
});
