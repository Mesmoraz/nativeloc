import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { all, get, getUser, memberOf, run, type DB, type Member, type ProjectRow, type Role, type UserRow } from './db.js';
import { openPoolRole } from './pool/access.js';
import { reviewRight } from './services/review.js';
import { assertMayContribute } from './signup/gate.js';
import { tierOf } from './trust.js';

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

export interface UserActor {
  kind: 'user';
  user: UserRow;
  locales: string[];
  /** Every org the user belongs to, oldest membership first. May be empty (a volunteer with no org). */
  memberships: { orgId: number; role: Role }[];
  /** The org this sign-in is working in, or null when the user has no memberships. */
  current: Member | null;
  /** Hash of the session token (to remember the current org). */
  sessionHash: string;
}

export type Actor = UserActor | { kind: 'token'; projectId: number; scopes: Scope[] };

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
  const sessionHash = sha256(sid);
  const session = get<{ user_id: number; org_id: number | null }>(db, 'SELECT user_id, org_id FROM sessions WHERE token_hash = ? AND expires_at > ?', sessionHash, Date.now());
  const user = session && getUser(db, session.user_id);
  if (!user) return null;
  const memberships = membershipsOf(db, user.id);
  // The org picked for this sign-in, while the user still belongs to it; otherwise their first.
  const pick = memberships.find((m) => m.orgId === session.org_id) ?? memberships[0];
  return { kind: 'user', user, locales: JSON.parse(user.locales), memberships, current: pick ? { ...user, ...pick } : null, sessionHash };
}

export const membershipsOf = (db: DB, userId: number) =>
  all<{ orgId: number; role: Role }>(db, 'SELECT org_id AS orgId, role FROM memberships WHERE user_id = ? ORDER BY created_at, org_id', userId);

/** Signed in, with or without an org. */
export function requireUser(db: DB, req: FastifyRequest): UserActor {
  const actor = actorOf(db, req);
  if (!actor || actor.kind !== 'user') throw new HttpError(401, 'Please sign in.');
  return actor;
}

/** Signed in and working in an org (optionally with one of `roles` there). `member` is the user in that org. */
export function requireMember(db: DB, req: FastifyRequest, roles?: Role[]): UserActor & { member: Member } {
  const actor = requireUser(db, req);
  const member = actor.current;
  if (!member || (roles && !roles.includes(member.role))) throw new HttpError(403, 'You do not have permission to do that.');
  return { ...actor, member };
}

/** NativeLoc staff (verification and moderation). */
export function requireStaff(db: DB, req: FastifyRequest): UserActor {
  const actor = requireUser(db, req);
  if (!actor.user.is_staff) throw new HttpError(403, 'Only NativeLoc staff can do that.');
  return actor;
}

export type Access = 'read' | 'translate' | 'review' | 'admin' | 'push' | 'export';

/**
 * Load a project and check the caller may perform `access` on it (optionally for one locale).
 * `member` is the signed-in user with their role in the project's org (null for API tokens).
 */
export function projectAccess(db: DB, req: FastifyRequest, projectId: number, access: Access, locale?: string): { project: ProjectRow; actor: Actor; member: Member | null } {
  const actor = actorOf(db, req);
  if (!actor) throw new HttpError(401, 'Please sign in.');
  const project = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw new HttpError(404, 'Project not found.');

  if (actor.kind === 'token') {
    const ok =
      actor.projectId === project.id &&
      ((access === 'push' && actor.scopes.includes('push')) || ((access === 'export' || access === 'read') && (actor.scopes.includes('read') || actor.scopes.includes('push'))));
    if (!ok) throw new HttpError(403, 'This API token cannot do that.');
    return { project, actor, member: null };
  }

  // Members act with their role in the project's org. Anyone else gets in only if the open pool lets them.
  const membership = memberOf(db, actor.user, project.org_id);
  const poolRole = membership ? null : openPoolRole(db, actor.user, project, access);
  const member: Member | null = membership ?? (poolRole ? { ...actor.user, orgId: project.org_id, role: poolRole } : null);
  if (!member) throw new HttpError(404, 'Project not found.');
  assertMayContribute(db, actor.user, project, access);
  if (member.role === 'admin') return { project, actor, member };
  const needs: Record<Access, Role[]> = {
    read: ['reviewer', 'localizer'],
    export: ['reviewer', 'localizer'],
    translate: ['reviewer', 'localizer'],
    review: ['reviewer'],
    admin: [],
    push: [],
  };
  // Localizers review only when reviewRight says so (peer votes, leads). New volunteers review after the placement check.
  if (access === 'review' && member.role === 'localizer') {
    if (locale && tierOf(db, member, locale) === 'new') throw new HttpError(403, 'Pass the placement check for this language to start reviewing.');
    if (!locale || !reviewRight(db, project, member, locale)) throw new HttpError(403, 'You do not have permission to do that.');
  } else if (!needs[access].includes(member.role)) throw new HttpError(403, 'You do not have permission to do that.');
  if (locale && (access === 'translate' || access === 'review') && !actor.locales.includes(locale)) {
    throw new HttpError(403, `You are not assigned to ${locale}.`);
  }
  return { project, actor, member };
}
