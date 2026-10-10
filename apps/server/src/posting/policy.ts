import { HttpError } from '../auth.js';
import { get, run, type DB, type OrgRow, type ProjectRow } from '../db.js';
import { screenProject } from '../moderation/screen.js';

/**
 * Decision (plan §4): business sign-ups are waitlisted until Segment 5 and can't post.
 * integration: assertMayPost (2A) replaces this check once it merges.
 */
export const BUSINESS_MAY_POST = false;

/** Decision (plan §4): pages one website crawl reads on the community tier (about 4,000 words). */
export const CRAWL_PAGE_LIMIT = 15;

export const getOrg = (db: DB, orgId: number) => get<OrgRow>(db, 'SELECT * FROM orgs WHERE id = ?', orgId);

/** Refuses posting (new projects, pasted text, crawls, submitting) for orgs that can't post yet. */
export function assertMayPost(db: DB, orgId: number) {
  const org = getOrg(db, orgId);
  if (org?.type === 'business' && !BUSINESS_MAY_POST) {
    throw new HttpError(403, 'Business accounts are on the waitlist for now. We’ll email you when posting opens for businesses.');
  }
}

/**
 * How a project's translations are reviewed unless the poster picks. Private work is reviewed by the org's own
 * people, as before Segment 2. Public work: verified nonprofits keep standard review (their Trusted and Lead
 * reviewers); everyone else gets community review.
 */
export function defaultReviewMode(org: Pick<OrgRow, 'type' | 'verification'> | undefined, visibility: 'private' | 'public'): 'standard' | 'community' {
  if (visibility === 'private') return 'standard';
  return org?.type === 'nonprofit' && org.verification === 'verified' ? 'standard' : 'community';
}

/**
 * New content on a public project volunteers already see goes through the automatic screen again, so it can't
 * skip moderation. Projects waiting for staff (pending) or sent back (rejected) are left alone.
 */
export function rescreenAfterChange(db: DB, projectId: number, changed: number) {
  if (!changed) return;
  const project = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!project || project.visibility !== 'public' || project.moderation !== 'approved') return;
  const { decision } = screenProject(db, project);
  run(db, 'UPDATE projects SET moderation = ? WHERE id = ?', decision, project.id);
}
