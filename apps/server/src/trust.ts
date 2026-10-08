import { HttpError } from './auth.js';
import { all, get, run, tx, type DB, type UserRow } from './db.js';

/**
 * Trust is per language. 'new' volunteers translate, but their reviews don't count until they pass the
 * placement check. 'trusted' approvals count toward peer review. A 'lead' approval is final.
 */
export type Tier = 'new' | 'trusted' | 'lead';
export const TIERS: Tier[] = ['new', 'trusted', 'lead'];

/** Placement pass marks: share of planted problems judged correctly, and of translations a grader accepts. */
export const PASS_REVIEW = 0.8;
export const PASS_TRANSLATE = 0.8;
export const RETRY_DAYS = 7;
const PICK = { translate: 5, review: 8 };

export function tierOf(db: DB, user: UserRow, locale: string): Tier {
  const row = get<{ tier: Tier }>(db, 'SELECT tier FROM user_languages WHERE user_id = ? AND locale = ?', user.id, locale);
  if (row) return row.tier;
  // No row: someone an admin added directly. Admins and reviewers lead; invited localizers are vetted.
  return user.role === 'localizer' ? 'trusted' : 'lead';
}

export function tiersOf(db: DB, user: UserRow): Record<string, Tier> {
  return Object.fromEntries((JSON.parse(user.locales) as string[]).map((l) => [l, tierOf(db, user, l)]));
}

export function setTier(db: DB, userId: number, locale: string, tier: Tier, reason: string) {
  if (!TIERS.includes(tier)) throw new HttpError(400, 'Tier must be new, trusted or lead.');
  run(
    db,
    `INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, locale) DO UPDATE SET tier = excluded.tier, reason = excluded.reason, updated_at = CURRENT_TIMESTAMP`,
    userId, locale, tier, reason,
  );
}

// ---------- placement check ----------

interface ItemRow {
  id: number;
  org_id: number;
  locale: string;
  kind: 'translate' | 'review';
  source: string;
  reference: string | null;
  candidate: string | null;
  has_error: number;
  error_note: string | null;
}
interface AttemptRow {
  id: number;
  user_id: number;
  locale: string;
  status: 'in_progress' | 'submitted' | 'passed' | 'failed';
  review_correct: number | null;
  review_total: number | null;
  started_at: string;
  submitted_at: string | null;
  graded_at: string | null;
}
interface AnswerRow {
  item_id: number;
  position: number;
  text: string | null;
  verdict: 'ok' | 'problem' | null;
  explanation: string | null;
  correct: number | null;
  grader_note: string | null;
}

const latestAttempt = (db: DB, userId: number, locale: string) =>
  get<AttemptRow>(db, 'SELECT * FROM placement_attempts WHERE user_id = ? AND locale = ? ORDER BY id DESC LIMIT 1', userId, locale);

const itemCounts = (db: DB, orgId: number, locale: string) =>
  Object.fromEntries(
    all<{ kind: string; n: number }>(db, 'SELECT kind, COUNT(*) AS n FROM placement_items WHERE org_id = ? AND locale = ? AND archived = 0 GROUP BY kind', orgId, locale).map((r) => [r.kind, r.n]),
  ) as Partial<Record<'translate' | 'review', number>>;

function retryAfter(attempt: AttemptRow | undefined): string | null {
  if (attempt?.status !== 'failed' || !attempt.graded_at) return null;
  const at = new Date(attempt.graded_at + 'Z').getTime() + RETRY_DAYS * 864e5;
  return at > Date.now() ? new Date(at).toISOString() : null;
}

export function placementStatus(db: DB, user: UserRow, locale: string) {
  const attempt = latestAttempt(db, user.id, locale);
  const counts = itemCounts(db, user.org_id, locale);
  return {
    locale,
    tier: tierOf(db, user, locale),
    available: (counts.translate ?? 0) + (counts.review ?? 0) > 0,
    questions: Math.min(counts.translate ?? 0, PICK.translate) + Math.min(counts.review ?? 0, PICK.review),
    attempt: attempt ? { id: attempt.id, status: attempt.status, submittedAt: attempt.submitted_at, gradedAt: attempt.graded_at } : null,
    retryAfter: retryAfter(attempt),
  };
}

/** What the candidate sees: never the reference or whether a problem was planted. */
function attemptForCandidate(db: DB, attempt: AttemptRow) {
  const rows = all<AnswerRow & ItemRow>(
    db,
    'SELECT a.*, i.kind, i.source, i.candidate FROM placement_answers a JOIN placement_items i ON i.id = a.item_id WHERE a.attempt_id = ? ORDER BY a.position',
    attempt.id,
  );
  return {
    id: attempt.id,
    locale: attempt.locale,
    status: attempt.status,
    items: rows.map((r) => ({ itemId: r.item_id, kind: r.kind, source: r.source, candidate: r.kind === 'review' ? r.candidate : undefined })),
  };
}

function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

export function startPlacement(db: DB, user: UserRow, locale: string) {
  if (!(JSON.parse(user.locales) as string[]).includes(locale)) throw new HttpError(403, `You haven't joined ${locale}.`);
  if (tierOf(db, user, locale) !== 'new') throw new HttpError(409, 'You can already review in this language.');
  const last = latestAttempt(db, user.id, locale);
  if (last?.status === 'in_progress') return attemptForCandidate(db, last);
  if (last?.status === 'submitted') throw new HttpError(409, 'Your placement check is waiting to be graded.');
  const wait = retryAfter(last);
  if (wait) throw new HttpError(409, `You can try again after ${wait.slice(0, 10)}.`);

  const items = all<ItemRow>(db, 'SELECT * FROM placement_items WHERE org_id = ? AND locale = ? AND archived = 0', user.org_id, locale);
  if (!items.length) throw new HttpError(404, 'There is no placement check for this language yet. An admin can add one, or mark you as trusted.');
  const translate = shuffle(items.filter((i) => i.kind === 'translate')).slice(0, PICK.translate);
  const review = shuffle(items.filter((i) => i.kind === 'review')).slice(0, PICK.review);
  // Spotting problems first: it's quicker, and it shows the standard we expect before they write.
  const picked = [...review, ...translate];

  return tx(db, () => {
    const id = Number(run(db, "INSERT INTO placement_attempts (user_id, locale, status) VALUES (?, ?, 'in_progress')", user.id, locale).lastInsertRowid);
    picked.forEach((item, i) => run(db, 'INSERT INTO placement_answers (attempt_id, item_id, position) VALUES (?, ?, ?)', id, item.id, i));
    return attemptForCandidate(db, get<AttemptRow>(db, 'SELECT * FROM placement_attempts WHERE id = ?', id)!);
  });
}

export interface SubmittedAnswer {
  itemId: number;
  text?: string;
  verdict?: 'ok' | 'problem';
  explanation?: string;
}

export function submitPlacement(db: DB, user: UserRow, attemptId: number, answers: SubmittedAnswer[]) {
  const attempt = get<AttemptRow>(db, 'SELECT * FROM placement_attempts WHERE id = ? AND user_id = ?', attemptId, user.id);
  if (!attempt) throw new HttpError(404, 'Placement check not found.');
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'This placement check was already submitted.');
  const rows = all<AnswerRow & ItemRow>(db, 'SELECT a.*, i.kind, i.has_error FROM placement_answers a JOIN placement_items i ON i.id = a.item_id WHERE a.attempt_id = ?', attemptId);
  const byItem = new Map(answers.map((a) => [a.itemId, a]));

  return tx(db, () => {
    let reviewCorrect = 0;
    let reviewTotal = 0;
    for (const row of rows) {
      const a = byItem.get(row.item_id);
      if (row.kind === 'translate') {
        const text = a?.text?.trim();
        if (!text) throw new HttpError(400, 'Translate every sentence before you submit.');
        run(db, 'UPDATE placement_answers SET text = ? WHERE attempt_id = ? AND item_id = ?', text, attemptId, row.item_id);
      } else {
        if (a?.verdict !== 'ok' && a?.verdict !== 'problem') throw new HttpError(400, 'Mark every translation as "looks right" or "has a problem".');
        const correct = (a.verdict === 'problem') === !!row.has_error ? 1 : 0;
        reviewCorrect += correct;
        reviewTotal++;
        run(db, 'UPDATE placement_answers SET verdict = ?, explanation = ?, correct = ? WHERE attempt_id = ? AND item_id = ?', a.verdict, a.explanation?.trim() || null, correct, attemptId, row.item_id);
      }
    }
    run(db, "UPDATE placement_attempts SET status = 'submitted', review_correct = ?, review_total = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ?", reviewCorrect, reviewTotal, attemptId);
    // Nothing for a person to grade: decide now.
    if (!rows.some((r) => r.kind === 'translate')) return finish(db, attemptId, null);
    return { status: 'submitted' as const };
  });
}

/** Who may grade: admins, reviewers of the language, and leads in it. Never the candidate. */
function canGrade(db: DB, grader: UserRow, locale: string) {
  if (grader.role === 'admin') return true;
  const locales = JSON.parse(grader.locales) as string[];
  return locales.includes(locale) && (grader.role === 'reviewer' || tierOf(db, grader, locale) === 'lead');
}

export function gradingQueue(db: DB, grader: UserRow) {
  const attempts = all<AttemptRow & { name: string }>(
    db,
    `SELECT a.*, u.name FROM placement_attempts a JOIN users u ON u.id = a.user_id
     WHERE a.status = 'submitted' AND u.org_id = ? AND a.user_id != ? ORDER BY a.submitted_at`,
    grader.org_id, grader.id,
  ).filter((a) => canGrade(db, grader, a.locale));
  return attempts.map((a) => ({
    id: a.id,
    name: a.name,
    locale: a.locale,
    submittedAt: a.submitted_at,
    review: { correct: a.review_correct ?? 0, total: a.review_total ?? 0 },
    // The problem-spotting part was graded automatically; show the misses so the grader has the full picture.
    reviewMisses: all<{ source: string; candidate: string; has_error: number; error_note: string | null; verdict: string; explanation: string | null }>(
      db,
      `SELECT i.source, i.candidate, i.has_error, i.error_note, an.verdict, an.explanation FROM placement_answers an
       JOIN placement_items i ON i.id = an.item_id WHERE an.attempt_id = ? AND i.kind = 'review' AND an.correct = 0 ORDER BY an.position`,
      a.id,
    ).map((m) => ({ source: m.source, candidate: m.candidate, planted: m.has_error ? m.error_note : null, verdict: m.verdict, explanation: m.explanation })),
    translations: all<{ item_id: number; source: string; reference: string | null; text: string }>(
      db,
      `SELECT an.item_id, i.source, i.reference, an.text FROM placement_answers an
       JOIN placement_items i ON i.id = an.item_id WHERE an.attempt_id = ? AND i.kind = 'translate' ORDER BY an.position`,
      a.id,
    ).map((t) => ({ itemId: t.item_id, source: t.source, reference: t.reference, text: t.text })),
  }));
}

export function gradePlacement(db: DB, grader: UserRow, attemptId: number, grades: { itemId: number; pass: boolean; note?: string }[]) {
  const attempt = get<AttemptRow & { org_id: number }>(db, 'SELECT a.*, u.org_id FROM placement_attempts a JOIN users u ON u.id = a.user_id WHERE a.id = ?', attemptId);
  if (!attempt || attempt.org_id !== grader.org_id) throw new HttpError(404, 'Placement check not found.');
  if (attempt.user_id === grader.id) throw new HttpError(403, "You can't grade your own placement check.");
  if (!canGrade(db, grader, attempt.locale)) throw new HttpError(403, 'Only reviewers and leads in this language can grade it.');
  if (attempt.status !== 'submitted') throw new HttpError(409, 'This placement check is not waiting to be graded.');
  const toGrade = all<{ item_id: number }>(db, "SELECT an.item_id FROM placement_answers an JOIN placement_items i ON i.id = an.item_id WHERE an.attempt_id = ? AND i.kind = 'translate'", attemptId);
  const byItem = new Map(grades.map((g) => [g.itemId, g]));
  if (toGrade.some((t) => typeof byItem.get(t.item_id)?.pass !== 'boolean')) throw new HttpError(400, 'Grade every translation as acceptable or not.');
  return tx(db, () => {
    for (const t of toGrade) {
      const g = byItem.get(t.item_id)!;
      run(db, 'UPDATE placement_answers SET correct = ?, grader_note = ? WHERE attempt_id = ? AND item_id = ?', g.pass ? 1 : 0, g.note?.trim() || null, attemptId, t.item_id);
    }
    return finish(db, attemptId, grader.id);
  });
}

function finish(db: DB, attemptId: number, graderId: number | null) {
  const a = get<AttemptRow>(db, 'SELECT * FROM placement_attempts WHERE id = ?', attemptId)!;
  const t = get<{ ok: number; n: number }>(
    db,
    "SELECT COALESCE(SUM(an.correct), 0) AS ok, COUNT(*) AS n FROM placement_answers an JOIN placement_items i ON i.id = an.item_id WHERE an.attempt_id = ? AND i.kind = 'translate'",
    attemptId,
  )!;
  const reviewOk = !a.review_total || (a.review_correct ?? 0) / a.review_total >= PASS_REVIEW;
  const translateOk = !t.n || t.ok / t.n >= PASS_TRANSLATE;
  const status = reviewOk && translateOk ? 'passed' : 'failed';
  run(db, 'UPDATE placement_attempts SET status = ?, graded_by = ?, graded_at = CURRENT_TIMESTAMP WHERE id = ?', status, graderId, attemptId);
  if (status === 'passed') setTier(db, a.user_id, a.locale, 'trusted', 'placement check');
  return {
    status,
    review: { correct: a.review_correct ?? 0, total: a.review_total ?? 0 },
    translations: { accepted: t.ok, total: t.n },
  };
}

// ---------- placement content (admins) ----------

export function listItems(db: DB, orgId: number, locale: string) {
  return all<ItemRow>(db, 'SELECT * FROM placement_items WHERE org_id = ? AND locale = ? AND archived = 0 ORDER BY kind, id', orgId, locale).map((i) => ({
    id: i.id,
    kind: i.kind,
    source: i.source,
    reference: i.reference,
    candidate: i.candidate,
    hasError: !!i.has_error,
    errorNote: i.error_note,
  }));
}

export function addItem(
  db: DB,
  orgId: number,
  locale: string,
  body: { kind?: string; source?: string; reference?: string; candidate?: string; hasError?: boolean; errorNote?: string },
) {
  const source = body.source?.trim();
  if (!source) throw new HttpError(400, 'Write the English sentence.');
  if (body.kind === 'translate') {
    if (!body.reference?.trim()) throw new HttpError(400, 'Add a good reference translation for graders to compare against.');
  } else if (body.kind === 'review') {
    if (!body.candidate?.trim()) throw new HttpError(400, 'Add the translation volunteers will judge.');
    if (body.hasError && !body.errorNote?.trim()) throw new HttpError(400, "Describe the planted problem so graders know what it is.");
  } else {
    throw new HttpError(400, 'Kind must be "translate" or "review".');
  }
  const r = run(
    db,
    'INSERT INTO placement_items (org_id, locale, kind, source, reference, candidate, has_error, error_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    orgId, locale, body.kind, source, body.reference?.trim() || null, body.candidate?.trim() || null, body.hasError ? 1 : 0, body.hasError ? body.errorNote!.trim() : null,
  );
  return { id: Number(r.lastInsertRowid) };
}
