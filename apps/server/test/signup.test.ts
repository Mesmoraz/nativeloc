import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, run, type DB } from '../src/db.js';
import { setMailer, type OutgoingEmail } from '../src/signup/mailer.js';
import { ensurePlatformOrg } from '../src/signup/platform.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
let legacyOrg: number;
const cookies: Record<string, string> = {};
const sent: OutgoingEmail[] = [];
const pw = 'pw-12345678';

const as = (email: string) => ({ cookie: cookies[email] });
const keep = (email: string, res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === 'nl_sid');
  if (c) cookies[email] = `nl_sid=${c.value}`;
};
const lastLink = (email: string) => /token=([\w-]+)/.exec([...sent].reverse().find((m) => m.to === email)!.body)![1];
const userId = (email: string) => get<{ id: number }>(db, 'SELECT id FROM users WHERE email = ?', email)!.id;

async function signup(email: string, name = email.split('@')[0]) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name, email, password: pw } });
  keep(email, res);
  return res;
}
async function verify(email: string) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token: lastLink(email) } });
}
async function login(email: string) {
  keep(email, await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: pw } }));
}
const me = async (email: string) => (await app.inject({ url: '/api/v1/me', headers: as(email) })).json();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
  setMailer({ name: 'test', send: async (m) => void sent.push(m) });
  // An org from before open sign-up, with an admin and a project in Spanish and French.
  legacyOrg = Number(run(db, "INSERT INTO orgs (name) VALUES ('Old Pantry')").lastInsertRowid);
  const admin = Number(run(db, "INSERT INTO users (email, name, password_hash) VALUES ('boss@t.test', 'Boss', ?)", hashPassword(pw)).lastInsertRowid);
  addMembership(db, admin, legacyOrg, 'admin');
  await login('boss@t.test');
  await app.inject({ method: 'POST', url: '/api/v1/projects', headers: as('boss@t.test'), payload: { name: 'Pantry', sourceLocale: 'en', locales: ['es', 'fr'] } });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sign-up and email verification', () => {
  it('creates an account with no org, signs it in and emails a confirmation link', async () => {
    const res = await signup('ana@t.test', 'Ana Ruiz');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ name: 'Ana Ruiz', role: null, locales: [], tiers: {}, emailVerified: false, isStaff: false });
    expect(await me('ana@t.test')).toMatchObject({ org: null, orgs: [] });
    expect(sent.at(-1)).toMatchObject({ to: 'ana@t.test', subject: expect.stringMatching(/confirm/i) });
    expect(get(db, "SELECT sent_at IS NOT NULL AS sent, provider FROM outbox WHERE to_email = 'ana@t.test'")).toEqual({ sent: 1, provider: 'test' });
    expect((await signup('ANA@t.test')).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name: 'X', email: 'x@t.test', password: 'short' } })).statusCode).toBe(400);
  });

  it('blocks posting until the email is confirmed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/orgs', headers: as('ana@t.test'), payload: { type: 'individual' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/confirm your email/i);
  });

  it('rate-limits resending', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/resend-verification', headers: as('ana@t.test') });
    expect(res.statusCode).toBe(429); // the sign-up email went out seconds ago
    run(db, "UPDATE outbox SET created_at = datetime('now', '-2 minutes') WHERE to_email = 'ana@t.test'");
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/resend-verification', headers: as('ana@t.test') })).json()).toEqual({ ok: true });
  });

  it('confirms the email once per link', async () => {
    const token = lastLink('ana@t.test');
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token } });
    expect(res.json().user).toMatchObject({ email: 'ana@t.test', emailVerified: true });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token: 'ev_nope' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/resend-verification', headers: as('ana@t.test') })).statusCode).toBe(409);
  });

  it('lets people pick languages in settings, starting at new', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: as('ana@t.test'), payload: { name: 'Ana R.', locales: ['es', 'pt-BR'] } });
    expect(res.json().user).toMatchObject({ name: 'Ana R.', locales: ['es', 'pt-BR'], tiers: { es: 'new', 'pt-BR': 'new' } });
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: as('ana@t.test'), payload: { locales: ['nope!'] } })).statusCode).toBe(400);
  });
});

describe('creating an org ("Get translation")', () => {
  beforeAll(async () => {
    for (const e of ['np@t.test', 'biz@t.test']) {
      await signup(e);
      await verify(e);
    }
  });

  it('makes a self-serve requester the admin of their nonprofit, still new in every language', async () => {
    await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: as('np@t.test'), payload: { locales: ['es', 'fr', 'ja'] } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: as('np@t.test'),
      payload: { type: 'nonprofit', name: 'Eastside Food Bank', ein: '12-3456789', state: 'or', website: 'https://eastside.example', description: 'Groceries' },
    });
    expect(res.json()).toMatchObject({
      org: { name: 'Eastside Food Bank', type: 'nonprofit', verification: 'pending', role: 'admin', ein: '123456789', state: 'OR' },
      waitlisted: false,
    });
    const after = await me('np@t.test');
    expect(after.org).toMatchObject({ id: res.json().org.id, role: 'admin' });
    // Contract risk 1: owning an org vouches for nothing.
    expect(after.user.tiers).toEqual({ es: 'new', fr: 'new', ja: 'new' });
    expect(all(db, "SELECT tier FROM user_languages WHERE user_id = ? AND tier != 'new'", userId('np@t.test'))).toEqual([]);
  });

  it('validates the form', async () => {
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/v1/orgs', headers: as('np@t.test'), payload });
    expect((await post({ type: 'charity', name: 'X' })).statusCode).toBe(400);
    expect((await post({ type: 'nonprofit', name: 'X', ein: '123' })).statusCode).toBe(400);
    expect((await post({ type: 'nonprofit', name: 'X', state: 'Oregon' })).statusCode).toBe(400);
    expect((await post({ type: 'small_org' })).statusCode).toBe(400);
    expect((await post({ type: 'small_org', name: 'X', ein: '12-3456789' })).statusCode).toBe(400);
  });

  it('re-checks verification when the EIN, name or state changes (2B matches the IRS list)', async () => {
    const org = (await me('np@t.test')).org;
    run(db, "INSERT INTO eo_bmf (ein, name, city, state) VALUES ('987654321', 'EASTSIDE FOOD BANK INC', 'PORTLAND', 'OR')");
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/orgs/${org.id}`, headers: as('np@t.test'), payload: { ein: '98-7654321' } });
    expect(res.json().org).toMatchObject({ ein: '987654321', verification: 'verified' });
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/orgs/${org.id}`, headers: as('np@t.test'), payload: { type: 'business' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/orgs/${org.id}`, headers: as('ana@t.test'), payload: { name: 'Mine' } })).statusCode).toBe(404);
  });

  it('gives individuals a personal org named after them, once', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/orgs', headers: as('ana@t.test'), payload: { type: 'individual' } });
    expect(res.json()).toMatchObject({ org: { name: 'Ana R.', type: 'individual', verification: 'unverified', role: 'admin' }, waitlisted: false });
    expect((await app.inject({ method: 'POST', url: '/api/v1/orgs', headers: as('ana@t.test'), payload: { type: 'individual' } })).statusCode).toBe(409);
    expect((await me('ana@t.test')).user.tiers).toEqual({ es: 'new', 'pt-BR': 'new' });
  });

  it('puts businesses on the waitlist: they cannot post', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/orgs', headers: as('biz@t.test'), payload: { type: 'business', name: 'Acme Corp' } });
    expect(res.json()).toMatchObject({ org: { type: 'business' }, waitlisted: true });
    const project = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token) VALUES (?, 'Shop', 'en', 'pb_biz')", res.json().org.id).lastInsertRowid);
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${project}`, headers: as('biz@t.test'), payload: { name: 'Shop 2' } });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error).toMatch(/waitlist/);
  });
});

describe('invites and join links with an existing account', () => {
  it('adds a second org through an invite, and only orgs that may vouch raise trust', async () => {
    // Ana (self-serve, es new) is invited to the legacy org as a reviewer for French: it vouches.
    let token = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: as('boss@t.test'), payload: { role: 'reviewer', locales: ['fr'] } })).json().token;
    let res = await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: as('ana@t.test') });
    expect(res.json().user).toMatchObject({ email: 'ana@t.test', role: 'reviewer', tiers: { es: 'new', fr: 'lead' } });
    const ana = await me('ana@t.test');
    expect(ana.orgs.map((o: { name: string }) => o.name).sort()).toEqual(['Ana R.', 'Old Pantry']);
    expect(ana.org.name).toBe('Old Pantry'); // the invite's org becomes current
    expect((await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: as('ana@t.test') })).statusCode).toBe(404);

    // The requester's own unverified org invites a second account as a reviewer: no vouch, still new.
    token = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: as('biz@t.test'), payload: { role: 'reviewer', locales: ['es'], email: 'sock@t.test' } })).json().token;
    res = await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, payload: { name: 'Sock', password: pw } });
    expect(res.json().user).toMatchObject({ role: 'reviewer', tiers: { es: 'new' }, emailVerified: true });
  });

  it('refuses an invite addressed to someone else', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: as('boss@t.test'), payload: { email: 'other@t.test' } })).json();
    expect((await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: as('np@t.test') })).statusCode).toBe(403);
  });

  it('joins another org from a join link as a localizer', async () => {
    const { code } = (await app.inject({ method: 'POST', url: '/api/v1/join-links', headers: as('boss@t.test'), payload: { locales: ['es'] } })).json().link;
    expect((await app.inject({ url: `/api/v1/join/${code}`, headers: as('np@t.test') })).json()).toMatchObject({ me: { email: 'np@t.test' }, member: false });
    const res = await app.inject({ method: 'POST', url: `/api/v1/join/${code}`, headers: as('np@t.test'), payload: { locales: ['es'] } });
    expect(res.json().user).toMatchObject({ role: 'localizer', tiers: { es: 'new' } });
    expect((await me('np@t.test')).orgs).toHaveLength(2);
  });

  it('makes new join-link accounts confirm their email before translating', async () => {
    const { code } = (await app.inject({ method: 'POST', url: '/api/v1/join-links', headers: as('boss@t.test'), payload: { locales: ['es'] } })).json().link;
    const res = await app.inject({ method: 'POST', url: `/api/v1/join/${code}`, payload: { name: 'Vol', email: 'vol@t.test', password: pw, locales: ['es'] } });
    keep('vol@t.test', res);
    expect(res.json().user.emailVerified).toBe(false);
    const project = get<{ id: number }>(db, "SELECT id FROM projects WHERE name = 'Pantry'")!.id;
    const key = (await app.inject({ method: 'POST', url: `/api/v1/projects/${project}/keys`, headers: as('boss@t.test'), payload: { entries: [{ key: 'hi', source: 'Hi' }] } })).json();
    expect(key.created).toBe(1);
    const keyId = get<{ id: number }>(db, "SELECT id FROM keys WHERE name = 'hi'")!.id;
    const put = () => app.inject({ method: 'PUT', url: `/api/v1/translations/${keyId}/es`, headers: as('vol@t.test'), payload: { text: 'Hola' } });
    expect((await put()).statusCode).toBe(403);
    await verify('vol@t.test');
    expect((await put()).statusCode).toBe(200);
  });
});

describe('admins and people who help several orgs (risk 3)', () => {
  it('cannot remove languages or lower tiers of someone who is a member elsewhere', async () => {
    const ana = userId('ana@t.test');
    let res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${ana}`, headers: as('boss@t.test'), payload: { locales: ['fr'] } });
    expect(res.statusCode).toBe(403);
    res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${ana}`, headers: as('boss@t.test'), payload: { tiers: { fr: 'new' } } });
    expect(res.statusCode).toBe(403);
    // Raising is a vouch, which a legacy org may give.
    res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${ana}`, headers: as('boss@t.test'), payload: { tiers: { es: 'trusted' } } });
    expect(res.json().user.tiers).toMatchObject({ es: 'trusted', fr: 'lead' });
  });

  it("doesn't let an unverified self-serve org place anyone", async () => {
    const sock = userId('sock@t.test');
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${sock}`, headers: as('biz@t.test'), payload: { tiers: { es: 'lead' } } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/users/${sock}`, headers: as('biz@t.test'), payload: { locales: ['es', 'de'] } })).json().user.tiers).toEqual({ es: 'new', de: 'new' });
  });
});

describe('platform-wide placement check (risk 2)', () => {
  let attemptId: number;

  beforeAll(async () => {
    const platform = ensurePlatformOrg(db);
    const staff = Number(run(db, "INSERT INTO users (email, name, password_hash, locales, is_staff) VALUES ('staff@t.test', 'Staff', ?, '[\"pt-BR\"]', 1)", hashPassword(pw)).lastInsertRowid);
    addMembership(db, staff, platform, 'admin');
    await login('staff@t.test');
    const add = (body: object) => app.inject({ method: 'POST', url: '/api/v1/placement-items', headers: as('staff@t.test'), payload: { locale: 'pt-BR', ...body } });
    await add({ kind: 'translate', source: 'Open on Mondays.', reference: 'Aberto às segundas.' });
    await add({ kind: 'review', source: 'Free food.', candidate: 'Comida grátis.' });
  });

  it('falls back to the platform set when the current org has none', async () => {
    // Ana works in Old Pantry, which has no pt-BR check; a volunteer with no org would see the same.
    await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: as('ana@t.test'), payload: { locales: ['es', 'fr', 'pt-BR'] } });
    expect((await app.inject({ url: '/api/v1/placement/pt-BR', headers: as('ana@t.test') })).json()).toMatchObject({ available: true, questions: 2, tier: 'new' });
    const attempt = (await app.inject({ method: 'POST', url: '/api/v1/placement/pt-BR/start', headers: as('ana@t.test') })).json().attempt;
    attemptId = attempt.id;
    const answers = attempt.items.map((i: { itemId: number; kind: string }) => (i.kind === 'translate' ? { itemId: i.itemId, text: 'Aberto às segundas.' } : { itemId: i.itemId, verdict: 'ok' }));
    expect((await app.inject({ method: 'POST', url: `/api/v1/placement/attempts/${attemptId}/submit`, headers: as('ana@t.test'), payload: { answers } })).json()).toEqual({ status: 'submitted' });
  });

  it('is graded by the platform org, not the volunteer’s own orgs', async () => {
    expect((await app.inject({ url: '/api/v1/placement-grading', headers: as('boss@t.test') })).json().attempts).toEqual([]);
    const queue = (await app.inject({ url: '/api/v1/placement-grading', headers: as('staff@t.test') })).json().attempts;
    expect(queue.map((a: { id: number }) => a.id)).toEqual([attemptId]);
    const grades = queue[0].translations.map((t: { itemId: number }) => ({ itemId: t.itemId, pass: true }));
    const res = await app.inject({ method: 'POST', url: `/api/v1/placement/attempts/${attemptId}/grade`, headers: as('staff@t.test'), payload: { grades } });
    expect(res.json().status).toBe('passed');
    expect((await me('ana@t.test')).user.tiers['pt-BR']).toBe('trusted');
  });
});
