import { get, getOrg, run, type DB, type OrgRow, type ProjectRow } from '../db.js';
import { screenProject } from '../moderation/screen.js';
import { assertMayPost as assertOrgMayPost } from '../signup/gate.js';

/** Decision (plan §4): pages one website crawl reads on the community tier (about 4,000 words). */
export const CRAWL_PAGE_LIMIT = 15;

/**
 * Refuses posting (new projects, pasted text, crawls, submitting) for orgs that can't post yet. The rule (business
 * waitlist, plan §4) lives in signup/gate.ts.
 */
export function assertMayPost(db: DB, orgId: number) {
  const org = getOrg(db, orgId);
  if (org) assertOrgMayPost(org);
}

/**
 * How a project's translations are reviewed unless the poster picks. Private work is reviewed by the org's own
 * people, as before open sign-up. Public work: verified nonprofits keep standard review (their Trusted and Lead
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
