import { REAL_WORK } from '../badges.js';
import { HttpError } from '../auth.js';
import { all, get, run, tx, type DB, type ProjectRow } from '../db.js';

/**
 * Thank-you notes (docs/segment-3d-org-features.md): an org admin thanks everyone with accepted work on a project
 * since its last thank-you. Practice (Spot the problem) and the org's own admins and reviewers aren't thanked. At
 * most one note per project a day, so it stays meaningful.
 */

export const THANKS_MAX = 280;
const GAP_MS = 24 * 3600_000;
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const parse = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

const lastSent = (db: DB, projectId: number) =>
  get<{ at: string | null }>(db, 'SELECT MAX(created_at) AS at FROM thank_yous WHERE project_id = ?', projectId)?.at ?? null;

function recipients(db: DB, project: ProjectRow): number[] {
  return all<{ user_id: number }>(
    db,
    `SELECT DISTINCT x.user_id FROM xp_events x
     WHERE x.project_id = ? AND x.status = 'accepted' AND x.kind IN ${REAL_WORK} AND x.created_at > ?
       AND x.user_id NOT IN (SELECT user_id FROM memberships WHERE org_id = ? AND role IN ('admin', 'reviewer'))
     ORDER BY x.user_id`,
    project.id, lastSent(db, project.id) ?? '', project.org_id,
  ).map((r) => r.user_id);
}

export function thanksStatus(db: DB, project: ProjectRow, now = Date.now()) {
  const last = lastSent(db, project.id);
  const next = last ? parse(last) + GAP_MS : null;
  return { recipients: recipients(db, project).length, lastSentAt: last, nextAllowedAt: next && next > now ? stamp(next) : null };
}

export function sendThanks(db: DB, project: ProjectRow, byUserId: number, body: unknown, now = Date.now()) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new HttpError(400, 'Write a short note first.');
  if (text.length > THANKS_MAX) throw new HttpError(400, `Keep it to ${THANKS_MAX} characters.`);
  const status = thanksStatus(db, project, now);
  if (status.nextAllowedAt) throw new HttpError(429, 'You thanked this project’s volunteers in the last day. Try again tomorrow.');
  const to = recipients(db, project);
  if (!to.length) throw new HttpError(409, 'Nobody new has worked on this project since your last thank-you.');
  return tx(db, () => {
    run(db, 'INSERT INTO thank_yous (project_id, sent_by, body, recipients, created_at) VALUES (?, ?, ?, ?, ?)', project.id, byUserId, text, to.length, stamp(now));
    for (const u of to) run(db, "INSERT INTO volunteer_messages (user_id, org_id, project_id, kind, body) VALUES (?, ?, ?, 'thanks', ?)", u, project.org_id, project.id, text);
    return { recipients: to.length };
  });
}
