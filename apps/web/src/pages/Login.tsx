import { useState } from 'react';
import { useSession } from '../App';
import { api } from '../api';

export function Login() {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
      </form>
    </div>
  );
}
