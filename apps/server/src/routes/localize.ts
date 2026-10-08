import type { FastifyInstance } from 'fastify';
import { HttpError, projectAccess, requireUser } from '../auth.js';
import { all, get, run, type DB, type KeyRow } from '../db.js';
import { approveTranslation, queue, saveTranslation } from '../services.js';
import { checkLocale, intParam } from '../util.js';

function keyProject(db: DB, keyId: number) {
  const key = get<KeyRow>(db, 'SELECT * FROM keys WHERE id = ?', keyId);
  if (!key) throw new HttpError(404, 'String not found.');
  return key;
}

export function localizeRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Params: { id: string }; Querystring: { locale?: string; mode?: string; limit?: string; exclude?: string; keyId?: string } }>(
    '/api/v1/projects/:id/queue',
    async (req) => {
      const locale = checkLocale(req.query.locale);
      const mode = req.query.mode === 'review' ? 'review' : 'translate';
      const { project, actor } = projectAccess(db, req, intParam(req.params.id), mode, locale);
      return queue(db, project, locale, mode, {
        viewer: actor.kind === 'user' ? actor.user : undefined,
        limit: Number(req.query.limit) || undefined,
        exclude: (req.query.exclude ?? '').split(',').filter(Boolean).map(Number),
        keyId: req.query.keyId ? intParam(req.query.keyId) : undefined,
      });
    },
  );

  app.put<{ Params: { keyId: string; locale: string }; Body: { text?: string; approve?: boolean } }>('/api/v1/translations/:keyId/:locale', async (req) => {
    const locale = checkLocale(req.params.locale);
    const key = keyProject(db, intParam(req.params.keyId));
    const { project, actor } = projectAccess(db, req, key.project_id, req.body?.approve ? 'review' : 'translate', locale);
    if (actor.kind !== 'user') throw new HttpError(403, 'Sign in to translate.');
    if (typeof req.body?.text !== 'string') throw new HttpError(400, 'Missing text.');
    return saveTranslation(db, project, actor.user, key.id, locale, req.body.text, !!req.body.approve);
  });

  /** Approve as-is: reviewers approve outright; with peer review on, a localizer's approval is one vote. */
  app.post<{ Params: { keyId: string; locale: string } }>('/api/v1/translations/:keyId/:locale/approve', async (req) => {
    const locale = checkLocale(req.params.locale);
    const key = keyProject(db, intParam(req.params.keyId));
    const { project, actor } = projectAccess(db, req, key.project_id, 'review', locale);
    if (actor.kind !== 'user') throw new HttpError(403, 'Sign in to review.');
    return approveTranslation(db, project, actor.user, key.id, locale);
  });

  /**
   * Send back to the translator queue (reviewers). Peers can't: one person shouldn't be able to
   * discard others' work. They improve the text instead, which resubmits it for review.
   */
  app.post<{ Params: { keyId: string; locale: string } }>('/api/v1/translations/:keyId/:locale/reject', async (req) => {
    const locale = checkLocale(req.params.locale);
    const key = keyProject(db, intParam(req.params.keyId));
    const { actor } = projectAccess(db, req, key.project_id, 'review', locale);
    if (actor.kind !== 'user' || actor.user.role === 'localizer') throw new HttpError(403, 'Only reviewers can send translations back. Improve the text instead.');
    run(db, "UPDATE translations SET status = 'outdated' WHERE key_id = ? AND locale = ?", key.id, locale);
    run(db, 'DELETE FROM votes WHERE key_id = ? AND locale = ?', key.id, locale);
    return { status: 'outdated' };
  });

  // ----- questions: localizers ask, admins answer -----

  app.post<{ Params: { keyId: string }; Body: { locale?: string; text?: string } }>('/api/v1/keys/:keyId/questions', async (req) => {
    const locale = checkLocale(req.body?.locale);
    const key = keyProject(db, intParam(req.params.keyId));
    const { actor } = projectAccess(db, req, key.project_id, 'translate', locale);
    if (actor.kind !== 'user') throw new HttpError(403, 'Sign in first.');
    const text = req.body?.text?.trim();
    if (!text) throw new HttpError(400, 'Write your question.');
    const r = run(db, 'INSERT INTO questions (key_id, locale, user_id, text) VALUES (?, ?, ?, ?)', key.id, locale, actor.user.id, text);
    return { id: Number(r.lastInsertRowid) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/questions', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    return {
      questions: all(
        db,
        `SELECT q.id, q.locale, q.text, q.answer, q.created_at AS createdAt, q.resolved_at AS resolvedAt, u.name AS user, k.id AS keyId, k.name AS key, k.source
         FROM questions q JOIN keys k ON k.id = q.key_id JOIN users u ON u.id = q.user_id
         WHERE k.project_id = ? ORDER BY q.resolved_at IS NOT NULL, q.id DESC LIMIT 200`,
        project.id,
      ),
    };
  });

  app.post<{ Params: { qid: string }; Body: { answer?: string; description?: boolean } }>('/api/v1/questions/:qid/answer', async (req) => {
    requireUser(db, req, ['admin']);
    const q = get<{ id: number; key_id: number }>(db, 'SELECT id, key_id FROM questions WHERE id = ?', intParam(req.params.qid));
    if (!q) throw new HttpError(404, 'Question not found.');
    const key = keyProject(db, q.key_id);
    projectAccess(db, req, key.project_id, 'admin');
    const answer = req.body?.answer?.trim();
    if (!answer) throw new HttpError(400, 'Write an answer.');
    run(db, 'UPDATE questions SET answer = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?', answer, q.id);
    // Optionally fold the answer into the string's context note so every language benefits.
    if (req.body?.description) run(db, 'UPDATE keys SET description = TRIM(COALESCE(description, \'\') || \' \' || ?) WHERE id = ?', answer, key.id);
    return { ok: true };
  });
}
