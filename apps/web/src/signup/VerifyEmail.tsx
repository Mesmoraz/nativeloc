import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../App';
import { api } from '../api';

/** Where the emailed link lands: /verify-email?token=… */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const { session, refresh } = useSession();
  const [state, setState] = useState<'checking' | 'done' | 'failed'>('checking');
  const [error, setError] = useState('');
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return; // one try per page load (React dev mode runs effects twice)
    sent.current = true;
    api('/api/v1/auth/verify-email', { body: { token: params.get('token') ?? '' } }).then(
      async () => {
        setState('done');
        await refresh();
      },
      (e) => {
        setError(e.message);
        setState('failed');
      },
    );
  }, [params, refresh]);

  return (
    <div className="page">
      <div className="card center-card stack">
        <div className="row">
          <span className="brand-mark">文A</span>
          <h1 style={{ margin: 0 }}>{state === 'done' ? 'Email confirmed' : state === 'failed' ? "That link didn't work" : 'Confirming…'}</h1>
        </div>
        {state === 'done' && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              Thanks! You can translate, review and post now.
            </p>
            <Link className="btn primary" to={session ? '/welcome' : '/'}>
              {session ? 'Continue' : 'Sign in'}
            </Link>
          </>
        )}
        {state === 'failed' && (
          <>
            <div className="alert error">{error}</div>
            <Link className="btn" to="/">
              {session ? 'Back to NativeLoc' : 'Sign in'}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
