import { validateTranslation, type Issue } from '@nativeloc/core';
import { HttpError } from '../auth.js';
import { get, run, tx, type DB, type KeyRow, type Member, type ProjectRow, type TranslationRow } from '../db.js';
import { tierOf } from '../trust.js';
import { onApprove, onSave, onVote } from '../xp.js';

// Owned by Segment 2 piece 2C (community review engine): who may review, saving, approving, votes.

/**
 * How `user` (with their role in the project's org) may review `project` in `locale`: approve outright, cast
 * one peer vote, or not at all. The one rule behind projectAccess('review'), Review cards and the queues.
 * Doesn't check that the user works in `locale`; projectAccess does.
 */
export function reviewRight(db: DB, project: ProjectRow, user: Member, locale: string): 'approve' | 'vote' | null {
  if (user.role !== 'localizer') return 'approve';
  const tier = tierOf(db, user, locale);
  if (tier === 'lead') return 'approve';
  return tier === 'trusted' && project.peer_approvals > 0 ? 'vote' : null;
}

/** Peer reviewers never see their own work, or work they already approved. */
export const PEER_FILTER = 'AND t.updated_by IS NOT ? AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.key_id = t.key_id AND v.locale = t.locale AND v.user_id = ?)';
/** A peer reviewer: a localizer on a peer-review project whose approval is one vote (leads approve outright). */
export const isPeer = (db: DB, project: ProjectRow, locale: string, user?: Member) =>
  !!user && user.role === 'localizer' && project.peer_approvals > 0 && tierOf(db, user, locale) !== 'lead';

/** Translations in review that `user` can act on (for peers: not their own, not yet approved by them). */
export function reviewable(db: DB, project: ProjectRow, locale: string, user: Member): number {
  if (user.role === 'localizer' && tierOf(db, user, locale) === 'new') return 0;
  const peer = isPeer(db, project, locale, user);
  return get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM translations t JOIN keys k ON k.id = t.key_id
     WHERE k.project_id = ? AND k.archived = 0 AND t.locale = ? AND t.status = 'review' ${peer ? PEER_FILTER : ''}`,
    project.id, locale, ...(peer ? [user.id, user.id] : []),
  )!.n;
}


// ---------- saving ----------

export function saveTranslation(db: DB, project: ProjectRow, user: Member, keyId: number, locale: string, text: string, approve: boolean) {
  const key = get<KeyRow>(db, 'SELECT * FROM keys WHERE id = ? AND project_id = ?', keyId, project.id);
  if (!key) throw new HttpError(404, 'String not found.');
  const issues: Issue[] = validateTranslation(key.source, text, { locale, maxLength: key.max_length });
  if (issues.some((i) => i.level === 'error')) throw new HttpError(422, issues.find((i) => i.level === 'error')!.message, { issues });
  const canApprove = user.role !== 'localizer' || tierOf(db, user, locale) === 'lead';
  const status = (approve && canApprove) || !project.require_review ? 'approved' : 'review';
  return tx(db, () => {
    run(
      db,
      `INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key_id, locale) DO UPDATE SET text = excluded.text, status = excluded.status, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
      keyId, locale, text, status, user.id,
    );
    // Approvals were for the old wording.
    run(db, 'DELETE FROM votes WHERE key_id = ? AND locale = ?', keyId, locale);
    const xp = onSave(db, user.id, { projectId: project.id, keyId, locale }, status);
    return { status, issues, xp };
  });
}

export const approvalCount = (db: DB, keyId: number, locale: string) =>
  get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM votes WHERE key_id = ? AND locale = ?', keyId, locale)!.n;

/**
 * Reviewers, admins and leads approve outright. With peer review on, a trusted localizer's approval is one vote;
 * the translation is approved once `peer_approvals` people other than its author have approved it.
 */
export function approveTranslation(db: DB, project: ProjectRow, user: Member, keyId: number, locale: string) {
  const t = get<TranslationRow>(db, 'SELECT * FROM translations WHERE key_id = ? AND locale = ?', keyId, locale);
  if (!t) throw new HttpError(404, 'Nothing to approve yet.');
  const s = { projectId: project.id, keyId, locale };
  if (!isPeer(db, project, locale, user)) {
    return tx(db, () => {
      run(db, "UPDATE translations SET status = 'approved', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", user.id, keyId, locale);
      run(db, 'DELETE FROM votes WHERE key_id = ? AND locale = ?', keyId, locale);
      // Reviewing is staff's job, so no XP for them. A volunteer lead's review of someone else's work earns XP.
      const xp = onApprove(db, user.id, s, user.role === 'localizer' && t.status === 'review' && t.updated_by !== user.id);
      return { status: 'approved' as const, xp };
    });
  }
  if (t.status !== 'review') throw new HttpError(409, 'This one is no longer waiting for review.');
  if (t.updated_by === user.id) throw new HttpError(403, "You can't approve your own translation. Another volunteer will review it.");
  return tx(db, () => {
    const voted = Number(run(db, 'INSERT OR IGNORE INTO votes (key_id, locale, user_id) VALUES (?, ?, ?)', keyId, locale, user.id).changes) > 0;
    const count = approvalCount(db, keyId, locale);
    // The author keeps credit (updated_by) when peers approve.
    const status = count >= project.peer_approvals ? 'approved' : 'review';
    if (status === 'approved') run(db, "UPDATE translations SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", keyId, locale);
    // Approving twice is one vote, and earns once.
    const xp = voted ? onVote(db, user.id, s, status === 'approved') : null;
    return { status, approvals: { count, needed: project.peer_approvals }, xp };
  });
}

