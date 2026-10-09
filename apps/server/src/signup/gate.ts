import type { Access } from '../auth.js';
import type { DB, ProjectRow, UserRow } from '../db.js';

/**
 * Owned by Segment 2 piece 2A (sign-up and onboarding).
 *
 * projectAccess calls this for every signed-in user it lets in, before role checks. Throw an HttpError to stop
 * them, e.g. 403 "Confirm your email first" for translate/review/admin while the email is unverified.
 * Until 2A: allows everything.
 */
export function assertMayContribute(_db: DB, _user: UserRow, _project: ProjectRow, _access: Access): void {}
