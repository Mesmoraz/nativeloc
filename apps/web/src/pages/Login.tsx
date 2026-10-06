import { useState } from 'react';
import { useSession } from '../App';
import { api } from '../api';

// Accounts created by `npm run seed`. Shown only in dev builds.
const DEMO_ACCOUNTS = [
  { email: 'maria@demo.test', password: 'demo-localizer-pass', who: 'María', role: 'Localizer · Spanish' },
  { email: 'lucas@demo.test', password: 'demo-reviewer-pass', who: 'Lucas', role: 'Reviewer · Spanish, French' },
  { email: 'yuki@demo.test', password: 'demo-localizer-pass', who: 'Yuki', role: 'Localizer · Japanese' },
  { email: 'admin@demo.test', password: 'demo-admin-pass', who: 'Avery', role: 'Admin · manage projects' },
];

export function Login() {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(email: string, password: string) {
    setBusy(true);
    setError('');
    try {
      await api('/api/v1/auth/login', { body: { email, password } });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void signIn(email, password);
  }

  return (
    <div className="page">
      <form className="card center-card stack" onSubmit={submit}>
        <div className="row">
          <span className="brand-mark">文A</span>
          <h1 style={{ margin: 0 }}>NativeLoc</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Sign in to translate or manage your projects.
        </p>
        <label className="field">
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="alert error">{error}</div>}
        <button className="primary" disabled={busy}>
          Sign in
        </button>
        {import.meta.env.DEV && (
          <div className="stack demo-accounts">
            <p className="muted" style={{ margin: 0 }}>
              Demo: sign in as…
            </p>
            {DEMO_ACCOUNTS.map((a) => (
              <button type="button" key={a.email} disabled={busy} onClick={() => void signIn(a.email, a.password)}>
                <b>{a.who}</b> <span className="muted">{a.role}</span>
              </button>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}
