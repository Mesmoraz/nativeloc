import type { SourceEntry } from '@nativeloc/core';
import type { CrawledPage } from './crawl.js';

export interface SiteSummary {
  pages: number;
  strings: number;
  words: number;
  /** Words on the pages people come to for help (priority > 0); these get translated first. */
  priorityWords: number;
}

export const wordCount = (icu: string) => icu.replace(/\{[^{}]*\}/g, ' ').split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

/**
 * One entry per distinct text across the site, in crawl order (most important pages first), so the
 * translation queue follows that order. Text shared by many pages (menus, footers) appears once.
 */
export function siteEntries(pages: CrawledPage[]): { entries: SourceEntry[]; summary: SiteSummary } {
  const byKey = new Map<string, { entry: SourceEntry; paths: string[]; roles: Set<string> }>();
  let priorityWords = 0;
  for (const page of pages) {
    for (const s of page.segments) {
      const found = byKey.get(s.key);
      if (found) {
        if (!found.paths.includes(page.path)) found.paths.push(page.path);
        found.roles.add(s.role);
        continue;
      }
      if (page.priority > 0) priorityWords += wordCount(s.source);
      byKey.set(s.key, {
        entry: { key: s.key, source: s.source, meta: Object.keys(s.labels).length ? { labels: s.labels } : undefined },
        paths: [page.path],
        roles: new Set([s.role]),
      });
    }
  }
  const entries = [...byKey.values()].map(({ entry, paths, roles }) => {
    const where = paths.length > 3 ? `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more pages` : paths.join(', ');
    const what = [...roles].slice(0, 2).join(' / ');
    return {
      ...entry,
      description: `${what.charAt(0).toUpperCase()}${what.slice(1)}. Website text on ${where}.`,
      meta: { ...entry.meta, pages: paths },
    };
  });
  const words = entries.reduce((n, e) => n + wordCount(e.source), 0);
  return { entries, summary: { pages: pages.length, strings: entries.length, words, priorityWords } };
}
