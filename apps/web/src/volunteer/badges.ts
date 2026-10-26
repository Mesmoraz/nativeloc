import type { BadgeId, EarnedBadge } from './types';

/** How each badge reads (the server only knows ids; apps/server/src/badges.ts says when each is earned). */
export const BADGE_INFO: Record<BadgeId, { name: string; emoji: string; how: string; later?: true }> = {
  approved_1: { name: 'First approved string', emoji: '✅', how: 'Get one translation approved.' },
  approved_100: { name: '100 approved', emoji: '💯', how: 'Get 100 translations approved.' },
  approved_1000: { name: '1,000 approved', emoji: '🏆', how: 'Get 1,000 translations approved.' },
  bridge_builder: { name: 'Bridge builder', emoji: '🌉', how: 'Help 10 different organizations.' },
  trusted: { name: 'Trusted', emoji: '🛡️', how: 'Pass the placement check, or be vouched for by an organization.' },
  lead: { name: 'Lead', emoji: '⭐', how: 'Become a lead reviewer in a language.' },
  rare_voice: { name: 'Rare voice', emoji: '🗣️', how: 'Do approved work in a language with few volunteers.' },
  eagle_eye: { name: 'Eagle eye', emoji: '🦅', how: 'Catch 25 planted errors in Spot the problem cards.' },
  first_responder: { name: 'First responder', emoji: '🚨', how: 'Translate an urgent notice that goes live within a day.', later: true },
};

export const BADGE_ORDER = Object.keys(BADGE_INFO) as BadgeId[];

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' });
  } catch {
    return null;
  }
})();
export const languageName = (code: string) => languageNames?.of(code) ?? code;

/** "Rare voice · Japanese". */
export const badgeLabel = (b: EarnedBadge) => `${BADGE_INFO[b.id].name}${b.detail ? ` · ${languageName(b.detail)}` : ''}`;

/** A server timestamp ("2026-10-21 18:20:00", UTC) as a short local date. */
export const shortDate = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
