import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../App';
import { api } from '../api';
import { languageName } from '../types';

interface InviteInfo {
  org: string;
  role: string;
  locales: string[];
  email: string | null;
}

export function Invite() {
  const { token = '' } = useParams();
  const { session, refresh } = useSession();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '' });

  useEffect(() => {
    api<InviteInfo>(`/api/v1/invites/${token}`).then(setInfo, (e) => setError(e.message));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      // Signed in: the invite joins this account to the org; no form needed.
      await api(`/api/v1/invites/${token}/accept`, { body: session ? {} : form });
      await refresh();
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="page">
      <form className="card center-card stack" onSubmit={submit}>
        <h1>Join {info?.org ?? 'NativeLoc'}</h1>
        {info && (
          <p className="muted" style={{ margin: 0 }}>
            You're invited as a <b>{info.role}</b>
            {info.locales.length ? <> for {info.locales.map(languageName).join(', ')}</> : null}.
          </p>
        )}
        {info && session && (
          <p className="small muted" style={{ margin: 0 }}>
            You're signed in as <b>{session.user.name}</b> ({session.user.email}). Accepting adds {info.org} to your account.
          </p>
        )}
        {info && !session && (
          <>
            <label className="field">
              Your name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </label>
            {!info.email && (
              <label className="field">
                Email
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </label>
            )}
            <label className="field">
              Choose a password (8+ characters)
              <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
            </label>
          </>
        )}
        {error && <div className="alert error">{error}</div>}
        {info && <button className="primary">{session ? `Join ${info.org}` : 'Create account'}</button>}
        {info && !session && (
          <p className="small muted" style={{ margin: 0 }}>
            Already have an account? <Link to="/">Sign in</Link>, then open this link again.
          </p>
        )}
      </form>
    </div>
  );
}
