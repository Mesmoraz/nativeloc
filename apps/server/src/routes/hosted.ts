import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { escapeAttr, escapeHtml, translatePage } from '@nativeloc/site';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { get, type DB, type ProjectRow } from '../db.js';
import { liveTranslations, projectLocales } from '../services.js';

export interface HostedDeps {
  db: DB;
  /** For tests. */
  fetch?: typeof fetch;
  /**
   * Read sites on this machine or a private network (the local demo site). Off in production, so a saved
   * website address can't be used to make the server read internal services.
   */
  allowPrivate?: boolean;
}

const MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'NativeLocPreview/0.1 (volunteer translation preview)';

/**
 * Hosted copy, preview stage: /preview/{previewToken}/{locale}/{path} shows the organization's live page with
 * the translations volunteers have approved so far. Nothing is stored; every view reads the real site.
 *
 * The token is the only credential, the page is never indexed, and the site's own scripts run sandboxed
 * so they can't reach this server's cookies or API.
 */
export function hostedRoutes(app: FastifyInstance, { db, fetch: doFetch = fetch, allowPrivate = process.env.NODE_ENV !== 'production' }: HostedDeps) {
  const projectFor = (token: string) => {
    const p = get<ProjectRow>(db, 'SELECT * FROM projects WHERE preview_token = ?', token);
    return p?.site_url ? p : null;
  };

  app.get<{ Params: { token: string } }>('/preview/:token', async (req, reply) => reply.redirect(`/preview/${encodeURIComponent(req.params.token)}/`));

  app.get<{ Params: { token: string } }>('/preview/:token/', async (req, reply) => {
    const p = projectFor(req.params.token);
    if (!p) return notFound(reply);
    const links = projectLocales(db, p.id)
      .map((l) => `<li><a href="${escapeAttr(l)}/" lang="${escapeAttr(l)}">${escapeHtml(nativeName(l))}</a> <span>${escapeHtml(englishName(l))}</span></li>`)
      .join('');
    return sendPage(reply, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(p.name)}: translated preview</title><style>${PAGE_CSS}</style></head>
<body><main><p class="tag">Private preview</p><h1>${escapeHtml(p.name)}</h1>
<p>Pick a language to see <a href="${escapeAttr(p.site_url!)}">${escapeHtml(new URL(p.site_url!).host)}</a> with the translations community volunteers have checked so far. Text that isn't translated yet stays in English.</p>
<ul>${links || '<li>No languages yet.</li>'}</ul></main></body></html>`);
  });

  app.get<{ Params: { token: string; locale: string } }>('/preview/:token/:locale', async (req, reply) =>
    reply.redirect(`/preview/${encodeURIComponent(req.params.token)}/${encodeURIComponent(req.params.locale)}/`),
  );

  app.get<{ Params: { token: string; locale: string } }>('/preview/:token/:locale/*', async (req, reply) => {
    const { token, locale } = req.params;
    const p = projectFor(token);
    if (!p || !projectLocales(db, p.id).includes(locale)) return notFound(reply);
    const site = new URL(p.site_url!);

    // The rest of the raw URL is the page on the organization's site. Build it on the site's own origin so
    // no path can point the server anywhere else.
    const prefix = `/preview/${token}/${locale}`;
    const rest = req.url.slice(req.url.indexOf(prefix) + prefix.length) || '/';
    const target = new URL(site.origin);
    const q = rest.indexOf('?');
    target.pathname = q < 0 ? rest : rest.slice(0, q);
    target.search = q < 0 ? '' : rest.slice(q);

    const here = `${req.protocol}://${req.host}`;
    const proxied = (u: URL, lang = locale) =>
      sameSite(u, site) ? `${here}/preview/${encodeURIComponent(token)}/${encodeURIComponent(lang)}${u.pathname}${u.search}${u.hash}` : null;

    let res: Response;
    try {
      if (!allowPrivate && (await isPrivateHost(target.hostname))) return sendPage(reply, 403, errorPage(`${site.host} isn't a public website.`));
      res = await doFetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': p.source_locale },
      });
    } catch {
      return sendPage(reply, 502, errorPage(`We couldn't reach ${site.host} just now. Try again in a minute.`));
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const to = new URL(res.headers.get('location')!, target);
      return reply.redirect(proxied(to) ?? to.href);
    }
    // Images, PDFs and anything else that isn't a page: send the visitor to the original.
    if (!/html/i.test(res.headers.get('content-type') ?? '')) return reply.redirect(target.href);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return reply.redirect(target.href);

    const translations = liveTranslations(db, p, locale);
    const others = projectLocales(db, p.id).filter((l) => l !== locale);
    const page = translatePage(decode(bytes, res.headers.get('content-type')), {
      url: target.href,
      locale,
      translations,
      linkFor: (u) => proxied(u),
      head: '<meta name="robots" content="noindex, nofollow">',
      banner: banner({ locale, others: others.map((l) => ({ locale: l, href: proxied(target, l)! })), original: target.href }),
    });
    reply
      .header('x-robots-tag', 'noindex, nofollow')
      // Opaque origin: the site's scripts run, but can't read this server's cookies or call its API.
      .header('content-security-policy', 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation')
      // The preview token is in the address; don't hand it to the site's servers or its analytics.
      .header('referrer-policy', 'no-referrer')
      .header('x-nativeloc-translated', `${page.translated}/${page.strings}`);
    return sendPage(reply, res.status === 200 ? 200 : res.status, page.html);
  });
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  return !addresses.length || addresses.some(isPrivateAddress);
}

/** Loopback, private, link-local (cloud metadata), carrier-grade NAT and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

const sameSite = (a: URL, b: URL) => /^https?:$/.test(a.protocol) && a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');

function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const sendPage = (reply: FastifyReply, status: number, html: string) =>
  reply.code(status).header('cache-control', 'private, no-store').type('text/html; charset=utf-8').send(html);

const notFound = (reply: FastifyReply) =>
  sendPage(reply.header('x-robots-tag', 'noindex, nofollow'), 404, errorPage('This preview link isn\'t active. Ask the person who sent it for a new one.'));

function errorPage(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Preview unavailable</title><style>${PAGE_CSS}</style></head>
<body><main><p class="tag">Private preview</p><p>${escapeHtml(message)}</p></main></body></html>`;
}

function nativeName(locale: string) {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return locale;
  }
}
function englishName(locale: string) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** A strip across the top of the page. Inline styles with `all: initial` so the site's CSS can't restyle it. */
function banner({ locale, others, original }: { locale: string; others: { locale: string; href: string }[]; original: string }) {
  const box = "all:initial;display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;position:sticky;top:0;z-index:2147483647;box-sizing:border-box;width:100%;padding:8px 16px;background:#1f2937;color:#f9fafb;font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif";
  const link = 'all:initial;color:#93c5fd;font:inherit;text-decoration:underline;cursor:pointer';
  const tag = 'all:initial;font:600 12px/1.4 system-ui,sans-serif;color:#1f2937;background:#fcd34d;padding:2px 8px;border-radius:999px';
  const text = 'all:initial;font:inherit;color:inherit';
  const langs = others.map((o) => `<a style="${link}" href="${escapeAttr(o.href)}" lang="${escapeAttr(o.locale)}">${escapeHtml(nativeName(o.locale))}</a>`).join(' ');
  return `<div style="${box}" translate="no" role="region" aria-label="Translation preview">
<span style="${tag}">Preview</span>
<span style="${text}">${escapeHtml(nativeName(locale))} · translated by community volunteers. Not public yet.</span>
${langs ? `<span style="${text}">Also in: ${langs}</span>` : ''}
<a style="${link}" href="${escapeAttr(original)}">View original</a>
</div>`;
}

const PAGE_CSS = `body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827;background:#f9fafb}
main{max-width:560px;margin:48px auto;padding:0 16px}h1{font-size:24px;margin:0 0 8px}a{color:#1d4ed8}
.tag{display:inline-block;font-size:12px;font-weight:600;background:#fcd34d;border-radius:999px;padding:2px 8px;margin:0}
ul{list-style:none;padding:0}li{padding:8px 0;border-bottom:1px solid #e5e7eb}li a{font-size:18px;margin-right:8px}li span{color:#6b7280}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f9fafb}a{color:#93c5fd}li{border-color:#374151}li span{color:#9ca3af}}`;
