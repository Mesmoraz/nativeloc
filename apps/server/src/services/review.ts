import { displayKey, validateTranslation, type Issue } from '@nativeloc/core';
import { HttpError } from '../auth.js';
import { all, get, run, tx, type DB, type KeyRow, type Member, type ProjectRow, type TranslationRow } from '../db.js';
import { fileReport } from '../moderation/reports.js';
import { tierOf } from '../trust.js';
import { awardOf, onApprove, onCommunityReview, onCommunitySave, onSave, onVote, settleCommunity, type XpAward } from '../xp.js';

// Owned by Segment 2 piece 2C (community review engine): who may review, saving, approving, votes, and the
// adaptive 3–5 round community review (docs/segment-2-open-signup.md §2).

/**
 * How `user` (with their role in the project's org) may review `project` in `locale`: approve outright, cast
 * one peer vote, or not at all. The one rule behind projectAccess('review'), Review cards and the queues.
 * Doesn't check that the user works in `locale`; projectAccess does.
 *
 * Standard projects: reviewers and admins approve, leads approve, trusted localizers vote when peer review is on.
 * Community projects: reviewers and admins (the poster's org) approve; trusted and lead volunteers vote (a lead's
 * approval settles only an escalated string); new volunteers don't review.
 */
export function reviewRight(db: DB, project: ProjectRow, user: Member, locale: string): 'approve' | 'vote' | null {
  if (user.role !== 'localizer') return 'approve';
  const tier = tierOf(db, user, locale);
  if (project.review_mode === 'community') return tier === 'new' ? null : 'vote';
  if (tier === 'lead') return 'approve';
  return tier === 'trusted' && project.peer_approvals > 0 ? 'vote' : null;
}

/** Peer reviewers never see their own work, or work they already approved. */
export const PEER_FILTER = 'AND t.updated_by IS NOT ? AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.key_id = t.key_id AND v.locale = t.locale AND v.user_id = ?)';
/** A peer reviewer: a localizer on a peer-review project whose approval is one vote (leads approve outright). */
export const isPeer = (db: DB, project: ProjectRow, locale: string, user?: Member) =>
  !!user && user.role === 'localizer' && project.peer_approvals > 0 && tierOf(db, user, locale) !== 'lead';

/**
 * The extra WHERE for a Review queue as `viewer` sees it. Peers never see their own work or work they already
 * reviewed. In community mode, escalated strings are hidden from anyone below Trusted.
 */
export function reviewFilter(db: DB, project: ProjectRow, locale: string, viewer?: Member): { sql: string; params: number[] } {
  if (project.review_mode !== 'community') {
    return isPeer(db, project, locale, viewer) ? { sql: PEER_FILTER, params: [viewer!.id, viewer!.id] } : { sql: '', params: [] };
  }
  if (!viewer || viewer.role !== 'localizer') return { sql: '', params: [] };
  const own = `AND t.updated_by IS NOT ? AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.key_id = t.key_id AND r.locale = t.locale
               AND r.user_id = ? AND r.current = 1 AND r.kind IN ('approve', 'flag'))`;
  // A string still in review with ESCALATE_AT counted reviews is escalated (consensus would have made it 'ready').
  const escalated = tierOf(db, viewer, locale) === 'new' ? `AND (${COUNTED_SQL}) < ${COMMUNITY.escalateAt}` : '';
  return { sql: `${own} ${escalated}`, params: [viewer.id, viewer.id] };
}

/** Translations in review that `user` can act on (for peers: not their own, not yet reviewed by them). */
export function reviewable(db: DB, project: ProjectRow, locale: string, user: Member): number {
  if (user.role === 'localizer' && tierOf(db, user, locale) === 'new') return 0;
  const f = reviewFilter(db, project, locale, user);
  return get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM translations t JOIN keys k ON k.id = t.key_id
     WHERE k.project_id = ? AND k.archived = 0 AND t.locale = ? AND t.status = 'review' ${f.sql}`,
    project.id, locale, ...f.params,
  )!.n;
}

// ---------- community review: the rules ----------

/** The adaptive rounds. Change the numbers here only. */
export const COMMUNITY = {
  /** Approvals of the current text needed while every review so far approved. */
  clean: 3,
  /** Approvals needed after any Flag or Improve (or the poster sending it back). */
  disputed: 5,
  /** Flags on the current text a disputed consensus tolerates. */
  maxFlags: 1,
  /** Reviews without consensus before the string is escalated (one Lead approval settles it). */
  escalateAt: 8,
} as const;

/**
 * Plan §4: do flags from new (unplaced) volunteers count as votes? Recommendation: no. Their flags are kept
 * (counts = 0) but never change the outcome or earn XP.
 */
export const NEW_VOLUNTEER_FLAGS_COUNT = false;

export const FLAG_REASONS = ['meaning', 'grammar', 'tone', 'offensive'] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

/** Counted reviews of t's string in this round (SQL fragment over alias t). */
const COUNTED_SQL = "SELECT COUNT(*) FROM reviews r WHERE r.key_id = t.key_id AND r.locale = t.locale AND r.counts = 1 AND r.kind <> 'send_back'";

export interface CommunityReview {
  reviews: number;
  approvals: number;
  flags: number;
  needed: 3 | 5;
  escalated: boolean;
}

/** Where a string stands in community review, and whether the current text has reached consensus. */
export function communityState(db: DB, keyId: number, locale: string): CommunityReview & { consensus: boolean; disagreement: boolean } {
  const rows = all<{ kind: string; counts: number; current: number }>(db, 'SELECT kind, counts, current FROM reviews WHERE key_id = ? AND locale = ?', keyId, locale);
  const counted = rows.filter((r) => r.counts && r.kind !== 'send_back');
  const disagreement = counted.some((r) => r.kind === 'flag' || r.kind === 'improve') || rows.some((r) => r.kind === 'send_back');
  const needed = disagreement ? COMMUNITY.disputed : COMMUNITY.clean;
  const approvals = counted.filter((r) => r.kind === 'approve' && r.current).length;
  const flags = counted.filter((r) => r.kind === 'flag' && r.current).length;
  const consensus = approvals >= needed && flags <= (disagreement ? COMMUNITY.maxFlags : 0);
  return { reviews: counted.length, approvals, flags, needed, escalated: !consensus && counted.length >= COMMUNITY.escalateAt, consensus, disagreement };
}

export const reviewOf = (db: DB, keyId: number, locale: string): CommunityReview => {
  const { consensus: _c, disagreement: _d, ...review } = communityState(db, keyId, locale);
  return review;
};

const ref = (project: ProjectRow, keyId: number, locale: string) => ({ projectId: project.id, keyId, locale });

/** Records who approved a string outright, for the manifest's reviewer count. */
const recordApprover = (db: DB, keyId: number, locale: string, userId: number) =>
  run(db, 'INSERT OR IGNORE INTO approvers (key_id, locale, user_id) VALUES (?, ?, ?)', keyId, locale, userId);

function getTranslation(db: DB, keyId: number, locale: string) {
  return get<TranslationRow>(db, 'SELECT * FROM translations WHERE key_id = ? AND locale = ?', keyId, locale);
}

/** One review per person per wording: a second approval is a no-op, anything else is refused. */
function currentReviewBy(db: DB, keyId: number, locale: string, userId: number) {
  return get<{ kind: string }>(db, "SELECT kind FROM reviews WHERE key_id = ? AND locale = ? AND user_id = ? AND current = 1 AND kind IN ('approve', 'flag')", keyId, locale, userId);
}

/** Community consensus (or a Lead settling an escalated string): 'ready' for the poster, and XP settles. */
function makeReady(db: DB, project: ProjectRow, t: TranslationRow) {
  run(db, "UPDATE translations SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", t.key_id, t.locale);
  settleCommunity(db, ref(project, t.key_id, t.locale), t.text);
}

function communityVote(db: DB, project: ProjectRow, user: Member, t: TranslationRow) {
  if (t.status !== 'review') throw new HttpError(409, 'This one is no longer waiting for review.');
  if (t.updated_by === user.id) throw new HttpError(403, "You can't approve your own translation. Another volunteer will review it.");
  const s = ref(project, t.key_id, t.locale);
  return tx(db, () => {
    const before = communityState(db, t.key_id, t.locale);
    const prior = currentReviewBy(db, t.key_id, t.locale, user.id);
    if (prior?.kind === 'flag') throw new HttpError(409, 'You already flagged this wording.');
    let xp: XpAward = null;
    if (!prior) {
      run(db, "INSERT INTO reviews (key_id, locale, user_id, kind, text) VALUES (?, ?, ?, 'approve', ?)", t.key_id, t.locale, user.id, t.text);
      xp = onCommunityReview(db, user.id, s);
    }
    const after = communityState(db, t.key_id, t.locale);
    const leadSettles = before.escalated && tierOf(db, user, t.locale) === 'lead';
    let status: 'review' | 'ready' = 'review';
    if (after.consensus || leadSettles) {
      makeReady(db, project, t);
      status = 'ready';
      if (xp) xp = awardOf(db, user.id, 'review', s);
    }
    const review = reviewOf(db, t.key_id, t.locale);
    return { status, review, approvals: { count: review.approvals, needed: review.needed }, xp };
  });
}

/** Review cards' third choice. Flags from new volunteers are kept but don't count (NEW_VOLUNTEER_FLAGS_COUNT). */
export function flagTranslation(db: DB, project: ProjectRow, user: Member, keyId: number, locale: string, reason: string, note?: string) {
  if (project.review_mode !== 'community') throw new HttpError(409, 'Flags are for community-reviewed projects. Improve the text or ask a reviewer instead.');
  if (!(FLAG_REASONS as readonly string[]).includes(reason)) throw new HttpError(400, 'Pick a reason: meaning, grammar, tone or offensive.');
  const t = getTranslation(db, keyId, locale);
  if (!t) throw new HttpError(404, 'Nothing to flag yet.');
  if (t.status !== 'review') throw new HttpError(409, 'This one is no longer waiting for review.');
  if (t.updated_by === user.id) throw new HttpError(403, "You can't flag your own translation. Improve it instead.");
  const counts = reviewRight(db, project, user, locale) !== null || NEW_VOLUNTEER_FLAGS_COUNT ? 1 : 0;
  const s = ref(project, keyId, locale);
  return tx(db, () => {
    if (currentReviewBy(db, keyId, locale, user.id)) throw new HttpError(409, 'You already reviewed this wording.');
    run(db, "INSERT INTO reviews (key_id, locale, user_id, kind, reason, note, text, counts) VALUES (?, ?, ?, 'flag', ?, ?, ?, ?)", keyId, locale, user.id, reason, note?.trim() || null, t.text, counts);
    // An uncounted 'offensive' flag from a new volunteer still reaches staff, as a report on that string. Other
    // uncounted flags (meaning, grammar, tone) are kept for the poster but shouldn't count toward pausing a project.
    if (!counts && reason === 'offensive') fileReport(db, user.id, project, { keyId, reason: 'harmful', note: `Flagged as offensive (${locale})${note?.trim() ? `: ${note.trim()}` : ''}` });
    const xp = counts ? onCommunityReview(db, user.id, s) : null;
    return { status: 'review' as const, review: reviewOf(db, keyId, locale), xp };
  });
}

// ---------- saving ----------

export function saveTranslation(db: DB, project: ProjectRow, user: Member, keyId: number, locale: string, text: string, approve: boolean) {
  const key = get<KeyRow>(db, 'SELECT * FROM keys WHERE id = ? AND project_id = ?', keyId, project.id);
  if (!key) throw new HttpError(404, 'String not found.');
  const issues: Issue[] = validateTranslation(key.source, text, { locale, maxLength: key.max_length });
  if (issues.some((i) => i.level === 'error')) throw new HttpError(422, issues.find((i) => i.level === 'error')!.message, { issues });
  const canApprove = reviewRight(db, project, user, locale) === 'approve';
  const status = (approve && canApprove) || !project.require_review ? 'approved' : 'review';
  const community = project.review_mode === 'community';
  const prev = community ? getTranslation(db, keyId, locale) : undefined;
  return tx(db, () => {
    if (community) {
      if (!prev || (prev.status !== 'review' && prev.status !== 'ready')) {
        // A new submission starts a new round.
        run(db, 'DELETE FROM reviews WHERE key_id = ? AND locale = ?', keyId, locale);
      } else if (prev.text !== text) {
        run(db, 'UPDATE reviews SET current = 0 WHERE key_id = ? AND locale = ?', keyId, locale);
        // Someone else editing text in review is an Improve: a review, and a disagreement.
        if (prev.updated_by !== user.id) {
          const counts = reviewRight(db, project, user, locale) !== null ? 1 : 0;
          run(db, "INSERT INTO reviews (key_id, locale, user_id, kind, text, counts) VALUES (?, ?, ?, 'improve', ?, ?)", keyId, locale, user.id, text, counts);
        }
      }
    }
    run(
      db,
      `INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key_id, locale) DO UPDATE SET text = excluded.text, status = excluded.status, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
      keyId, locale, text, status, user.id,
    );
    // Approvals were for the old wording.
    run(db, 'DELETE FROM votes WHERE key_id = ? AND locale = ?', keyId, locale);
    if (status === 'approved' && approve && canApprove) recordApprover(db, keyId, locale, user.id);
    const s = ref(project, keyId, locale);
    const xp = community ? onCommunitySave(db, user.id, s, status, text) : onSave(db, user.id, s, status);
    return { status, issues, xp, ...(community ? { review: reviewOf(db, keyId, locale) } : {}) };
  });
}

export const approvalCount = (db: DB, keyId: number, locale: string) =>
  get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM votes WHERE key_id = ? AND locale = ?', keyId, locale)!.n;

/**
 * Reviewers, admins and leads approve outright. With peer review on, a trusted localizer's approval is one vote;
 * the translation is approved once `peer_approvals` people other than its author have approved it.
 * Community projects: a volunteer's approval is one vote toward consensus ('ready'); see COMMUNITY.
 */
export function approveTranslation(db: DB, project: ProjectRow, user: Member, keyId: number, locale: string) {
  const t = getTranslation(db, keyId, locale);
  if (!t) throw new HttpError(404, 'Nothing to approve yet.');
  const s = ref(project, keyId, locale);
  if (project.review_mode === 'community') {
    if (reviewRight(db, project, user, locale) !== 'approve') return communityVote(db, project, user, t);
    return tx(db, () => {
      run(db, "UPDATE translations SET status = 'approved', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", user.id, keyId, locale);
      recordApprover(db, keyId, locale, user.id);
      settleCommunity(db, s, t.text);
      return { status: 'approved' as const, review: reviewOf(db, keyId, locale), xp: null };
    });
  }
  if (!isPeer(db, project, locale, user)) {
    return tx(db, () => {
      run(db, "UPDATE translations SET status = 'approved', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", user.id, keyId, locale);
      run(db, 'DELETE FROM votes WHERE key_id = ? AND locale = ?', keyId, locale);
      recordApprover(db, keyId, locale, user.id);
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

// ---------- the poster's "Ready to publish" list ----------

export function readyList(db: DB, project: ProjectRow, locale?: string) {
  const rows = all<{ key_id: number; name: string; source: string; locale: string; text: string }>(
    db,
    `SELECT t.key_id, k.name, k.source, t.locale, t.text FROM translations t JOIN keys k ON k.id = t.key_id
     WHERE k.project_id = ? AND k.archived = 0 AND t.status = 'ready' ${locale ? 'AND t.locale = ?' : ''} ORDER BY t.locale, k.id`,
    project.id, ...(locale ? [locale] : []),
  );
  return {
    items: rows.map((r) => {
      const state = communityState(db, r.key_id, r.locale);
      const flags = all<{ reason: FlagReason; count: number }>(
        db,
        "SELECT reason, COUNT(*) AS count FROM reviews WHERE key_id = ? AND locale = ? AND kind = 'flag' AND counts = 1 GROUP BY reason ORDER BY count DESC, reason",
        r.key_id, r.locale,
      );
      return { keyId: r.key_id, key: displayKey(r.name), source: r.source, locale: r.locale, text: r.text, review: reviewOf(db, r.key_id, r.locale), flags, disagreement: state.disagreement };
    }),
  };
}

/** Publishing ready text: 'ready' → 'approved'. All of the project's ready text when `items` is omitted. */
export function publishReady(db: DB, project: ProjectRow, items?: { keyId: number; locale: string }[]) {
  return tx(db, () => {
    const sql = `UPDATE translations SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE status = 'ready'
                 AND key_id IN (SELECT id FROM keys WHERE project_id = ? AND archived = 0)`;
    if (!items) return { approved: Number(run(db, sql, project.id).changes) };
    let approved = 0;
    for (const it of items) approved += Number(run(db, `${sql} AND key_id = ? AND locale = ?`, project.id, Number(it.keyId), String(it.locale)).changes);
    return { approved };
  });
}

/**
 * The poster disagrees: back to review, with the note shown to reviewers. Approvals so far no longer count and the
 * string now needs the disputed number. XP already accepted at consensus stays.
 */
export function sendBack(db: DB, project: ProjectRow, user: Member, keyId: number, locale: string, note?: string) {
  const t = getTranslation(db, keyId, locale);
  const key = get<KeyRow>(db, 'SELECT * FROM keys WHERE id = ? AND project_id = ?', keyId, project.id);
  if (!t || !key) throw new HttpError(404, 'String not found.');
  if (t.status !== 'ready') throw new HttpError(409, 'Only text that is ready to publish can be sent back.');
  return tx(db, () => {
    run(db, "UPDATE translations SET status = 'review', updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND locale = ?", keyId, locale);
    run(db, 'UPDATE reviews SET current = 0 WHERE key_id = ? AND locale = ?', keyId, locale);
    run(db, "INSERT INTO reviews (key_id, locale, user_id, kind, note, text, counts, current) VALUES (?, ?, ?, 'send_back', ?, ?, 0, 0)", keyId, locale, user.id, note?.trim() || null, t.text);
    return { status: 'review' as const };
  });
}

/** The poster's latest send-back note on a string in review, for reviewers. */
export const sendBackNote = (db: DB, keyId: number, locale: string) =>
  get<{ note: string | null }>(db, "SELECT note FROM reviews WHERE key_id = ? AND locale = ? AND kind = 'send_back' ORDER BY id DESC LIMIT 1", keyId, locale)?.note ?? null;
