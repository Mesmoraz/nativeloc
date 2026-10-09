import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { all, type DB, type Member, type ProjectRow, type Role, type UserRow } from '../db.js';
import { projectLocales, queue, reviewRight } from '../services.js';
import { stats } from '../xp.js';

// Shapes are the contract in apps/web/src/volunteer/types.ts.

type Item = ReturnType<typeof queue>['items'][number];
interface Card {
  id: string;
  type: 'translate' | 'review';
  project: { id: number; name: string; sourceLocale: string };
  locale: string;
  item: Item;
}

/**
 * A short session of cards from every project in the orgs the user belongs to, in their languages. Translate and Review
 * alternate (Translate first) while both last; within each kind, projects and queue order are kept.
 */
export function buildSession(db: DB, user: UserRow, size: number): { cards: Card[]; empty: null | 'no_languages' | 'nothing_to_do' } {
  const locales = JSON.parse(user.locales) as string[];
  if (!locales.length) return { cards: [], empty: 'no_languages' };

  const piles: Record<Card['type'], Card[]> = { translate: [], review: [] };
  const deal = (type: Card['type'], project: ProjectRow, member: Member, locale: string) => {
    if (piles[type].length >= size) return;
    const { items } = queue(db, project, locale, type, { viewer: member, limit: size - piles[type].length });
    for (const item of items) piles[type].push({ id: `${type}:${item.keyId}:${locale}`, type, project: { id: project.id, name: project.name, sourceLocale: project.source_locale }, locale, item });
  };
  const roles = new Map(all<{ org_id: number; role: Role }>(db, 'SELECT org_id, role FROM memberships WHERE user_id = ?', user.id).map((m) => [m.org_id, m.role]));
  const projects = all<ProjectRow>(db, 'SELECT p.* FROM projects p JOIN memberships m ON m.org_id = p.org_id AND m.user_id = ? ORDER BY p.id', user.id);
  for (const project of projects) {
    // The user as a member of this project's org: their role there decides what they may review.
    const member: Member = { ...user, orgId: project.org_id, role: roles.get(project.org_id)! };
    const offered = projectLocales(db, project.id);
    for (const locale of locales.filter((l) => offered.includes(l))) {
      deal('translate', project, member, locale);
      if (reviewRight(db, project, member, locale)) deal('review', project, member, locale);
    }
  }

  const cards: Card[] = [];
  for (let i = 0; cards.length < size && (piles.translate.length || piles.review.length); i++) {
    const next = (i % 2 === 0 ? piles.translate.shift() ?? piles.review.shift() : piles.review.shift() ?? piles.translate.shift())!;
    cards.push(next);
  }
  return { cards, empty: cards.length ? null : 'nothing_to_do' };
}

export function volunteerRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { size?: string } }>('/api/v1/volunteer/session', async (req) => {
    const { user } = requireUser(db, req);
    const size = Math.min(Math.max(Math.trunc(Number(req.query.size)) || 5, 1), 10);
    return buildSession(db, user, size);
  });

  app.get('/api/v1/volunteer/stats', async (req) => {
    const { user } = requireUser(db, req);
    return stats(db, user.id);
  });
}
