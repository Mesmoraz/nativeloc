import { all, get, run, type DB, type ProjectRow } from '../db.js';
import { pausedByReports } from './reports.js';

export interface ScreenResult {
  /** 'approved': clear pass, volunteers can see it. 'pending': goes to the staff queue. */
  decision: 'approved' | 'pending';
  /** Why it was held, for the staff queue, e.g. ["3 phone numbers", "mentions prices"]. Empty when approved. */
  reasons: string[];
}

/**
 * The automatic screen's rules, all in one place so they're easy to tune. A project that trips none of them is
 * approved; anything else waits for staff with the reasons listed. The screen never rejects on its own.
 * (Plan §4, "commercial-content screen": automatic heuristics + staff review.)
 */
export const RULES = {
  /** Size: the community tier is for a page or a small app, not a whole site. */
  maxStrings: 1500,
  maxWords: 20_000,
  maxStringChars: 5000,
  /** Density: hold when there are at least `min` hits and fewer than `wordsPerHit` words per hit, or `max` hits in all. */
  links: { min: 3, wordsPerHit: 40, max: 25 },
  phones: { min: 3, wordsPerHit: 40, max: 10 },
  /** Prices are commercial unless the string is about donating. */
  maxPrices: 0,
  /** Small blocklist: scams, adult content, gambling. Whole words, case-insensitive. Hits are listed for staff. */
  blocklist: ['casino', 'viagra', 'cialis', 'porn', 'xxx', 'escort', 'onlyfans', 'forex', 'payday loan', 'crypto giveaway', 'sports betting', 'replica watches', 'get rich quick'],
  /** Shop wording. One hit is enough to hold the project. */
  commercial: ['buy now', 'add to cart', 'add to bag', 'checkout', 'check out now', 'shop now', 'order now', 'free shipping', 'promo code', 'coupon code', 'discount code', 'limited time offer', 'subscribe and save', 'best price', '% off'],
  /** Business accounts are waitlisted (plan §4); if one reaches submit anyway, staff look at it. */
  holdBusinessOrgs: true,
};

const LINK_RE = /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|shop|store|biz|info|ly)(?:\/\S*)?\b/gi;
// Phone numbers with the usual separators: 555-0100, (503) 555-0100, +44 20 7946 0958.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b|\b\d{3}[\s.-]\d{4}\b/g;
const PRICE_RE = /[$€£¥₹]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|dollars|euros)\b/gi;
const DONATION_RE = /\bdonat|\bgive\b|\bgift\b|\bfundrais|\bsponsor/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (p: string) => new RegExp(`${/^\w/.test(p) ? '\\b' : ''}${escape(p)}${/\w$/.test(p) ? '\\b' : ''}`, 'i');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (re: RegExp, s: string) => s.match(re)?.length ?? 0;

function dense(hits: number, words: number, rule: { min: number; wordsPerHit: number; max: number }) {
  return hits >= rule.max || (hits >= rule.min && words / hits < rule.wordsPerHit);
}

/** Runs RULES over a project's text. Pure: no database. `orgType` is the posting org's type. */
export function screenText(sources: string[], orgType?: string): ScreenResult {
  const reasons: string[] = [];
  const text = sources.join('\n');
  const words = text.split(/\s+/).filter(Boolean).length;

  if (!sources.length) reasons.push('no text to translate');
  if (sources.length > RULES.maxStrings) reasons.push(`${sources.length} strings (limit ${RULES.maxStrings})`);
  if (words > RULES.maxWords) reasons.push(`${words} words (limit ${RULES.maxWords})`);
  const long = sources.filter((s) => s.length > RULES.maxStringChars).length;
  if (long) reasons.push(`${plural(long, 'string')} over ${RULES.maxStringChars} characters`);

  const links = count(LINK_RE, text);
  if (dense(links, words, RULES.links)) reasons.push(plural(links, 'link'));
  const phones = count(PHONE_RE, text);
  if (dense(phones, words, RULES.phones)) reasons.push(plural(phones, 'phone number'));

  const blocked = RULES.blocklist.filter((w) => phraseRe(w).test(text));
  if (blocked.length) reasons.push(`blocked words: ${blocked.map((w) => `"${w}"`).join(', ')}`);

  const prices = sources.filter((s) => !DONATION_RE.test(s)).reduce((n, s) => n + count(PRICE_RE, s), 0);
  if (prices > RULES.maxPrices) reasons.push(`mentions prices (${prices})`);
  const shop = RULES.commercial.filter((w) => phraseRe(w).test(text));
  if (shop.length) reasons.push(`commercial wording: ${shop.map((w) => `"${w}"`).join(', ')}`);

  if (RULES.holdBusinessOrgs && orgType === 'business') reasons.push('posted by a business account');
  return { decision: reasons.length ? 'pending' : 'approved', reasons };
}

/**
 * Owned by Segment 2 piece 2B (verification and moderation).
 *
 * The automatic screen. 2D's "submit for moderation" calls this, then stores `moderation = decision` on the
 * project (and 2B's queue picks up 'pending'). Each call is recorded (moderation_screens) so the staff queue
 * can show the reasons and when it was submitted.
 *
 * A project staff rejected or asked to change, or one paused by reports, always goes back to staff: the
 * screen can't tell whether the problem they saw was fixed.
 */
export function screenProject(db: DB, project: ProjectRow): ScreenResult {
  const sources = all<{ source: string }>(db, 'SELECT source FROM keys WHERE project_id = ? AND archived = 0 ORDER BY id', project.id).map((k) => k.source);
  const org = get<{ type: string }>(db, 'SELECT type FROM orgs WHERE id = ?', project.org_id);
  const result = screenText(sources, org?.type);

  const last = get<{ decision: string }>(db, 'SELECT decision FROM moderation_decisions WHERE project_id = ? ORDER BY id DESC LIMIT 1', project.id);
  if (last && last.decision !== 'approved') result.reasons.push(last.decision === 'changes' ? 'resubmitted after staff asked for changes' : 'resubmitted after staff rejected it');
  if (pausedByReports(db, project.id)) result.reasons.push('paused by volunteer reports');
  if (result.reasons.length) result.decision = 'pending';

  run(db, 'INSERT INTO moderation_screens (project_id, decision, reasons) VALUES (?, ?, ?)', project.id, result.decision, JSON.stringify(result.reasons));
  return result;
}
