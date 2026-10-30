import { HttpError } from './auth.js';
import { all, type DB } from './db.js';

/**
 * Org leaderboards (docs/segment-3e-campaigns-leaderboards.md): top translators for an org in a month, by accepted
 * translated words (counted from the English source). Opt-in: only volunteers who turned on "Show me on leaderboards"
 * are named, and everyone else is a count. The org's own admins and reviewers aren't ranked.
 */

export const TOP = 10;

/** Words in English source text: runs between whitespace. */
export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** "María López" → "María L.": enough to recognise yourself, not enough to find someone. */
export const shortName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${[...parts[parts.length - 1]][0]}.` : parts[0];
};

/** "YYYY-MM": this month or last month (UTC) only. */
export function boardMonth(month: unknown, now = Date.now()): string {
  const d = new Date(now);
  const thisMonth = d.toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  if (month === undefined || month === '') return thisMonth;
  if (month !== thisMonth && month !== lastMonth) throw new HttpError(400, `month must be ${thisMonth} or ${lastMonth}.`);
  return month;
}

/** Every volunteer's words for the org that month, most first, with whether they opted in. */
function standings(db: DB, orgId: number, month: string) {
  const rows = all<{ user_id: number; name: string; opted: number | null; source: string }>(
    db,
    `SELECT u.id AS user_id, u.name, vp.show_on_leaderboards AS opted, k.source
     FROM xp_events x JOIN keys k ON k.id = x.key_id JOIN projects p ON p.id = x.project_id JOIN users u ON u.id = x.user_id
     LEFT JOIN volunteer_prefs vp ON vp.user_id = u.id
     WHERE p.org_id = ? AND x.kind = 'translate' AND x.status = 'accepted' AND substr(x.settled_at, 1, 7) = ?
       AND u.id NOT IN (SELECT user_id FROM memberships WHERE org_id = ? AND role IN ('admin', 'reviewer'))`,
    orgId, month, orgId,
  );
  const by = new Map<number, { userId: number; name: string; opted: boolean; words: number }>();
  for (const r of rows) {
    const s = by.get(r.user_id) ?? { userId: r.user_id, name: r.name, opted: !!r.opted, words: 0 };
    s.words += wordCount(r.source);
    by.set(r.user_id, s);
  }
  return [...by.values()].filter((s) => s.words > 0).sort((a, b) => b.words - a.words || a.name.localeCompare(b.name));
}

export function leaderboard(db: DB, orgId: number, month: string) {
  const all = standings(db, orgId, month);
  const top = all.filter((s) => s.opted).slice(0, TOP);
  return {
    month,
    top: top.map((s) => ({ name: shortName(s.name), words: s.words })),
    /** Everyone else with words that month: opted out, or below the top 10. */
    others: all.length - top.length,
    totalWords: all.reduce((n, s) => n + s.words, 0),
  };
}

/**
 * The volunteer's boards: this month's, for each org they've done accepted work with (most work first, up to 5).
 * `you` is their words and place among those named, or null when they haven't opted in.
 */
export function volunteerBoards(db: DB, userId: number, opted: boolean, now = Date.now()) {
  const month = boardMonth(undefined, now);
  const orgs = all<{ id: number; name: string }>(
    db,
    `SELECT o.id, o.name FROM xp_events x JOIN projects p ON p.id = x.project_id JOIN orgs o ON o.id = p.org_id
     WHERE x.user_id = ? AND x.status = 'accepted' AND x.kind = 'translate'
     GROUP BY o.id ORDER BY COUNT(*) DESC, o.name LIMIT 5`,
    userId,
  );
  return orgs.map((o) => {
    const named = standings(db, o.id, month).filter((s) => s.opted);
    const i = named.findIndex((s) => s.userId === userId);
    return { org: o, ...leaderboard(db, o.id, month), you: opted ? { words: i >= 0 ? named[i].words : 0, place: i >= 0 ? i + 1 : null } : null };
  });
}
