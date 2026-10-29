import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { HttpError } from './auth.js';
import { openDb, type DB } from './db.js';
import { authRoutes } from './routes/auth.js';
import { bundleRoutes } from './routes/bundles.js';
import { hostedRoutes } from './routes/hosted.js';
import { communityRoutes } from './routes/community.js';
import { localizeRoutes } from './routes/localize.js';
import { placementRoutes } from './routes/placement.js';
import { postingRoutes } from './routes/posting.js';
import { projectRoutes } from './routes/projects.js';
import { signupRoutes } from './routes/signup.js';
import { staffRoutes } from './routes/staff.js';
import { volunteerRoutes } from './routes/volunteer.js';

export interface AppOptions {
  dbPath: string;
  dataDir: string;
  /** Built web app to serve at "/", if present. */
  webDist?: string;
  logger?: boolean;
  /** How the hosted preview reads organizations' sites (tests pass a fake). */
  fetch?: typeof fetch;
  /** Let the hosted preview read sites on private networks (default: outside production only). */
  allowPrivateSites?: boolean;
}

/** What the feature route modules (sign-up, staff, community review, posting) get. */
export interface RouteDeps {
  db: DB;
  dataDir: string;
  screenshotDir: string;
}

export async function buildApp(opts: AppOptions) {
  const db: DB = openDb(opts.dbPath);
  const screenshotDir = join(opts.dataDir, 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });

  app.get('/api/health', async () => ({ ok: true }));
  authRoutes(app, db);
  projectRoutes(app, { db, screenshotDir });
  localizeRoutes(app, db);
  placementRoutes(app, db);
  volunteerRoutes(app, db);
  bundleRoutes(app, db);
  hostedRoutes(app, { db, fetch: opts.fetch, allowPrivate: opts.allowPrivateSites });
  const deps: RouteDeps = { db, dataDir: opts.dataDir, screenshotDir };
  signupRoutes(app, deps);
  staffRoutes(app, deps);
  communityRoutes(app, deps);
  postingRoutes(app, deps);

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
    // Single-page app: unknown non-API GETs get index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !/^\/(api|b|files|preview)\//.test(req.url)) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found.' });
    });
  }

  app.addHook('onClose', async () => db.close());
  return { app, db };
}
