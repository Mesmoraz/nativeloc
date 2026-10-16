import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app.js';
import { HttpError, projectAccess } from '../auth.js';
import { publishReady, readyList, sendBack } from '../services/review.js';
import { checkLocale, intParam } from '../util.js';

/** Community review: Flag, and the poster's "Ready to publish" list. Endpoints: docs/segment-2-contracts.md §3. */
export function communityRoutes(app: FastifyInstance, { db }: RouteDeps) {
  /** The poster's "Ready to publish" list: text community review agreed on (org admins). */
  app.get<{ Params: { id: string }; Querystring: { locale?: string } }>('/api/v1/projects/:id/ready', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    return readyList(db, project, req.query.locale ? checkLocale(req.query.locale) : undefined);
  });

  /** Publish ready text (ready → approved): the listed items, or everything when `items` is omitted. */
  app.post<{ Params: { id: string }; Body: { items?: { keyId: number; locale: string }[] } }>('/api/v1/projects/:id/ready/approve', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    const items = req.body?.items;
    if (items !== undefined && (!Array.isArray(items) || items.some((i) => !i || !Number.isInteger(i.keyId) || typeof i.locale !== 'string'))) {
      throw new HttpError(400, 'items must be a list of { keyId, locale }.');
    }
    return publishReady(db, project, items?.map((i) => ({ keyId: i.keyId, locale: checkLocale(i.locale) })));
  });

  /** Send ready text back to review with a note for reviewers. */
  app.post<{ Params: { id: string }; Body: { keyId?: number; locale?: string; note?: string } }>('/api/v1/projects/:id/ready/send-back', async (req) => {
    const { project, member } = projectAccess(db, req, intParam(req.params.id), 'admin');
    if (!member) throw new HttpError(403, 'Sign in first.');
    if (!Number.isInteger(req.body?.keyId)) throw new HttpError(400, 'Missing keyId.');
    return sendBack(db, project, member, req.body!.keyId!, checkLocale(req.body?.locale), typeof req.body?.note === 'string' ? req.body.note : undefined);
  });
}
