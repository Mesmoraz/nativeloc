// Segment 1 contract: the volunteer card flow. The server (apps/server/src/routes/volunteer.ts) returns these
// shapes and the web app consumes them. See docs/segment-1-volunteer-cards.md. Change both sides together.
import type { QueueItem } from '../api';

export type CardType = 'translate' | 'review';

/** One screen in a session. `item` is the same shape the full editor's queue returns. */
export interface Card {
  /** Stable within a session, e.g. "translate:12:es". */
  id: string;
  type: CardType;
  /** `sourceLocale` is the language the strings are written in (e.g. "en"), for labelling and plural examples. */
  project: { id: number; name: string; sourceLocale: string };
  locale: string;
  item: QueueItem;
}

/** GET /api/v1/volunteer/session?size=5 (size 1–10, default 5). */
export interface SessionResponse {
  cards: Card[];
  /** Set when `cards` is empty, so the app can say why instead of showing a blank screen. */
  empty: null | 'no_languages' | 'nothing_to_do';
}

export interface XpTotals {
  /** XP for work reviewers have accepted. Only this counts toward goals and, later, badges. */
  accepted: number;
  /** XP waiting on review. Shown faded; it becomes accepted, or quietly disappears if overturned. */
  pending: number;
}

/** GET /api/v1/volunteer/stats */
export interface StatsResponse {
  xp: XpTotals;
  today: XpTotals;
  /** Accepted translations authored by this volunteer, all time. */
  approvedStrings: number;
  /** Distinct projects this volunteer has accepted work in. */
  projectsHelped: { id: number; name: string }[];
}

/**
 * Added to the existing PUT /api/v1/translations/:keyId/:locale and
 * POST /api/v1/translations/:keyId/:locale/approve responses, alongside their current fields.
 */
export interface XpAward {
  xp: { points: number; status: 'pending' | 'accepted' } | null;
}

/** Point values. The server is the source of truth; the web app may use these for animations. */
export const XP = { translate: 10, review: 5 } as const;
