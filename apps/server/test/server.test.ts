import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword, sha256 } from '../src/auth.js';
import { run, type DB } from '../src/db.js';

let app: FastifyInstance;
let db: DB;
let dir: string;
let projectId: number;
const TOKEN = 'nl_test_push';
const cookies: Record<string, string> = {};

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((x) => x.name === 'nl_sid')!;
  cookies[email] = `nl_sid=${c.value}`;
}
const as = (email: string) => ({ cookie: cookies[email] });
const bearer = { authorization: `Bearer ${TOKEN}` };

function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
  const boundary = '----nltest';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function tinyPng(width: number, height: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
  const org = Number(run(db, "INSERT INTO orgs (name) VALUES ('Test')").lastInsertRowid);
  const pw = hashPassword('pw-12345678');
  run(db, "INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, 'admin@t.test', 'Admin', ?, 'admin', '[]')", org, pw);
  run(db, `INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, 'loc@t.test', 'Loc', ?, 'localizer', '["es"]')`, org, pw);
  run(db, `INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, 'rev@t.test', 'Rev', ?, 'reviewer', '["es"]')`, org, pw);
  await login('admin@t.test');
  await login('loc@t.test');
  await login('rev@t.test');

  const res = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: as('admin@t.test'), payload: { name: 'Kiosk', sourceLocale: 'en', locales: ['es', 'ja'] } });
  projectId = res.json().project.id;
  run(db, 'INSERT INTO api_tokens (project_id, name, token_hash, scopes) VALUES (?, ?, ?, ?)', projectId, 'ci', sha256(TOKEN), '["push"]');
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('end to end', () => {
  it('ingests source strings with an API token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/keys`,
      headers: bearer,
      payload: {
        entries: [
          { key: 'greeting', source: 'Hello {name}!', description: 'Home screen', maxLength: 20 },
          { key: 'items', source: '{count, plural, one {# item} other {# items}}' },
          { key: 'checkout', source: 'Checkout' },
        ],
      },
    });
    expect(res.json()).toMatchObject({ created: 3 });
  });

  it('imports an Android file through the upload endpoint', async () => {
    const m = multipart({}, { name: 'strings.xml', type: 'text/xml', data: Buffer.from('<resources><string name="yes">Yes</string></resources>') });
    const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/import`, headers: { ...bearer, ...m.headers }, payload: m.payload });
    expect(res.json()).toMatchObject({ created: 1 });
  });

  it('attaches screenshots with pixel boxes', async () => {
    const m = multipart({ label: 'Home', keys: JSON.stringify([{ key: 'greeting', x: 100, y: 50, w: 200, h: 40 }, { key: 'nope' }]) }, { name: 'home.png', type: 'image/png', data: tinyPng(1000, 500) });
    const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/screenshots`, headers: { ...bearer, ...m.headers }, payload: m.payload });
    expect(res.json()).toMatchObject({ width: 1000, height: 500, missingKeys: ['nope'] });
  });

  it('keeps localizers to their languages', async () => {
    const res = await app.inject({ url: `/api/v1/projects/${projectId}/queue?locale=ja`, headers: as('loc@t.test') });
    expect(res.statusCode).toBe(403);
  });

  it('serves a localizer queue with context', async () => {
    const res = await app.inject({ url: `/api/v1/projects/${projectId}/queue?locale=es`, headers: as('loc@t.test') });
    const body = res.json();
    expect(body.items[0]).toMatchObject({ key: 'greeting', placeholders: [{ token: '{name}' }], screenshot: { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.08 } } });
    const items = body.items.find((i: { key: string }) => i.key === 'items');
    expect(Object.keys(items.template.forms)).toEqual(['one', 'many', 'other']);
    expect(body.progress).toMatchObject({ total: 4, todo: 4 });
  });

  it('rejects broken placeholders in plain language', async () => {
    const keyId = db.prepare("SELECT id FROM keys WHERE name = 'greeting'").get()!.id;
    const res = await app.inject({ method: 'PUT', url: `/api/v1/translations/${keyId}/es`, headers: as('loc@t.test'), payload: { text: '¡Hola {nombre}!' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('Missing placeholder {name}.');
  });

  it('runs translate → review → publish → device fetch', async () => {
    const id = (name: string) => db.prepare('SELECT id FROM keys WHERE name = ?').get(name)!.id as number;
    let res = await app.inject({ method: 'PUT', url: `/api/v1/translations/${id('greeting')}/es`, headers: as('loc@t.test'), payload: { text: '¡Hola {name}!' } });
    expect(res.json().status).toBe('review');
    res = await app.inject({ method: 'PUT', url: `/api/v1/translations/${id('items')}/es`, headers: as('loc@t.test'), payload: { text: '{count, plural, one {# artículo} many {# de artículos} other {# artículos}}' } });
    expect(res.json().status).toBe('review');

    res = await app.inject({ url: `/api/v1/projects/${projectId}/queue?locale=es&mode=review`, headers: as('rev@t.test') });
    expect(res.json().items).toHaveLength(2);
    for (const name of ['greeting', 'items']) {
      res = await app.inject({ method: 'POST', url: `/api/v1/translations/${id(name)}/es/approve`, headers: as('rev@t.test') });
      expect(res.json().status).toBe('approved');
    }

    res = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/publish`, headers: as('admin@t.test') });
    const manifest = res.json().manifest;
    expect(manifest.version).toBe(1);
    expect(manifest.locales.es.completeness).toBe(0.5);

    res = await app.inject({ url: manifest.locales.es.url });
    expect(res.json()).toEqual({ checkout: 'Checkout', greeting: '¡Hola {name}!', items: '{count, plural, one {# artículo} many {# de artículos} other {# artículos}}', yes: 'Yes' });
    const etag = res.headers.etag as string;
    res = await app.inject({ url: manifest.locales.es.url, headers: { 'if-none-match': etag } });
    expect(res.statusCode).toBe(304);
  });

  it('exports native files for bundled fallbacks', async () => {
    const res = await app.inject({ url: `/api/v1/projects/${projectId}/export?format=android-xml&locale=es`, headers: bearer });
    expect(res.body).toContain('<string name="greeting">¡Hola %1$s!</string>');
    expect(res.body).toContain('<item quantity="many">%1$d de artículos</item>');
    expect(res.body).not.toContain('checkout');
  });

  it('marks translations outdated when the source changes', async () => {
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/keys`, headers: bearer, payload: { entries: [{ key: 'greeting', source: 'Hi there, {name}!' }] } });
    const res = await app.inject({ url: `/api/v1/projects/${projectId}/queue?locale=es`, headers: as('loc@t.test') });
    const item = res.json().items.find((i: { key: string }) => i.key === 'greeting');
    expect(item).toMatchObject({ prevSource: 'Hello {name}!', current: { text: '¡Hola {name}!', status: 'outdated' } });
  });

  it('suggests translation memory matches', async () => {
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/keys`, headers: bearer, payload: { entries: [{ key: 'cart_items', source: '{count, plural, one {# item!} other {# items!}}' }] } });
    const res = await app.inject({ url: `/api/v1/projects/${projectId}/queue?locale=es`, headers: as('loc@t.test') });
    const item = res.json().items.find((i: { key: string }) => i.key === 'cart_items');
    expect(item.suggestions[0]).toMatchObject({ text: '{count, plural, one {# artículo} many {# de artículos} other {# artículos}}' });
    expect(item.suggestions[0].score).toBeGreaterThan(90);
  });
});
