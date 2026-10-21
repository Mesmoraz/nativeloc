import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { actorOf, createSession, hashPassword, HttpError, membershipsOf, type UserActor, randomToken, requireMember, requireUser, SESSION_COOKIE, sha256, verifyPassword } from '../auth.js';
import { addMembership, all, get, getOrg, getUser, memberOf, ROLES, run, tx, USER_COLUMNS, type DB, type OrgRow, type Role, type UserRow } from '../db.js';
import { saveTimeZone, timeZoneOf, validTimeZone } from '../streaks.js';
import { setTier, tierOf, tiersOf, TIERS, vouchFor, type Tier } from '../trust.js';
import { checkLocale } from '../util.js';
import { orgMayVouch } from '../signup/gate.js';
import { isEmailVerified, publicUrl, sendVerification } from '../signup/mailer.js';

/**
 * `role` is the user's role in `orgId` (default: their first org), or null if they have no role there.
 * Shapes: PublicUser in apps/web/src/contracts.ts.
 */
export function publicUser(db: DB, u: UserRow, orgId?: number | null) {
  const memberships = membershipsOf(db, u.id);
  const role = (orgId == null ? memberships[0] : memberships.find((m) => m.orgId === orgId))?.role ?? null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role,
    locales: JSON.parse(u.locales) as string[],
    tiers: tiersOf(db, u),
    isStaff: !!u.is_staff,
    emailVerified: isEmailVerified(db, u.id),
  };
}

/** GET /api/v1/me: the signed-in user, the org this sign-in works in (`org`, null when they have none) and all their orgs. */
export function meResponse(db: DB, actor: UserActor) {
  const orgs = actor.memberships.map((m) => ({ ...orgJson(getOrg(db, m.orgId)!), role: m.role }));
  return { user: publicUser(db, actor.user, actor.current?.orgId), org: orgs.find((o) => o.id === actor.current?.orgId) ?? null, orgs, timeZone: timeZoneOf(db, actor.user.id) };
}

/** Makes `orgId` the org this sign-in works in. */
export const setCurrentOrg = (db: DB, actor: UserActor, orgId: number) => run(db, 'UPDATE sessions SET org_id = ? WHERE token_hash = ?', orgId, actor.sessionHash);

/** A new account from an invite or join link. Unverified accounts get the confirmation email. */
async function createAccount(db: DB, baseUrl: string, fields: { email: string; name: string; password: string; locales: string[] }, verified: boolean, setup: (id: number) => void) {
  const id = tx(db, () => {
    const r = run(
      db,
      'INSERT INTO users (email, name, password_hash, locales, email_verified) VALUES (?, ?, ?, ?, ?)',
      fields.email, fields.name, hashPassword(fields.password), JSON.stringify(fields.locales), verified ? 1 : 0,
    );
    const id = Number(r.lastInsertRowid);
    setup(id);
    return id;
  });
  const user = getUser(db, id)!;
  if (!verified) await sendVerification(db, user, baseUrl);
  return user;
}

export function orgJson(o: OrgRow) {
  return { id: o.id, name: o.name, type: o.type, verification: o.verification, website: o.website, description: o.description };
}

export function authRoutes(app: FastifyInstance, db: DB) {
  app.post<{ Body: { email?: string; password?: string } }>('/api/v1/auth/login', async (req, reply) => {
    const { email = '', password = '' } = req.body ?? {};
    const user = get<UserRow>(db, `SELECT ${USER_COLUMNS} FROM users WHERE email = ?`, email.trim());
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

  const me = (actor: UserActor) => meResponse(db, actor);

  app.get('/api/v1/me', async (req) => me(requireUser(db, req)));

  /** The browser's time zone, so streak days are the volunteer's own (streaks.ts). The web app sends it when it changes. */
  app.put<{ Body: { timeZone?: unknown } }>('/api/v1/me/time-zone', async (req) => {
    const { user } = requireUser(db, req);
    const tz = req.body?.timeZone;
    if (!validTimeZone(tz)) throw new HttpError(400, "That isn't a time zone we know.");
    saveTimeZone(db, user.id, tz);
    return { timeZone: tz };
  });

  /** Switch the org this sign-in works in. */
  app.put<{ Body: { orgId?: number } }>('/api/v1/me/org', async (req) => {
    const actor = requireUser(db, req);
    const orgId = Number(req.body?.orgId);
    if (!actor.memberships.some((m) => m.orgId === orgId)) throw new HttpError(404, 'You are not a member of that organization.');
    setCurrentOrg(db, actor, orgId);
    return me(requireUser(db, req));
  });

  // ----- invites (admins create links; localizers accept them) -----

  app.post<{ Body: { role?: Role; locales?: string[]; email?: string } }>('/api/v1/invites', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    const role = req.body?.role ?? 'localizer';
    if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role.');
    const locales = (req.body?.locales ?? []).map(checkLocale);
    const token = randomToken();
    run(db, 'INSERT INTO invites (token_hash, org_id, role, locales, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)', sha256(token), member.orgId, role, JSON.stringify(locales), req.body?.email ?? null, Date.now() + 14 * 864e5);
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

  // Signed in: the invite adds a membership to the existing account. Signed out: it creates an account (409 if the
  // email has one: sign in first). Only orgs that may vouch (signup/gate.ts) raise the invitee's trust.
  app.post<{ Params: { token: string }; Body: { name?: string; email?: string; password?: string } }>('/api/v1/invites/:token/accept', async (req, reply) => {
    const inv = get<{ org_id: number; role: Role; locales: string; email: string | null; expires_at: number; used_at: string | null }>(db, 'SELECT * FROM invites WHERE token_hash = ?', sha256(req.params.token));
    if (!inv || inv.used_at || inv.expires_at < Date.now()) throw new HttpError(404, 'This invite link is no longer valid.');
    const invLocales = JSON.parse(inv.locales) as string[];
    const useInvite = () => run(db, 'UPDATE invites SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?', sha256(req.params.token));
    const vouch = (userId: number) => {
      if (orgMayVouch(db, inv.org_id)) vouchFor(db, userId, inv.role, invLocales, 'invited by an admin');
    };

    const actor = actorOf(db, req);
    if (actor?.kind === 'user') {
      if (inv.email && inv.email.toLowerCase() !== actor.user.email.toLowerCase()) throw new HttpError(403, `This invite is for ${inv.email}. Sign in with that account to accept it.`);
      if (memberOf(db, actor.user, inv.org_id)) throw new HttpError(409, "You're already on this team.");
      const added = invLocales.filter((l) => !actor.locales.includes(l));
      tx(db, () => {
        addMembership(db, actor.user.id, inv.org_id, inv.role);
        run(db, 'UPDATE users SET locales = ? WHERE id = ?', JSON.stringify([...actor.locales, ...added]), actor.user.id);
        vouch(actor.user.id);
        useInvite();
        setCurrentOrg(db, actor, inv.org_id);
      });
      return { user: publicUser(db, getUser(db, actor.user.id)!, inv.org_id) };
    }

    const name = req.body?.name?.trim();
    const email = (inv.email ?? req.body?.email ?? '').trim();
    const password = req.body?.password ?? '';
    if (!name || !/^\S+@\S+$/.test(email)) throw new HttpError(400, 'Please enter your name and email.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (get(db, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Sign in, then open this link again.');
    // An invite to a named address confirms that address; one the invitee typed in still needs the emailed link.
    const user = await createAccount(db, publicUrl(req), { email, name, password, locales: invLocales }, !!inv.email, (id) => {
      addMembership(db, id, inv.org_id, inv.role);
      vouch(id);
      useInvite();
    });
    createSession(db, reply, user.id);
    return { user: publicUser(db, user) };
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
    const { member } = requireMember(db, req, ['admin']);
    const locales = [...new Set((req.body?.locales ?? []).map(checkLocale))];
    if (!locales.length) throw new HttpError(400, 'Pick at least one language volunteers can sign up for.');
    const code = randomBytes(9).toString('base64url');
    run(db, 'INSERT INTO join_links (code, org_id, locales) VALUES (?, ?, ?)', code, member.orgId, JSON.stringify(locales));
    return { link: linkJson(get<JoinLink>(db, 'SELECT * FROM join_links WHERE code = ?', code)!) };
  });

  app.get('/api/v1/join-links', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    return { links: all<JoinLink>(db, 'SELECT * FROM join_links WHERE org_id = ? AND disabled_at IS NULL ORDER BY created_at DESC', member.orgId).map(linkJson) };
  });

  app.delete<{ Params: { code: string } }>('/api/v1/join-links/:code', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    run(db, 'UPDATE join_links SET disabled_at = CURRENT_TIMESTAMP WHERE code = ? AND org_id = ?', req.params.code, member.orgId);
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
    // `me`: whoever is signed in (they join with that account); `member`: they already belong to this org.
    const actor = actorOf(db, req);
    const me = actor?.kind === 'user' ? publicUser(db, actor.user, link.org_id) : null;
    const member = actor?.kind === 'user' && !!memberOf(db, actor.user, link.org_id);
    return { org: link.org, locales: link.localeList, projects: [...new Set(projects.map((p) => p.name))], me, member };
  });

  app.post<{ Params: { code: string }; Body: { name?: string; email?: string; password?: string; locales?: string[] } }>('/api/v1/join/:code', async (req, reply) => {
    const link = activeLink(req.params.code);
    const locales = (req.body?.locales ?? []).filter((l) => link.localeList.includes(l));
    if (!locales.length) throw new HttpError(400, 'Pick the language you will translate into.');

    // Signed in: join the org as a localizer if not a member yet, and add the languages.
    const actor = actorOf(db, req);
    if (actor?.kind === 'user') {
      const member = memberOf(db, actor.user, link.org_id);
      const merged = [...new Set([...actor.locales, ...locales])];
      tx(db, () => {
        if (!member) addMembership(db, actor.user.id, link.org_id, 'localizer');
        run(db, 'UPDATE users SET locales = ? WHERE id = ?', JSON.stringify(merged), actor.user.id);
        // A language added through a public link starts at 'new' until the placement check.
        if ((member?.role ?? 'localizer') === 'localizer') {
          for (const l of locales.filter((x) => !actor.locales.includes(x))) setTier(db, actor.user.id, l, 'new', 'joined from sign-up link');
        }
        if (!member) setCurrentOrg(db, actor, link.org_id);
      });
      return { user: publicUser(db, getUser(db, actor.user.id)!, link.org_id) };
    }

    const name = req.body?.name?.trim();
    const email = (req.body?.email ?? '').trim();
    const password = req.body?.password ?? '';
    if (!name || !/^\S+@\S+$/.test(email)) throw new HttpError(400, 'Please enter your name and email.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (get(db, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Sign in, then open this link again to add the language.');
    // Join links are shared publicly, so the address isn't confirmed until the emailed link is opened.
    const user = await createAccount(db, publicUrl(req), { email, name, password, locales }, false, (id) => {
      addMembership(db, id, link.org_id, 'localizer');
      for (const l of locales) setTier(db, id, l, 'new', 'joined from sign-up link');
    });
    createSession(db, reply, user.id);
    return { user: publicUser(db, user) };
  });

  // ----- team -----

  // The members of the admin's current org, with their role there. Languages and tiers belong to the person, not the
  // org, so an admin's edits to them show in every org the person helps.
  app.get('/api/v1/users', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    const users = all<UserRow>(db, `SELECT ${USER_COLUMNS} FROM users WHERE id IN (SELECT user_id FROM memberships WHERE org_id = ?) ORDER BY name`, member.orgId);
    return { users: users.map((u) => publicUser(db, u, member.orgId)) };
  });

  app.patch<{ Params: { id: string }; Body: { role?: Role; locales?: string[]; tiers?: Record<string, Tier>; reason?: string } }>('/api/v1/users/:id', async (req) => {
    const { member } = requireMember(db, req, ['admin']);
    const user = getUser(db, Number(req.params.id));
    const target = user && memberOf(db, user, member.orgId);
    if (!target) throw new HttpError(404, 'User not found.');
    const role = req.body?.role ?? target.role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role.');
    const locales = req.body?.locales ? JSON.stringify([...new Set(req.body.locales.map(checkLocale))]) : target.locales;
    const before = JSON.parse(target.locales) as string[];
    const after = JSON.parse(locales) as string[];
    // Languages and tiers belong to the person and count in every org they help. An admin may add languages and
    // vouch (if their org may vouch), but only someone's sole org may take a language away or lower a tier.
    const elsewhere = !!get(db, 'SELECT 1 FROM memberships WHERE user_id = ? AND org_id != ?', target.id, member.orgId);
    const mayVouch = orgMayVouch(db, member.orgId);
    if (elsewhere && before.some((l) => !after.includes(l))) throw new HttpError(403, `${target.name} also helps other organizations, so only they can remove a language.`);
    const tiers = Object.entries(req.body?.tiers ?? {}).map(([l, t]) => [checkLocale(l), t] as const);
    for (const [l, t] of tiers) {
      if (!TIERS.includes(t)) throw new HttpError(400, 'Tier must be new, trusted or lead.');
      const now = TIERS.indexOf(tierOf(db, target, l));
      if (TIERS.indexOf(t) > now && !mayVouch) throw new HttpError(403, 'Your organization can place volunteers once NativeLoc has verified it.');
      if (TIERS.indexOf(t) < now && elsewhere) throw new HttpError(403, `${target.name} also helps other organizations, so their level in ${l} can't be lowered here.`);
    }
    tx(db, () => {
      addMembership(db, target.id, member.orgId, role);
      run(db, 'UPDATE users SET locales = ? WHERE id = ?', locales, target.id);
      if (mayVouch) vouchFor(db, target.id, role, after.filter((l) => !before.includes(l)), `added by ${member.name}`);
      // Admins can place people directly, e.g. for an interpreter certification or a partner organization's vouch.
      for (const [l, t] of tiers) setTier(db, target.id, l, t, req.body?.reason?.trim() || `set by ${member.name}`);
    });
    return { user: publicUser(db, getUser(db, target.id)!, member.orgId) };
  });
}
