import { createHash } from 'node:crypto';
import { getAdapter, validateTranslation, type BundleManifest, type ExportEntry } from '@nativeloc/core';
import { all, run, tx, type DB, type ProjectRow } from '../db.js';
import { projectLocales } from './progress.js';

// Owned by Segment 2 piece 2C (community review engine): bundles ship only 'approved' text; quality labels go here.

function bundleFor(db: DB, project: ProjectRow, locale: string) {
  const rows = all<{ name: string; source: string; text: string | null; status: string | null }>(
    db,
    `SELECT k.name, k.source, t.text, t.status FROM keys k LEFT JOIN translations t ON t.key_id = k.id AND t.locale = ?
     WHERE k.project_id = ? AND k.archived = 0 ORDER BY k.name`,
    locale, project.id,
  );
  const isSource = locale === project.source_locale;
  const out: Record<string, string> = {};
  let done = 0;
  for (const r of rows) {
    // Outdated text still ships if it is structurally valid against the new source.
    const usable =
      r.text != null &&
      (r.status === 'approved' || (r.status === 'outdated' && !validateTranslation(r.source, r.text, { locale }).some((i) => i.level === 'error')));
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

export function publish(db: DB, project: ProjectRow): BundleManifest {
  const locales = [project.source_locale, ...projectLocales(db, project.id).filter((l) => l !== project.source_locale)];
  return tx(db, () => {
    const version = project.version + 1;
    for (const locale of locales) {
      const { body, completeness } = bundleFor(db, project, locale);
      const hash = createHash('sha256').update(body).digest('hex');
      run(db, 'INSERT INTO releases (project_id, version, locale, sha256, body, completeness) VALUES (?, ?, ?, ?, ?, ?)', project.id, version, locale, hash, body, completeness);
    }
    run(db, 'UPDATE projects SET version = ? WHERE id = ?', version, project.id);
    return manifest(db, { ...project, version })!;
  });
}

export function manifest(db: DB, project: ProjectRow): BundleManifest | null {
  if (!project.version) return null;
  const rows = all<{ locale: string; sha256: string; completeness: number; created_at: string }>(
    db,
    'SELECT locale, sha256, completeness, created_at FROM releases WHERE project_id = ? AND version = ?',
    project.id, project.version,
  );
  return {
    project: project.name,
    version: project.version,
    sourceLocale: project.source_locale,
    publishedAt: rows[0] ? new Date(rows[0].created_at + 'Z').toISOString() : new Date().toISOString(),
    locales: Object.fromEntries(
      // The content hash in the URL keeps HTTP caches from serving an older bundle under a newer manifest.
      rows.map((r) => [r.locale, { sha256: r.sha256, url: `/b/${project.bundle_token}/${r.locale}.json?h=${r.sha256.slice(0, 16)}`, completeness: Math.round(r.completeness * 1000) / 1000 }]),
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
