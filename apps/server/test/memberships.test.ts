import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, openDb, run, type DB } from '../src/db.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const pw = hashPassword('pw-12345678');
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function signIn(app: FastifyInstance, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  expect(res.statusCode).toBe(200);
  return { cookie: `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}` };
}

describe('migrating a Segment 1 database', () => {
  let path: string;
  let ids: { org: number; admin: number; loc: number; project: number; key: number };

  beforeAll(() => {
    // A database exactly as Segment 1 left it: the schema from test/fixtures, with some data in it.
    path = join(tempDir(), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = ON;');
    old.exec(readFileSync(join(import.meta.dirname, 'fixtures/schema-segment-1.sql'), 'utf8'));
    const ins = (sql: string, ...p: (string | number)[]) => Number(old.prepare(sql).run(...p).lastInsertRowid);
    const org = ins("INSERT INTO orgs (name) VALUES ('Old Org')");
    const admin = ins("INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, 'admin@old.test', 'Admin', ?, 'admin', '[]')", org, pw);
    const loc = ins(`INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, 'loc@old.test', 'Loc', ?, 'localizer', '["es"]')`, org, pw);
    const project = ins("INSERT INTO projects (org_id, name, source_locale, bundle_token, peer_approvals) VALUES (?, 'Old App', 'en', 'pb_old', 2)", org);
    ins("INSERT INTO project_locales (project_id, locale) VALUES (?, 'es')", project);
    const key = ins("INSERT INTO keys (project_id, name, source) VALUES (?, 'hello', 'Hello')", project);
    ins("INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, 'es', 'Hola', 'review', ?)", key, loc);
    ins("INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, 'es', 'trusted', 'placement check')", loc);
    ins("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h', ?, 9999999999999)", loc);
    ins("INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status) VALUES (?, 'translate', ?, 'es', ?, 10, 'pending')", loc, key, project);
    old.close();
    ids = { org, admin, loc, project, key };
  });

  it('keeps every row and gives each user a membership with their org and role', () => {
    const db = openDb(path);
    try {
      expect(all(db, 'SELECT user_id, org_id, role FROM memberships ORDER BY user_id')).toEqual([
        { user_id: ids.admin, org_id: ids.org, role: 'admin' },
        { user_id: ids.loc, org_id: ids.org, role: 'localizer' },
      ]);
      expect(get(db, 'SELECT email, is_staff FROM users WHERE id = ?', ids.loc)).toEqual({ email: 'loc@old.test', is_staff: 0 });
      expect(get(db, 'SELECT text, status, updated_by FROM translations WHERE key_id = ?', ids.key)).toEqual({ text: 'Hola', status: 'review', updated_by: ids.loc });
      expect(get(db, 'SELECT COUNT(*) AS n FROM sessions')).toEqual({ n: 1 });
      expect(get(db, 'SELECT COUNT(*) AS n FROM xp_events')).toEqual({ n: 1 });
      expect(get(db, 'SELECT tier FROM user_languages WHERE user_id = ?', ids.loc)).toEqual({ tier: 'trusted' });
      // New columns with today's behavior as the default.
      expect(get(db, 'SELECT type, verification, ein FROM orgs')).toEqual({ type: 'small_org', verification: 'unverified', ein: null });
      expect(get(db, 'SELECT visibility, moderation, review_mode, peer_approvals FROM projects')).toEqual({ visibility: 'private', moderation: 'none', review_mode: 'standard', peer_approvals: 2 });
      expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
      expect(get(db, 'PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
      // Legacy columns stay but are optional now; 'ready' is allowed, nonsense isn't.
      const fresh = Number(run(db, "INSERT INTO users (email, name, password_hash) VALUES ('new@old.test', 'New', 'x')").lastInsertRowid);
      run(db, "UPDATE translations SET status = 'ready' WHERE key_id = ?", ids.key);
      expect(() => run(db, "UPDATE translations SET status = 'bogus' WHERE key_id = ?", ids.key)).toThrow(/CHECK/);
      // Foreign keys still point at the rebuilt tables.
      expect(() => run(db, "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h2', 999, 1)")).toThrow(/FOREIGN KEY/);
      run(db, "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h3', ?, 1)", fresh);
      run(db, 'DELETE FROM users WHERE id = ?', fresh);
      expect(get(db, 'SELECT COUNT(*) AS n FROM sessions')).toEqual({ n: 1 }); // ON DELETE CASCADE survived the rebuild
    } finally {
      db.close();
    }
  });

  it('runs once: reopening changes nothing, and a removed membership stays removed', () => {
    let db = openDb(path);
    run(db, 'DELETE FROM memberships WHERE user_id = ?', ids.admin);
    db.close();
    db = openDb(path);
    try {
      expect(all(db, 'SELECT user_id FROM memberships')).toEqual([{ user_id: ids.loc }]);
      expect(all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE name LIKE '%_new'")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('serves the migrated data to the same people as before', async () => {
    const path2 = join(tempDir(), 'old2.sqlite');
    const old = new DatabaseSync(path2);
    old.exec(readFileSync(join(import.meta.dirname, 'fixtures/schema-segment-1.sql'), 'utf8'));
    const org = Number(old.prepare("INSERT INTO orgs (name) VALUES ('Old Org')").run().lastInsertRowid);
    const other = Number(old.prepare("INSERT INTO orgs (name) VALUES ('Someone Else')").run().lastInsertRowid);
    old.prepare(`INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, 'rev@old.test', 'Rev', ?, 'reviewer', '["es"]')`).run(org, pw);
    const mine = Number(old.prepare("INSERT INTO projects (org_id, name, source_locale, bundle_token) VALUES (?, 'Mine', 'en', 'pb_m')").run(org).lastInsertRowid);
    const theirs = Number(old.prepare("INSERT INTO projects (org_id, name, source_locale, bundle_token) VALUES (?, 'Theirs', 'en', 'pb_t')").run(other).lastInsertRowid);
    old.prepare("INSERT INTO project_locales (project_id, locale) VALUES (?, 'es')").run(mine);
    old.close();

    const { app } = await buildApp({ dbPath: path2, dataDir: tempDir() });
    try {
      const rev = await signIn(app, 'rev@old.test');
      const me = (await app.inject({ url: '/api/v1/me', headers: rev })).json();
      expect(me.user.role).toBe('reviewer');
      expect(me.org).toMatchObject({ id: org, name: 'Old Org' });
      expect((await app.inject({ url: '/api/v1/projects', headers: rev })).json().projects.map((p: { name: string }) => p.name)).toEqual(['Mine']);
      expect((await app.inject({ url: `/api/v1/projects/${mine}`, headers: rev })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/v1/projects/${theirs}`, headers: rev })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('several orgs per user', () => {
  let app: FastifyInstance;
  let db: DB;
  const o = { a: 0, b: 0, c: 0 };
  const p = { a: 0, b: 0, c: 0 };
  let multi: { cookie: string };
  let loner: { cookie: string };
  let multiId: number;

  const project = (org: number, name: string) => {
    const id = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token) VALUES (?, ?, 'en', ?)", org, name, `pb_${name}`).lastInsertRowid);
    run(db, "INSERT INTO project_locales (project_id, locale) VALUES (?, 'es')", id);
    run(db, "INSERT INTO keys (project_id, name, source) VALUES (?, 'k', 'Hello')", id);
    return id;
  };
  const user = (email: string, locales: string[]) =>
    Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, email.split('@')[0], pw, JSON.stringify(locales)).lastInsertRowid);

  beforeAll(async () => {
    ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: tempDir() }));
    for (const k of ['a', 'b', 'c'] as const) {
      o[k] = Number(run(db, 'INSERT INTO orgs (name) VALUES (?)', `Org ${k.toUpperCase()}`).lastInsertRowid);
      p[k] = project(o[k], `proj-${k}`);
    }
    // Localizer in A (joined first), admin in B, nothing in C.
    multiId = user('multi@t.test', ['es']);
    addMembership(db, multiId, o.a, 'localizer');
    addMembership(db, multiId, o.b, 'admin');
    run(db, "INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, 'es', 'trusted', 'test')", multiId);
    addMembership(db, user('bee@t.test', ['es']), o.b, 'reviewer');
    user('loner@t.test', ['es']); // no memberships at all
    multi = await signIn(app, 'multi@t.test');
    loner = await signIn(app, 'loner@t.test');
  });
  afterAll(() => app.close());

  it('opens projects in every org the user belongs to, and no others', async () => {
    expect((await app.inject({ url: `/api/v1/projects/${p.a}`, headers: multi })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/projects/${p.b}`, headers: multi })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/projects/${p.c}`, headers: multi })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/projects/${p.c}/keys`, headers: multi })).statusCode).toBe(404);
  });

  it('applies the role from the project’s org', async () => {
    const rename = (id: number) => app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}`, headers: multi, payload: { name: `renamed-${id}` } });
    expect((await rename(p.b)).statusCode).toBe(200); // admin in B
    expect((await rename(p.a)).statusCode).toBe(403); // localizer in A
    const keyA = get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ?', p.a)!.id;
    const save = await app.inject({ method: 'PUT', url: `/api/v1/translations/${keyA}/es`, headers: multi, payload: { text: 'Hola' } });
    expect(save.json().status).toBe('review'); // a localizer's text waits for review in A
  });

  it('gives nobody without a membership any project', async () => {
    expect((await app.inject({ url: `/api/v1/projects/${p.a}`, headers: loner })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/projects', headers: loner })).json()).toEqual({ projects: [] });
    expect((await app.inject({ url: '/api/v1/volunteer/session', headers: loner })).json()).toEqual({ cards: [], empty: 'nothing_to_do' });
    expect((await app.inject({ url: '/api/v1/users', headers: loner })).statusCode).toBe(403);
    const me = (await app.inject({ url: '/api/v1/me', headers: loner })).json();
    expect(me).toMatchObject({ org: null, orgs: [], user: { role: null, isStaff: false } });
  });

  it('lists every org in /me and switches the current one', async () => {
    let me = (await app.inject({ url: '/api/v1/me', headers: multi })).json();
    expect(me.orgs.map((x: { id: number; role: string }) => [x.id, x.role])).toEqual([
      [o.a, 'localizer'],
      [o.b, 'admin'],
    ]);
    expect(me.org).toMatchObject({ id: o.a, type: 'small_org', verification: 'unverified' });
    expect(me.user.role).toBe('localizer');
    expect((await app.inject({ url: '/api/v1/users', headers: multi })).statusCode).toBe(403); // not an admin of A

    me = (await app.inject({ method: 'PUT', url: '/api/v1/me/org', headers: multi, payload: { orgId: o.b } })).json();
    expect(me.org.id).toBe(o.b);
    expect(me.user.role).toBe('admin');
    expect((await app.inject({ url: '/api/v1/projects', headers: multi })).json().projects.map((x: { id: number }) => x.id)).toEqual([p.b]);
    const team = (await app.inject({ url: '/api/v1/users', headers: multi })).json().users;
    expect(team.map((u: { email: string; role: string }) => `${u.email} ${u.role}`).sort()).toEqual(['bee@t.test reviewer', 'multi@t.test admin']);

    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/org', headers: multi, payload: { orgId: o.c } })).statusCode).toBe(404);
    // Leaving the current org falls back to the first one left.
    run(db, 'DELETE FROM memberships WHERE user_id = ? AND org_id = ?', multiId, o.b);
    expect((await app.inject({ url: '/api/v1/me', headers: multi })).json().org.id).toBe(o.a);
    addMembership(db, multiId, o.b, 'admin');
  });

  it('builds volunteer sessions from every org the user belongs to', async () => {
    run(db, "INSERT INTO keys (project_id, name, source) VALUES (?, 'k2', 'Goodbye')", p.a); // A's first string is in review now
    const { cards } = (await app.inject({ url: '/api/v1/volunteer/session?size=10', headers: multi })).json();
    expect([...new Set(cards.map((c: { project: { id: number } }) => c.project.id))].sort()).toEqual([p.a, p.b].sort());
  });

  it('turns an invite into a membership of the inviting org', async () => {
    await app.inject({ method: 'PUT', url: '/api/v1/me/org', headers: multi, payload: { orgId: o.b } });
    const { token } = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: multi, payload: { role: 'reviewer', locales: ['fr'] } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, payload: { name: 'Newbie', email: 'newbie@t.test', password: 'pw-12345678' } });
    expect(res.json().user).toMatchObject({ role: 'reviewer', locales: ['fr'] });
    const id = get<{ id: number }>(db, "SELECT id FROM users WHERE email = 'newbie@t.test'")!.id;
    expect(all(db, 'SELECT org_id, role FROM memberships WHERE user_id = ?', id)).toEqual([{ org_id: o.b, role: 'reviewer' }]);
  });

  it('reports staff in /me', async () => {
    expect((await app.inject({ url: '/api/v1/me', headers: multi })).json().user.isStaff).toBe(false);
    run(db, 'UPDATE users SET is_staff = 1 WHERE id = ?', multiId);
    expect((await app.inject({ url: '/api/v1/me', headers: multi })).json().user.isStaff).toBe(true);
  });
});
