import { run, type DB, type OrgRow, type Verification } from '../db.js';

/**
 * Owned by Segment 2 piece 2B (verification and moderation).
 *
 * 2A calls this after creating an org or changing its EIN. 2B: look the EIN up in the EO-BMF table and set
 * 'verified' on an EIN + name + state match, else 'pending' for the staff queue. Until 2B: nonprofits wait for staff.
 */
export function startVerification(db: DB, org: OrgRow): Verification {
  if (org.type !== 'nonprofit') return org.verification;
  run(db, "UPDATE orgs SET verification = 'pending' WHERE id = ?", org.id);
  return 'pending';
}
