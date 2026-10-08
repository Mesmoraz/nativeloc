import type { FastifyInstance } from 'fastify';
import { HttpError, requireUser } from '../auth.js';
import { get, run, type DB } from '../db.js';
import { addItem, gradePlacement, gradingQueue, listItems, placementStatus, startPlacement, submitPlacement, type SubmittedAnswer } from '../trust.js';
import { checkLocale, intParam } from '../util.js';

export function placementRoutes(app: FastifyInstance, db: DB) {
  // ----- volunteers -----

  app.get<{ Params: { locale: string } }>('/api/v1/placement/:locale', async (req) => {
    const { user } = requireUser(db, req);
    return placementStatus(db, user, checkLocale(req.params.locale));
  });

  app.post<{ Params: { locale: string } }>('/api/v1/placement/:locale/start', async (req) => {
    const { user } = requireUser(db, req);
    return { attempt: startPlacement(db, user, checkLocale(req.params.locale)) };
  });

  app.post<{ Params: { id: string }; Body: { answers?: SubmittedAnswer[] } }>('/api/v1/placement/attempts/:id/submit', async (req) => {
    const { user } = requireUser(db, req);
    return submitPlacement(db, user, intParam(req.params.id), req.body?.answers ?? []);
  });

  // ----- graders: admins, reviewers and leads of the language -----

  app.get('/api/v1/placement-grading', async (req) => {
    const { user } = requireUser(db, req);
    return { attempts: gradingQueue(db, user) };
  });

  app.post<{ Params: { id: string }; Body: { grades?: { itemId: number; pass: boolean; note?: string }[] } }>('/api/v1/placement/attempts/:id/grade', async (req) => {
    const { user } = requireUser(db, req);
    return gradePlacement(db, user, intParam(req.params.id), req.body?.grades ?? []);
  });

  // ----- placement content (admins) -----

  app.get<{ Querystring: { locale?: string } }>('/api/v1/placement-items', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    return { items: listItems(db, user.org_id, checkLocale(req.query.locale)) };
  });

  app.post<{ Body: { locale?: string; kind?: string; source?: string; reference?: string; candidate?: string; hasError?: boolean; errorNote?: string } }>(
    '/api/v1/placement-items',
    async (req) => {
      const { user } = requireUser(db, req, ['admin']);
      return addItem(db, user.org_id, checkLocale(req.body?.locale), req.body ?? {});
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/placement-items/:id', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    const item = get<{ id: number }>(db, 'SELECT id FROM placement_items WHERE id = ? AND org_id = ?', intParam(req.params.id), user.org_id);
    if (!item) throw new HttpError(404, 'Item not found.');
    // Archived, not deleted: past attempts still refer to it.
    run(db, 'UPDATE placement_items SET archived = 1 WHERE id = ?', item.id);
    return { ok: true };
  });
}
