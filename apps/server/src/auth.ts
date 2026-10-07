import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { get, run, type DB, type ProjectRow, type UserRow } from './db.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const SESSION_COOKIE = 'nl_sid';
const SESSION_DAYS = 30;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (prefix = '') => prefix + randomBytes(24).toString('base64url');

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 32).toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), 32);
  return timingSafeEqual(actual, Buffer.from(hash, 'base64'));
}

export function createSession(db: DB, reply: FastifyReply, userId: number) {
  const token = randomToken();
  run(db, 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 86400 });
}

export type Scope = 'push' | 'read';

export type Actor =
  | { kind: 'user'; user: UserRow; locales: string[] }
  | { kind: 'token'; projectId: number; scopes: Scope[] };

export function actorOf(db: DB, req: FastifyRequest): Actor | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer) {
    const row = get<{ id: number; project_id: number; scopes: string }>(db, 'SELECT id, project_id, scopes FROM api_tokens WHERE token_hash = ?', sha256(bearer));
    if (!row) throw new HttpError(401, 'Invalid API token.');
    run(db, 'UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', row.id);
    return { kind: 'token', projectId: row.project_id, scopes: JSON.parse(row.scopes) };
  }
  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return null;
  const user = get<UserRow>(db, 'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', sha256(sid), Date.now());
  return user ? { kind: 'user', user, locales: JSON.parse(user.locales) } : null;
}

export function requireUser(db: DB, req: FastifyRequest, roles?: UserRow['role'][]) {
  const actor = actorOf(db, req);
  if (!actor || actor.kind !== 'user') throw new HttpError(401, 'Please sign in.');
  if (roles && !roles.includes(actor.user.role)) throw new HttpError(403, 'You do not have permission to do that.');
  return actor;
}

export type Access = 'read' | 'translate' | 'review' | 'admin' | 'push' | 'export';

/** Load a project and check the caller may perform `access` on it (optionally for one locale). */
export function projectAccess(db: DB, req: FastifyRequest, projectId: number, access: Access, locale?: string): { project: ProjectRow; actor: Actor } {
  const actor = actorOf(db, req);
  if (!actor) throw new HttpError(401, 'Please sign in.');
  const project = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw new HttpError(404, 'Project not found.');

  if (actor.kind === 'token') {
    const ok =
      actor.projectId === project.id &&
      ((access === 'push' && actor.scopes.includes('push')) || ((access === 'export' || access === 'read') && (actor.scopes.includes('read') || actor.scopes.includes('push'))));
    if (!ok) throw new HttpError(403, 'This API token cannot do that.');
    return { project, actor };
  }

  const { user } = actor;
  if (user.org_id !== project.org_id) throw new HttpError(404, 'Project not found.');
  if (user.role === 'admin') return { project, actor };
  const needs: Record<Access, UserRow['role'][]> = {
    read: ['reviewer', 'localizer'],
    export: ['reviewer', 'localizer'],
    translate: ['reviewer', 'localizer'],
    review: ['reviewer'],
    admin: [],
    push: [],
  };
  // With peer review on, localizers review each other's work (approvals are counted, see approveTranslation).
  const peer = access === 'review' && user.role === 'localizer' && project.peer_approvals > 0;
  if (!needs[access].includes(user.role) && !peer) throw new HttpError(403, 'You do not have permission to do that.');
  if (locale && (access === 'translate' || access === 'review') && !actor.locales.includes(locale)) {
    throw new HttpError(403, `You are not assigned to ${locale}.`);
  }
  return { project, actor };
}
