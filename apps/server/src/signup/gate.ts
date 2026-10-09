import { HttpError, type Access } from '../auth.js';
import { get, type DB, type OrgRow, type ProjectRow, type UserRow } from '../db.js';
import { isEmailVerified } from './mailer.js';

/**
 * Owned by Segment 2 piece 2A (sign-up and onboarding).
 *
 * projectAccess calls this for every signed-in user it lets in, before role checks. Unconfirmed emails can look
 * but not translate, review or manage; a waitlisted business's projects can't be managed (posted to).
 */
export function assertMayContribute(db: DB, user: UserRow, project: ProjectRow, access: Access): void {
  if (access === 'translate' || access === 'review' || access === 'admin') assertEmailVerified(db, user);
  if (access === 'admin') {
    const org = get<OrgRow>(db, 'SELECT * FROM orgs WHERE id = ?', project.org_id);
    if (org) assertMayPost(org);
  }
}

export function assertEmailVerified(db: DB, user: UserRow) {
  if (!isEmailVerified(db, user.id)) throw new HttpError(403, `Confirm your email address first. We sent a link to ${user.email}.`);
}

/**
 * Plan §4 decision "business sign-ups before Segment 5": waitlist only, no posting. Flip this to let them post.
 * Business orgs are still saved (type 'business'); the waitlist is `SELECT * FROM orgs WHERE type = 'business'`.
 */
export const BUSINESS_WAITLIST = true;

export const isWaitlisted = (org: Pick<OrgRow, 'type'>) => BUSINESS_WAITLIST && org.type === 'business';

/** 2D: call before creating a project in `org` (POST /api/v1/projects). projectAccess('admin') already checks it. */
export function assertMayPost(org: Pick<OrgRow, 'type'>) {
  if (isWaitlisted(org)) throw new HttpError(403, "Business accounts are on the waitlist. We'll email you when you can post.");
}

/**
 * Whether an org's word raises someone's trust (invites, an admin adding a language or placing a tier). Orgs that
 * predate open sign-up, or were set up by staff, do. An org someone made for themselves does only once staff (2B)
 * verified it; otherwise anyone could make an org, invite a second account and make it a lead everywhere.
 */
export function orgMayVouch(db: DB, orgId: number): boolean {
  const org = get<{ self_serve: number; verification: string }>(db, 'SELECT self_serve, verification FROM orgs WHERE id = ?', orgId);
  return !!org && (!org.self_serve || org.verification === 'verified');
}
