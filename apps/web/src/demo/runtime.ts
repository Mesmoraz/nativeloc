// The online demo's server: the real NativeLoc server code, running in the page on sql.js (see shims/ and
// the demo build in vite.config.ts). It starts from the seeded demo database; what visitors change is kept
// in this browser (IndexedDB) until they reset the demo.
import { Buffer } from 'buffer';
import initSqlJs from 'sql.js';
import { clearInbox, deliver } from './inbox';
import type { DemoResponse } from './shims/fastify';

const BASE = import.meta.env.BASE_URL;
const COOKIES = 'nl-demo-cookies';
const IDB = { name: 'nativeloc-demo', store: 'db', key: 'current' };
/** The seeded database's build; a new deploy starts everyone over. */
const SEED_VERSION = import.meta.env.VITE_DEMO_SEED ?? 'dev';

type App = { handle: (init: { method: string; url: string; body?: unknown; form?: FormData; headers?: Record<string, string>; cookies?: Record<string, string> }) => Promise<DemoResponse> };

// ---------- saved state ----------

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(IDB.name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(IDB.store);
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        const req = fn(open.result.transaction(IDB.store, mode).objectStore(IDB.store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      };
    } catch {
      resolve(undefined);
    }
  });
}

const loadSaved = () => idb<{ seed: string; bytes: Uint8Array } | undefined>('readonly', (s) => s.get(IDB.key));
const save = (bytes: Uint8Array) => idb('readwrite', (s) => s.put({ seed: SEED_VERSION, bytes }, IDB.key));

function readCookies(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(COOKIES) ?? '{}');
  } catch {
    return {};
  }
}

function writeCookies(c: Record<string, string>) {
  try {
    localStorage.setItem(COOKIES, JSON.stringify(c));
  } catch {
    /* private window: the session lasts until reload */
  }
}

// ---------- boot ----------

/** The demo food bank site, published alongside the demo, stands in for http://localhost:5175. */
const siteFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== 'http://localhost:5175') return new Response('Not found', { status: 404 });
  const path = url.pathname === '/' ? 'index.html' : /\.[a-z]+$/.test(url.pathname) ? url.pathname.slice(1) : `${url.pathname.slice(1)}.html`;
  return fetch(`${BASE}food-bank-site/${path}`);
};

let booting: Promise<App> | null = null;

function boot(): Promise<App> {
  booting ??= (async () => {
    const g = globalThis as unknown as { Buffer: typeof Buffer; process: { env: Record<string, string> } };
    g.Buffer = Buffer;
    g.process = { env: { NODE_ENV: 'production', APP_URL: `${location.origin}${BASE.replace(/\/$/, '')}` } };
    const [SQL, saved] = await Promise.all([initSqlJs({ locateFile: (file) => `${BASE}demo/${file}` }), loadSaved()]);
    let bytes = saved?.seed === SEED_VERSION ? saved.bytes : null;
    if (!bytes) {
      const res = await fetch(`${BASE}demo/nativeloc.sqlite`);
      if (!res.ok) throw new Error('Could not load the demo data.');
      bytes = new Uint8Array(await res.arrayBuffer());
      writeCookies({});
      clearInbox();
    }
    globalThis.__demoSql = { SQL, bytes };
    const [{ buildApp }, { setMailer }] = await Promise.all([import('demo-server'), import('demo-server-mailer')]);
    setMailer({ name: 'demo-inbox', send: async (msg) => deliver(msg) });
    const { app } = await buildApp({ dbPath: 'demo', dataDir: '/demo-data', fetch: siteFetch, allowPrivateSites: true });
    return app as unknown as App;
  })();
  return booting;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const db = globalThis.__demoSql?.db;
    if (!db) return;
    const bytes = db.export();
    // export() reopens the database, which resets pragmas.
    db.exec('PRAGMA foreign_keys = ON');
    void save(bytes);
  }, 300);
}

/** Links the server hands out (screenshots, previews) point at its own root; on Pages the app lives under BASE. */
function rebase(text: string) {
  if (BASE === '/') return text.replace(/"\/preview\//g, `"/preview.html#/preview/`);
  return text.replace(/"\/files\//g, `"${BASE}files/`).replace(/"\/preview\//g, `"${BASE}preview.html#/preview/`);
}

// ---------- requests ----------

/** fetch() for API calls, answered by the in-page server. */
export async function demoFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const app = await boot();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const form = init.body instanceof FormData ? init.body : undefined;
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const method = (init.method ?? 'GET').toUpperCase();
  const jar = readCookies();
  const res = await app.handle({ method, url: path, body, form, headers, cookies: jar });

  if (res.cookies.length) {
    for (const c of res.cookies) {
      if (c.value === null) delete jar[c.name];
      else jar[c.name] = c.value;
    }
    writeCookies(jar);
  }
  if (method !== 'GET' && res.status < 400) saveSoon();

  const out = new Headers(res.headers);
  let payload: BodyInit | null = null;
  if (res.body == null) payload = null;
  else if (typeof res.body === 'string') payload = rebase(res.body);
  else if (res.body instanceof Uint8Array) payload = new Blob([res.body as Uint8Array<ArrayBuffer>]);
  else {
    payload = rebase(JSON.stringify(res.body));
    out.set('content-type', 'application/json; charset=utf-8');
  }
  const nullBody = res.status === 204 || res.status === 304 || (res.status >= 300 && res.status < 400);
  return new Response(nullBody ? null : payload, { status: res.status, headers: out });
}

/** Start over from the seeded data. */
export async function resetDemo() {
  await idb('readwrite', (s) => s.delete(IDB.key));
  writeCookies({});
  clearInbox();
  location.href = BASE;
}
