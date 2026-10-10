import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar, useSession } from '../App';
import { api } from '../api';
import type { MeResponse, UpdateOrgRequest } from '../contracts';
import { languageName } from '../types';
import { ConfirmEmail, LanguagePicker, ORG_TYPE_LABEL, type OrgDetails } from './shared';
import './signup.css';

const TIER_LABEL = { new: 'New', trusted: 'Trusted', lead: 'Lead' } as const;
const VERIFICATION_LABEL = { unverified: '', pending: 'Verification pending', verified: 'Verified', rejected: 'Not verified' } as const;

/** Account settings: name, languages, and the orgs you belong to (switch, and edit the ones you run). */
export function Settings() {
  const { session, refresh } = useSession();
  const user = session!.user;
  const [name, setName] = useState(user.name);
  const [locales, setLocales] = useState(user.locales);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api<MeResponse>('/api/v1/me', { method: 'PATCH', body: { name, locales } });
      await refresh();
      setMsg({ ok: 'Saved.' });
    } catch (err) {
      setMsg({ error: (err as Error).message });
    }
  }

  return (
    <>
      <TopBar />
      <main className="su-page stack">
        <h1>Account</h1>
        {user.emailVerified === false && <ConfirmEmail email={user.email} />}
        <form className="card stack" onSubmit={save}>
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </label>
          <div className="small muted">
            Email: {user.email} {user.emailVerified !== false && '· confirmed'}
          </div>
          <LanguagePicker value={locales} onChange={setLocales} />
          {user.locales.length > 0 && (
            <div className="small muted">
              Your level:{' '}
              {user.locales.map((l, i) => (
                <span key={l}>
                  {i > 0 && ' · '}
                  {languageName(l)} {TIER_LABEL[user.tiers[l] ?? 'new']}
                  {(user.tiers[l] ?? 'new') === 'new' && (
                    <>
                      {' '}
                      (<Link to={`/placement/${l}`}>placement check</Link>)
                    </>
                  )}
                </span>
              ))}
            </div>
          )}
          {msg.error && <div className="alert error">{msg.error}</div>}
          {msg.ok && <div className="alert small">{msg.ok}</div>}
          <div className="row">
            <span className="spacer" />
            <button className="primary">Save</button>
          </div>
        </form>

        <h2>Organizations</h2>
        {!session!.orgs.length && <p className="muted" style={{ margin: 0 }}>You don't belong to an organization. Volunteers don't need one.</p>}
        {session!.orgs.map((o) => (
          <OrgCard key={o.id} orgId={o.id} />
        ))}
        <Link className="btn" to="/welcome?hat=request" style={{ alignSelf: 'flex-start' }}>
          Set up an organization
        </Link>
      </main>
    </>
  );
}

function OrgCard({ orgId }: { orgId: number }) {
  const { session, refresh } = useSession();
  const [org, setOrg] = useState<OrgDetails | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<UpdateOrgRequest & { state?: string }>({});
  const [error, setError] = useState('');
  const current = session!.org?.id === orgId;

  useEffect(() => {
    api<{ org: OrgDetails }>(`/api/v1/orgs/${orgId}`).then((r) => setOrg(r.org), (e) => setError(e.message));
  }, [orgId]);
  if (!org) return error ? <div className="alert error">{error}</div> : null;

  async function switchTo() {
    await api('/api/v1/me/org', { method: 'PUT', body: { orgId } });
    await refresh();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ org: OrgDetails }>(`/api/v1/orgs/${orgId}`, { method: 'PATCH', body: form });
      setOrg(r.org);
      setEditing(false);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const field = (k: 'name' | 'ein' | 'state' | 'website' | 'description', label: string) => (
    <label className="field">
      {label}
      <input value={form[k] ?? org[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </label>
  );

  return (
    <div className="card stack">
      <div className="row">
        <div style={{ flex: 1, minWidth: 160 }}>
          <b>{org.name}</b>
          <div className="small muted">
            {ORG_TYPE_LABEL[org.type]} · {org.role}
            {org.type === 'nonprofit' && VERIFICATION_LABEL[org.verification] ? ` · ${VERIFICATION_LABEL[org.verification]}` : ''}
            {org.type === 'business' ? ' · on the waitlist' : ''}
          </div>
        </div>
        {current ? <span className="badge">Current</span> : <button onClick={switchTo}>Switch to</button>}
        {org.role === 'admin' && !editing && <button onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {editing && (
        <form className="stack" onSubmit={save}>
          {field('name', 'Name')}
          {org.type === 'nonprofit' && field('ein', 'EIN')}
          {org.type === 'nonprofit' && field('state', 'State')}
          {org.type !== 'individual' && field('website', 'Website')}
          {field('description', 'What you do')}
          <div className="row">
            <span className="spacer" />
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="primary">Save</button>
          </div>
        </form>
      )}
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}
