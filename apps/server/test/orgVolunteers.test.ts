import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, run, type DB } from '../src/db.js';

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
