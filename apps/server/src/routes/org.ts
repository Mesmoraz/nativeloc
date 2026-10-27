import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app.js';
import { requireMember } from '../auth.js';
import { setVolunteer, volunteersOf } from '../org/volunteers.js';
import { intParam } from '../util.js';

/** An org's volunteers: favorites and Approved Reviewers (org/volunteers.ts). Admins of the current org. */
export function orgRoutes(app: FastifyInstance, { db }: RouteDeps) {
  app.get('/api/v1/org/volunteers', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    return { volunteers: volunteersOf(db, member.orgId) };
  });

  app.put<{ Params: { userId: string }; Body: { favorite?: unknown; approvedReviewer?: unknown } }>('/api/v1/org/volunteers/:userId', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    return setVolunteer(db, member.orgId, member.id, intParam(req.params.userId), req.body ?? {});
  });
}
