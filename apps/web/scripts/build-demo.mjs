// Builds the online demo (GitHub Pages) into apps/web/dist: the web app in demo mode, with the server running
// in the page, plus the seeded demo database, sql.js's WebAssembly, and the demo food bank website.
//   npm run build:demo -w @nativeloc/web          (DEMO_BASE=/ for a site at the domain root)
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(web, '../..');
const dist = join(web, 'dist');
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });

let seed = process.env.VITE_DEMO_SEED;
try {
  seed ??= execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
} catch {
  seed ??= String(Date.now());
}

// 1. The app, in demo mode.
run('npx', ['vite', 'build', '--mode', 'demo', web], { VITE_DEMO_SEED: seed });

// 2. Fresh demo data, from the same seed script `npm run demo` uses.
const data = mkdtempSync(join(tmpdir(), 'nativeloc-demo-'));
try {
  run('npx', ['tsx', '--no-warnings', 'apps/server/src/seed.ts', '--reset'], { NATIVELOC_DATA: data });
  const dbFile = join(data, 'nativeloc.sqlite');
  // sql.js reads a single file: fold the write-ahead log in and leave WAL mode.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;');
  db.close();
  mkdirSync(join(dist, 'demo'), { recursive: true });
  copyFileSync(dbFile, join(dist, 'demo', 'nativeloc.sqlite'));
  // sql.js's WebAssembly, loaded by src/demo/runtime.ts (kept out of the bundle so normal builds don't ship it).
  copyFileSync(createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm'), join(dist, 'demo', 'sql-wasm.wasm'));
  if (existsSync(join(data, 'screenshots'))) cpSync(join(data, 'screenshots'), join(dist, 'files', 'screenshots'), { recursive: true });
} finally {
  rmSync(data, { recursive: true, force: true });
}

// 3. The pretend food bank website the hosted preview reads (the server reads it from http://localhost:5175).
const site = join(root, 'examples', 'food-bank-site');
mkdirSync(join(dist, 'food-bank-site'), { recursive: true });
for (const f of readdirSync(site)) if (/\.(html|css|svg)$/.test(f)) copyFileSync(join(site, f), join(dist, 'food-bank-site', f));

// 4. GitHub Pages: any unknown path gets the app (client-side routes), and skip Jekyll.
copyFileSync(join(dist, 'index.html'), join(dist, '404.html'));
writeFileSync(join(dist, '.nojekyll'), '');
console.log(`\nOnline demo built in ${dist} (data ${seed}).`);
