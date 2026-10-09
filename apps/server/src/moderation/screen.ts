import type { DB, ProjectRow } from '../db.js';

export interface ScreenResult {
  /** 'approved': clear pass, volunteers can see it. 'pending': goes to the staff queue. */
  decision: 'approved' | 'pending';
  /** Why it was held, for the staff queue, e.g. ["3 phone numbers", "mentions prices"]. Empty when approved. */
  reasons: string[];
}

/**
 * Owned by Segment 2 piece 2B (verification and moderation).
 *
 * The automatic screen. 2D's "submit for moderation" calls this, then stores `moderation = decision` on the
 * project (and 2B's queue picks up 'pending'). Until 2B: everything waits for staff.
 */
export function screenProject(_db: DB, _project: ProjectRow): ScreenResult {
  return { decision: 'pending', reasons: ['automatic screen not built yet'] };
}
