import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, openDb, run, type DB } from '../src/db.js';

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
async function user(locales: string[], org?: number, role: 'localizer' | 'reviewer' | 'admin' = 'localizer', name = `Vol${++n} Test`) {
  const email = `u${++n}@cp.test`;
  const id = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, name, pw, JSON.stringify(locales)).lastInsertRowid);
  if (org) addMembership(db, id, org, role);
  for (const l of locales) run(db, "INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, ?, 'trusted', 'test')", id, l);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  cookies[id] = `nl_sid=${res.cookies.find((x) => x.name === 'nl_sid')!.value}`;
  return id;
}
const as = (id: number) => ({ cookie: cookies[id] });
const org = (name = `Org ${++n}`) => Number(run(db, 'INSERT INTO orgs (name) VALUES (?)', name).lastInsertRowid);
function project(orgId: number, locales: string[], name = `Proj ${++n}`) {
  const id = Number(
    run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, review_mode, visibility, moderation) VALUES (?, ?, 'en', ?, 'standard', 'public', 'approved')", orgId, name, `cp_${++n}`).lastInsertRowid,
  );
  for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
  return id;
}
const key = (p: number, source = `Source ${++n}`) => Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', p, `k${++n}`, source).lastInsertRowid);

describe('schema', () => {
  it('rebuilds an old volunteer_messages table with its rows, so launch messages fit', () => {
    const path = join(dir, 'old-messages.db');
    const old = openDb(path);
    const u = Number(run(old, "INSERT INTO users (email, name, password_hash) VALUES ('m@cp.test', 'm', 'x')").lastInsertRowid);
    const o = Number(run(old, "INSERT INTO orgs (name) VALUES ('O')").lastInsertRowid);
    run(old, "INSERT INTO volunteer_messages (user_id, org_id, kind, body) VALUES (?, ?, 'thanks', 'Hi')", u, o);
    old.exec(`
      CREATE TABLE vm_old (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('thanks', 'favorite', 'approved_reviewer')), body TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, seen_at TEXT);
      INSERT INTO vm_old SELECT * FROM volunteer_messages; DROP TABLE volunteer_messages; ALTER TABLE vm_old RENAME TO volunteer_messages;`);
    old.close();
    const db2 = openDb(path);
    expect(all(db2, 'SELECT kind, body FROM volunteer_messages')).toEqual([{ kind: 'thanks', body: 'Hi' }]);
    run(db2, "INSERT INTO volunteer_messages (user_id, org_id, kind) VALUES (?, ?, 'launch')", u, o);
    expect(get(db2, "SELECT 1 AS y FROM sqlite_master WHERE name = 'volunteer_messages_user'")).toEqual({ y: 1 });
    expect(all<{ name: string }>(db2, 'PRAGMA table_info(volunteer_prefs)').map((c) => c.name)).toContain('show_on_leaderboards');
    db2.close();
  });
});
