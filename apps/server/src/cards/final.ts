import { HttpError } from '../auth.js';
import { all, get, run, tx, type DB, type Member, type ProjectRow } from '../db.js';
import { isApprovedReviewer } from '../org/volunteers.js';
import { publishReady, reviewOf, sendBack, sendBackNote } from '../services/review.js';
import { recordActivity } from '../streaks.js';
import { XP } from '../xp.js';

/**
 * Final check (docs/segment-3d-org-features.md): an org's Approved Reviewer does the poster's last step on community
 * text that reached agreement without one of them. Publish it, or send it back with a note.
 */

/** Ready strings in `project` and `locale` that `viewer` can give a Final check, longest-waiting first. */
export function finalCandidates(db: DB, project: ProjectRow, locale: string, viewer: Member, limit: number) {
  if (project.review_mode !== 'community' || !isApprovedReviewer(db, project.org_id, viewer.id, locale)) return [];
  return all<{ key_id: number; urgent: number; shot: number | null; since: string }>(
    db,
    `SELECT k.id AS key_id, k.urgent, (SELECT MIN(screenshot_id) FROM screenshot_keys WHERE key_id = k.id) AS shot, t.updated_at AS since
     FROM translations t JOIN keys k ON k.id = t.key_id
     WHERE k.project_id = ? AND k.archived = 0 AND t.locale = ? AND t.status = 'ready' AND t.updated_by IS NOT ?
     ORDER BY k.urgent DESC, since, k.id LIMIT ?`,
    project.id, locale, viewer.id, limit,
  );
}

export function finalCard(db: DB, keyId: number, locale: string) {
  const r = get<{ source: string; description: string | null; text: string }>(
    db,
    'SELECT k.source, k.description, t.text FROM keys k JOIN translations t ON t.key_id = k.id AND t.locale = ? WHERE k.id = ?',
    locale, keyId,
  )!;
  return { keyId, source: r.source, note: r.description, text: r.text, review: reviewOf(db, keyId, locale), sentBack: sendBackNote(db, keyId, locale) };
}

/**
 * Publish or send back. Either is review work, and final, so it earns accepted review XP at once and counts as review
 * activity. 403 for anyone who isn't the org's Approved Reviewer here, or who wrote the text; 409 once it isn't ready.
 */
export function decideFinal(db: DB, project: ProjectRow, viewer: Member, keyId: number, locale: string, decision: unknown, note?: unknown) {
  if (decision !== 'publish' && decision !== 'send_back') throw new HttpError(400, 'decision must be "publish" or "send_back".');
  if (project.review_mode !== 'community' || !isApprovedReviewer(db, project.org_id, viewer.id, locale)) {
    throw new HttpError(403, "Only this organization's Approved Reviewers can do that.");
  }
  const t = get<{ status: string; updated_by: number | null }>(db, 'SELECT status, updated_by FROM translations WHERE key_id = ? AND locale = ?', keyId, locale);
  if (!t || t.status !== 'ready') throw new HttpError(409, 'This one is no longer waiting to be published.');
  if (t.updated_by === viewer.id) throw new HttpError(403, 'You wrote this text, so someone else has to check it.');
  const s = { projectId: project.id, keyId, locale };
  return tx(db, () => {
    if (decision === 'publish') {
      publishReady(db, project, [{ keyId, locale }], { userId: viewer.id, via: 'approved_reviewer' });
      run(db, 'INSERT OR IGNORE INTO approvers (key_id, locale, user_id) VALUES (?, ?, ?)', keyId, locale, viewer.id);
    } else {
      sendBack(db, project, viewer, keyId, locale, typeof note === 'string' ? note : undefined);
    }
    run(
      db,
      "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, settled_at) VALUES (?, 'review', ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)",
      viewer.id, keyId, locale, project.id, XP.review,
    );
    recordActivity(db, viewer, 'review', s);
    return { status: decision === 'publish' ? ('approved' as const) : ('review' as const), xp: { points: XP.review, status: 'accepted' as const } };
  });
}
