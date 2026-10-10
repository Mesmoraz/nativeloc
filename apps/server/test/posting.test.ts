import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addMembership, all, get, run, type DB } from '../src/db.js';
import { RESTARTED } from '../src/posting/crawlJobs.js';
import { BlockedUrl, checkUrl, guardedFetch, isPublicAddress, netSettings } from '../src/posting/netguard.js';
import { CRAWL_PAGE_LIMIT, defaultReviewMode } from '../src/posting/policy.js';
import { PASTE_MAX_CHARS, paragraphs, splitPaste } from '../src/posting/split.js';

/** A local website for the crawler. `pages` maps a path to [status, headers, body]. */
async function site(pages: Record<string, [number, Record<string, string>, string]>) {
  const server = createServer((req, res) => {
    const page = pages[req.url ?? '/'];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(page[0], page[1]).end(page[2]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, origin: `http://127.0.0.1:${port}` };
}
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

beforeAll(() => {
  netSettings.hostDelayMs = 0;
});

describe('network guard', () => {
  it('knows public from private addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'nonsense',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('refuses addresses that would reach inside the network', async () => {
    for (const url of [
      'http://127.0.0.1/', 'http://localhost/', 'http://LOCALHOST./admin', 'http://foo.localhost/', 'http://printer.local/',
      'http://10.0.0.5/', 'http://192.168.0.1/router', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://intranet/',
      'file:///etc/passwd', 'ftp://example.org/', 'gopher://example.org/', 'javascript:alert(1)',
      'http://user:pass@example.org/', 'http://example.org:8080/', 'http://example.org:22/', 'not a url',
    ])
      await expect(checkUrl(url), url).rejects.toBeInstanceOf(BlockedUrl);
  });

  it('checks every redirect hop, so a page cannot bounce the crawler inside', async () => {
    const inside = await site({ '/secret': [200, { 'content-type': 'text/html' }, '<p>internal</p>'] });
    const outside = await site({
      '/': [302, { location: `${inside.origin}/secret` }, ''],
      '/meta': [301, { location: 'http://169.254.169.254/latest/meta-data/' }, ''],
      '/ok': [302, { location: '/landing' }, ''],
      '/landing': [200, { 'content-type': 'text/html' }, '<p>hello</p>'],
      '/big': [200, { 'content-type': 'text/html' }, 'x'.repeat(4096)],
    });
    servers.push(inside.server, outside.server);
    // Only the "outside" server is allowed (it stands in for a public site); the other local server is not.
    netSettings.allowHosts = new Set([`127.0.0.1:${outside.port}`]);
    await expect(guardedFetch(`${inside.origin}/secret`)).rejects.toBeInstanceOf(BlockedUrl);
    await expect(guardedFetch(`${outside.origin}/`)).rejects.toBeInstanceOf(BlockedUrl);
    await expect(guardedFetch(`${outside.origin}/meta`)).rejects.toBeInstanceOf(BlockedUrl);
    const res = await guardedFetch(`${outside.origin}/ok`, { headers: { 'user-agent': 'NativeLocBot/test' } });
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${outside.origin}/landing`);
    expect(await res.text()).toBe('<p>hello</p>');
    const max = netSettings.maxBytes;
    netSettings.maxBytes = 1024;
    await expect(guardedFetch(`${outside.origin}/big`)).rejects.toThrow(/larger than/);
    netSettings.maxBytes = max;
    netSettings.allowHosts = new Set();
  });
});

// ---------- the API ----------

const pw = hashPassword('pw-12345678');
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function boot(dbPath = ':memory:') {
  const dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  dirs.push(dir);
  return buildApp({ dbPath, dataDir: dir });
}

/** An org with an admin who is signed in. */
async function poster(app: FastifyInstance, db: DB, email: string, org: { type?: string; verification?: string } = {}) {
  let orgId = get<{ org_id: number }>(db, "SELECT m.org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?", email)?.org_id;
  if (!orgId) {
    orgId = Number(run(db, 'INSERT INTO orgs (name, type, verification) VALUES (?, ?, ?)', email, org.type ?? 'small_org', org.verification ?? 'unverified').lastInsertRowid);
    const userId = Number(run(db, 'INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, ?)', email, email, pw, '[]').lastInsertRowid);
    addMembership(db, userId, orgId, 'admin');
  }
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-12345678' } });
  expect(res.statusCode).toBe(200);
  return { orgId, headers: { cookie: `nl_sid=${res.cookies.find((c) => c.name === 'nl_sid')!.value}` } };
}

describe('pasting text', () => {
  it('splits into paragraphs, joining hard-wrapped lines and keeping lists apart', () => {
    expect(paragraphs('We are open Monday to Friday.\n\nCall us for delivery.')).toEqual(['We are open Monday to Friday.', 'Call us for delivery.']);
    expect(paragraphs('Bring a bag and a photo\nID if you have one.\nNo appointment needed.')).toEqual(['Bring a bag and a photo', 'ID if you have one.', 'No appointment needed.']);
    expect(paragraphs('Bring a bag and a\nphoto ID if you have one.')).toEqual(['Bring a bag and a photo ID if you have one.']);
    expect(paragraphs('What to bring:\n- a bag\n• proof of address\n1. Sign in')).toEqual(['What to bring:', 'a bag', 'proof of address', '1. Sign in']);
    expect(paragraphs('Eastside Food Bank\r\n123 Main St\r\n\r\n\r\n')).toEqual(['Eastside Food Bank', '123 Main St']);
  });

  it('gives each text a stable key, once, and escapes ICU syntax', () => {
    const a = splitPaste('Hello there. How are you?\n\nHello there. How are you?', 'sentences');
    expect(a.map((s) => s.source)).toEqual(['Hello there.', 'How are you?']);
    expect(splitPaste('How are you?\n\nHello there.', 'sentences').map((s) => s.key)).toEqual([a[1].key, a[0].key]);
    expect(splitPaste('Use {name} here')[0].source).toBe("Use '{'name'}' here");
    expect(splitPaste('***\n\n—\n\nOK')).toHaveLength(1);
  });

  it('keeps very long pastes safe: long paragraphs split at sentences, and limits are explained', () => {
    const long = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i + 1} of a long paragraph.`).join(' ');
    const parts = splitPaste(long, 'paragraphs');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.source.length <= 600)).toBe(true);
    expect(parts.map((p) => p.source).join(' ')).toBe(long);
    const runOn = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
    expect(splitPaste(runOn, 'sentences').every((p) => p.source.length <= 1500)).toBe(true);
    expect(() => splitPaste('x'.repeat(PASTE_MAX_CHARS + 1))).toThrow(/up to 100,000/);
    expect(() => splitPaste(Array.from({ length: 1200 }, (_, i) => `Line ${i}.`).join('\n'))).toThrow(/up to 1,000/);
  });
});

describe('posting content', () => {
  let app: FastifyInstance;
  let db: DB;
  let me: Awaited<ReturnType<typeof poster>>;
  const create = (body: Record<string, unknown>, headers = me.headers) => app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: body });

  beforeAll(async () => {
    ({ app, db } = await boot());
    me = await poster(app, db, 'ana@community.test');
  });
  afterAll(() => app.close());

  it('creates projects with visibility and a review mode that defaults from the org', async () => {
    const priv = (await create({ name: 'Private', locales: ['es'] })).json().project;
    expect(priv).toMatchObject({ visibility: 'private', moderation: 'none', reviewMode: 'standard' });
    const pub = (await create({ name: 'Public', locales: ['es'], visibility: 'public' })).json().project;
    expect(pub).toMatchObject({ visibility: 'public', moderation: 'none', reviewMode: 'community' });
    const chosen = (await create({ name: 'Chosen', visibility: 'public', reviewMode: 'standard' })).json().project;
    expect(chosen.reviewMode).toBe('standard');
    expect((await create({ name: 'Bad', visibility: 'everyone' })).statusCode).toBe(400);

    const np = await poster(app, db, 'np@verified.test', { type: 'nonprofit', verification: 'verified' });
    expect((await create({ name: 'NP', visibility: 'public' }, np.headers)).json().project.reviewMode).toBe('standard');
    expect(defaultReviewMode({ type: 'nonprofit', verification: 'pending' }, 'public')).toBe('community');
  });

  it('going public resets moderation and picks the public review default', async () => {
    const p = (await create({ name: 'Switch', locales: ['es'] })).json().project;
    run(db, "UPDATE projects SET moderation = 'approved' WHERE id = ?", p.id);
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${p.id}`, headers: me.headers, payload: { visibility: 'public' } });
    expect(res.json().project).toMatchObject({ visibility: 'public', moderation: 'none', reviewMode: 'community' });
  });

  it('pastes text as strings, with a preview, a context note, and unchanged on a second paste', async () => {
    const p = (await create({ name: 'Paste', locales: ['es'] })).json().project;
    const url = `/api/v1/projects/${p.id}/paste`;
    const text = 'We are open Monday to Friday.\n\nCall us for delivery.';
    const preview = (await app.inject({ method: 'POST', url, headers: me.headers, payload: { text, dryRun: true } })).json();
    expect(preview).toMatchObject({ created: 2, unchanged: 0 });
    expect(get(db, 'SELECT COUNT(*) AS n FROM keys WHERE project_id = ?', p.id)).toEqual({ n: 0 });

    const first = await app.inject({ method: 'POST', url, headers: me.headers, payload: { text, context: 'Hours page', split: 'paragraphs' } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ created: 2, unchanged: 0, keys: [{ source: 'We are open Monday to Friday.' }, { source: 'Call us for delivery.' }] });
    expect(all(db, 'SELECT source, description FROM keys WHERE project_id = ? ORDER BY id', p.id)).toEqual([
      { source: 'We are open Monday to Friday.', description: 'Hours page' },
      { source: 'Call us for delivery.', description: 'Hours page' },
    ]);
    const again = (await app.inject({ method: 'POST', url, headers: me.headers, payload: { text, context: 'Hours page' } })).json();
    expect(again).toMatchObject({ created: 0, unchanged: 2 });

    expect((await app.inject({ method: 'POST', url, headers: me.headers, payload: { text: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: me.headers, payload: { text, split: 'words' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: me.headers, payload: { text: 'a'.repeat(PASTE_MAX_CHARS + 1) } })).statusCode).toBe(413);
  });

  it('refuses crawls of private networks and odd addresses', async () => {
    const p = (await create({ name: 'Crawl refused' })).json().project;
    for (const url of ['http://127.0.0.1/', 'localhost:3000', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://[::1]/', 'file:///etc/passwd', 'http://a:b@example.org/']) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${p.id}/crawl`, headers: me.headers, payload: { url } });
      expect(res.statusCode, url).toBe(400);
    }
    expect(get(db, 'SELECT COUNT(*) AS n FROM crawl_jobs')).toEqual({ n: 0 });
  });

  it('submits public projects to the automatic screen', async () => {
    const submit = (id: number) => app.inject({ method: 'POST', url: `/api/v1/projects/${id}/submit`, headers: me.headers });
    const paste = (id: number, text: string) => app.inject({ method: 'POST', url: `/api/v1/projects/${id}/paste`, headers: me.headers, payload: { text } });

    const priv = (await create({ name: 'Not public', locales: ['es'] })).json().project;
    expect((await submit(priv.id)).statusCode).toBe(400);

    const clean = (await create({ name: 'Clean', locales: ['es'], visibility: 'public' })).json().project;
    expect((await submit(clean.id)).json().error).toMatch(/Add some text/);
    await paste(clean.id, 'Our pantry is open on Tuesdays.\n\nEveryone is welcome.');
    expect((await submit(clean.id)).json()).toEqual({ moderation: 'approved', reasons: [] });
    expect(get(db, 'SELECT moderation FROM projects WHERE id = ?', clean.id)).toEqual({ moderation: 'approved' });
    // New content on a live project is screened again.
    await paste(clean.id, 'Buy now with promo code SAVE.');
    expect(get(db, 'SELECT moderation FROM projects WHERE id = ?', clean.id)).toEqual({ moderation: 'pending' });
    // Waiting for staff: a resubmit doesn't approve it.
    expect((await submit(clean.id)).json()).toEqual({ moderation: 'pending', reasons: [] });

    const shop = (await create({ name: 'Shop', locales: ['es'], visibility: 'public' })).json().project;
    await paste(shop.id, 'Shoes for $40. Add to cart today!');
    const held = (await submit(shop.id)).json();
    expect(held.moderation).toBe('pending');
    expect(held.reasons.join(' ')).toMatch(/price/);

    const noLang = (await create({ name: 'No languages', visibility: 'public' })).json().project;
    await paste(noLang.id, 'Hello.');
    expect((await submit(noLang.id)).json().error).toMatch(/language/);
  });

  it('keeps business accounts on the waitlist', async () => {
    const biz = await poster(app, db, 'shop@biz.test', { type: 'business' });
    const res = await create({ name: 'Biz', locales: ['es'] }, biz.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/waitlist/);
    // Even a project that exists some other way can't get content or be submitted.
    const id = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, visibility) VALUES (?, 'Old', 'en', 'pb_biz', 'public')", biz.orgId).lastInsertRowid);
    for (const [url, payload] of [
      [`/api/v1/projects/${id}/paste`, { text: 'Hi.' }],
      [`/api/v1/projects/${id}/crawl`, { url: 'https://example.org/' }],
      [`/api/v1/projects/${id}/submit`, {}],
    ] as const)
      expect((await app.inject({ method: 'POST', url, headers: biz.headers, payload })).statusCode, url).toBe(403);
  });
});

describe('website crawl jobs', () => {
  const html = (title: string, body: string): [number, Record<string, string>, string] => [
    200,
    { 'content-type': 'text/html; charset=utf-8' },
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`,
  ];

  it('reads the site in the background, help pages first, within the page cap, honoring robots.txt', async () => {
    const pages: Record<string, [number, Record<string, string>, string]> = {
      '/robots.txt': [200, { 'content-type': 'text/plain' }, 'User-agent: *\nDisallow: /\n\nUser-agent: NativeLocBot\nDisallow: /private\n'],
      '/': html(
        'Home',
        '<h1>Eastside Food Bank</h1><a href="/get-help">Get help</a> <a href="/blog/news">News</a> <a href="/private/staff">Staff</a> ' +
          Array.from({ length: 30 }, (_, i) => `<a href="/programs/p${i}">Program ${i}</a>`).join(' '),
      ),
      '/get-help': html('Get help', '<p>Free groceries every Tuesday.</p>'),
      '/blog/news': html('News', '<p>Our annual gala was fun.</p>'),
      '/private/staff': html('Staff', '<p>Staff only.</p>'),
    };
    for (let i = 0; i < 30; i++) pages[`/programs/p${i}`] = html(`Program ${i}`, `<p>Program ${i} helps families.</p>`);
    const agents: string[] = [];
    const server = createServer((req, res) => {
      agents.push(String(req.headers['user-agent']));
      const page = pages[req.url ?? '/'];
      if (!page) return void res.writeHead(404).end();
      res.writeHead(page[0], page[1]).end(page[2]);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    netSettings.allowHosts = new Set([`127.0.0.1:${port}`]);

    const { app, db } = await boot();
    try {
      const me = await poster(app, db, 'web@community.test');
      const p = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: me.headers, payload: { name: 'Site', locales: ['es'] } })).json().project;
      const start = await app.inject({ method: 'POST', url: `/api/v1/projects/${p.id}/crawl`, headers: me.headers, payload: { url: `http://127.0.0.1:${port}/` } });
      expect(start.statusCode).toBe(200);
      expect(start.json().job).toMatchObject({ url: `http://127.0.0.1:${port}/`, status: 'queued', pages: 0, strings: 0, error: null });
      // One crawl per org at a time.
      expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${p.id}/crawl`, headers: me.headers, payload: { url: `http://127.0.0.1:${port}/` } })).statusCode).toBe(409);

      const job = await waitFor(app, p.id, me.headers);
      expect(job).toMatchObject({ status: 'done', pages: CRAWL_PAGE_LIMIT, error: null });
      expect(job.strings).toBeGreaterThan(CRAWL_PAGE_LIMIT);
      const sources = all<{ source: string }>(db, 'SELECT source FROM keys WHERE project_id = ?', p.id).map((k) => k.source);
      expect(sources).toContain('Free groceries every Tuesday.');
      expect(sources).not.toContain('Staff only.'); // robots.txt: our group disallows /private
      expect(sources).not.toContain('Our annual gala was fun.'); // news ranks below the program pages; the cap stops first
      expect(agents.length).toBeGreaterThan(0);
      expect(agents.every((a) => a.startsWith('NativeLocBot/'))).toBe(true);
    } finally {
      await app.close();
      netSettings.allowHosts = new Set();
    }
  });

  it('marks a failed site clearly, and a job interrupted by a restart as failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
    dirs.push(dir);
    const path = join(dir, 'restart.sqlite');
    const down = await site({});
    servers.push(down.server);
    netSettings.allowHosts = new Set([`127.0.0.1:${down.port}`]);

    let { app, db } = await boot(path);
    const me = await poster(app, db, 'restart@community.test');
    const p = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: me.headers, payload: { name: 'R' } })).json().project;
    await app.inject({ method: 'POST', url: `/api/v1/projects/${p.id}/crawl`, headers: me.headers, payload: { url: `${down.origin}/` } });
    const failed = await waitFor(app, p.id, me.headers);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Couldn’t read any pages: HTTP 404/);

    // The server stops mid-crawl (one job running) with another queued behind it.
    run(db, "INSERT INTO crawl_jobs (project_id, org_id, url, status, pages) VALUES (?, ?, ?, 'running', 3)", p.id, me.orgId, `${down.origin}/a`);
    run(db, "INSERT INTO crawl_jobs (project_id, org_id, url, status) VALUES (?, ?, ?, 'queued')", p.id, me.orgId, `${down.origin}/b`);
    await app.close();

    ({ app, db } = await boot(path));
    try {
      const again = await poster(app, db, 'restart@community.test');
      const jobs = await waitFor(app, p.id, again.headers, true);
      expect(jobs.map((j) => [j.url.replace(down.origin, ''), j.status])).toEqual([['/b', 'failed'], ['/a', 'failed'], ['/', 'failed']]);
      expect(jobs[1]).toMatchObject({ pages: 3, error: RESTARTED });
      expect(jobs[0].error).toMatch(/HTTP 404/); // the queued one ran after the restart
    } finally {
      await app.close();
      netSettings.allowHosts = new Set();
    }
  });
});

interface Job {
  id: number;
  url: string;
  status: string;
  pages: number;
  strings: number;
  error: string | null;
}
/** Polls the job list until nothing is queued or running; returns the newest job, or all of them. */
async function waitFor(app: FastifyInstance, projectId: number, headers: Record<string, string>): Promise<Job>;
async function waitFor(app: FastifyInstance, projectId: number, headers: Record<string, string>, everything: true): Promise<Job[]>;
async function waitFor(app: FastifyInstance, projectId: number, headers: Record<string, string>, everything = false) {
  for (let i = 0; i < 400; i++) {
    const jobs = (await app.inject({ url: `/api/v1/projects/${projectId}/crawl`, headers })).json().jobs as Job[];
    if (jobs.length && jobs.every((j) => j.status === 'done' || j.status === 'failed')) return everything ? jobs : jobs[0];
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('crawl did not finish');
}
