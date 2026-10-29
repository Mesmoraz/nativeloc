import { createHash } from 'node:crypto';
import { getAdapter, validateTranslation, type BundleManifest, type ExportEntry } from '@nativeloc/core';
import { all, get, run, tx, type DB, type ProjectRow } from '../db.js';
import { projectLocales } from './progress.js';

// Bundles ship only 'approved' text (and still-valid 'outdated' text), with a quality label per language.

/**
 * Outdated text still ships if it is structurally valid against the new source. Community text goes outdated from
 * 'review' or 'ready' too, so there it ships only if the poster published it before (`shipped`).
 */
const shippable = (r: { name: string; source: string; text: string | null; status: string | null }, locale: string, shipped: Record<string, string> | null) =>
  r.text != null &&
  (r.status === 'approved' ||
    (r.status === 'outdated' && (!shipped || shipped[r.name] === r.text) && !validateTranslation(r.source, r.text, { locale }).some((i) => i.level === 'error')));

/** What a publish would ship right now for one language, translated keys only (no source fallback). */
export function liveTranslations(db: DB, project: ProjectRow, locale: string): Map<string, string> {
  const rows = all<{ name: string; source: string; text: string | null; status: string | null }>(
    db,
    `SELECT k.name, k.source, t.text, t.status FROM keys k JOIN translations t ON t.key_id = k.id AND t.locale = ?
     WHERE k.project_id = ? AND k.archived = 0`,
    locale, project.id,
  );
  const shipped = project.review_mode === 'community' ? lastShipped(db, project, locale) : null;
  return new Map(rows.filter((r) => shippable(r, locale, shipped)).map((r) => [r.name, r.text!]));
}

function bundleFor(db: DB, project: ProjectRow, locale: string) {
  const rows = all<{ name: string; source: string; text: string | null; status: string | null }>(
    db,
    `SELECT k.name, k.source, t.text, t.status FROM keys k LEFT JOIN translations t ON t.key_id = k.id AND t.locale = ?
     WHERE k.project_id = ? AND k.archived = 0 ORDER BY k.name`,
    locale, project.id,
  );
  const isSource = locale === project.source_locale;
  const shipped = project.review_mode === 'community' ? lastShipped(db, project, locale) : null;
  const out: Record<string, string> = {};
  let done = 0;
  for (const r of rows) {
    const usable = shippable(r, locale, shipped);
    if (isSource) {
      out[r.name] = r.source;
      done++;
    } else if (usable) {
      out[r.name] = r.text!;
      if (r.status === 'approved') done++;
    } else {
      out[r.name] = r.source;
    }
  }
  return { body: JSON.stringify(out), completeness: rows.length ? done / rows.length : 1 };
}

/** The bundle of the current release for `locale` (empty before the first publish). */
function lastShipped(db: DB, project: ProjectRow, locale: string): Record<string, string> {
  const rel = get<{ body: string }>(db, 'SELECT body FROM releases WHERE project_id = ? AND version = ? AND locale = ?', project.id, project.version, locale);
  return rel ? JSON.parse(rel.body) : {};
}

/**
 * The quality label: 'verified' for standard review (the org's reviewers, leads, trusted peers), 'community' for
 * community review. Shown as "Checked by N native speakers" or "Community-reviewed, not verified".
 */
export const qualityOf = (project: ProjectRow): 'verified' | 'community' => (project.review_mode === 'community' ? 'community' : 'verified');

/** Distinct people who reviewed the approved text in `locale`: outright approvers, peer votes and community reviews. */
export function reviewerCount(db: DB, project: ProjectRow, locale: string): number {
  if (locale === project.source_locale) return 0;
  const shipping = `SELECT t.key_id FROM translations t JOIN keys k ON k.id = t.key_id
                    WHERE k.project_id = ? AND k.archived = 0 AND t.locale = ? AND t.status = 'approved'`;
  return get<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT user_id) AS n FROM (
       SELECT user_id FROM approvers WHERE locale = ? AND key_id IN (${shipping})
       UNION SELECT user_id FROM votes WHERE locale = ? AND key_id IN (${shipping})
       UNION SELECT user_id FROM reviews WHERE locale = ? AND counts = 1 AND kind IN ('approve', 'flag', 'improve') AND key_id IN (${shipping}))`,
    locale, project.id, locale, locale, project.id, locale, locale, project.id, locale,
  )!.n;
}

export function publish(db: DB, project: ProjectRow): BundleManifest {
  const locales = [project.source_locale, ...projectLocales(db, project.id).filter((l) => l !== project.source_locale)];
  return tx(db, () => {
    const version = project.version + 1;
    for (const locale of locales) {
      const { body, completeness } = bundleFor(db, project, locale);
      const hash = createHash('sha256').update(body).digest('hex');
      run(db, 'INSERT INTO releases (project_id, version, locale, sha256, body, completeness) VALUES (?, ?, ?, ?, ?, ?)', project.id, version, locale, hash, body, completeness);
      run(db, 'INSERT OR REPLACE INTO release_quality (project_id, version, locale, quality, reviewers) VALUES (?, ?, ?, ?, ?)', project.id, version, locale, qualityOf(project), reviewerCount(db, project, locale));
    }
    run(db, 'UPDATE projects SET version = ? WHERE id = ?', version, project.id);
    return manifest(db, { ...project, version })!;
  });
}

export function manifest(db: DB, project: ProjectRow): BundleManifest | null {
  if (!project.version) return null;
  // Releases from before quality labels existed get the project's label as it is now.
  const rows = all<{ locale: string; sha256: string; completeness: number; created_at: string; quality: 'verified' | 'community' | null; reviewers: number | null }>(
    db,
    `SELECT r.locale, r.sha256, r.completeness, r.created_at, q.quality, q.reviewers FROM releases r
     LEFT JOIN release_quality q ON q.project_id = r.project_id AND q.version = r.version AND q.locale = r.locale
     WHERE r.project_id = ? AND r.version = ?`,
    project.id, project.version,
  );
  return {
    project: project.name,
    version: project.version,
    sourceLocale: project.source_locale,
    publishedAt: rows[0] ? new Date(rows[0].created_at + 'Z').toISOString() : new Date().toISOString(),
    locales: Object.fromEntries(
      // The content hash in the URL keeps HTTP caches from serving an older bundle under a newer manifest.
      rows.map((r) => [r.locale, { sha256: r.sha256, url: `/b/${project.bundle_token}/${r.locale}.json?h=${r.sha256.slice(0, 16)}`, completeness: Math.round(r.completeness * 1000) / 1000,
        quality: r.quality ?? qualityOf(project),
        reviewers: r.reviewers ?? reviewerCount(db, project, r.locale),
      }]),
    ),
  };
}

export function exportFile(db: DB, project: ProjectRow, format: string, locale: string): string {
  const adapter = getAdapter(format);
  const isSource = locale === project.source_locale;
  const rows = all<{ name: string; source: string; description: string | null; meta: string | null; text: string | null; status: string | null }>(
    db,
    `SELECT k.name, k.source, k.description, k.meta, t.text, t.status FROM keys k
     LEFT JOIN translations t ON t.key_id = k.id AND t.locale = ?
     WHERE k.project_id = ? AND k.archived = 0 ORDER BY k.id`,
    locale, project.id,
  );
  const entries: ExportEntry[] = rows.map((r) => ({
    key: r.name,
    source: r.source,
    description: r.description,
    meta: r.meta ? JSON.parse(r.meta) : null,
    text: isSource ? r.source : r.status === 'approved' ? r.text : null,
  }));
  return adapter.serialize(entries, locale);
}
