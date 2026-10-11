import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPage } from '@nativeloc/site';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isPrivateAddress } from '../src/routes/hosted.js';
import { hashPassword } from '../src/auth.js';
import { get, run, type DB } from '../src/db.js';

const SITE = 'https://www.food.example.org';
const PAGES: Record<string, string> = {
  '/get-food': `<!doctype html><html lang="en"><head><title>Get food</title></head><body>
    <nav><a href="/">Home</a> <a href="https://food.example.org/hours?day=mon">Hours</a></nav>
    <h1>Get food</h1><p>Call <a href="tel:555">our hotline</a> today.</p><p>Not translated yet.</p>
    <img src="/logo.png" alt="Logo"></body></html>`,
};

let app: FastifyInstance;
let db: DB;
let dir: string;
let projectId: number;
let cookie: string;
const requested: string[] = [];

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  requested.push(url.href);
  if (url.pathname === '/old-page') return new Response(null, { status: 301, headers: { location: '/get-food' } });
  if (url.pathname === '/away') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/x' } });
  if (url.pathname === '/flyer.pdf') return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
  const html = PAGES[url.pathname];
  return html
    ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response('<html><body><p>Page not found</p></body></html>', { status: 404, headers: { 'content-type': 'text/html' } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-hosted-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir, fetch: fakeFetch as typeof fetch }));
  const org = Number(run(db, "INSERT INTO orgs (name) VALUES ('Test')").lastInsertRowid);
  run(db, "INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, 'admin@t.test', 'Admin', ?, 'admin', '[]')", org, hashPassword('pw-12345678'));
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@t.test', password: 'pw-12345678' } });
  cookie = `nl_sid=${login.cookies.find((c) => c.name === 'nl_sid')!.value}`;
  const res = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie }, payload: { name: 'Food Bank site', sourceLocale: 'en', locales: ['es', 'so'] } });
  projectId = res.json().project.id;

  // Keys exactly as the crawler would push them; Spanish translations in three states.
  const segments = readPage(PAGES['/get-food'], `${SITE}/get-food`).segments;
  const es: Record<string, [string, string]> = {
    'Get food': ['Obtener comida', 'approved'],
    'Call {link1}our hotline{link1_end} today.': ['Llame hoy a {link1}nuestra línea{link1_end}.', 'approved'],
    Logo: ['Logotipo (en revisión)', 'review'],
  };
  for (const s of segments) {
    // The same text twice on a page (title and heading) is one key.
    if (get(db, 'SELECT 1 FROM keys WHERE project_id = ? AND name = ?', projectId, s.key)) continue;
    const k = Number(run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', projectId, s.key, s.source).lastInsertRowid);
    if (es[s.source]) run(db, 'INSERT INTO translations (key_id, locale, text, status) VALUES (?, ?, ?, ?)', k, 'es', es[s.source][0], es[s.source][1]);
  }
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('hosted preview', () => {
  let token: string;

  it('is off until the project has a website', async () => {
    const res = await app.inject({ method: 'GET', url: '/preview/pv_nothing/es/' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('saves the website as an origin and creates a preview token', async () => {
    const bad = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${projectId}`, headers: { cookie }, payload: { siteUrl: 'not a site' } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${projectId}`, headers: { cookie }, payload: { siteUrl: 'www.food.example.org/get-food' } });
    expect(res.json().project.siteUrl).toBe(SITE);
    token = res.json().project.previewToken;
    expect(token).toMatch(/^pv_/);
  });

  it('lists the languages', async () => {
    const res = await app.inject({ method: 'GET', url: `/preview/${token}/` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="es/"');
    expect(res.body).toContain('Soomaali');
    expect(res.body).toContain('noindex');
  });

  it('shows the live page with approved translations only', async () => {
    const res = await app.inject({ method: 'GET', url: `/preview/${token}/es/get-food`, headers: { host: 'preview.test' } });
    expect(res.statusCode).toBe(200);
    expect(requested.at(-1)).toBe(`${SITE}/get-food`);
    expect(res.body).toContain('<title>Obtener comida</title>');
    expect(res.body).toContain('<h1>Obtener comida</h1>');
    expect(res.body).toContain('>Home</a>');
    // The banner's styles survive as one attribute.
    expect(res.body).toMatch(/font:14px\/1\.4 system-ui,-apple-system,'Segoe UI',sans-serif" translate="no"/);
    expect(res.body).toContain('Llame hoy a <a href="tel:555">nuestra línea</a>.');
    expect(res.body).toContain('<p>Not translated yet.</p>');
    // Waiting for review: not shown.
    expect(res.body).toContain('alt="Logo"');
    expect(res.body).toContain(`<base href="${SITE}/get-food">`);
    // Links on the same site (with or without www) stay in the preview, in the same language.
    expect(res.body).toContain(`href="http://preview.test/preview/${token}/es/"`);
    expect(res.body).toContain(`href="http://preview.test/preview/${token}/es/hours?day=mon"`);
    expect(res.body).toContain(`href="http://preview.test/preview/${token}/so/get-food"`);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['content-security-policy']).toMatch(/^sandbox allow-scripts/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-nativeloc-translated']).toBe('2/5');
  });

  it('never fetches another host, whatever the path says', async () => {
    await app.inject({ method: 'GET', url: `/preview/${token}/es//evil.example.com/steal` });
    expect(new URL(requested.at(-1)!).origin).toBe(SITE);
  });

  it('follows redirects inside the preview and sends everything else to the original', async () => {
    const moved = await app.inject({ method: 'GET', url: `/preview/${token}/es/old-page`, headers: { host: 'preview.test' } });
    expect(moved.statusCode).toBe(302);
    expect(moved.headers.location).toBe(`http://preview.test/preview/${token}/es/get-food`);
    const away = await app.inject({ method: 'GET', url: `/preview/${token}/es/away` });
    expect(away.headers.location).toBe('https://elsewhere.example.com/x');
    const pdf = await app.inject({ method: 'GET', url: `/preview/${token}/es/flyer.pdf` });
    expect(pdf.headers.location).toBe(`${SITE}/flyer.pdf`);
  });

  it('passes through the site\'s own 404, and refuses languages the project lacks', async () => {
    expect((await app.inject({ method: 'GET', url: `/preview/${token}/es/missing` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/preview/${token}/fr/get-food` })).statusCode).toBe(404);
  });

  it('stops working when the token is rotated', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/rotate-preview-token`, headers: { cookie } });
    expect(res.json().previewToken).not.toBe(token);
    expect((await app.inject({ method: 'GET', url: `/preview/${token}/es/get-food` })).statusCode).toBe(404);
    expect(get<{ preview_token: string }>(db, 'SELECT preview_token FROM projects WHERE id = ?', projectId)!.preview_token).toBe(res.json().previewToken);
  });
});

describe('private network guard', () => {
  it('recognizes addresses a public website never has', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses to read a private site when private sites are off', async () => {
    const d = mkdtempSync(join(tmpdir(), 'nativeloc-hosted-'));
    const built = await buildApp({ dbPath: ':memory:', dataDir: d, fetch: fakeFetch as typeof fetch, allowPrivateSites: false });
    try {
      const org = Number(run(built.db, "INSERT INTO orgs (name) VALUES ('T')").lastInsertRowid);
      const pid = Number(run(built.db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, site_url, preview_token) VALUES (?, 'S', 'en', 'pb_x', 'http://127.0.0.1:8080', 'pv_local')", org).lastInsertRowid);
      run(built.db, "INSERT INTO project_locales (project_id, locale) VALUES (?, 'es')", pid);
      const before = requested.length;
      const res = await built.app.inject({ method: 'GET', url: '/preview/pv_local/es/' });
      expect(res.statusCode).toBe(403);
      expect(requested.length).toBe(before);
    } finally {
      await built.app.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
