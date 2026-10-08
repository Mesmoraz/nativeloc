import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TopBar, useSession } from '../App';
import { api, ApiError, type Tier } from '../api';
import { languageName, nativeLanguageName, textDirection } from '../types';

interface Status {
  locale: string;
  tier: Tier;
  available: boolean;
  questions: number;
  attempt: { id: number; status: 'in_progress' | 'submitted' | 'passed' | 'failed' } | null;
  retryAfter: string | null;
}
interface Attempt {
  id: number;
  locale: string;
  items: { itemId: number; kind: 'translate' | 'review'; source: string; candidate?: string }[];
}
type Answer = { text?: string; verdict?: 'ok' | 'problem'; explanation?: string };

/** The placement check a volunteer takes before their reviews count in a language. */
export function Placement() {
  const { locale = '' } = useParams();
  const { refresh } = useSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [result, setResult] = useState<{ status: string; review?: { correct: number; total: number } } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lang = languageName(locale);
  const dir = textDirection(locale);

  useEffect(() => {
    api<Status>(`/api/v1/placement/${locale}`).then(setStatus, (e) => setError(e.message));
  }, [locale]);

  async function start() {
    setError('');
    try {
      const r = await api<{ attempt: Attempt }>(`/api/v1/placement/${locale}/start`, { method: 'POST' });
      setAttempt(r.attempt);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const set = (itemId: number, patch: Answer) => setAnswers((a) => ({ ...a, [itemId]: { ...a[itemId], ...patch } }));
  const unanswered = attempt?.items.filter((i) => (i.kind === 'translate' ? !answers[i.itemId]?.text?.trim() : !answers[i.itemId]?.verdict)).length ?? 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!attempt || unanswered) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ status: string; review?: { correct: number; total: number } }>(`/api/v1/placement/attempts/${attempt.id}/submit`, {
        body: { answers: attempt.items.map((i) => ({ itemId: i.itemId, ...answers[i.itemId] })) },
      });
      setResult(r);
      setAttempt(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const reviewItems = attempt?.items.filter((i) => i.kind === 'review') ?? [];
  const translateItems = attempt?.items.filter((i) => i.kind === 'translate') ?? [];

  return (
    <>
      <TopBar>
        <div style={{ fontWeight: 600, flex: 1 }}>Placement check · {nativeLanguageName(locale)}</div>
        <Link to="/" className="btn ghost">
          Exit
        </Link>
      </TopBar>
      <main className="page" style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="stack" style={{ gap: 20 }}>
          {error && <div className="alert error">{error}</div>}

          {result && (
            <div className="card stack">
              {result.status === 'submitted' && (
                <>
                  <h1 style={{ margin: 0 }}>Thanks! It's with a reviewer now.</h1>
                  <p className="muted" style={{ margin: 0 }}>
                    An experienced {lang} reviewer will read your translations, usually within a few days. Keep translating in the meantime: your work counts
                    the same.
                  </p>
                </>
              )}
              {result.status === 'passed' && <h1 style={{ margin: 0 }}>You passed. Your reviews in {lang} now count.</h1>}
              {result.status === 'failed' && (
                <>
                  <h1 style={{ margin: 0 }}>Not this time</h1>
                  <p className="muted" style={{ margin: 0 }}>
                    You can keep translating, and try the check again in a week.
                  </p>
                </>
              )}
              <div>
                <Link className="btn primary" to="/">
                  Back to my languages
                </Link>
              </div>
            </div>
          )}

          {!result && status && !attempt && (
            <div className="card stack">
              <h1 style={{ margin: 0 }}>Start reviewing in {lang}</h1>
              {status.tier !== 'new' ? (
                <p style={{ margin: 0 }}>You already review in {lang}. Thank you!</p>
              ) : status.attempt?.status === 'submitted' ? (
                <p style={{ margin: 0 }}>Your placement check is with a reviewer. You'll be able to review as soon as it's graded.</p>
              ) : status.retryAfter ? (
                <p style={{ margin: 0 }}>
                  Your last check didn't pass. You can try again on {new Date(status.retryAfter).toLocaleDateString()}. Until then, keep translating; your work
                  still counts.
                </p>
              ) : !status.available ? (
                <p style={{ margin: 0 }}>There's no placement check for {lang} yet. An organizer will add one, or can approve you directly.</p>
              ) : (
                <>
                  <p style={{ margin: 0 }}>
                    Translations go live when other volunteers approve them, so reviewers need to catch real mistakes. This short check shows that you can.
                    It takes about 15 minutes.
                  </p>
                  <ol className="join-steps">
                    <li>Read a few translations and say whether each one is right. Some have a mistake on purpose.</li>
                    <li>Translate a few short sentences. An experienced reviewer reads them.</li>
                  </ol>
                  <p className="small muted" style={{ margin: 0 }}>
                    {status.questions} questions. No dictionary rules: write the way you would for a neighbor.
                  </p>
                  <div>
                    <button className="primary" onClick={() => void start()}>
                      {status.attempt?.status === 'in_progress' ? 'Continue the check' : 'Start the check'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {attempt && (
            <form className="stack" style={{ gap: 20 }} onSubmit={submit}>
              {reviewItems.length > 0 && (
                <section className="stack">
                  <h2 style={{ margin: 0 }}>1. Is this translation right?</h2>
                  <p className="small muted" style={{ margin: 0 }}>
                    Look for anything that would mislead someone: a wrong number, day or time, a missing “not”, a changed rule.
                  </p>
                  {reviewItems.map((item, n) => {
                    const a = answers[item.itemId] ?? {};
                    return (
                      <fieldset key={item.itemId} className="card stack placement-item">
                        <legend className="small muted">
                          {n + 1} of {reviewItems.length}
                        </legend>
                        <div>
                          <div className="label-row">English</div>
                          <div>{item.source}</div>
                        </div>
                        <div>
                          <div className="label-row">{lang}</div>
                          <div lang={locale} dir={dir} style={{ fontSize: '1.05rem' }}>
                            {item.candidate}
                          </div>
                        </div>
                        <div className="row">
                          <button type="button" aria-pressed={a.verdict === 'ok'} className="choice" onClick={() => set(item.itemId, { verdict: 'ok' })}>
                            Looks right
                          </button>
                          <button type="button" aria-pressed={a.verdict === 'problem'} className="choice" onClick={() => set(item.itemId, { verdict: 'problem' })}>
                            Has a problem
                          </button>
                        </div>
                        {a.verdict === 'problem' && (
                          <label className="field">
                            What's wrong? (optional, helps the reviewer)
                            <input value={a.explanation ?? ''} onChange={(e) => set(item.itemId, { explanation: e.target.value })} />
                          </label>
                        )}
                      </fieldset>
                    );
                  })}
                </section>
              )}

              {translateItems.length > 0 && (
                <section className="stack">
                  <h2 style={{ margin: 0 }}>2. Translate into {lang}</h2>
                  <p className="small muted" style={{ margin: 0 }}>
                    This is text from a food bank or clinic website. Write it the way someone in your community would want to read it.
                  </p>
                  {translateItems.map((item, n) => (
                    <div key={item.itemId} className="card stack">
                      <div className="small muted">
                        {n + 1} of {translateItems.length}
                      </div>
                      <div style={{ fontSize: '1.05rem' }}>{item.source}</div>
                      <textarea
                        rows={2}
                        lang={locale}
                        dir={dir}
                        aria-label={`Your ${lang} translation`}
                        value={answers[item.itemId]?.text ?? ''}
                        onChange={(e) => set(item.itemId, { text: e.target.value })}
                      />
                    </div>
                  ))}
                </section>
              )}

              <div className="row">
                <button className="primary" disabled={busy || unanswered > 0}>
                  Submit my answers
                </button>
                {unanswered > 0 && <span className="small muted">{unanswered} left to answer</span>}
              </div>
            </form>
          )}
        </div>
      </main>
    </>
  );
}
