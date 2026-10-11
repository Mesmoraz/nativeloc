import { createHash } from 'node:crypto';
import {
  displayKey,
  getAdapter,
  listPlaceholders,
  pluralExamples,
  targetTemplate,
  toEditorModel,
  validateTranslation,
  type BundleManifest,
  type ExportEntry,
  type Issue,
  type SourceEntry,
} from '@nativeloc/core';
import { HttpError } from './auth.js';
import { all, get, run, tx, type DB, type KeyRow, type ProjectRow, type TranslationRow, type UserRow } from './db.js';
import { tierOf } from './trust.js';

export function projectLocales(db: DB, projectId: number): string[] {
  return all<{ locale: string }>(db, 'SELECT locale FROM project_locales WHERE project_id = ? ORDER BY locale', projectId).map((r) => r.locale);
}

// ---------- ingest ----------

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
        `UPDATE keys SET source = ?, prev_source = ?, description = ?, max_length = ?, meta = COALESCE(?, meta), archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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

// ---------- progress ----------

export interface LocaleProgress {
  locale: string;
  total: number;
  approved: number;
  review: number;
  outdated: number;
  todo: number;
}

export function progress(db: DB, projectId: number): LocaleProgress[] {
  const total = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM keys WHERE project_id = ? AND archived = 0', projectId)!.n;
  return projectLocales(db, projectId).map((locale) => {
    const counts = Object.fromEntries(
      all<{ status: string; n: number }>(
        db,
        `SELECT t.status, COUNT(*) AS n FROM translations t JOIN keys k ON k.id = t.key_id
         WHERE k.project_id = ? AND k.archived = 0 AND t.locale = ? GROUP BY t.status`,
        projectId, locale,
      ).map((r) => [r.status, r.n]),
    );
    const approved = counts.approved ?? 0;
    const review = counts.review ?? 0;
    const outdated = counts.outdated ?? 0;
    return { locale, total, approved, review, outdated, todo: total - approved - review - outdated };
  });
}

// ---------- localizer queue ----------

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const s = a.toLowerCase().slice(0, 300);
  const t = b.toLowerCase().slice(0, 300);
  if (!s.length || !t.length) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[t.length] / Math.max(s.length, t.length);
}

export interface Suggestion {
  source: string;
  text: string;
  score: number;
  origin: 'memory';
}

/** Translation memory: approved translations of similar source text anywhere in the org. */
function suggestionsFor(pool: { key_id: number; source: string; text: string }[], key: KeyRow): Suggestion[] {
  if (key.source.length > 300) return [];
  return pool
    .filter((p) => p.key_id !== key.id && Math.abs(p.source.length - key.source.length) <= Math.max(key.source.length, 10) * 0.5)
    .map((p) => ({ source: p.source, text: p.text, score: Math.round(similarity(p.source, key.source) * 100), origin: 'memory' as const }))
    .filter((s) => s.score >= 60)
    .sort((a, b) => b.score - a.score)
    .filter((s, i, arr) => arr.findIndex((o) => o.text === s.text) === i)
    .slice(0, 3);
}

export function screenshotContext(db: DB, keyId: number) {
  const shot = get<{ id: number; file: string; label: string | null; width: number; height: number; x: number | null; y: number | null; w: number | null; h: number | null }>(
    db,
    `SELECT s.id, s.file, s.label, s.width, s.height, sk.x, sk.y, sk.w, sk.h FROM screenshot_keys sk
     JOIN screenshots s ON s.id = sk.screenshot_id WHERE sk.key_id = ? ORDER BY (sk.x IS NULL), s.id DESC LIMIT 1`,
    keyId,
  );
  if (!shot) return null;
  return {
    id: shot.id,
    url: `/files/screenshots/${shot.file}`,
    label: shot.label,
    width: shot.width,
    height: shot.height,
    box: shot.x == null ? null : { x: shot.x, y: shot.y!, w: shot.w!, h: shot.h! },
  };
}

/** Peer reviewers never see their own work, or work they already approved. */
const PEER_FILTER = 'AND t.updated_by IS NOT ? AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.key_id = t.key_id AND v.locale = t.locale AND v.user_id = ?)';
/** A peer reviewer: a localizer on a peer-review project whose approval is one vote (leads approve outright). */
const isPeer = (db: DB, project: ProjectRow, locale: string, user?: UserRow) =>
  !!user && user.role === 'localizer' && project.peer_approvals > 0 && tierOf(db, user, locale) !== 'lead';

/** Translations in review that `user` can act on (for peers: not their own, not yet approved by them). */
export function reviewable(db: DB, project: ProjectRow, locale: string, user: UserRow): number {
  if (user.role === 'localizer' && tierOf(db, user, locale) === 'new') return 0;
  const peer = isPeer(db, project, locale, user);
  return get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM translations t JOIN keys k ON k.id = t.key_id
     WHERE k.project_id = ? AND k.archived = 0 AND t.locale = ? AND t.status = 'review' ${peer ? PEER_FILTER : ''}`,
    project.id, locale, ...(peer ? [user.id, user.id] : []),
  )!.n;
}

export function queue(
  db: DB,
  project: ProjectRow,
  locale: string,
  mode: 'translate' | 'review',
  opts: { limit?: number; exclude?: number[]; keyId?: number; viewer?: UserRow } = {},
) {
  const limit = Math.min(opts.limit ?? 20, 50);
  const exclude = (opts.exclude ?? []).filter(Number.isFinite);
  const peer = mode === 'review' && isPeer(db, project, locale, opts.viewer);
  const statusFilter = mode === 'review' ? `t.status = 'review' ${peer ? PEER_FILTER : ''}` : "(t.status IS NULL OR t.status = 'outdated')";
  // Keys that share a screen come together, so localizers stay in one visual context.
  const keys = all<KeyRow & { t_text: string | null; t_status: TranslationRow['status'] | null }>(
    db,
    `SELECT k.*, t.text AS t_text, t.status AS t_status FROM keys k
     LEFT JOIN translations t ON t.key_id = k.id AND t.locale = ?
     WHERE k.project_id = ? AND k.archived = 0
       ${opts.keyId ? 'AND k.id = ?' : `AND ${statusFilter}`}
       ${exclude.length ? `AND k.id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
     ORDER BY (SELECT MIN(screenshot_id) FROM screenshot_keys WHERE key_id = k.id) IS NULL,
              (SELECT MIN(screenshot_id) FROM screenshot_keys WHERE key_id = k.id), k.id
     LIMIT ?`,
    locale, project.id, ...(opts.keyId ? [opts.keyId] : peer ? [opts.viewer!.id, opts.viewer!.id] : []), ...exclude, limit,
  );

  const pool = all<{ key_id: number; source: string; text: string }>(
    db,
    `SELECT t.key_id, k.source, t.text FROM translations t JOIN keys k ON k.id = t.key_id JOIN projects p ON p.id = k.project_id
     WHERE p.org_id = ? AND t.locale = ? AND t.status = 'approved' LIMIT 5000`,
    project.org_id, locale,
  );
  const examples = pluralExamples(locale);

  const items = keys.map((k) => {
    const openQuestions = all<{ id: number; text: string; answer: string | null; user: string }>(
      db,
      `SELECT q.id, q.text, q.answer, u.name AS user FROM questions q JOIN users u ON u.id = q.user_id
       WHERE q.key_id = ? AND q.locale = ? ORDER BY q.id DESC LIMIT 5`,
      k.id, locale,
    );
    return {
      keyId: k.id,
      key: displayKey(k.name),
      source: k.source,
      prevSource: k.t_status === 'outdated' ? k.prev_source : null,
      description: k.description,
      maxLength: k.max_length,
      current: k.t_text != null ? { text: k.t_text, status: k.t_status } : null,
      sourceModel: toEditorModel(k.source),
      template: targetTemplate(k.source, k.t_text, locale),
      placeholders: listPlaceholders(k.source, (k.meta ? JSON.parse(k.meta).labels : undefined) ?? {}),
      pluralExamples: examples,
      screenshot: screenshotContext(db, k.id),
      suggestions: suggestionsFor(pool, k),
      questions: openQuestions,
      approvals: k.t_status === 'review' && project.peer_approvals > 0 ? { count: approvalCount(db, k.id, locale), needed: project.peer_approvals } : null,
    };
  });
  const p = progress(db, project.id).find((r) => r.locale === locale);
  return {
    project: { id: project.id, name: project.name, sourceLocale: project.source_locale, peerApprovals: project.peer_approvals },
    locale,
    mode,
    progress: p,
    items,
  };
}

// ---------- saving ----------

export function saveTranslation(db: DB, project: ProjectRow, user: UserRow, keyId: number, locale: string, text: string, approve: boolean) {
  const key = get<KeyRow>(db, 'SELECT * FROM keys WHERE id = ? AND project_id = ?', keyId, project.id);
  if (!key) throw new HttpError(404, 'String not found.');
  const issues: Issue[] = validateTranslation(key.source, text, { locale, maxLength: key.max_length });
  if (issues.some((i) => i.level === 'error')) throw new HttpError(422, issues.find((i) => i.level === 'error')!.message, { issues });
  const canApprove = user.role !== 'localizer' || tierOf(db, user, locale) === 'lead';
  const status = (approve && canApprove) || !project.require_review ? 'approved' : 'review';
  run(
    db,
    `INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key_id, locale) DO UPDATE SET text = excluded.text, status = excluded.status, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
    keyId, locale, text, status, user.id,
  );
  // Approvals were for the old wording.
  run(db, 'DELETE FROM votes WHERE key_id = ? AND locale = ?', keyId, locale);
  return { status, issues };
}

const approvalCount = (db: DB, keyId: number, locale: string) =>
  get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM votes WHERE key_id = ? AND locale = ?', keyId, locale)!.n;

/**
 * Reviewers, admins and leads approve outright. With peer review on, a trusted localizer's approval is one vote;
 * the translation is approved once `peer_approvals` people other than its author have approved it.
 */
export function approveTranslation(db: DB, project: ProjectRow, user: UserRow, keyId: number, locale: string) {
  const t = get<TranslationRow>(db, 'SELECT * FROM translations WHERE key_id = ? AND locale = ?', keyId, locale);
  if (!t) throw new HttpError(404, 'Nothing to approve yet.');
  if (!isPeer(db, project, locale, user)) {
    run(db, "UPDATE translations SET status = 'approved', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", user.id, keyId, locale);
    run(db, 'DELETE FROM votes WHERE key_id = ? AND locale = ?', keyId, locale);
    return { status: 'approved' as const };
  }
  if (t.status !== 'review') throw new HttpError(409, 'This one is no longer waiting for review.');
  if (t.updated_by === user.id) throw new HttpError(403, "You can't approve your own translation. Another volunteer will review it.");
  return tx(db, () => {
    run(db, 'INSERT OR IGNORE INTO votes (key_id, locale, user_id) VALUES (?, ?, ?)', keyId, locale, user.id);
    const count = approvalCount(db, keyId, locale);
    // The author keeps credit (updated_by) when peers approve.
    const status = count >= project.peer_approvals ? 'approved' : 'review';
    if (status === 'approved') run(db, "UPDATE translations SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", keyId, locale);
    return { status, approvals: { count, needed: project.peer_approvals } };
  });
}

// ---------- publish & export ----------

/** Outdated text still ships if it is structurally valid against the new source. */
const shippable = (r: { source: string; text: string | null; status: string | null }, locale: string) =>
  r.text != null &&
  (r.status === 'approved' || (r.status === 'outdated' && !validateTranslation(r.source, r.text, { locale }).some((i) => i.level === 'error')));

/** What a publish would ship right now for one language, translated keys only (no source fallback). */
export function liveTranslations(db: DB, project: ProjectRow, locale: string): Map<string, string> {
  const rows = all<{ name: string; source: string; text: string | null; status: string | null }>(
    db,
    `SELECT k.name, k.source, t.text, t.status FROM keys k JOIN translations t ON t.key_id = k.id AND t.locale = ?
     WHERE k.project_id = ? AND k.archived = 0`,
    locale, project.id,
  );
  return new Map(rows.filter((r) => shippable(r, locale)).map((r) => [r.name, r.text!]));
}

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
    const usable = shippable(r, locale);
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
