import { displayKey, listPlaceholders, pluralExamples, targetTemplate, toEditorModel } from '@nativeloc/core';
import { all, get, type DB, type KeyRow, type Member, type ProjectRow, type TranslationRow } from '../db.js';
import { progress } from './progress.js';
import { approvalCount, reviewFilter, reviewOf, sendBackNote } from './review.js';

// Owned by Segment 2 piece 2C (community review engine): which strings a Translate or Review queue offers.
// The volunteer session builder (2E) consumes queue() as is.

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

/**
 * The strings a Translate or Review queue offers. Peer reviewers never see their own work, or work they already
 * reviewed (reviewFilter). `exclude` drops keys; `keyId` asks for one key whatever its status.
 */
export function queue(
  db: DB,
  project: ProjectRow,
  locale: string,
  mode: 'translate' | 'review',
  opts: { limit?: number; exclude?: number[]; keyId?: number; viewer?: Member } = {},
) {
  const limit = Math.min(opts.limit ?? 20, 50);
  const exclude = (opts.exclude ?? []).filter(Number.isFinite);
  const filter = mode === 'review' ? reviewFilter(db, project, locale, opts.viewer) : { sql: '', params: [] };
  const statusFilter = mode === 'review' ? `t.status = 'review' ${filter.sql}` : "(t.status IS NULL OR t.status = 'outdated')";
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
    locale, project.id, ...(opts.keyId ? [opts.keyId] : filter.params), ...exclude, limit,
  );

  const pool = all<{ key_id: number; source: string; text: string }>(
    db,
    `SELECT t.key_id, k.source, t.text FROM translations t JOIN keys k ON k.id = t.key_id JOIN projects p ON p.id = k.project_id
     WHERE p.org_id = ? AND t.locale = ? AND t.status = 'approved' LIMIT 5000`,
    project.org_id, locale,
  );
  const examples = pluralExamples(locale);
  const community = project.review_mode === 'community';

  const items = keys.map((k) => {
    const openQuestions = all<{ id: number; text: string; answer: string | null; user: string }>(
      db,
      `SELECT q.id, q.text, q.answer, u.name AS user FROM questions q JOIN users u ON u.id = q.user_id
       WHERE q.key_id = ? AND q.locale = ? ORDER BY q.id DESC LIMIT 5`,
      k.id, locale,
    );
    // Community review: where the string stands, and the poster's note when they sent it back.
    const review = community && (k.t_status === 'review' || k.t_status === 'ready') ? reviewOf(db, k.id, locale) : null;
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
      approvals: review
        ? k.t_status === 'review' ? { count: review.approvals, needed: review.needed } : null
        : k.t_status === 'review' && project.peer_approvals > 0 ? { count: approvalCount(db, k.id, locale), needed: project.peer_approvals } : null,
      review,
      ...(community ? { sentBack: review ? sendBackNote(db, k.id, locale) : null } : {}),
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

