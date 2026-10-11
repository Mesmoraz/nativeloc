import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../App';
import { api } from '../api';
import type { SignupRequest } from '../contracts';

/** Self-serve sign-up: name, email, password. Onboarding (/welcome) picks the hats. */
export function Signup() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState<SignupRequest>({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/v1/auth/signup', { body: form });
      await refresh();
      navigate('/welcome');
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
          <h1 style={{ margin: 0 }}>Join NativeLoc</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Volunteer a few minutes in your language, get your organization's information translated, or both.
        </p>
        <label className="field">
          Your name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" required autoFocus />
        </label>
        <label className="field">
          Email
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" required />
        </label>
        <label className="field">
          Choose a password (8+ characters)
          <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
        </label>
        {error && <div className="alert error">{error}</div>}
        <button className="primary" disabled={busy}>
          Create account
        </button>
        <p className="small muted" style={{ margin: 0 }}>
          Already have an account? <Link to="/">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
