import { all, get, type DB } from '../db.js';

export function projectLocales(db: DB, projectId: number): string[] {
  return all<{ locale: string }>(db, 'SELECT locale FROM project_locales WHERE project_id = ? ORDER BY locale', projectId).map((r) => r.locale);
}

export interface LocaleProgress {
  locale: string;
  total: number;
  approved: number;
  /** Agreed by community review, waiting for the poster to publish. Not shipped yet. */
  ready: number;
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
    const ready = counts.ready ?? 0;
    const review = counts.review ?? 0;
    const outdated = counts.outdated ?? 0;
    return { locale, total, approved, ready, review, outdated, todo: total - approved - ready - review - outdated };
  });
}
