import type { Access } from '../auth.js';
import type { DB, OrgRow, ProjectRow, UserRow } from '../db.js';
import { projectLocales } from '../services/progress.js';

/** What the pool lets a non-member do: see the project and work on it. Never export, push or admin. */
const POOL_ACCESS: Access[] = ['read', 'translate', 'review'];

/** Public work that moderation approved. Private, not yet submitted, pending and rejected projects stay members-only. */
export const inOpenPool = (project: ProjectRow) => project.visibility === 'public' && project.moderation === 'approved';

/**
 * projectAccess calls this when the user has no membership in the project's org. Return the role they act with
 * ('localizer': translate, and review as their trust tier allows) to let them in, or null for "Project not found".
 * Public, approved projects that want at least one of the user's languages let anyone in as a localizer.
 */
export function openPoolRole(db: DB, user: UserRow, project: ProjectRow, access: Access = 'read'): 'localizer' | null {
  if (!POOL_ACCESS.includes(access) || !inOpenPool(project)) return null;
  const mine = JSON.parse(user.locales) as string[];
  return projectLocales(db, project.id).some((l) => mine.includes(l)) ? 'localizer' : null;
}

/** A nonprofit staff checked. Until then a nonprofit is served as a community org (plan §2). */
export const isVerifiedNonprofit = (org: Pick<OrgRow, 'type' | 'verification'>) => org.type === 'nonprofit' && org.verification === 'verified';

/**
 * Which orgs the volunteer's "Nonprofits only" filter keeps: verified nonprofits only (decided 2026-10-10), so an org
 * can't get into the filtered pool just by calling itself a nonprofit.
 */
export const passesNonprofitsOnly = isVerifiedNonprofit;
