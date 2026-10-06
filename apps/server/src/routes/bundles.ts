import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../auth.js';
import { get, type DB, type ProjectRow } from '../db.js';
import { manifest } from '../services.js';

/**
 * Public, cacheable endpoints devices poll. The unguessable bundle token in the URL is the
 * only credential, so any device that can do HTTP + JSON is supported.
 */
export function bundleRoutes(app: FastifyInstance, db: DB) {
  const projectFor = (token: string) => {
    const p = get<ProjectRow>(db, 'SELECT * FROM projects WHERE bundle_token = ?', token);
    if (!p || !p.version) throw new HttpError(404, 'Nothing published yet.');
    return p;
  };

  const sendCached = (req: FastifyRequest, reply: FastifyReply, etag: string, body: string) => {
    reply.header('etag', etag).header('cache-control', 'public, max-age=60').header('access-control-allow-origin', '*');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  };

  app.get<{ Params: { token: string } }>('/b/:token/manifest.json', async (req, reply) => {
    const m = manifest(db, projectFor(req.params.token))!;
    const body = JSON.stringify(m);
    return sendCached(req, reply, `"v${m.version}-${Object.values(m.locales).map((l) => l.sha256.slice(0, 8)).join('')}"`, body);
  });

  app.get<{ Params: { token: string; file: string } }>('/b/:token/:file', async (req, reply) => {
    const locale = /^(.+)\.json$/.exec(req.params.file)?.[1];
    if (!locale) throw new HttpError(404, 'Not found.');
    const p = projectFor(req.params.token);
    const rel = get<{ sha256: string; body: string }>(db, 'SELECT sha256, body FROM releases WHERE project_id = ? AND version = ? AND locale = ?', p.id, p.version, locale);
    if (!rel) throw new HttpError(404, `No published bundle for ${locale}.`);
    return sendCached(req, reply, `"${rel.sha256}"`, rel.body);
  });
}
