import { all, getOrg, type DB, type Member, type OrgRow, type ProjectRow, type Role, type UserRow } from '../db.js';
import { projectLocales, queue, reviewFilter, reviewRight } from '../services.js';
import { isVerifiedNonprofit, openPoolRole, passesNonprofitsOnly } from './access.js';
import { pickCandidates, pickCard } from '../cards/pick.js';
import { dealSpot } from '../cards/spot.js';
import { hoursSince, score } from './score.js';

// Shapes are the contract in apps/web/src/volunteer/types.ts (and CardOrg in apps/web/src/contracts.ts).

type Item = ReturnType<typeof queue>['items'][number];
interface CardOrg {
  id: number;
  name: string;
  type: OrgRow['type'];
  verified: boolean;
  description: string | null;
}
interface CardBase {
  id: string;
  project: { id: number; name: string; sourceLocale: string };
  org: CardOrg;
  locale: string;
  /** The string is marked urgent. */
  urgent: boolean;
}
type WorkCard = CardBase & { type: 'translate' | 'review'; item: Item };
/** Spot the problem (cards/spot.ts): no real work, a check with a known answer. */
type SpotCard = CardBase & { type: 'spot'; spot: { checkId: number; source: string; shown: string } };
/** Pick the better one (cards/pick.ts): two wordings of a string in community review, in random order. */
type PickCard = CardBase & { type: 'pick'; pick: { keyId: number; source: string; note: string | null; a: string; b: string } };
type Card = WorkCard | SpotCard | PickCard;

/** Chance a session includes a Spot the problem card (docs/segment-3c-card-types.md). */
export const SPOT_CHANCE = 1 / 3;
/** A Spot card only joins a session with at least this many real cards, so it never stands in for missing work. */
const SPOT_MIN_REAL = 2;

/** A project the user can draw cards from, with the role they act with there. */
interface Source {
  project: ProjectRow;
  org: OrgRow;
  member: Member;
}

/** Projects a session draws from: every project in the user's orgs, plus public, approved projects anywhere that openPoolRole lets them into. */
function sources(db: DB, user: UserRow, nonprofitsOnly: boolean): Source[] {
  const roles = new Map(all<{ org_id: number; role: Role }>(db, 'SELECT org_id, role FROM memberships WHERE user_id = ?', user.id).map((m) => [m.org_id, m.role]));
  // The visibility/moderation test here only narrows the scan; openPoolRole decides who gets in.
  const projects = all<ProjectRow>(
    db,
    `SELECT p.* FROM projects p
     WHERE p.org_id IN (SELECT org_id FROM memberships WHERE user_id = ?) OR (p.visibility = 'public' AND p.moderation = 'approved')
     ORDER BY p.created_at, p.id`,
    user.id,
  );
  const orgs = new Map<number, OrgRow>();
  const out: Source[] = [];
  for (const project of projects) {
    const role = roles.get(project.org_id) ?? openPoolRole(db, user, project, 'translate');
    if (!role) continue;
    if (!orgs.has(project.org_id)) orgs.set(project.org_id, getOrg(db, project.org_id)!);
    const org = orgs.get(project.org_id)!;
    if (nonprofitsOnly && !passesNonprofitsOnly(org)) continue;
    // The user as they act in this project's org: their role decides what they may review.
    out.push({ project, org, member: { ...user, orgId: project.org_id, role } });
  }
  return out;
}

const cardOrg = (org: OrgRow): CardOrg => ({ id: org.id, name: org.name, type: org.type, verified: isVerifiedNonprofit(org), description: org.description });

/** Strings read per project, language and card type to score. Enough for the per-project cap plus slack. */
const CANDIDATES_PER_GROUP = 6;
/** At most this many cards from one project in a session, unless nothing else is left. */
const MAX_PER_PROJECT = 2;

/** A string a volunteer could get a card for, with its score (see pool/score.ts). */
interface Scored {
  s: Source;
  type: WorkCard['type'] | 'pick';
  locale: string;
  keyId: number;
  urgent: boolean;
  /** The first screenshot the string appears on; strings sharing one stay together. */
  shot: number | null;
  score: number;
}

const poolKey = (c: Pick<Scored, 'type' | 'keyId' | 'locale'>) => `${c.type}:${c.keyId}:${c.locale}`;

/**
 * The strings a project offers in one language for one card type, longest-waiting first (urgent first): the ones
 * queue() would deal. `shot` narrows them to one screenshot's strings.
 */
function candidates(db: DB, s: Source, locale: string, type: WorkCard['type'], limit: number, now: number, shot?: number): Scored[] {
  const review = type === 'review';
  const filter = review ? reviewFilter(db, s.project, locale, s.member) : { sql: '', params: [] };
  const rows = all<{ id: number; urgent: number; shot: number | null; since: string }>(
    db,
    `SELECT k.id, k.urgent, (SELECT MIN(screenshot_id) FROM screenshot_keys WHERE key_id = k.id) AS shot,
            ${review ? 't.updated_at' : 'CASE WHEN t.status IS NULL THEN k.created_at ELSE COALESCE(k.source_changed_at, k.updated_at) END'} AS since
     FROM keys k LEFT JOIN translations t ON t.key_id = k.id AND t.locale = ?
     WHERE k.project_id = ? AND k.archived = 0 AND ${review ? `t.status = 'review' ${filter.sql}` : "(t.status IS NULL OR t.status = 'outdated')"}
       ${shot == null ? '' : 'AND k.id IN (SELECT key_id FROM screenshot_keys WHERE screenshot_id = ?)'}
     ORDER BY k.urgent DESC, since, k.id LIMIT ?`,
    locale, s.project.id, ...filter.params, ...(shot == null ? [] : [shot]), limit,
  );
  return rows.map((r) => ({
    s, type, locale, keyId: r.id, urgent: !!r.urgent, shot: r.shot,
    score: score({ waitedHours: hoursSince(r.since, now), urgent: !!r.urgent, priority: s.project.priority, verifiedNonprofit: isVerifiedNonprofit(s.org) }),
  }));
}

/**
 * A short session of cards, in the user's languages, from their orgs' projects and the open pool. Each string is
 * scored (pool/score.ts: how long it has waited, plus urgent, project priority and verified-nonprofit boosts) and the
 * best come first, at most two per project unless nothing else is left. Translate and Review alternate (Translate
 * first) while both last, but an urgent string is never held behind a non-urgent one. Strings that share a screenshot
 * are dealt together. Review cards appear only where reviewRight allows. About one session in three also gets a Spot
 * the problem card (SPOT_CHANCE), after the first card, in place of the last real card when the session is full.
 * `opts` lets tests fix the chance and the randomness.
 */
export function buildSession(
  db: DB,
  user: UserRow,
  size: number,
  nonprofitsOnly = false,
  now = Date.now(),
  opts: { spotChance?: number; rand?: () => number } = {},
): { cards: Card[]; empty: null | 'no_languages' | 'nothing_to_do' } {
  const locales = JSON.parse(user.locales) as string[];
  if (!locales.length) return { cards: [], empty: 'no_languages' };

  const open = new Map<string, Scored>();
  const add = (list: Scored[]) => list.forEach((c) => open.set(poolKey(c), c));
  const from = sources(db, user, nonprofitsOnly);
  for (const s of from) {
    const offered = projectLocales(db, s.project.id);
    for (const locale of locales.filter((l) => offered.includes(l))) {
      add(candidates(db, s, locale, 'translate', CANDIDATES_PER_GROUP, now));
      if (reviewRight(db, s.project, s.member, locale)) {
        add(candidates(db, s, locale, 'review', CANDIDATES_PER_GROUP, now));
        add(
          pickCandidates(db, s.project, locale, s.member, CANDIDATES_PER_GROUP).map((r) => ({
            s, type: 'pick' as const, locale, keyId: r.key_id, urgent: !!r.urgent, shot: r.shot,
            score: score({ waitedHours: hoursSince(r.since, now), urgent: !!r.urgent, priority: s.project.priority, verifiedNonprofit: isVerifiedNonprofit(s.org) }),
          })),
        );
      }
    }
  }

  const picked: Scored[] = [];
  const dealt = new Set<string>();
  const perProject = new Map<number, number>();
  const used = (c: Scored) => perProject.get(c.s.project.id) ?? 0;
  const best = (list: Scored[]) => list.reduce<Scored | undefined>((b, c) => (!b || c.score > b.score ? c : b), undefined);
  while (picked.length < size && open.size) {
    const all = [...open.values()];
    // Variety first: projects under their cap; once none is left, anything goes.
    const fresh = all.filter((c) => used(c) < MAX_PER_PROJECT);
    const pool = fresh.length ? fresh : all;
    const want: WorkCard['type'] = picked.length % 2 === 0 ? 'translate' : 'review';
    // A Pick card takes a Review slot.
    const ofType = pool.filter((c) => c.type === want || (want === 'review' && c.type === 'pick'));
    // Keep a screenshot's strings together: prefer one that shares a screenshot with a card of this type already dealt.
    const together = ofType.filter((c) => c.shot != null && picked.some((p) => p.type === c.type && p.s.project.id === c.s.project.id && p.shot === c.shot));
    let pick = best(together) ?? best(ofType) ?? best(pool)!;
    const top = best(pool)!;
    if (top.urgent && !pick.urgent) pick = top;
    open.delete(poolKey(pick));
    dealt.add(poolKey(pick));
    picked.push(pick);
    perProject.set(pick.s.project.id, used(pick) + 1);
    // Bring in the other strings on this screenshot, which the per-group scan may not have reached.
    if (pick.shot != null && pick.type !== 'pick' && used(pick) < MAX_PER_PROJECT) {
      add(candidates(db, pick.s, pick.locale, pick.type, MAX_PER_PROJECT + 1, now, pick.shot).filter((c) => !dealt.has(poolKey(c))));
    }
  }

  const projectJson = (project: ProjectRow) => ({ id: project.id, name: project.name, sourceLocale: project.source_locale });
  const rand = opts.rand ?? Math.random;
  const cards: Card[] = picked.map(({ s, type, locale, keyId, urgent }): Card => {
    const { project, org, member } = s;
    const base = { id: `${type}:${keyId}:${locale}`, project: projectJson(project), org: cardOrg(org), locale, urgent };
    if (type === 'pick') return { ...base, type, pick: pickCard(db, keyId, locale, member, rand)! };
    const [item] = queue(db, project, locale, type, { viewer: member, keyId }).items;
    return { ...base, type, item };
  });

  if (cards.length >= SPOT_MIN_REAL && rand() < (opts.spotChance ?? SPOT_CHANCE)) {
    const spot = dealSpot(db, user.id, from, locales, rand);
    if (spot) {
      if (cards.length >= size) cards.pop();
      const at = 1 + Math.floor(rand() * cards.length);
      cards.splice(at, 0, {
        id: `spot:${spot.checkId}`,
        type: 'spot',
        project: projectJson(spot.source.project),
        org: cardOrg(spot.source.org),
        locale: spot.locale,
        urgent: false,
        spot: { checkId: spot.checkId, source: spot.sourceText, shown: spot.shown },
      });
    }
  }
  return { cards, empty: cards.length ? null : 'nothing_to_do' };
}
