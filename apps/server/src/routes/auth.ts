import type { FastifyInstance } from 'fastify';
import { createSession, hashPassword, HttpError, randomToken, requireUser, SESSION_COOKIE, sha256, verifyPassword } from '../auth.js';
import { all, get, run, tx, type DB, type UserRow } from '../db.js';
import { checkLocale } from '../util.js';

export function publicUser(u: UserRow) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, locales: JSON.parse(u.locales) as string[] };
}

export function authRoutes(app: FastifyInstance, db: DB) {
  app.post<{ Body: { email?: string; password?: string } }>('/api/v1/auth/login', async (req, reply) => {
    const { email = '', password = '' } = req.body ?? {};
    const user = get<UserRow>(db, 'SELECT * FROM users WHERE email = ?', email.trim());
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
    createSession(db, reply, user.id);
    return { user: publicUser(user) };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(sid));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/me', async (req) => {
    const { user } = requireUser(db, req);
    const org = get<{ id: number; name: string }>(db, 'SELECT id, name FROM orgs WHERE id = ?', user.org_id);
    return { user: publicUser(user), org };
  });

  // ----- invites (admins create links; localizers accept them) -----

  app.post<{ Body: { role?: UserRow['role']; locales?: string[]; email?: string } }>('/api/v1/invites', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    const role = req.body?.role ?? 'localizer';
    if (!['admin', 'reviewer', 'localizer'].includes(role)) throw new HttpError(400, 'Unknown role.');
    const locales = (req.body?.locales ?? []).map(checkLocale);
    const token = randomToken();
    run(db, 'INSERT INTO invites (token_hash, org_id, role, locales, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)', sha256(token), user.org_id, role, JSON.stringify(locales), req.body?.email ?? null, Date.now() + 14 * 864e5);
    return { token, path: `/invite/${token}` };
  });

  app.get<{ Params: { token: string } }>('/api/v1/invites/:token', async (req) => {
    const inv = get<{ role: string; locales: string; email: string | null; org: string; expires_at: number; used_at: string | null }>(
      db,
      'SELECT i.role, i.locales, i.email, i.expires_at, i.used_at, o.name AS org FROM invites i JOIN orgs o ON o.id = i.org_id WHERE token_hash = ?',
      sha256(req.params.token),
    );
    if (!inv || inv.used_at || inv.expires_at < Date.now()) throw new HttpError(404, 'This invite link is no longer valid. Ask your admin for a new one.');
    return { org: inv.org, role: inv.role, locales: JSON.parse(inv.locales), email: inv.email };
  });

  app.post<{ Params: { token: string }; Body: { name?: string; email?: string; password?: string } }>('/api/v1/invites/:token/accept', async (req, reply) => {
    const inv = get<{ org_id: number; role: string; locales: string; email: string | null; expires_at: number; used_at: string | null }>(db, 'SELECT * FROM invites WHERE token_hash = ?', sha256(req.params.token));
    if (!inv || inv.used_at || inv.expires_at < Date.now()) throw new HttpError(404, 'This invite link is no longer valid.');
    const name = req.body?.name?.trim();
    const email = (inv.email ?? req.body?.email ?? '').trim();
    const password = req.body?.password ?? '';
    if (!name || !/^\S+@\S+$/.test(email)) throw new HttpError(400, 'Please enter your name and email.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (get(db, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists.');
    const userId = tx(db, () => {
      const r = run(db, 'INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, ?, ?, ?, ?, ?)', inv.org_id, email, name, hashPassword(password), inv.role, inv.locales);
      run(db, 'UPDATE invites SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?', sha256(req.params.token));
      return Number(r.lastInsertRowid);
    });
    createSession(db, reply, userId);
    return { user: publicUser(get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', userId)!) };
  });

  // ----- team -----

  app.get('/api/v1/users', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    return { users: all<UserRow>(db, 'SELECT * FROM users WHERE org_id = ? ORDER BY name', user.org_id).map(publicUser) };
  });

  app.patch<{ Params: { id: string }; Body: { role?: UserRow['role']; locales?: string[] } }>('/api/v1/users/:id', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    const target = get<UserRow>(db, 'SELECT * FROM users WHERE id = ? AND org_id = ?', Number(req.params.id), user.org_id);
    if (!target) throw new HttpError(404, 'User not found.');
    const role = req.body?.role ?? target.role;
    if (!['admin', 'reviewer', 'localizer'].includes(role)) throw new HttpError(400, 'Unknown role.');
    const locales = req.body?.locales ? JSON.stringify(req.body.locales.map(checkLocale)) : target.locales;
    run(db, 'UPDATE users SET role = ?, locales = ? WHERE id = ?', role, locales, target.id);
    return { user: publicUser(get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', target.id)!) };
  });
}
