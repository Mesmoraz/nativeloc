import type { Access } from '../auth.js';
import type { DB, ProjectRow, UserRow } from '../db.js';

/**
 * Owned by Segment 2 piece 2E (open volunteer pool).
 *
 * projectAccess calls this when the user has no membership in the project's org. Return the role they act with
 * ('localizer': translate, and review as their trust tier allows) to let them in, or null for "Project not found".
 * Until 2E: nobody outside the org gets in. 2E: public projects with moderation 'approved', in the user's languages.
 */
export function openPoolRole(_db: DB, _user: UserRow, _project: ProjectRow, _access?: Access): 'localizer' | null {
  return null;
}
