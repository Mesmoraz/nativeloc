import { getAdapter, validateTranslation, type SourceEntry } from '@nativeloc/core';
import { HttpError } from '../auth.js';
import { all, get, run, tx, type DB, type KeyRow, type ProjectRow } from '../db.js';
import { projectLocales } from './progress.js';

// Every way strings come in (CLI push, file import, paste, website crawl) goes through upsertEntries.

export interface UpsertResult {
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  translations: number;
  skipped: string[];
}

/**
 * Upsert source keys, or (when `locale` is a target language) import existing translations.
 * Changing a key's source marks its translations "outdated" so localizers revisit them.
 */
export function upsertEntries(db: DB, project: ProjectRow, entries: SourceEntry[], opts: { locale?: string; prune?: boolean; userId?: number } = {}): UpsertResult {
  const result: UpsertResult = { created: 0, updated: 0, unchanged: 0, archived: 0, translations: 0, skipped: [] };
  const locale = opts.locale && opts.locale !== project.source_locale ? opts.locale : undefined;

  return tx(db, () => {
    if (locale) {
      if (!projectLocales(db, project.id).includes(locale)) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', project.id, locale);
      for (const e of entries) {
        const key = get<KeyRow>(db, 'SELECT * FROM keys WHERE project_id = ? AND name = ?', project.id, e.key);
        const text = e.translation ?? e.source;
        if (!key || !text) {
          result.skipped.push(e.key);
          continue;
        }
        const errors = validateTranslation(key.source, text, { locale }).filter((i) => i.level === 'error');
        run(
          db,
          `INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (key_id, locale) DO UPDATE SET text = excluded.text, status = excluded.status, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
          key.id, locale, text, errors.length ? 'review' : 'approved', opts.userId ?? null,
        );
        result.translations++;
      }
      return result;
    }

    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.key || typeof e.source !== 'string') throw new HttpError(400, 'Each entry needs a "key" and a "source".');
      seen.add(e.key);
      const meta = e.meta ? JSON.stringify(e.meta) : null;
      const existing = get<KeyRow>(db, 'SELECT * FROM keys WHERE project_id = ? AND name = ?', project.id, e.key);
      if (!existing) {
        run(db, 'INSERT INTO keys (project_id, name, source, description, max_length, meta) VALUES (?, ?, ?, ?, ?, ?)', project.id, e.key, e.source, e.description ?? null, e.maxLength ?? null, meta);
        result.created++;
        continue;
      }
      const changed = existing.source !== e.source;
      const description = e.description ?? existing.description;
      const maxLength = e.maxLength ?? existing.max_length;
      if (!changed && description === existing.description && maxLength === existing.max_length && (meta ?? existing.meta) === existing.meta && !existing.archived) {
        result.unchanged++;
        continue;
      }
      run(
        db,
        `UPDATE keys SET source = ?, prev_source = ?, description = ?, max_length = ?, meta = COALESCE(?, meta), archived = 0, updated_at = CURRENT_TIMESTAMP${changed ? ', source_changed_at = CURRENT_TIMESTAMP' : ''} WHERE id = ?`,
        e.source, changed ? existing.source : existing.prev_source, description, maxLength, meta, existing.id,
      );
      if (changed) run(db, "UPDATE translations SET status = 'outdated' WHERE key_id = ?", existing.id);
      result.updated++;
    }
    if (opts.prune) {
      for (const k of all<KeyRow>(db, 'SELECT id, name FROM keys WHERE project_id = ? AND archived = 0', project.id)) {
        if (!seen.has(k.name)) {
          run(db, 'UPDATE keys SET archived = 1 WHERE id = ?', k.id);
          result.archived++;
        }
      }
    }
    return result;
  });
}

export function importFile(db: DB, project: ProjectRow, content: string, format: string, opts: { locale?: string; prune?: boolean; userId?: number }) {
  const adapter = getAdapter(format);
  let parsed;
  try {
    parsed = adapter.parse(content, opts.locale);
  } catch (e) {
    throw new HttpError(400, `Could not read the file as ${adapter.label}: ${(e as Error).message}`);
  }
  const locale = opts.locale || parsed.locale?.replace('_', '-') || undefined;
  const isTarget = !!locale && locale !== project.source_locale;
  const carriesSource = parsed.entries.some((e) => e.translation);
  if (!isTarget) return { ...upsertEntries(db, project, parsed.entries, opts), entries: parsed.entries.length };
  if (!carriesSource) return { ...upsertEntries(db, project, parsed.entries, { ...opts, locale }), entries: parsed.entries.length };
  // A filled-in .po carries both the source strings (msgid) and their translations (msgstr).
  const res = upsertEntries(db, project, parsed.entries, { prune: opts.prune });
  res.translations = upsertEntries(db, project, parsed.entries.filter((e) => e.translation), { locale, userId: opts.userId }).translations;
  return { ...res, entries: parsed.entries.length };
}
