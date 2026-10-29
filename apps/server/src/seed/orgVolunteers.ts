import { get, run, type DB, type ProjectRow } from '../db.js';
import { sendThanks } from '../org/thanks.js';
import { setVolunteer } from '../org/volunteers.js';
import type { Demo } from './types.js';

/**
 * Demo data for favorites, Approved Reviewers and thank-yous (docs/segment-3d-org-features.md). Runs after the
 * community-review and card seeds, whose agreed strings are on FreshMart's Ready list.
 *
 * - Ana: FreshMart's Approved Reviewer. She gets Final check cards for the ready hours-page strings she didn't write,
 *   which have waited on the Ready list for two days.
 * - María: a FreshMart favorite, with an unseen thank-you for the community hours page.
 * - Publications over the last month, mostly by Ana, so the staff table shows an org relying on its Approved Reviewer.
 */
export function seedOrgVolunteers(db: DB, demo: Demo) {
  const ana = get<{ id: number }>(db, "SELECT id FROM users WHERE email = 'ana@demo.test'")!.id;
  setVolunteer(db, demo.orgId, demo.users.admin, ana, { approvedReviewer: true });
  setVolunteer(db, demo.orgId, demo.users.admin, demo.users.maria, { favorite: true });

  const hours = get<ProjectRow>(db, "SELECT * FROM projects WHERE bundle_token = 'pb_demo_hours'")!;
  // The agreed strings have been waiting on the Ready list for two days, which is what Approved Reviewers fix. Final
  // check cards compete with Review cards on waiting time, so fresh ones would rarely make a session.
  run(db, "UPDATE translations SET updated_at = datetime('now', '-2 days') WHERE status = 'ready' AND key_id IN (SELECT id FROM keys WHERE project_id = ?)", hours.id);
  sendThanks(db, hours, demo.users.admin, 'Thank you! Our pantry hours page now reads naturally in Spanish. Families have already told us it helped.');

  const key = get<{ id: number }>(db, "SELECT id FROM keys WHERE project_id = ? AND name = 'hours.title'", hours.id)!.id;
  for (let d = 2; d <= 28; d += 4) {
    run(db, "INSERT INTO publications (key_id, locale, project_id, user_id, via, created_at) VALUES (?, 'es', ?, ?, 'approved_reviewer', datetime('now', ?))", key, hours.id, ana, `-${d} days`);
  }
  for (const d of [9, 23]) {
    run(db, "INSERT INTO publications (key_id, locale, project_id, user_id, via, created_at) VALUES (?, 'es', ?, ?, 'poster', datetime('now', ?))", key, hours.id, demo.users.admin, `-${d} days`);
  }
}
