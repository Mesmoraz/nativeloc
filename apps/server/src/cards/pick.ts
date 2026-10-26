import { HttpError } from '../auth.js';
import { all, get, run, tx, type DB, type Member, type ProjectRow } from '../db.js';
import { recordActivity } from '../streaks.js';
import { CARD_XP } from '../xp.js';

/**
 * Pick the better one (docs/segment-3c-card-types.md): a community-review string whose wording was Improved, shown
 * as the current text and the one it replaced. A pick is advice: it's tallied for the poster and the Lead who
 * settles the string, and never counts as an approval. Its XP waits for the string to settle (settleCommunity in
 * xp.ts): accepted if you picked the wording that won.
 */

export interface PickTally {
  text: string;
  count: number;
}

export const pickTally = (db: DB, keyId: number, locale: string): PickTally[] =>
  all<PickTally>(db, 'SELECT chosen AS text, COUNT(*) AS count FROM picks WHERE key_id = ? AND locale = ? GROUP BY chosen ORDER BY count DESC, text', keyId, locale);

/**
 * The pair a string offers `viewer`, from its latest Improve, or null. Not for anyone who wrote either wording, has
 * reviewed the string, or has already picked.
 */
const PAIR_SQL = `
  SELECT t.key_id, t.text AS current, r.previous_text AS previous
  FROM translations t JOIN keys k ON k.id = t.key_id
  JOIN reviews r ON r.id = (SELECT MAX(id) FROM reviews WHERE key_id = t.key_id AND locale = t.locale AND kind = 'improve')
  WHERE t.status = 'review' AND k.archived = 0 AND r.text = t.text AND r.previous_text IS NOT NULL AND r.previous_text <> t.text
    AND t.updated_by IS NOT ? AND r.previous_by IS NOT ?
    AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.key_id = t.key_id AND v.locale = t.locale AND v.user_id = ? AND v.kind IN ('approve', 'flag'))
    AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.key_id = t.key_id AND p.locale = t.locale AND p.user_id = ?)`;

/** Strings in `project` and `locale` that could be Pick cards for `viewer`, longest-waiting first. */
export function pickCandidates(db: DB, project: ProjectRow, locale: string, viewer: Member, limit: number) {
  if (project.review_mode !== 'community') return [];
  return all<{ key_id: number; urgent: number; shot: number | null; since: string }>(
    db,
    `SELECT c.key_id, k.urgent, (SELECT MIN(screenshot_id) FROM screenshot_keys WHERE key_id = k.id) AS shot, t.updated_at AS since
     FROM (${PAIR_SQL} AND k.project_id = ? AND t.locale = ?) c
     JOIN keys k ON k.id = c.key_id JOIN translations t ON t.key_id = c.key_id AND t.locale = ?
     ORDER BY k.urgent DESC, since, k.id LIMIT ?`,
    viewer.id, viewer.id, viewer.id, viewer.id, project.id, locale, locale, limit,
  );
}

/** The card's content: the source and the two wordings, in random order. */
export function pickCard(db: DB, keyId: number, locale: string, viewer: Member, rand: () => number) {
  const pair = get<{ current: string; previous: string }>(db, `${PAIR_SQL} AND t.key_id = ? AND t.locale = ?`, viewer.id, viewer.id, viewer.id, viewer.id, keyId, locale);
  if (!pair) return null;
  const key = get<{ source: string; description: string | null }>(db, 'SELECT source, description FROM keys WHERE id = ?', keyId)!;
  const [a, b] = rand() < 0.5 ? [pair.current, pair.previous] : [pair.previous, pair.current];
  return { keyId, source: key.source, note: key.description, a, b };
}

/**
 * Saves `viewer`'s pick. `chosen` and `other` must be the string's current pair (409 when it moved on). Books
 * pending 'pick' XP and records review activity.
 */
export function savePick(db: DB, project: ProjectRow, viewer: Member, keyId: number, locale: string, chosen: unknown, other: unknown) {
  if (typeof chosen !== 'string' || typeof other !== 'string') throw new HttpError(400, 'Send the chosen wording and the other one.');
  if (project.review_mode !== 'community') throw new HttpError(409, 'This project has no wordings to pick between.');
  const pair = get<{ current: string; previous: string }>(db, `${PAIR_SQL} AND t.key_id = ? AND t.locale = ?`, viewer.id, viewer.id, viewer.id, viewer.id, keyId, locale);
  const same = pair && ((chosen === pair.current && other === pair.previous) || (chosen === pair.previous && other === pair.current));
  if (!same) throw new HttpError(409, 'This one has moved on since the card was dealt.');
  const s = { projectId: project.id, keyId, locale };
  return tx(db, () => {
    run(db, 'INSERT INTO picks (user_id, key_id, locale, chosen, other) VALUES (?, ?, ?, ?, ?)', viewer.id, keyId, locale, chosen, other);
    run(
      db,
      "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status) VALUES (?, 'pick', ?, ?, ?, ?, 'pending')",
      viewer.id, keyId, locale, project.id, CARD_XP.pick,
    );
    recordActivity(db, viewer, 'review', s);
    return { ok: true as const, xp: { points: CARD_XP.pick, status: 'pending' as const } };
  });
}
