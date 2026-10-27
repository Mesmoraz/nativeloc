import { REAL_WORK } from '../badges.js';
import { HttpError } from '../auth.js';
import { all, get, getUser, run, tx, type DB } from '../db.js';
import { tierOf } from '../trust.js';

/**
 * An org's own recognition of the volunteers who work on its content (docs/segment-3d-org-features.md). Favorites get
 * its cards first. Approved Reviewers stand in for the poster's click on community-review text, once they're at
 * least Trusted in the language. Both are the org's trust, separate from platform tiers.
 */

export interface OrgVolunteer {
  id: number;
  name: string;
  locales: string[];
  /** Platform tier per language: an Approved Reviewer only counts where this is trusted or lead. */
  tiers: Record<string, 'new' | 'trusted' | 'lead'>;
  /** Accepted pieces of work on this org's projects. */
  accepted: number;
  lastActive: string;
  favorite: boolean;
  approvedReviewer: boolean;
}

/** Volunteers with accepted work on the org's projects, not counting its own members. Most work first. */
export function volunteersOf(db: DB, orgId: number): OrgVolunteer[] {
  const rows = all<{ id: number; name: string; locales: string; accepted: number; last: string; favorite: number | null; approved_reviewer: number | null }>(
    db,
    `SELECT u.id, u.name, u.locales, COUNT(*) AS accepted, MAX(x.created_at) AS last, ov.favorite, ov.approved_reviewer
     FROM xp_events x JOIN projects p ON p.id = x.project_id JOIN users u ON u.id = x.user_id
     LEFT JOIN org_volunteers ov ON ov.org_id = p.org_id AND ov.user_id = u.id
     WHERE p.org_id = ? AND x.status = 'accepted' AND x.kind IN ${REAL_WORK}
       AND u.id NOT IN (SELECT user_id FROM memberships WHERE org_id = ?)
     GROUP BY u.id ORDER BY accepted DESC, u.name`,
    orgId, orgId,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    locales: JSON.parse(r.locales) as string[],
    tiers: Object.fromEntries(all<{ locale: string; tier: 'new' | 'trusted' | 'lead' }>(db, 'SELECT locale, tier FROM user_languages WHERE user_id = ?', r.id).map((t) => [t.locale, t.tier])),
    accepted: r.accepted,
    lastActive: r.last,
    favorite: !!r.favorite,
    approvedReviewer: !!r.approved_reviewer,
  }));
}

/**
 * Sets either flag. Only for volunteers on the org's list (404 otherwise). Turning one on tells the volunteer, in
 * their inbox (org/messages.ts); turning it off says nothing.
 */
export function setVolunteer(db: DB, orgId: number, byUserId: number, userId: number, patch: { favorite?: unknown; approvedReviewer?: unknown }) {
  const fields = { favorite: patch.favorite, approved_reviewer: patch.approvedReviewer };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && typeof v !== 'boolean') throw new HttpError(400, `${k === 'favorite' ? 'favorite' : 'approvedReviewer'} must be true or false.`);
  if (fields.favorite === undefined && fields.approved_reviewer === undefined) throw new HttpError(400, 'Send favorite or approvedReviewer.');
  const before = volunteersOf(db, orgId).find((v) => v.id === userId);
  if (!before) throw new HttpError(404, "That person hasn't done accepted work for your organization.");
  tx(db, () => {
    run(db, 'INSERT OR IGNORE INTO org_volunteers (org_id, user_id, updated_by) VALUES (?, ?, ?)', orgId, userId, byUserId);
    for (const [col, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      run(db, `UPDATE org_volunteers SET ${col} = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE org_id = ? AND user_id = ?`, v ? 1 : 0, byUserId, orgId, userId);
      const was = col === 'favorite' ? before.favorite : before.approvedReviewer;
      if (v && !was) run(db, 'INSERT INTO volunteer_messages (user_id, org_id, kind) VALUES (?, ?, ?)', userId, orgId, col);
    }
  });
  return volunteersOf(db, orgId).find((v) => v.id === userId)!;
}

/** Whether `userId`'s approval stands in for the org's poster in `locale`: marked by the org, and at least Trusted there. */
export function isApprovedReviewer(db: DB, orgId: number, userId: number, locale: string): boolean {
  if (!get(db, 'SELECT 1 FROM org_volunteers WHERE org_id = ? AND user_id = ? AND approved_reviewer = 1', orgId, userId)) return false;
  const user = getUser(db, userId);
  return !!user && tierOf(db, user, locale) !== 'new';
}

/** Orgs that have made `userId` a favorite: their cards get the favorite boost (pool/score.ts). */
export const favoriteOrgsOf = (db: DB, userId: number) =>
  new Set(all<{ org_id: number }>(db, 'SELECT org_id FROM org_volunteers WHERE user_id = ? AND favorite = 1', userId).map((r) => r.org_id));
