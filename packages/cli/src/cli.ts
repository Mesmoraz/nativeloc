import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { detectFormat, getAdapter } from '@nativeloc/core';

interface FileConfig {
  /** Source-language file, e.g. app/src/main/res/values/strings.xml */
  path: string;
  format?: string;
  /** Where translations live, with {locale}, e.g. app/src/main/res/values-{locale}/strings.xml */
  translations?: string;
}
interface Config {
  server: string;
  projectId: number;
  files: FileConfig[];
}

const HELP = `nativeloc — sync strings with NativeLoc

Usage:
  nativeloc init                          Create nativeloc.config.json
  nativeloc push [--prune] [--with-translations] [--publish]
                                          Upload source strings (and existing translations)
  nativeloc pull                          Download approved translations into "translations" paths
  nativeloc screenshot <image.png> --label "Cart" --keys cart_total,checkout
             [--boxes '[{"key":"checkout","x":10,"y":20,"w":200,"h":60}]']
                                          Attach a device screenshot so localizers see context
  nativeloc publish                       Publish a new version to devices

Options:
  --config <file>   Config file (default: nativeloc.config.json)
  --token <token>   API token (default: $NATIVELOC_TOKEN)
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: 'nativeloc.config.json' },
    token: { type: 'string' },
    prune: { type: 'boolean', default: false },
    'with-translations': { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    label: { type: 'string' },
    keys: { type: 'string' },
    boxes: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...rest] = positionals;

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function loadConfig(): Config & { root: string } {
  const path = resolve(opts.config!);
  if (!existsSync(path)) fail(`No ${opts.config} here. Run "nativeloc init" first.`);
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as Config;
  if (!cfg.server || !cfg.projectId) fail('Config needs "server" and "projectId".');
  return { ...cfg, root: dirname(path) };
}

function token(): string {
  const t = opts.token ?? process.env.NATIVELOC_TOKEN;
  if (!t) fail('Set NATIVELOC_TOKEN (create one under the project\'s "Devices & API" tab) or pass --token.');
  return t;
}

async function call<T>(cfg: Config, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.server.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) fail(`${res.status}: ${(() => { try { return JSON.parse(text).error; } catch { return text; } })()}`);
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T;
}

async function projectLocales(cfg: Config): Promise<string[]> {
  const r = await call<{ project: { locales: string[] } }>(cfg, `/api/v1/projects/${cfg.projectId}`);
  return r.project.locales;
}

const formatOf = (f: FileConfig) => f.format ?? detectFormat(f.path) ?? fail(`Can't tell the format of ${f.path}; set "format".`);

async function push() {
  const cfg = loadConfig();
  for (const f of cfg.files) {
    const path = resolve(cfg.root, f.path);
    const { entries } = getAdapter(formatOf(f)).parse(readFileSync(path, 'utf8'));
    const r = await call<{ created: number; updated: number; unchanged: number; archived: number }>(cfg, `/api/v1/projects/${cfg.projectId}/keys`, {
      method: 'POST',
      body: JSON.stringify({ entries, prune: opts.prune }),
    });
    console.log(`✔ ${f.path}: ${entries.length} strings (${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged${r.archived ? `, ${r.archived} archived` : ''})`);

    if (opts['with-translations'] && f.translations) {
      for (const locale of await projectLocales(cfg)) {
        const tPath = resolve(cfg.root, f.translations.replace('{locale}', locale));
        if (!existsSync(tPath)) continue;
        const parsed = getAdapter(formatOf(f)).parse(readFileSync(tPath, 'utf8'), locale);
        const tr = await call<{ translations: number }>(cfg, `/api/v1/projects/${cfg.projectId}/keys`, {
          method: 'POST',
          body: JSON.stringify({ entries: parsed.entries.map((e) => ({ ...e, source: e.translation ?? e.source })), locale }),
        });
        console.log(`  ✔ ${locale}: ${tr.translations} existing translations`);
      }
    }
  }
  if (opts.publish) await publish();
}

async function pull() {
  const cfg = loadConfig();
  const locales = await projectLocales(cfg);
  for (const f of cfg.files) {
    if (!f.translations) {
      console.log(`- ${f.path}: no "translations" path, skipped`);
      continue;
    }
    for (const locale of locales) {
      const body = await call<string>(cfg, `/api/v1/projects/${cfg.projectId}/export?format=${formatOf(f)}&locale=${locale}`);
      const out = resolve(cfg.root, f.translations.replace('{locale}', androidLocale(formatOf(f), locale)));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
      console.log(`✔ ${locale} → ${f.translations.replace('{locale}', androidLocale(formatOf(f), locale))}`);
    }
  }
}

/** Android resource folders use "values-pt-rBR" for "pt-BR". */
function androidLocale(format: string, locale: string) {
  if (format !== 'android-xml') return locale;
  const [lang, region] = locale.split('-');
  return region && /^[A-Z]{2}$/.test(region) ? `${lang}-r${region}` : locale;
}

async function screenshot() {
  const cfg = loadConfig();
  const image = rest[0] ?? fail('Pass the image path: nativeloc screenshot shot.png --keys a,b');
  const form = new FormData();
  form.set('label', opts.label ?? basename(image));
  form.set('keys', opts.boxes ?? JSON.stringify((opts.keys ?? '').split(',').filter(Boolean).map((key) => ({ key: key.trim() }))));
  form.set('file', new Blob([readFileSync(image)], { type: image.endsWith('.png') ? 'image/png' : 'image/jpeg' }), basename(image));
  const r = await call<{ id: number; missingKeys: string[] }>(cfg, `/api/v1/projects/${cfg.projectId}/screenshots`, { method: 'POST', body: form });
  console.log(`✔ Screenshot #${r.id} uploaded${r.missingKeys.length ? ` (unknown keys ignored: ${r.missingKeys.join(', ')})` : ''}`);
}

async function publish() {
  const cfg = loadConfig();
  const r = await call<{ manifest: { version: number; locales: Record<string, { completeness: number }> } }>(cfg, `/api/v1/projects/${cfg.projectId}/publish`, { method: 'POST' });
  const summary = Object.entries(r.manifest.locales).map(([l, v]) => `${l} ${Math.round(v.completeness * 100)}%`).join(', ');
  console.log(`✔ Published version ${r.manifest.version}: ${summary}`);
}

function init() {
  if (existsSync(opts.config!)) fail(`${opts.config} already exists.`);
  const guess = existsSync('app/src/main/res/values/strings.xml')
    ? { path: 'app/src/main/res/values/strings.xml', translations: 'app/src/main/res/values-{locale}/strings.xml' }
    : { path: 'po/messages.pot', format: 'po', translations: 'po/{locale}.po' };
  const cfg: Config = { server: 'http://localhost:4600', projectId: 1, files: [guess] };
  writeFileSync(opts.config!, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`✔ Wrote ${opts.config}. Set "projectId" (see the project URL) and NATIVELOC_TOKEN, then run "nativeloc push".`);
}

const commands: Record<string, () => unknown> = { init, push, pull, screenshot, publish };
if (opts.help || !command || !commands[command]) {
  console.log(HELP);
  process.exit(command && !opts.help ? 1 : 0);
}
await commands[command]();
