import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../App';
import { api, type User } from '../api';
import { languageName, nativeLanguageName } from '../types';

interface JoinInfo {
  org: string;
  locales: string[];
  projects: string[];
  me: User | null;
}

/** Public volunteer sign-up from a shared link: pick your language, make an account, start translating. */
export function Join() {
  const { code = '' } = useParams();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [form, setForm] = useState({ name: '', email: '', password: '' });

  useEffect(() => {
    api<JoinInfo>(`/api/v1/join/${code}`).then(
      (r) => {
        setInfo(r);
        if (r.locales.length === 1) setPicked(r.locales);
      },
      (e) => setError(e.message),
    );
  }, [code]);

  const toggle = (l: string) => setPicked((p) => (p.includes(l) ? p.filter((x) => x !== l) : [...p, l]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked.length) return setError('Pick the language you will translate into.');
    setBusy(true);
    setError('');
    try {
      await api(`/api/v1/join/${code}`, { body: { ...form, locales: picked } });
      await refresh();
      navigate('/');
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
          <h1 style={{ margin: 0 }}>Volunteer with {info?.org ?? 'NativeLoc'}</h1>
        </div>
        {info && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              Help local organizations reach people in their own language
              {info.projects.length ? <> — including {info.projects.slice(0, 3).join(', ')}{info.projects.length > 3 ? ' and more' : ''}</> : null}. No experience
              needed: you'll see one short piece of text at a time, with a picture of where it appears.
            </p>
            <ol className="join-steps small">
              <li>Translate a few sentences whenever you have a minute.</li>
              <li>Check other volunteers' translations.</li>
              <li>When enough volunteers agree, it goes live.</li>
            </ol>

            <fieldset className="lang-pick">
              <legend className="small">Which language do you speak?</legend>
              {info.locales.map((l) => (
                <button type="button" key={l} aria-pressed={picked.includes(l)} onClick={() => toggle(l)} lang={l}>
                  <span className="lang-native">{nativeLanguageName(l)}</span>
                  <span className="small muted">{languageName(l)}</span>
                </button>
              ))}
            </fieldset>

            {info.me ? (
              <p className="small muted" style={{ margin: 0 }}>
                You're signed in as <b>{info.me.name}</b>. We'll add the languages you pick to your account.
              </p>
            ) : (
              <>
                <label className="field">
                  Your name
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" required />
                </label>
                <label className="field">
                  Email
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" required />
                </label>
                <label className="field">
                  Choose a password (8+ characters)
                  <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
                </label>
              </>
            )}
          </>
        )}
        {error && <div className="alert error">{error}</div>}
        {info && (
          <button className="primary" disabled={busy}>
            {info.me ? 'Add language & start' : 'Join & start translating'}
          </button>
        )}
      </form>
    </div>
  );
}
