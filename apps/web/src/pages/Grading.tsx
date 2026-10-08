import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar } from '../App';
import { api } from '../api';
import { languageName, textDirection } from '../types';

export interface GradingAttempt {
  id: number;
  name: string;
  locale: string;
  submittedAt: string;
  review: { correct: number; total: number };
  reviewMisses: { source: string; candidate: string; planted: string | null; verdict: string; explanation: string | null }[];
  translations: { itemId: number; source: string; reference: string | null; text: string }[];
}

/** Reviewers and leads grade the translation part of volunteers' placement checks. */
export function Grading() {
  const [attempts, setAttempts] = useState<GradingAttempt[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api<{ attempts: GradingAttempt[] }>('/api/v1/placement-grading').then((r) => setAttempts(r.attempts), (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <TopBar>
        <div style={{ fontWeight: 600, flex: 1 }}>Placement checks to grade</div>
        <Link to="/" className="btn ghost">
          Exit
        </Link>
      </TopBar>
      <main className="page" style={{ maxWidth: 860, margin: '0 auto' }}>
        <div className="stack" style={{ gap: 20 }}>
          {error && <div className="alert error">{error}</div>}
          {attempts && !attempts.length && <div className="card muted">Nothing to grade right now.</div>}
          {attempts?.map((a) => <GradeCard key={a.id} attempt={a} onDone={load} />)}
        </div>
      </main>
    </>
  );
}

function GradeCard({ attempt, onDone }: { attempt: GradingAttempt; onDone: () => void }) {
  const [grades, setGrades] = useState<Record<number, { pass?: boolean; note?: string }>>({});
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const lang = languageName(attempt.locale);
  const dir = textDirection(attempt.locale);
  const reviewPct = attempt.review.total ? Math.round((attempt.review.correct / attempt.review.total) * 100) : 100;
  const missing = attempt.translations.filter((t) => typeof grades[t.itemId]?.pass !== 'boolean').length;
  const grade = (itemId: number, patch: { pass?: boolean; note?: string }) => setGrades((g) => ({ ...g, [itemId]: { ...g[itemId], ...patch } }));

  async function submit() {
    setError('');
    try {
      const r = await api<{ status: string }>(`/api/v1/placement/attempts/${attempt.id}/grade`, {
        body: { grades: attempt.translations.map((t) => ({ itemId: t.itemId, pass: grades[t.itemId].pass, note: grades[t.itemId].note })) },
      });
      setResult(r.status === 'passed' ? `${attempt.name} passed and can now review in ${lang}.` : `${attempt.name} didn't pass. They can try again in a week.`);
      setTimeout(onDone, 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <div>
          <h2 style={{ margin: 0 }}>
            {attempt.name} · {lang}
          </h2>
          <div className="small muted">Submitted {new Date(attempt.submittedAt + 'Z').toLocaleDateString()}</div>
        </div>
        <span className="spacer" />
        <span className={`badge ${reviewPct >= 80 ? 'approved' : 'outdated'}`}>
          Spot the problem: {attempt.review.correct}/{attempt.review.total}
        </span>
      </div>

      {attempt.reviewMisses.length > 0 && (
        <details>
          <summary className="small">
            {attempt.reviewMisses.length} missed in “spot the problem”{reviewPct < 80 ? ' (below the 80% pass mark already)' : ''}
          </summary>
          <div className="stack small" style={{ marginTop: 8 }}>
            {attempt.reviewMisses.map((m, i) => (
              <div key={i}>
                <div>{m.source}</div>
                <div lang={attempt.locale} dir={dir} className="muted">
                  {m.candidate}
                </div>
                <div className="muted">
                  {m.planted ? `Planted problem (“${m.planted}”); they said it looks right.` : 'This one was correct; they flagged a problem'}
                  {m.explanation ? `: “${m.explanation}”` : '.'}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="small muted">Would you publish each translation as written? Small style differences from the reference are fine.</div>
      {attempt.translations.map((t) => {
        const g = grades[t.itemId] ?? {};
        return (
          <div key={t.itemId} className="stack placement-grade">
            <div>{t.source}</div>
            <div className="grade-pair">
              <div>
                <div className="label-row">Their translation</div>
                <div lang={attempt.locale} dir={dir} style={{ fontSize: '1.05rem' }}>
                  {t.text}
                </div>
              </div>
              <div>
                <div className="label-row">Reference</div>
                <div lang={attempt.locale} dir={dir} className="muted">
                  {t.reference}
                </div>
              </div>
            </div>
            <div className="row">
              <button type="button" className="choice" aria-pressed={g.pass === true} onClick={() => grade(t.itemId, { pass: true })}>
                Acceptable
              </button>
              <button type="button" className="choice" aria-pressed={g.pass === false} onClick={() => grade(t.itemId, { pass: false })}>
                Not acceptable
              </button>
              <input
                style={{ flex: 1, minWidth: 160 }}
                placeholder="Note (optional)"
                aria-label="Note"
                value={g.note ?? ''}
                onChange={(e) => grade(t.itemId, { note: e.target.value })}
              />
            </div>
          </div>
        );
      })}
      {error && <div className="alert error">{error}</div>}
      {result ? (
        <div className="alert ok">{result}</div>
      ) : (
        <div className="row">
          <button className="primary" disabled={missing > 0} onClick={() => void submit()}>
            Submit grades
          </button>
          {missing > 0 && <span className="small muted">{missing} left to grade</span>}
        </div>
      )}
    </div>
  );
}
