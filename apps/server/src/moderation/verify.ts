import { get, run, type DB, type OrgRow, type Verification } from '../db.js';
import { eoNames, lookupEin, normalizeEin, type EoMatch } from './eobmf.js';

/**
 * Nonprofit verification against the IRS EO-BMF (see eobmf.ts). An EIN + name + state match verifies the org
 * automatically; anything else (no EIN, EIN not listed, name or state differs, no state given) waits in the
 * staff queue. checkOrg is the one place the rule lives.
 */

// Words that don't tell two names apart: legal forms and filler. "Eastside Food Bank" matches "EASTSIDE FOOD BANK INC".
const NOISE = new Set(['THE', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LLC', 'LTD', 'LIMITED', 'NFP', 'NPO', 'OF']);

/** Uppercase words with punctuation and legal-form noise removed; "&" reads as "AND". */
export function nameWords(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w));
}

export function namesMatch(a: string, b: string): boolean {
  const x = nameWords(a).join(' ');
  return x.length > 0 && x === nameWords(b).join(' ');
}

export interface VerificationCheck {
  verified: boolean;
  /** Why it was or wasn't verified automatically, shown to staff. */
  reason: string;
  match: EoMatch | null;
}

/** The automatic rule: EIN listed, the name matches the IRS name or secondary name, and the state matches. */
export function checkOrg(db: DB, org: Pick<OrgRow, 'id' | 'name' | 'ein'>): VerificationCheck {
  const ein = normalizeEin(org.ein ?? '');
  if (!ein) return { verified: false, reason: org.ein ? 'EIN is not 9 digits' : 'No EIN given', match: null };
  const match = lookupEin(db, ein);
  if (!match) return { verified: false, reason: 'EIN is not in the IRS exempt organizations list', match: null };
  const names = eoNames(db, ein)!;
  if (!namesMatch(org.name, names.name) && !(names.sort_name && namesMatch(org.name, names.sort_name))) {
    return { verified: false, reason: `Name doesn't match the IRS record (${match.name})`, match };
  }
  const state = get<{ state: string | null }>(db, 'SELECT state FROM orgs WHERE id = ?', org.id)?.state?.trim().toUpperCase();
  if (!state) return { verified: false, reason: `No state given (IRS record: ${match.state})`, match };
  if (state !== match.state) return { verified: false, reason: `State ${state} doesn't match the IRS record (${match.state})`, match };
  return { verified: true, reason: 'EIN, name and state match the IRS record', match };
}

/** The latest automatic or staff note on an org's verification, for the staff queue. */
export const latestVerification = (db: DB, orgId: number) =>
  get<{ decision: string; source: 'auto' | 'staff'; note: string | null; created_at: string }>(
    db,
    'SELECT decision, source, note, created_at FROM org_verifications WHERE org_id = ? ORDER BY id DESC LIMIT 1',
    orgId,
  );

/**
 * Owned by Segment 2 piece 2B (verification and moderation).
 *
 * 2A calls this after creating an org or changing its EIN, name or state. Nonprofits are looked up in the EO-BMF
 * table: 'verified' on an EIN + name + state match, else 'pending' for the staff queue. Other org types keep
 * their verification. The org row is re-read, so callers can pass it from before their own UPDATE.
 */
export function startVerification(db: DB, org: OrgRow): Verification {
  const current = get<OrgRow>(db, 'SELECT id, name, type, verification, ein, website, description FROM orgs WHERE id = ?', org.id) ?? org;
  if (current.type !== 'nonprofit') return current.verification;
  const check = checkOrg(db, current);
  const decision: Verification = check.verified ? 'verified' : 'pending';
  run(db, 'UPDATE orgs SET verification = ? WHERE id = ?', decision, current.id);
  run(db, "INSERT INTO org_verifications (org_id, decision, source, note) VALUES (?, ?, 'auto', ?)", current.id, decision, check.reason);
  return decision;
}

/** A staff decision from the verification queue. */
export function decideVerification(db: DB, orgId: number, staffId: number, decision: 'verified' | 'rejected', note: string | null) {
  run(db, 'UPDATE orgs SET verification = ? WHERE id = ?', decision, orgId);
  run(db, "INSERT INTO org_verifications (org_id, decision, source, note, staff_id) VALUES (?, ?, 'staff', ?, ?)", orgId, decision, note, staffId);
}
