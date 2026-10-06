import { IntlMessageFormat } from 'intl-messageformat';

export type Bundle = Record<string, string>;

/** Where downloaded bundles are kept between runs (disk, localStorage, …). */
export interface BundleStorage {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
}

export interface NativeLocOptions {
  /** Server origin, e.g. "https://loc.example.com". */
  baseUrl: string;
  /** Public device token from the project's "Devices & API" page. */
  bundleToken: string;
  locale: string;
  /** Bundles shipped with the app, used before the first download and when offline. */
  fallback?: Record<string, Bundle>;
  storage?: BundleStorage;
  fetch?: typeof fetch;
}

interface Manifest {
  version: number;
  sourceLocale: string;
  locales: Record<string, { sha256: string; url: string; completeness: number }>;
}

interface CacheEntry {
  sha256: string;
  etag?: string;
  bundle: Bundle;
}

export function memoryStorage(): BundleStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

export function localStorageStorage(prefix = 'nativeloc:'): BundleStorage {
  return {
    get: (k) => {
      try {
        return globalThis.localStorage.getItem(prefix + k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        globalThis.localStorage.setItem(prefix + k, v);
      } catch {
        /* storage full or blocked: keep working from memory */
      }
    },
  };
}

/**
 * Lookup order for `t(key)`: downloaded bundle for the locale → bundled fallback for the
 * locale → downloaded/bundled source language → the key itself. It never throws.
 */
export class NativeLoc {
  private opts: Required<Omit<NativeLocOptions, 'fallback'>> & { fallback: Record<string, Bundle> };
  private bundles: Record<string, Bundle> = {};
  private sourceLocale: string | null = null;
  private manifestEtag: string | undefined;
  private formatters = new Map<string, IntlMessageFormat>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Keys rendered since the last `beginScreen()`, for screenshot capture. */
  readonly rendered = new Set<string>();
  version = 0;

  constructor(options: NativeLocOptions) {
    this.opts = {
      storage: memoryStorage(),
      fetch: globalThis.fetch.bind(globalThis),
      fallback: {},
      ...options,
      baseUrl: options.baseUrl.replace(/\/$/, ''),
    };
  }

  get locale() {
    return this.opts.locale;
  }

  /** Load cached bundles, then try the network. Resolves even when offline. */
  async init(): Promise<this> {
    const meta = await this.opts.storage.get('meta');
    if (meta) {
      const m = JSON.parse(meta) as { sourceLocale: string; version: number; etag?: string };
      this.sourceLocale = m.sourceLocale;
      this.version = m.version;
      this.manifestEtag = m.etag;
    }
    for (const l of this.wanted()) {
      const raw = await this.opts.storage.get(`bundle:${l}`);
      if (raw) this.bundles[l] = (JSON.parse(raw) as CacheEntry).bundle;
    }
    await this.refresh().catch(() => false);
    return this;
  }

  private wanted() {
    return [...new Set([this.opts.locale, this.sourceLocale].filter((l): l is string => !!l))];
  }

  /** Check for a newer published version. Returns true when strings changed. */
  async refresh(): Promise<boolean> {
    const headers: Record<string, string> = this.manifestEtag ? { 'if-none-match': this.manifestEtag } : {};
    const res = await this.opts.fetch(`${this.opts.baseUrl}/b/${this.opts.bundleToken}/manifest.json`, { headers });
    if (res.status === 304 && this.wanted().every((l) => this.bundles[l])) return false;
    if (!res.ok && res.status !== 304) throw new Error(`NativeLoc manifest: HTTP ${res.status}`);
    const manifest = res.status === 304 ? null : ((await res.json()) as Manifest);
    if (!manifest) {
      // Cached manifest is current but a bundle is missing (e.g. locale switched): refetch fully.
      this.manifestEtag = undefined;
      return this.refresh();
    }
    this.sourceLocale = manifest.sourceLocale;
    let changed = false;
    for (const l of this.wanted()) {
      const info = manifest.locales[l];
      if (!info) continue;
      const cachedRaw = await this.opts.storage.get(`bundle:${l}`);
      const cached = cachedRaw ? (JSON.parse(cachedRaw) as CacheEntry) : null;
      if (cached?.sha256 === info.sha256 && this.bundles[l]) continue;
      const b = await this.opts.fetch(new URL(info.url, this.opts.baseUrl + '/').toString());
      if (!b.ok) continue;
      const bundle = (await b.json()) as Bundle;
      this.bundles[l] = bundle;
      await this.opts.storage.set(`bundle:${l}`, JSON.stringify({ sha256: info.sha256, bundle } satisfies CacheEntry));
      changed = true;
    }
    this.manifestEtag = res.headers.get('etag') ?? undefined;
    this.version = manifest.version;
    await this.opts.storage.set('meta', JSON.stringify({ sourceLocale: manifest.sourceLocale, version: manifest.version, etag: this.manifestEtag }));
    if (changed) {
      this.formatters.clear();
      this.listeners.forEach((fn) => fn());
    }
    return changed;
  }

  async setLocale(locale: string) {
    this.opts.locale = locale;
    this.formatters.clear();
    const raw = await this.opts.storage.get(`bundle:${locale}`);
    if (raw) this.bundles[locale] = (JSON.parse(raw) as CacheEntry).bundle;
    await this.refresh().catch(() => false);
    this.listeners.forEach((fn) => fn());
  }

  /** Re-check every `ms` (default 5 minutes). Cheap: unchanged manifests return 304. */
  startPolling(ms = 5 * 60_000) {
    this.stopPolling();
    this.timer = setInterval(() => void this.refresh().catch(() => false), ms);
  }
  stopPolling() {
    if (this.timer) clearInterval(this.timer);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private lookup(key: string): { message: string; locale: string } | null {
    const l = this.opts.locale;
    const s = this.sourceLocale ?? Object.keys(this.opts.fallback).find((x) => x !== l) ?? l;
    for (const [bundle, locale] of [
      [this.bundles[l], l],
      [this.opts.fallback[l], l],
      [this.bundles[s], s],
      [this.opts.fallback[s], s],
    ] as const) {
      const m = bundle?.[key];
      if (m !== undefined) return { message: m, locale };
    }
    return null;
  }

  has(key: string) {
    return this.lookup(key) !== null;
  }

  /** Translate `key`, formatting ICU placeholders and plurals with `args`. */
  t(key: string, args?: Record<string, unknown>): string {
    this.rendered.add(key);
    const found = this.lookup(key);
    if (!found) return key;
    const id = `${found.locale}\u0000${found.message}`;
    try {
      let f = this.formatters.get(id);
      if (!f) {
        f = new IntlMessageFormat(found.message, found.locale, undefined, { ignoreTag: true });
        this.formatters.set(id, f);
      }
      return String(f.format(args as Record<string, string | number>));
    } catch {
      return found.message;
    }
  }

  /** Start tracking which keys a screen renders (see `captureContext`). */
  beginScreen() {
    this.rendered.clear();
  }
}

export interface CaptureBox {
  key: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/**
 * Send a screenshot plus the keys on it (with pixel boxes when known) so localizers see
 * exactly where each string appears. Needs a project API token with the "push" scope;
 * use it from dev/test builds only.
 */
export async function captureContext(opts: {
  baseUrl: string;
  projectId: number;
  pushToken: string;
  image: Blob;
  label: string;
  keys: CaptureBox[];
  fetch?: typeof fetch;
}): Promise<{ id: number; missingKeys: string[] }> {
  const form = new FormData();
  form.set('label', opts.label);
  form.set('keys', JSON.stringify(opts.keys));
  form.set('file', opts.image, `${opts.label.replace(/\W+/g, '-') || 'screen'}.png`);
  const res = await (opts.fetch ?? fetch)(`${opts.baseUrl.replace(/\/$/, '')}/api/v1/projects/${opts.projectId}/screenshots`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.pushToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`NativeLoc capture failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: number; missingKeys: string[] };
}
