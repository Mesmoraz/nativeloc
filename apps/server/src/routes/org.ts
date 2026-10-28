import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app.js';
import { HttpError, projectAccess, requireMember } from '../auth.js';
import { sendThanks, thanksStatus } from '../org/thanks.js';
import { cancelCampaign, createCampaign, projectCampaigns } from '../campaigns.js';
import { boardMonth, leaderboard } from '../leaderboards.js';
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

  // The org's leaderboard (leaderboards.ts): this month or last.
  app.get<{ Querystring: { month?: string } }>('/api/v1/org/leaderboard', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    return leaderboard(db, member.orgId, boardMonth(req.query.month));
  });

  // Thank-you notes on a project (org/thanks.ts): who would get one, and sending it. Org admins.
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/thanks', async (req) => thanksStatus(db, projectAccess(db, req, intParam(req.params.id), 'admin').project));
  app.post<{ Params: { id: string }; Body: { body?: unknown } }>('/api/v1/projects/:id/thanks', async (req) => {
    const { project, member } = projectAccess(db, req, intParam(req.params.id), 'admin');
    if (!member) throw new HttpError(403, 'Sign in as an admin of this organization.');
    return sendThanks(db, project, member.id, req.body?.body);
  });

  // Campaigns on a project (campaigns.ts). Org admins.
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/campaign', async (req) => projectCampaigns(db, projectAccess(db, req, intParam(req.params.id), 'admin').project.id));
  app.post<{ Params: { id: string }; Body: { name?: unknown; locales?: unknown; deadline?: unknown } }>('/api/v1/projects/:id/campaign', async (req) => {
    const { project, member } = projectAccess(db, req, intParam(req.params.id), 'admin');
    if (!member) throw new HttpError(403, 'Sign in as an admin of this organization.');
    return createCampaign(db, project, member.id, req.body ?? {});
  });
  app.delete<{ Params: { id: string } }>('/api/v1/projects/:id/campaign', async (req) => cancelCampaign(db, projectAccess(db, req, intParam(req.params.id), 'admin').project.id));
}
