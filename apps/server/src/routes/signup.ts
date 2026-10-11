import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app.js';
import { createSession, hashPassword, HttpError, requireUser } from '../auth.js';
import { addMembership, get, getUser, memberOf, run, tx, type DB, type OrgRow, type OrgType } from '../db.js';
import { normalizeEin } from '../moderation/eobmf.js';
import { startVerification } from '../moderation/verify.js';
import { assertEmailVerified, isWaitlisted } from '../signup/gate.js';
import { resendVerification, sendVerification, verifyEmail } from '../signup/mailer.js';
import { setTier } from '../trust.js';
import { checkLocale, intParam } from '../util.js';
import { meResponse, orgJson, publicUser, setCurrentOrg } from './auth.js';

const ORG_TYPES: OrgType[] = ['nonprofit', 'individual', 'small_org', 'business'];
/** Orgs one account may create, so a single sign-up can't flood the verification queue. */
export const MAX_ORGS_PER_USER = 5;
const US_STATE = /^[A-Z]{2}$/;

interface OrgBody {
  type?: string;
  name?: string;
  ein?: string;
  state?: string;
  website?: string;
  description?: string;
}

type OrgFields = { name?: string; ein?: string | null; state?: string | null; website?: string | null; description?: string | null };

/** Validates the editable org fields that are present in `body`. */
function orgFields(body: OrgBody, type: OrgType): OrgFields {
  const out: OrgFields = {};
  const text = (v: string | undefined, max: number, what: string) => {
    const t = v?.trim() ?? '';
    if (t.length > max) throw new HttpError(400, `${what} is too long (${max} characters at most).`);
    return t || null;
  };
  if (body.name !== undefined) {
    const name = text(body.name, 120, 'The name');
    if (!name) throw new HttpError(400, 'Give your organization a name.');
    out.name = name;
  }
  if (body.ein !== undefined) {
    if (type !== 'nonprofit') throw new HttpError(400, 'Only nonprofits have an EIN here.');
    // Groups without an EIN may leave it out; they go to the staff queue (2B).
    out.ein = body.ein.trim() ? normalizeEin(body.ein) : null;
    if (body.ein.trim() && !out.ein) throw new HttpError(400, 'An EIN is 9 digits, like 12-3456789.');
  }
  if (body.state !== undefined) {
    const state = body.state.trim().toUpperCase();
    if (state && !US_STATE.test(state)) throw new HttpError(400, 'Use the two-letter state code, like OR.');
    out.state = state || null;
  }
  if (body.website !== undefined) {
    const site = text(body.website, 200, 'The website');
    if (site && !/^https?:\/\/\S+\.\S+$/i.test(site)) throw new HttpError(400, 'Enter the website as a full address, like https://example.org.');
    out.website = site;
  }
  if (body.description !== undefined) out.description = text(body.description, 280, 'The description');
  return out;
}

const orgRow = (db: DB, id: number) => get<OrgRow & { ein: string | null; state: string | null }>(db, 'SELECT * FROM orgs WHERE id = ?', id)!;
/** OrgMembership plus the fields only its admins see. */
const orgOut = (db: DB, id: number, role: string) => {
  const o = orgRow(db, id);
  return { ...orgJson(o), role, ein: o.ein, state: o.state };
};

/** Owned by Segment 2 piece 2A (sign-up and onboarding). Endpoints: docs/segment-2-contracts.md §2A. */
export function signupRoutes(app: FastifyInstance, { db }: RouteDeps) {
  // ----- accounts -----

  app.post<{ Body: { name?: string; email?: string; password?: string } }>('/api/v1/auth/signup', async (req, reply) => {
    const name = req.body?.name?.trim() ?? '';
    const email = req.body?.email?.trim() ?? '';
    const password = req.body?.password ?? '';
    if (!name || name.length > 80) throw new HttpError(400, 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, 'Please enter a valid email address.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (get(db, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
    // No org and no languages yet: onboarding picks them. Trust starts at 'new' everywhere (no user_languages rows).
    const id = Number(run(db, "INSERT INTO users (email, name, password_hash, locales, email_verified) VALUES (?, ?, ?, '[]', 0)", email, name, hashPassword(password)).lastInsertRowid);
    const user = getUser(db, id)!;
    await sendVerification(db, user);
    createSession(db, reply, id);
    return { user: publicUser(db, user) };
  });

  app.post<{ Body: { token?: string } }>('/api/v1/auth/verify-email', async (req) => {
    const token = req.body?.token?.trim();
    if (!token) throw new HttpError(404, 'This link has expired or was already used. Sign in and ask for a new one.');
    const userId = verifyEmail(db, token);
    return { user: publicUser(db, getUser(db, userId)!) };
  });

  app.post('/api/v1/auth/resend-verification', async (req) => {
    const { user } = requireUser(db, req);
    await resendVerification(db, user);
    return { ok: true };
  });

  /** Account settings: name and languages. Languages added here start at 'new' (never vouched). */
  app.patch<{ Body: { name?: string; locales?: string[] } }>('/api/v1/me', async (req) => {
    const actor = requireUser(db, req);
    const name = req.body?.name === undefined ? actor.user.name : req.body.name.trim();
    if (!name || name.length > 80) throw new HttpError(400, 'Please enter your name.');
    if (req.body?.locales !== undefined && !Array.isArray(req.body.locales)) throw new HttpError(400, 'locales must be a list of language codes.');
    const locales = req.body?.locales ? [...new Set(req.body.locales.map(checkLocale))] : actor.locales;
    if (locales.length > 10) throw new HttpError(400, 'Pick up to 10 languages.');
    tx(db, () => {
      run(db, 'UPDATE users SET name = ?, locales = ? WHERE id = ?', name, JSON.stringify(locales), actor.user.id);
      // Removing a language keeps its tier row, so adding it back restores a placement already earned.
      for (const l of locales.filter((x) => !actor.locales.includes(x))) {
        if (!get(db, 'SELECT 1 FROM user_languages WHERE user_id = ? AND locale = ?', actor.user.id, l)) setTier(db, actor.user.id, l, 'new', 'added in account settings');
      }
    });
    return meResponse(db, requireUser(db, req));
  });

  // ----- orgs ("Get translation") -----

  // The caller becomes the admin of an org they made for themselves. Never vouchFor here: owning an org says
  // nothing about anyone's languages (contract risk 1), and self-made orgs vouch for nobody until verified.
  app.post<{ Body: OrgBody }>('/api/v1/orgs', async (req) => {
    const actor = requireUser(db, req);
    assertEmailVerified(db, actor.user);
    const type = req.body?.type as OrgType;
    if (!ORG_TYPES.includes(type)) throw new HttpError(400, 'Pick an account type: nonprofit, individual, small organization or business.');
    const created = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM orgs o JOIN memberships m ON m.org_id = o.id AND m.user_id = ? AND m.role = ? WHERE o.self_serve = 1', actor.user.id, 'admin')!.n;
    if (created >= MAX_ORGS_PER_USER) throw new HttpError(409, `You can set up ${MAX_ORGS_PER_USER} organizations. Contact us if you need more.`);
    if (type === 'individual' && get(db, "SELECT 1 FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? AND o.type = 'individual' AND o.self_serve = 1", actor.user.id)) {
      throw new HttpError(409, 'You already have a personal account.');
    }
    const body = { ...req.body, name: req.body?.name ?? (type === 'individual' ? actor.user.name : undefined) };
    if (body.name === undefined) throw new HttpError(400, 'Give your organization a name.');
    const f = orgFields(body, type);
    const id = tx(db, () => {
      const id = Number(
        run(
          db,
          'INSERT INTO orgs (name, type, ein, state, website, description, self_serve) VALUES (?, ?, ?, ?, ?, ?, 1)',
          f.name!, type, f.ein ?? null, f.state ?? null, f.website ?? null, f.description ?? null,
        ).lastInsertRowid,
      );
      addMembership(db, actor.user.id, id, 'admin');
      setCurrentOrg(db, actor, id);
      return id;
    });
    startVerification(db, orgRow(db, id));
    return { org: orgOut(db, id, 'admin'), waitlisted: isWaitlisted({ type }) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/orgs/:id', async (req) => {
    const actor = requireUser(db, req);
    const m = memberOf(db, actor.user, intParam(req.params.id));
    if (!m) throw new HttpError(404, 'Organization not found.');
    return { org: orgOut(db, m.orgId, m.role), waitlisted: isWaitlisted(orgRow(db, m.orgId)) };
  });

  app.patch<{ Params: { id: string }; Body: OrgBody }>('/api/v1/orgs/:id', async (req) => {
    const actor = requireUser(db, req);
    const m = memberOf(db, actor.user, intParam(req.params.id));
    if (!m) throw new HttpError(404, 'Organization not found.');
    if (m.role !== 'admin') throw new HttpError(403, 'Only admins can change the organization.');
    const before = orgRow(db, m.orgId);
    if ((before as { platform?: number }).platform) throw new HttpError(403, 'The NativeLoc community org is managed by staff.');
    if (req.body?.type !== undefined && req.body.type !== before.type) throw new HttpError(400, "The account type can't be changed. Contact us if it's wrong.");
    const f = orgFields(req.body ?? {}, before.type);
    const sets = Object.entries(f);
    if (sets.length) run(db, `UPDATE orgs SET ${sets.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...sets.map(([, v]) => v ?? null), m.orgId);
    // What verification matched on changed: check again (2B may verify automatically, or queue it for staff).
    if ((['name', 'ein', 'state'] as const).some((k) => k in f && f[k] !== before[k])) startVerification(db, orgRow(db, m.orgId));
    return { org: orgOut(db, m.orgId, m.role) };
  });
}
