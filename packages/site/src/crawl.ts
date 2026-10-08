import { readPage, type ParsedPage } from './html.js';

export interface CrawlOptions {
  /** Stop after this many HTML pages (default 30). */
  maxPages?: number;
  /** Pause between requests, to be polite to small nonprofit servers (default 500 ms). */
  delayMs?: number;
  fetch?: typeof fetch;
  userAgent?: string;
  onPage?: (page: CrawledPage, index: number) => void;
}

export interface CrawledPage extends ParsedPage {
  path: string;
  depth: number;
  priority: number;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** PDFs and documents linked from the site: often flyers and intake forms worth translating too. */
  documents: string[];
  /** URLs robots.txt asked us not to read. */
  disallowed: string[];
  errors: { url: string; error: string }[];
}

/**
 * Pages people come to for help get translated first. Weights apply to the path and the link text.
 * Positive: client-facing essentials. Negative: content that matters less to someone looking for help.
 */
const PRIORITY: [RegExp, number][] = [
  [/get[-_ ]?help|need[-_ ]?help|find[-_ ]?help|services?|programs?|resources?/i, 4],
  [/food|pantry|meals?|groceries|housing|shelter|rent|utilit|clinic|health|medical|legal|immigra|youth|senior/i, 4],
  [/hours|locations?|visit|directions|contact|apply|eligib|sign[-_ ]?up|register|appointment|intake|faq|emergency|crisis/i, 3],
  [/about|who[-_ ]?we[-_ ]?are|mission/i, 1],
  [/blog|news|press|stories|events?|calendar|careers?|jobs|staff|board|annual[-_ ]?report|financials|privacy|terms|policy|sitemap|login|cart|shop|tag\/|category\/|author\/|feed|page\/\d+|\d{4}\/\d{2}/i, -4],
];
const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|odt|rtf)$/i;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|mp[34]|mov|avi|zip|gz|css|js|json|xml|txt|ics|woff2?|ttf)$/i;

export function priorityOf(url: URL, linkText = ''): number {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path.
  }
  const hay = `${path} ${linkText}`;
  let score = 0;
  for (const [re, w] of PRIORITY) if (re.test(hay)) score += w;
  return score;
}

const sameSite = (a: URL, b: URL) => /^https?:$/.test(a.protocol) && a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');

function normalize(u: URL): string {
  const n = new URL(u.href);
  n.hash = '';
  for (const k of [...n.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) n.searchParams.delete(k);
  if (n.pathname !== '/' && n.pathname.endsWith('/')) n.pathname = n.pathname.slice(0, -1);
  return n.href;
}

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

/**
 * The robots.txt rules that apply to us (RFC 9309): the group naming our agent if there is one,
 * otherwise the "*" group.
 */
export function robotsRules(txt: string, agent = 'nativeloc'): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  for (const raw of txt.split(/\r?\n/)) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(raw.replace(/#.*/, '').trim());
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if (current && (field === 'allow' || field === 'disallow') && value) {
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  return (ours.length ? ours : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
}

/** Whether `pathAndQuery` may be read: the longest matching rule wins, and Allow wins a tie. */
export function robotsAllows(rules: RobotsRule[], pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    const anchored = rule.pattern.endsWith('$');
    const body = anchored ? rule.pattern.slice(0, -1) : rule.pattern;
    const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
    if (!re.test(pathAndQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return !best || best.allow;
}

/** Read a site page by page, most important pages first, staying on the same site. */
export async function crawl(start: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const doFetch = opts.fetch ?? fetch;
  const maxPages = opts.maxPages ?? 30;
  const delay = opts.delayMs ?? 500;
  const headers = { 'user-agent': opts.userAgent ?? 'NativeLocBot/0.1 (volunteer translation for nonprofits)', accept: 'text/html' };
  const origin = new URL(start);
  const result: CrawlResult = { pages: [], documents: [], disallowed: [], errors: [] };

  let rules: RobotsRule[] = [];
  try {
    const r = await doFetch(new URL('/robots.txt', origin).href, { headers });
    if (r.ok) rules = robotsRules(await r.text());
  } catch {
    // No robots.txt: everything is allowed.
  }
  const allowed = (u: URL) => robotsAllows(rules, u.pathname + u.search);

  const seen = new Set<string>();
  const read = new Set<string>();
  const queue: { url: string; depth: number; priority: number }[] = [{ url: normalize(origin), depth: 0, priority: 100 }];
  seen.add(queue[0].url);
  let fetched = 0;

  while (queue.length && result.pages.length < maxPages) {
    // Highest priority first; shallower pages break ties.
    queue.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    const item = queue.shift()!;
    const url = new URL(item.url);
    if (!allowed(url)) {
      result.disallowed.push(item.url);
      continue;
    }
    if (fetched++) await new Promise((r) => setTimeout(r, delay));
    let page: ParsedPage;
    try {
      const res = await doFetch(item.url, { headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!(res.headers.get('content-type') ?? '').includes('html')) continue;
      const finalUrl = res.url || item.url;
      if (!sameSite(new URL(finalUrl), origin)) continue;
      // Several links can redirect to one page; read it once.
      const landed = normalize(new URL(finalUrl));
      if (read.has(landed)) continue;
      read.add(landed);
      page = readPage(await res.text(), finalUrl);
    } catch (e) {
      result.errors.push({ url: item.url, error: (e as Error).message });
      continue;
    }
    const crawled: CrawledPage = { ...page, path: new URL(page.url).pathname, depth: item.depth, priority: item.priority };
    result.pages.push(crawled);
    opts.onPage?.(crawled, result.pages.length);

    for (const link of page.links) {
      let u: URL;
      try {
        u = new URL(link.url);
      } catch {
        continue;
      }
      if (!sameSite(u, origin)) continue;
      const key = normalize(u);
      if (seen.has(key)) continue;
      seen.add(key);
      if (DOC_EXT.test(u.pathname)) result.documents.push(key);
      else if (!SKIP_EXT.test(u.pathname)) queue.push({ url: key, depth: item.depth + 1, priority: priorityOf(u, link.text) - item.depth });
    }
  }
  return result;
}
