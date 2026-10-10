import { HttpError } from '../auth.js';
import { get, run, type DB, type ProjectRow } from '../db.js';

export type ReportReason = 'spam' | 'commercial' | 'harmful';
export const REPORT_REASONS: ReportReason[] = ['spam', 'commercial', 'harmful'];

/** Distinct people with open reports that pause an approved project (plan: "three reports pause the project"). */
export const PAUSE_REPORTS = 3;

const openReporters = (db: DB, projectId: number) =>
  get<{ n: number }>(db, 'SELECT COUNT(DISTINCT user_id) AS n FROM project_reports WHERE project_id = ? AND resolved_at IS NULL', projectId)?.n ?? 0;

export const pausedByReports = (db: DB, projectId: number) => openReporters(db, projectId) >= PAUSE_REPORTS;

/**
 * Files a report (or replaces the reporter's open one on this project). When PAUSE_REPORTS different people have
 * open reports on an approved project, it goes back to 'pending' for staff, and `paused` is true for the report
 * that did it. Reports on projects that aren't approved are kept for staff and change nothing.
 * Other pieces can call this too (e.g. 2C turning a new volunteer's flag into a report).
 */
export function fileReport(db: DB, userId: number, project: ProjectRow, report: { keyId?: number | null; reason: ReportReason; note?: string | null }): { paused: boolean } {
  // No transaction of its own (callers may be in one); node:sqlite runs these back to back on one connection.
  run(db, 'DELETE FROM project_reports WHERE project_id = ? AND user_id = ? AND resolved_at IS NULL', project.id, userId);
  run(
    db,
    'INSERT INTO project_reports (project_id, key_id, user_id, reason, note) VALUES (?, ?, ?, ?, ?)',
    project.id,
    report.keyId ?? null,
    userId,
    report.reason,
    report.note ?? null,
  );
  const moderation = get<{ moderation: string }>(db, 'SELECT moderation FROM projects WHERE id = ?', project.id)?.moderation;
  if (moderation !== 'approved' || !pausedByReports(db, project.id)) return { paused: false };
  run(db, "UPDATE projects SET moderation = 'pending' WHERE id = ?", project.id);
  return { paused: true };
}

/** Checks a POST /reports body. */
export function parseReport(db: DB, project: ProjectRow, body: { keyId?: unknown; reason?: unknown; note?: unknown }) {
  if (!REPORT_REASONS.includes(body.reason as ReportReason)) throw new HttpError(400, `reason must be one of ${REPORT_REASONS.join(', ')}.`);
  let keyId: number | null = null;
  if (body.keyId !== undefined && body.keyId !== null) {
    keyId = Number(body.keyId);
    if (!Number.isInteger(keyId) || !get(db, 'SELECT 1 FROM keys WHERE id = ? AND project_id = ?', keyId, project.id)) throw new HttpError(400, 'That string is not in this project.');
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new HttpError(400, 'note must be text.');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null;
  return { keyId, reason: body.reason as ReportReason, note };
}
