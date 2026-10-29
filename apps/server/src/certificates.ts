import { HttpError, randomToken } from './auth.js';
import { all, get, run, type DB } from './db.js';
import { localDay, timeZoneOf } from './streaks.js';

/**
 * Volunteer-hour certificates (docs/segment-3b-badges.md). Hours are estimated from accepted work at published
 * rates, the same rule as XP: nothing records time, and rushed or rejected work earns nothing. Each certificate is a
 * fixed copy of what was issued, so its public page always matches the printout. Later work, or new rates, need a
 * new certificate.
 */

/** Minutes per accepted card. Printed on every certificate; RATES_VERSION changes with them. */
export const RATES = { translate: 2, review: 1 } as const;
export const RATES_VERSION = '2026-10';
const MIN_MINUTES = 30;

interface CertificateRow {
  code: string;
  user_id: number;
  name: string;
  period_from: string | null;
  period_to: string;
  minutes: number;
  translations: number;
  reviews: number;
  orgs: string;
  rates: string;
  issued_at: string;
  revoked_at: string | null;
}

const toJson = (r: CertificateRow) => ({
  code: r.code,
  name: r.name,
  periodFrom: r.period_from,
  periodTo: r.period_to,
  hours: Math.floor(r.minutes / 30) / 2,
  translations: r.translations,
  reviews: r.reviews,
  orgs: JSON.parse(r.orgs) as string[],
  rates: JSON.parse(r.rates) as { version: string; translate: number; review: number },
  issuedAt: r.issued_at,
  revokedAt: r.revoked_at,
});
export type Certificate = ReturnType<typeof toJson>;

/** YYYY-MM-DD that's a real date, or undefined when not given. */
function day(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  // Date.parse rolls 2026-02-30 over to March, so the date must survive the round trip.
  const ok = !Number.isNaN(t) && new Date(t).toISOString().startsWith(v as string);
  if (!ok) throw new HttpError(400, `${field} must be a date like 2026-09-01.`);
  return v as string;
}

/**
 * Work counts in the period it was done (xp_events.created_at, by its UTC date), if it's accepted by now: a
 * school-year certificate issued in July includes June's work accepted in July.
 */
export function issueCertificate(db: DB, user: { id: number; name: string }, period: { from?: unknown; to?: unknown }, now = Date.now()): Certificate {
  const today = localDay(timeZoneOf(db, user.id), now);
  const from = day(period.from, 'from') ?? null;
  const to = day(period.to, 'to') ?? today;
  if (to > today) throw new HttpError(400, "The period can't end in the future.");
  if (from && from > to) throw new HttpError(400, 'The period has to start before it ends.');

  const where = "x.user_id = ? AND x.status = 'accepted' AND substr(x.created_at, 1, 10) BETWEEN ? AND ?";
  const args = [user.id, from ?? '0000-01-01', to] as const;
  const counts = { translate: 0, review: 0 };
  for (const r of all<{ kind: 'translate' | 'review'; n: number }>(db, `SELECT x.kind, COUNT(*) AS n FROM xp_events x WHERE ${where} GROUP BY x.kind`, ...args)) counts[r.kind] = r.n;
  const minutes = counts.translate * RATES.translate + counts.review * RATES.review;
  if (minutes < MIN_MINUTES) throw new HttpError(422, "There isn't half an hour of accepted work in that period yet.");
  const orgs = all<{ name: string }>(
    db,
    `SELECT DISTINCT o.name FROM xp_events x JOIN projects p ON p.id = x.project_id JOIN orgs o ON o.id = p.org_id WHERE ${where} ORDER BY o.name`,
    ...args,
  ).map((r) => r.name);

  const code = randomToken('vc_');
  run(
    db,
    `INSERT INTO volunteer_certificates (code, user_id, name, period_from, period_to, minutes, translations, reviews, orgs, rates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code, user.id, user.name, from, to, minutes, counts.translate, counts.review, JSON.stringify(orgs), JSON.stringify({ version: RATES_VERSION, ...RATES }),
  );
  return toJson(get<CertificateRow>(db, 'SELECT * FROM volunteer_certificates WHERE code = ?', code)!);
}

export const certificatesOf = (db: DB, userId: number) =>
  all<CertificateRow>(db, 'SELECT * FROM volunteer_certificates WHERE user_id = ? ORDER BY issued_at DESC, rowid DESC', userId).map(toJson);

export function revokeCertificate(db: DB, userId: number, code: string): Certificate {
  const r = get<CertificateRow>(db, 'SELECT * FROM volunteer_certificates WHERE code = ? AND user_id = ?', code, userId);
  if (!r) throw new HttpError(404, 'Certificate not found.');
  if (!r.revoked_at) run(db, 'UPDATE volunteer_certificates SET revoked_at = CURRENT_TIMESTAMP WHERE code = ?', code);
  return toJson(get<CertificateRow>(db, 'SELECT * FROM volunteer_certificates WHERE code = ?', code)!);
}

/** What anyone with the code sees. A revoked certificate says so, and no longer shows its numbers. */
export function publicCertificate(db: DB, code: string) {
  const r = get<CertificateRow>(db, 'SELECT * FROM volunteer_certificates WHERE code = ?', code);
  if (!r) throw new HttpError(404, 'Certificate not found.');
  if (r.revoked_at) return { code: r.code, revoked: true as const, name: r.name, periodFrom: r.period_from, periodTo: r.period_to, issuedAt: r.issued_at, revokedAt: r.revoked_at };
  return toJson(r);
}
