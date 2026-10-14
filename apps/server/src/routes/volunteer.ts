import type { FastifyInstance } from 'fastify';
import { HttpError, requireUser } from '../auth.js';
import { all, get, run, type DB, type Member, type OrgRow, type ProjectRow, type Role, type UserRow } from '../db.js';
import { isVerifiedNonprofit, openPoolRole, passesNonprofitsOnly } from '../pool/access.js';
import { hoursSince, score } from '../pool/score.js';
import { projectLocales, queue, reviewFilter, reviewRight } from '../services.js';
import { stats } from '../xp.js';

// Shapes are the contract in apps/web/src/volunteer/types.ts (and CardOrg in apps/web/src/contracts.ts).

type Item = ReturnType<typeof queue>['items'][number];
interface CardOrg {
  id: number;
  name: string;
  type: OrgRow['type'];
  verified: boolean;
  description: string | null;
}
interface Card {
  id: string;
  type: 'translate' | 'review';
  project: { id: number; name: string; sourceLocale: string };
  org: CardOrg;
  locale: string;
  /** The string is marked urgent. */
  urgent: boolean;
  item: Item;
}

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
    if (!orgs.has(project.org_id)) orgs.set(project.org_id, get<OrgRow>(db, 'SELECT id, name, type, verification, ein, website, description FROM orgs WHERE id = ?', project.org_id)!);
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
  type: Card['type'];
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
function candidates(db: DB, s: Source, locale: string, type: Card['type'], limit: number, now: number, shot?: number): Scored[] {
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
 * are dealt together. Review cards appear only where reviewRight allows.
 */
export function buildSession(db: DB, user: UserRow, size: number, nonprofitsOnly = false, now = Date.now()): { cards: Card[]; empty: null | 'no_languages' | 'nothing_to_do' } {
  const locales = JSON.parse(user.locales) as string[];
  if (!locales.length) return { cards: [], empty: 'no_languages' };

  const open = new Map<string, Scored>();
  const add = (list: Scored[]) => list.forEach((c) => open.set(poolKey(c), c));
  for (const s of sources(db, user, nonprofitsOnly)) {
    const offered = projectLocales(db, s.project.id);
    for (const locale of locales.filter((l) => offered.includes(l))) {
      add(candidates(db, s, locale, 'translate', CANDIDATES_PER_GROUP, now));
      if (reviewRight(db, s.project, s.member, locale)) add(candidates(db, s, locale, 'review', CANDIDATES_PER_GROUP, now));
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
    const from = fresh.length ? fresh : all;
    const want: Card['type'] = picked.length % 2 === 0 ? 'translate' : 'review';
    const ofType = from.filter((c) => c.type === want);
    // Keep a screenshot's strings together: prefer one that shares a screenshot with a card of this type already dealt.
    const together = ofType.filter((c) => c.shot != null && picked.some((p) => p.type === c.type && p.s.project.id === c.s.project.id && p.shot === c.shot));
    let pick = best(together) ?? best(ofType) ?? best(from)!;
    const top = best(from)!;
    if (top.urgent && !pick.urgent) pick = top;
    open.delete(poolKey(pick));
    dealt.add(poolKey(pick));
    picked.push(pick);
    perProject.set(pick.s.project.id, used(pick) + 1);
    // Bring in the other strings on this screenshot, which the per-group scan may not have reached.
    if (pick.shot != null && used(pick) < MAX_PER_PROJECT) {
      add(candidates(db, pick.s, pick.locale, pick.type, MAX_PER_PROJECT + 1, now, pick.shot).filter((c) => !dealt.has(poolKey(c))));
    }
  }

  const cards: Card[] = picked.map(({ s, type, locale, keyId, urgent }) => {
    const { project, org, member } = s;
    const [item] = queue(db, project, locale, type, { viewer: member, keyId }).items;
    return { id: `${type}:${keyId}:${locale}`, type, project: { id: project.id, name: project.name, sourceLocale: project.source_locale }, org: cardOrg(org), locale, urgent, item };
  });
  return { cards, empty: cards.length ? null : 'nothing_to_do' };
}

/** The user's saved "Nonprofits only" choice (off until they turn it on). */
export const nonprofitsOnlyPref = (db: DB, userId: number) =>
  !!get<{ v: number }>(db, 'SELECT nonprofits_only AS v FROM volunteer_prefs WHERE user_id = ?', userId)?.v;

function saveNonprofitsOnly(db: DB, userId: number, on: boolean) {
  run(
    db,
    `INSERT INTO volunteer_prefs (user_id, nonprofits_only) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET nonprofits_only = excluded.nonprofits_only, updated_at = CURRENT_TIMESTAMP`,
    userId, on ? 1 : 0,
  );
}

/** "1"/"true" and "0"/"false"; anything else (or nothing) means "use the saved choice". */
function flag(v: unknown): boolean | undefined {
  if (v === true || v === '1' || v === 'true') return true;
  if (v === false || v === '0' || v === 'false') return false;
  return undefined;
}

export function volunteerRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { size?: string; nonprofitsOnly?: string } }>('/api/v1/volunteer/session', async (req) => {
    const { user } = requireUser(db, req);
    const size = Math.min(Math.max(Math.trunc(Number(req.query.size)) || 5, 1), 10);
    // Passing the filter saves it, so the next session (on any device) starts the same way.
    const asked = flag(req.query.nonprofitsOnly);
    if (asked !== undefined) saveNonprofitsOnly(db, user.id, asked);
    return buildSession(db, user, size, asked ?? nonprofitsOnlyPref(db, user.id));
  });

  app.get('/api/v1/volunteer/stats', async (req) => {
    const { user } = requireUser(db, req);
    return stats(db, user.id);
  });

  // Card-session settings, and which card actions this server offers. Flag (2C) and Report (2B) are other pieces'
  // endpoints: the cards show those buttons only once the routes exist.
  const settings = (userId: number) => ({
    nonprofitsOnly: nonprofitsOnlyPref(db, userId),
    actions: {
      flag: app.hasRoute({ method: 'POST', url: '/api/v1/translations/:keyId/:locale/flag' }),
      report: app.hasRoute({ method: 'POST', url: '/api/v1/reports' }),
    },
  });
  app.get('/api/v1/volunteer/settings', async (req) => settings(requireUser(db, req).user.id));
  app.put<{ Body: { nonprofitsOnly?: unknown } }>('/api/v1/volunteer/settings', async (req) => {
    const { user } = requireUser(db, req);
    const on = flag(req.body?.nonprofitsOnly);
    if (on === undefined) throw new HttpError(400, 'nonprofitsOnly must be true or false.');
    saveNonprofitsOnly(db, user.id, on);
    return settings(user.id);
  });
}
