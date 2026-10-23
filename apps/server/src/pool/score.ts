// The order volunteers get cards in. Tune it here, in one place.
//
// A card's score is in hours: how long the string has waited (capped), plus boosts. A volunteer's session takes the
// highest-scoring cards. New rankers (favorites, campaign deadlines) add their own entries to BOOSTS.

export type ProjectPriority = 'low' | 'normal' | 'high';
export const PRIORITIES: ProjectPriority[] = ['low', 'normal', 'high'];

export const WEIGHTS = {
  /** A wait counts for at most this many hours (30 days), so very old strings don't bury everything else. */
  waitCapHours: 30 * 24,
  /** The string is marked urgent: it is worth a month of waiting. */
  urgent: 720,
  /** The project's priority setting (org admins and staff set it): high work is worth two more days of waiting. */
  priority: { high: 48, normal: 0, low: -24 } satisfies Record<ProjectPriority, number>,
  /** The project's org is a verified nonprofit: a day of waiting. */
  verifiedNonprofit: 24,
};

/** What the score knows about one candidate string, for one card type and language. */
export interface Candidate {
  /** Hours since it became available: key created or source changed (Translate), translation submitted (Review). */
  waitedHours: number;
  urgent: boolean;
  priority: ProjectPriority;
  verifiedNonprofit: boolean;
}

/** Each boost adds hours to the score. Add more (favorites, campaign deadlines) by pushing to this list. */
export const BOOSTS: ((c: Candidate) => number)[] = [
  (c) => (c.urgent ? WEIGHTS.urgent : 0),
  (c) => WEIGHTS.priority[c.priority] ?? 0,
  (c) => (c.verifiedNonprofit ? WEIGHTS.verifiedNonprofit : 0),
];

/** Hours since a SQLite timestamp ('YYYY-MM-DD HH:MM:SS', UTC). Unreadable or future times count as 0. */
export function hoursSince(ts: string, now = Date.now()): number {
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : 0;
}

export const score = (c: Candidate) => Math.min(c.waitedHours, WEIGHTS.waitCapHours) + BOOSTS.reduce((sum, boost) => sum + boost(c), 0);
