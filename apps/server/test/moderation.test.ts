import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, get, run, type DB, type OrgRow, type ProjectRow } from '../src/db.js';
import { importEoBmfSync } from '../src/moderation/eobmf.js';
import { screenProject, screenText } from '../src/moderation/screen.js';
import { startVerification } from '../src/moderation/verify.js';

const SAMPLE = join(import.meta.dirname, '../scripts/fixtures/eo-bmf-sample.csv');
const pw = hashPassword('pw-12345678');
let dir: string;
let app: FastifyInstance;
let db: DB;
const cookies: Record<string, string> = {};

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  expect(res.statusCode).toBe(200);
  return `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
}
const call = (who: string | null, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: who ? { cookie: cookies[who] } : {} });

const userId = (email: string) => get<{ id: number }>(db, 'SELECT id FROM users WHERE email = ?', email)!.id;
const addUser = (email: string, staff = 0) => run(db, 'INSERT INTO users (email, name, password_hash, is_staff) VALUES (?, ?, ?, ?)', email, email.split('@')[0], pw, staff);
function org(name: string, over: { type?: string; ein?: string | null; state?: string | null } = {}) {
  const id = Number(run(db, 'INSERT INTO orgs (name, type, ein, state) VALUES (?, ?, ?, ?)', name, over.type ?? 'nonprofit', over.ein ?? null, over.state ?? null).lastInsertRowid);
  return get<OrgRow>(db, 'SELECT id, name, type, verification, ein, website, description FROM orgs WHERE id = ?', id)!;
}
function project(orgId: number, name: string, sources: string[], moderation = 'pending') {
  const id = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, visibility, moderation) VALUES (?, ?, 'en', ?, 'public', ?)", orgId, name, `pb_${name}`, moderation).lastInsertRowid);
  sources.forEach((s, i) => run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', id, `k${i}`, s));
  return get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!;
}
const moderationOf = (id: number) => get<{ moderation: string }>(db, 'SELECT moderation FROM projects WHERE id = ?', id)!.moderation;
const inQueue = (queue: { projects: { project: { id: number } }[] }, id: number) => queue.projects.some((x) => x.project.id === id);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-mod-'));
  ({ app, db } = await buildApp({ dbPath: join(dir, 't.sqlite'), dataDir: dir }));
  importEoBmfSync(db, SAMPLE);
  addUser('staff@t.test', 1);
  for (const n of ['plain', 'v1', 'v2', 'v3', 'v4']) addUser(`${n}@t.test`);
  for (const e of ['staff', 'plain', 'v1', 'v2', 'v3', 'v4']) cookies[e] = await signIn(`${e}@t.test`);
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('EIN matching', () => {
  it('looks an EIN up, dashes or not', async () => {
    const res = await call(null, 'GET', '/api/v1/orgs/ein/12-3456789');
    expect(res.json()).toEqual({ match: { ein: '123456789', name: 'EASTSIDE FOOD BANK INC', city: 'PORTLAND', state: 'OR' } });
    expect((await call(null, 'GET', '/api/v1/orgs/ein/000000000')).json()).toEqual({ match: null });
    expect((await call(null, 'GET', '/api/v1/orgs/ein/12-34')).statusCode).toBe(400);
  });

  it('verifies on EIN + name + state', () => {
    const o = org('Eastside Food Bank', { ein: '12-3456789', state: 'or' });
    expect(startVerification(db, o)).toBe('verified');
    expect(get<{ verification: string }>(db, 'SELECT verification FROM orgs WHERE id = ?', o.id)!.verification).toBe('verified');
  });

  it('matches the IRS secondary name and ignores punctuation', () => {
    expect(startVerification(db, org('Hope Literacy', { ein: '987654321', state: 'TX' }))).toBe('verified');
    expect(startVerification(db, org('Hope, Literacy & Learning Center', { ein: '987654321', state: 'TX' }))).toBe('verified');
  });

  it('sends everything else to the staff queue', () => {
    expect(startVerification(db, org('Eastside Food Bank', { ein: '123456789', state: 'WA' }))).toBe('pending'); // wrong state
    expect(startVerification(db, org('Eastside Food Bank', { ein: '123456789' }))).toBe('pending'); // no state
    expect(startVerification(db, org('Westside Pantry', { ein: '123456789', state: 'OR' }))).toBe('pending'); // other name
    expect(startVerification(db, org('Ghost Charity', { ein: '111222333', state: 'OR' }))).toBe('pending'); // not listed
    expect(startVerification(db, org('No EIN Group'))).toBe('pending');
  });

  it('leaves non-nonprofits alone', () => {
    expect(startVerification(db, org('Corner Cafe', { type: 'business', ein: '123456789', state: 'OR' }))).toBe('unverified');
  });
});

describe('automatic screen', () => {
  it('approves plain content', () => {
    expect(screenText(['We are open Monday to Friday.', 'Call us for delivery.', 'Find us at 100 Main Street.'])).toEqual({ decision: 'approved', reasons: [] });
  });

  it.each([
    [['Buy now and save!'], 'commercial wording'],
    [['Lunch is $9.99 today.'], 'mentions prices'],
    [['Call 503-555-0100.', 'Or 503-555-0101.', 'Or 503-555-0102.'], '3 phone numbers'],
    [['Visit https://a.example', 'or https://b.example', 'or https://c.example'], '3 links'],
    [['Play at our casino tonight.'], 'blocked words'],
    [[], 'no text'],
  ])('holds %j', (sources, reason) => {
    const r = screenText(sources);
    expect(r.decision).toBe('pending');
    expect(r.reasons.join('; ')).toContain(reason);
  });

  it('lets a donation amount through', () => {
    expect(screenText(['Donate $25 to feed a family.']).decision).toBe('approved');
  });

  it('screenProject reads the project text and records the result', () => {
    const o = org('Screen Org');
    expect(screenProject(db, project(o.id, 'clean', ['Open Monday to Friday.'])).decision).toBe('approved');
    const shop = project(o.id, 'shop', ['Checkout now: add to cart for $5.']);
    const r = screenProject(db, shop);
    expect(r.decision).toBe('pending');
    expect(JSON.parse(get<{ reasons: string }>(db, 'SELECT reasons FROM moderation_screens WHERE project_id = ? ORDER BY id DESC', shop.id)!.reasons)).toEqual(r.reasons);
  });
});

describe('reports', () => {
  it('three different reporters pause an approved project', async () => {
    const o = org('Report Org');
    const p = project(o.id, 'reported', ['Hello.', 'World.'], 'approved');
    for (const v of ['v1', 'v2', 'v3']) addMembership(db, userId(`${v}@t.test`), o.id, 'localizer');
    const key = get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ?', p.id)!.id;
    const report = (who: string) => call(who, 'POST', '/api/v1/reports', { projectId: p.id, keyId: key, reason: 'commercial', note: 'Coupon codes' });

    expect((await report('v1')).json()).toEqual({ ok: true, paused: false });
    expect((await report('v1')).json()).toEqual({ ok: true, paused: false }); // the same person twice counts once
    expect((await report('v2')).json()).toEqual({ ok: true, paused: false });
    expect(moderationOf(p.id)).toBe('approved');
    expect((await report('v3')).json()).toEqual({ ok: true, paused: true });
    expect(moderationOf(p.id)).toBe('pending');

    const queue = (await call('staff', 'GET', '/api/v1/staff/moderation')).json();
    const item = queue.projects.find((x: { project: { id: number } }) => x.project.id === p.id);
    expect(item.reports).toEqual([{ reason: 'commercial', count: 3 }]);
    expect(item.sample[0]).toBe('Hello.');
  });

  it('rejects bad reasons and outsiders', async () => {
    const o = org('Private Org');
    const p = project(o.id, 'private', ['Hi.'], 'approved');
    expect((await call('v4', 'POST', '/api/v1/reports', { projectId: p.id, reason: 'spam' })).statusCode).toBe(404);
    addMembership(db, userId('v4@t.test'), o.id, 'localizer');
    expect((await call('v4', 'POST', '/api/v1/reports', { projectId: p.id, reason: 'nope' })).statusCode).toBe(400);
    expect((await call(null, 'POST', '/api/v1/reports', { projectId: p.id, reason: 'spam' })).statusCode).toBe(401);
  });
});

describe('staff endpoints', () => {
  it('are for staff only', async () => {
    const calls: ['GET' | 'POST', string][] = [
      ['GET', '/api/v1/staff/verifications'],
      ['POST', '/api/v1/staff/verifications/1'],
      ['GET', '/api/v1/staff/moderation'],
      ['POST', '/api/v1/staff/moderation/1'],
    ];
    for (const [method, url] of calls) {
      expect((await call('plain', method, url, { decision: 'verified' })).statusCode, `${method} ${url}`).toBe(403);
      expect((await call(null, method, url, { decision: 'verified' })).statusCode, `${method} ${url} signed out`).toBe(401);
    }
  });

  it('lists and decides verifications', async () => {
    const o = org('Pending Pantry', { ein: '123456789' });
    startVerification(db, o);
    const list = (await call('staff', 'GET', '/api/v1/staff/verifications')).json();
    const item = list.orgs.find((x: { org: { id: number } }) => x.org.id === o.id);
    expect(item.org.verification).toBe('pending');
    expect(item.match.name).toBe('EASTSIDE FOOD BANK INC');
    const res = await call('staff', 'POST', `/api/v1/staff/verifications/${o.id}`, { decision: 'verified', note: 'Matched by phone' });
    expect(res.json().org).toMatchObject({ id: o.id, verification: 'verified' });
    expect((await call('staff', 'POST', `/api/v1/staff/verifications/${o.id}`, { decision: 'maybe' })).statusCode).toBe(400);
    const after = (await call('staff', 'GET', '/api/v1/staff/verifications')).json();
    expect(after.orgs.some((x: { org: { id: number } }) => x.org.id === o.id)).toBe(false);
  });

  it('approves, rejects and asks for changes', async () => {
    const p = project(org('Mod Org').id, 'queue', ['Hello.']);
    expect(inQueue((await call('staff', 'GET', '/api/v1/staff/moderation')).json(), p.id)).toBe(true);

    const url = `/api/v1/staff/moderation/${p.id}`;
    expect((await call('staff', 'POST', url, { decision: 'changes' })).statusCode).toBe(400); // needs a reason
    expect((await call('staff', 'POST', url, { decision: 'changes', reason: 'Remove the prices on page 2' })).json()).toEqual({ project: { id: p.id, moderation: 'rejected' } });
    expect((await call('staff', 'POST', url, { decision: 'rejected', reason: 'Spam' })).json().project.moderation).toBe('rejected');
    expect((await call('staff', 'POST', url, { decision: 'approved' })).json().project.moderation).toBe('approved');
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM moderation_decisions WHERE project_id = ?', p.id)!.n).toBe(3);
    expect(inQueue((await call('staff', 'GET', '/api/v1/staff/moderation')).json(), p.id)).toBe(false);
  });
});
