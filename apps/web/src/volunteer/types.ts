// The volunteer card flow's API shapes. The server (apps/server/src/routes/volunteer.ts) returns these
// shapes and the web app consumes them. See docs/segment-1-volunteer-cards.md. Change both sides together.
import type { QueueItem } from '../api';
import type { CardOrg } from '../contracts';

export type CardType = 'translate' | 'review';

/** One screen in a session. `item` is the same shape the full editor's queue returns. */
export interface Card {
  /** Stable within a session, e.g. "translate:12:es". */
  id: string;
  type: CardType;
  /** `sourceLocale` is the language the strings are written in (e.g. "en"), for labelling and plural examples. */
  project: { id: number; name: string; sourceLocale: string };
  /** Who the card helps. */
  org: CardOrg;
  locale: string;
  /** Urgent strings come first in a session. */
  urgent?: boolean;
  item: QueueItem;
}

/** GET /api/v1/volunteer/session?size=5&nonprofitsOnly=1 (size 1–10, default 5). Passing nonprofitsOnly saves it. */
export interface SessionResponse {
  cards: Card[];
  /** Set when `cards` is empty, so the app can say why instead of showing a blank screen. */
  empty: null | 'no_languages' | 'nothing_to_do';
}

/** GET and PUT /api/v1/volunteer/settings. */
export interface VolunteerSettings {
  nonprofitsOnly: boolean;
  dailyGoal: DailyGoal;
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
  /** Days in a row with at least one card saved (pending counts), in the volunteer's time zone. */
  streak: Streak;
  /** Cards saved today (a string saved twice counts once) against the volunteer's goal. */
  goal: { target: DailyGoal; done: number };
  /** Badges earned, oldest first. Checked for new ones on every stats load. */
  badges: EarnedBadge[];
}

/** Server badge ids (apps/server/src/badges.ts). Names and wording are in badges.ts next to this file. */
export type BadgeId = 'approved_1' | 'approved_100' | 'approved_1000' | 'bridge_builder' | 'trusted' | 'lead' | 'rare_voice' | 'eagle_eye' | 'first_responder';

export interface EarnedBadge {
  id: BadgeId;
  /** The language, for rare_voice. */
  detail: string | null;
  earnedAt: string;
  /** Not shown yet: celebrate once, then POST /volunteer/badges/seen. */
  new: boolean;
}

/** The daily goal choices, in cards. */
export const DAILY_GOALS = [3, 5, 10, 20] as const;
export type DailyGoal = (typeof DAILY_GOALS)[number];

export interface Streak {
  current: number;
  /** A freeze covers a missed day. One is earned for every 7 active days in a streak, up to 2. */
  freezes: number;
  /** Today isn't a miss until it's over; this says whether it already counts. */
  activeToday: boolean;
  /** YYYY-MM-DD of the last day a freeze covered. */
  lastFreezeUsed: string | null;
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

/**
 * POST/GET /api/v1/volunteer/certificates and the public GET /api/v1/certificates/:code. Hours are estimated from
 * accepted work at `rates` (minutes per card), in halves. The verify link is /certificate/<code> on this site.
 */
export interface Certificate {
  code: string;
  name: string;
  periodFrom: string | null;
  periodTo: string;
  hours: number;
  translations: number;
  reviews: number;
  orgs: string[];
  rates: { version: string; translate: number; review: number };
  issuedAt: string;
  revokedAt: string | null;
}
/** The public read of a revoked certificate: no numbers, just that it was withdrawn. */
export interface RevokedCertificate {
  code: string;
  revoked: true;
  name: string;
  periodFrom: string | null;
  periodTo: string;
  issuedAt: string;
  revokedAt: string;
}
