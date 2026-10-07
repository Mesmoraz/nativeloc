import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { actorOf, createSession, hashPassword, HttpError, randomToken, requireUser, SESSION_COOKIE, sha256, verifyPassword } from '../auth.js';
import { all, get, run, tx, type DB, type UserRow } from '../db.js';
import { setTier, tiersOf, TIERS, type Tier } from '../trust.js';
import { checkLocale } from '../util.js';

export function publicUser(db: DB, u: UserRow) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, locales: JSON.parse(u.locales) as string[], tiers: tiersOf(db, u) };
}

export function authRoutes(app: FastifyInstance, db: DB) {
  app.post<{ Body: { email?: string; password?: string } }>('/api/v1/auth/login', async (req, reply) => {
    const { email = '', password = '' } = req.body ?? {};
    const user = get<UserRow>(db, 'SELECT * FROM users WHERE email = ?', email.trim());
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
    createSession(db, reply, user.id);
    return { user: publicUser(db, user) };
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
    return { user: publicUser(db, user), org };
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
    return { user: publicUser(db, get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', userId)!) };
  });

  // ----- volunteer join links (reusable; anyone with the link signs up as a localizer) -----

  type JoinLink = { code: string; org_id: number; locales: string; created_at: string; disabled_at: string | null };
  const activeLink = (code: string) => {
    const link = get<JoinLink & { org: string }>(db, 'SELECT j.*, o.name AS org FROM join_links j JOIN orgs o ON o.id = j.org_id WHERE j.code = ?', code);
    if (!link || link.disabled_at) throw new HttpError(404, 'This sign-up link is no longer active. Ask the person who shared it for a new one.');
    return { ...link, localeList: JSON.parse(link.locales) as string[] };
  };
  const linkJson = (l: JoinLink) => ({ code: l.code, path: `/join/${l.code}`, locales: JSON.parse(l.locales) as string[], createdAt: l.created_at, active: !l.disabled_at });

  app.post<{ Body: { locales?: string[] } }>('/api/v1/join-links', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    const locales = [...new Set((req.body?.locales ?? []).map(checkLocale))];
    if (!locales.length) throw new HttpError(400, 'Pick at least one language volunteers can sign up for.');
    const code = randomBytes(9).toString('base64url');
    run(db, 'INSERT INTO join_links (code, org_id, locales) VALUES (?, ?, ?)', code, user.org_id, JSON.stringify(locales));
    return { link: linkJson(get<JoinLink>(db, 'SELECT * FROM join_links WHERE code = ?', code)!) };
  });

  app.get('/api/v1/join-links', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    return { links: all<JoinLink>(db, 'SELECT * FROM join_links WHERE org_id = ? AND disabled_at IS NULL ORDER BY created_at DESC', user.org_id).map(linkJson) };
  });

  app.delete<{ Params: { code: string } }>('/api/v1/join-links/:code', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    run(db, 'UPDATE join_links SET disabled_at = CURRENT_TIMESTAMP WHERE code = ? AND org_id = ?', req.params.code, user.org_id);
    return { ok: true };
  });

  app.get<{ Params: { code: string } }>('/api/v1/join/:code', async (req) => {
    const link = activeLink(req.params.code);
    const projects = all<{ name: string; locale: string }>(
      db,
      `SELECT p.name, pl.locale FROM projects p JOIN project_locales pl ON pl.project_id = p.id
       WHERE p.org_id = ? AND pl.locale IN (${link.localeList.map(() => '?').join(',')}) ORDER BY p.name`,
      link.org_id, ...link.localeList,
    );
    const actor = actorOf(db, req);
    const me = actor?.kind === 'user' && actor.user.org_id === link.org_id ? publicUser(db, actor.user) : null;
    return { org: link.org, locales: link.localeList, projects: [...new Set(projects.map((p) => p.name))], me };
  });

  app.post<{ Params: { code: string }; Body: { name?: string; email?: string; password?: string; locales?: string[] } }>('/api/v1/join/:code', async (req, reply) => {
    const link = activeLink(req.params.code);
    const locales = (req.body?.locales ?? []).filter((l) => link.localeList.includes(l));
    if (!locales.length) throw new HttpError(400, 'Pick the language you will translate into.');

    // Already signed in to this org: just add the languages.
    const actor = actorOf(db, req);
    if (actor?.kind === 'user' && actor.user.org_id === link.org_id) {
      const merged = [...new Set([...actor.locales, ...locales])];
      tx(db, () => {
        run(db, 'UPDATE users SET locales = ? WHERE id = ?', JSON.stringify(merged), actor.user.id);
        // A language added through a public link starts at 'new' until the placement check.
        if (actor.user.role === 'localizer') for (const l of locales.filter((x) => !actor.locales.includes(x))) setTier(db, actor.user.id, l, 'new', 'joined from sign-up link');
      });
      return { user: publicUser(db, get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', actor.user.id)!) };
    }

    const name = req.body?.name?.trim();
    const email = (req.body?.email ?? '').trim();
    const password = req.body?.password ?? '';
    if (!name || !/^\S+@\S+$/.test(email)) throw new HttpError(400, 'Please enter your name and email.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (get(db, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Sign in, then open this link again to add the language.');
    const userId = tx(db, () => {
      const r = run(db, "INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, ?, ?, ?, 'localizer', ?)", link.org_id, email, name, hashPassword(password), JSON.stringify(locales));
      const id = Number(r.lastInsertRowid);
      for (const l of locales) setTier(db, id, l, 'new', 'joined from sign-up link');
      return id;
    });
    createSession(db, reply, userId);
    return { user: publicUser(db, get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', userId)!) };
  });

  // ----- team -----

  app.get('/api/v1/users', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    return { users: all<UserRow>(db, 'SELECT * FROM users WHERE org_id = ? ORDER BY name', user.org_id).map((u) => publicUser(db, u)) };
  });

  app.patch<{ Params: { id: string }; Body: { role?: UserRow['role']; locales?: string[]; tiers?: Record<string, Tier>; reason?: string } }>('/api/v1/users/:id', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    const target = get<UserRow>(db, 'SELECT * FROM users WHERE id = ? AND org_id = ?', Number(req.params.id), user.org_id);
    if (!target) throw new HttpError(404, 'User not found.');
    const role = req.body?.role ?? target.role;
    if (!['admin', 'reviewer', 'localizer'].includes(role)) throw new HttpError(400, 'Unknown role.');
    const locales = req.body?.locales ? JSON.stringify(req.body.locales.map(checkLocale)) : target.locales;
    tx(db, () => {
      run(db, 'UPDATE users SET role = ?, locales = ? WHERE id = ?', role, locales, target.id);
      // Admins can place people directly, e.g. for an interpreter certification or a partner organization's vouch.
      for (const [l, t] of Object.entries(req.body?.tiers ?? {})) {
        if (!TIERS.includes(t)) throw new HttpError(400, 'Tier must be new, trusted or lead.');
        setTier(db, target.id, checkLocale(l), t, req.body?.reason?.trim() || `set by ${user.name}`);
      }
    });
    return { user: publicUser(db, get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', target.id)!) };
  });
}
