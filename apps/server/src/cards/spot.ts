import { HttpError } from '../auth.js';
import { all, get, run, tx, type DB, type Member, type OrgRow, type ProjectRow } from '../db.js';
import { recordActivity } from '../streaks.js';
import { CARD_XP } from '../xp.js';

/**
 * Spot the problem (docs/segment-3c-card-types.md): an approved translation with one planted error, or none (a
 * control). The error is always a number the source and translation share: a time, price, phone number, date or
 * count. It works in every language with no one writing content, and it's graded exactly.
 */

export interface NumberToken {
  /** Digit values, e.g. "0100" (whatever the script: "٥" and "５" are "5"). */
  value: string;
  /** The text as written. */
  text: string;
  start: number;
  end: number;
}

const DIGIT = /\p{Nd}/u;

/** A decimal digit's value. Unicode keeps each script's digits as a run of ten starting at zero. */
function digitZero(ch: string): number {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return cp - ((cp - start) % 10);
}

export function numbersIn(text: string): NumberToken[] {
  return [...text.matchAll(/\p{Nd}+/gu)].map((m) => ({
    value: [...m[0]].map((ch) => String(ch.codePointAt(0)! - digitZero(ch))).join(''),
    text: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
}

/**
 * Changes one number the source and translation share: its last digit goes up by one (9 wraps to 0), in the same
 * script. The new value must not appear in the source, or the card would have no clear answer. `rand` (0 to 1)
 * picks where to start among the shared numbers. Null when nothing can be planted.
 */
export function plant(source: string, text: string, rand: () => number): { shown: string; original: string; changed: string } | null {
  const inSource = new Set(numbersIn(source).map((n) => n.value));
  const shared = numbersIn(text).filter((n) => inSource.has(n.value));
  if (!shared.length) return null;
  const first = Math.floor(rand() * shared.length) % shared.length;
  for (let i = 0; i < shared.length; i++) {
    const n = shared[(first + i) % shared.length];
    const chars = [...n.text];
    const last = chars[chars.length - 1];
    const zero = digitZero(last);
    const next = (last.codePointAt(0)! - zero + 1) % 10;
    const changed = chars.slice(0, -1).join('') + String.fromCodePoint(zero + next);
    const changedValue = n.value.slice(0, -1) + next;
    if (inSource.has(changedValue)) continue;
    return { shown: text.slice(0, n.start) + changed + text.slice(n.end), original: n.text, changed };
  }
  return null;
}

/** Half of all Spot cards show the approved text unchanged. */
export const CONTROL_SHARE = 0.5;

/** A project a session may draw from (pool/session.ts), with the role the volunteer acts with there. */
interface Source {
  project: ProjectRow;
  org: OrgRow;
  member: Member;
  favorite: boolean;
}

export interface DealtSpot {
  source: Source;
  locale: string;
  keyId: number;
  checkId: number;
  /** The English (source) text and the translation as shown. */
  sourceText: string;
  shown: string;
}

/**
 * Picks a Spot the problem card and records it: an approved translation in one of `sources` and `locales` that the
 * volunteer didn't write, whose source has a number, planted or left as a control. A text the volunteer has already
 * been shown is skipped. Placeholders and plurals (any "{") are left out, so the card shows plain text.
 */
export function dealSpot(db: DB, userId: number, sources: Source[], locales: string[], rand: () => number): DealtSpot | null {
  const byProject = new Map(sources.map((s) => [s.project.id, s]));
  if (!byProject.size || !locales.length) return null;
  const rows = all<{ key_id: number; project_id: number; locale: string; source: string; text: string }>(
    db,
    `SELECT t.key_id, k.project_id, t.locale, k.source, t.text FROM translations t JOIN keys k ON k.id = t.key_id
     WHERE t.status = 'approved' AND k.archived = 0 AND t.updated_by IS NOT ?
       AND k.project_id IN (${[...byProject.keys()].map(() => '?').join(', ')})
       AND t.locale IN (${locales.map(() => '?').join(', ')})
       AND k.source GLOB '*[0-9]*' AND instr(t.text, '{') = 0 AND instr(k.source, '{') = 0
     ORDER BY t.key_id, t.locale LIMIT 500`,
    userId, ...byProject.keys(), ...locales,
  );
  // Random order, from `rand` so tests can fix it.
  const order = rows.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r);
  for (const r of order) {
    const planted = rand() >= CONTROL_SHARE ? plant(r.source, r.text, rand) : null;
    if (!planted && !numbersIn(r.text).length) continue;
    const shown = planted?.shown ?? r.text;
    if (get(db, 'SELECT 1 FROM spot_checks WHERE user_id = ? AND key_id = ? AND locale = ? AND shown = ?', userId, r.key_id, r.locale, shown)) continue;
    const source = byProject.get(r.project_id)!;
    const checkId = Number(
      run(
        db,
        'INSERT INTO spot_checks (user_id, key_id, locale, project_id, role, shown, planted, original, changed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        userId, r.key_id, r.locale, r.project_id, source.member.role, shown, planted ? 1 : 0, planted?.original ?? null, planted?.changed ?? null,
      ).lastInsertRowid,
    );
    return { source, locale: r.locale, keyId: r.key_id, checkId, sourceText: r.source, shown };
  }
  return null;
}

/**
 * The volunteer's answer: "ok" or "problem". Right when it matches whether a number was planted. A right answer
 * earns accepted 'check' XP at once (nothing else has to agree), and any answer counts as review activity.
 */
export function answerSpot(db: DB, user: { id: number }, checkId: number, verdict: unknown) {
  if (verdict !== 'ok' && verdict !== 'problem') throw new HttpError(400, 'verdict must be "ok" or "problem".');
  const c = get<{ key_id: number; locale: string; project_id: number; role: Member['role']; planted: number; original: string | null; changed: string | null; answered_at: string | null }>(
    db,
    'SELECT key_id, locale, project_id, role, planted, original, changed, answered_at FROM spot_checks WHERE id = ? AND user_id = ?',
    checkId, user.id,
  );
  if (!c) throw new HttpError(404, 'Card not found.');
  if (c.answered_at) throw new HttpError(409, 'You already answered this one.');
  const correct = (verdict === 'problem') === !!c.planted;
  const s = { projectId: c.project_id, keyId: c.key_id, locale: c.locale };
  tx(db, () => {
    // answered_at in the WHERE: two answers at once can't both count.
    const answered = run(db, 'UPDATE spot_checks SET verdict = ?, correct = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ? AND answered_at IS NULL', verdict, correct ? 1 : 0, checkId);
    if (!Number(answered.changes)) throw new HttpError(409, 'You already answered this one.');
    if (correct) {
      run(
        db,
        "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, settled_at) VALUES (?, 'check', ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)",
        user.id, c.key_id, c.locale, c.project_id, CARD_XP.check,
      );
    }
    recordActivity(db, { id: user.id, role: c.role } as Member, 'review', s);
  });
  return {
    correct,
    planted: !!c.planted,
    original: c.original,
    changed: c.changed,
    xp: correct ? { points: CARD_XP.check, status: 'accepted' as const } : null,
  };
}
