import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TopBar, useSession } from '../App';
import { api, type Project } from '../api';
import type { ReviewMode, SubmitResponse, Visibility } from '../contracts';
import { languageName } from '../types';
import { AddContent } from './AddContent';
import { LanguagePicker } from './LanguagePicker';
import { MODERATION_TEXT, ReviewModeChoice, VisibilityChoice } from './Sharing';
import './posting.css';

const SOURCES = ['en', 'es', 'fr', 'zh-Hans', 'vi', 'ko', 'ru', 'ar', 'pt-BR', 'de'];

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <ol className="post-steps" aria-label="Steps">
      {['Project', 'Add text', 'Submit'].map((s, i) => (
        <li key={s} className={i + 1 === at ? 'on' : i + 1 < at ? 'done' : ''} aria-current={i + 1 === at ? 'step' : undefined}>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Who can't post yet gets a sentence instead of the form. */
function useCannotPost(): string | null {
  const { session } = useSession();
  const org = session?.org;
  if (!org) return 'Set up your organization first: posting needs an account type (nonprofit, community group or individual).';
  if (org.type === 'business') return 'Business accounts are on the waitlist for now. We’ll email you when posting opens for businesses.';
  if (org.role !== 'admin') return `Only admins of ${org.name} can start projects.`;
  return null;
}

/** Step 1: name, languages, who translates it. */
export function NewProject() {
  const { session } = useSession();
  const navigate = useNavigate();
  const blocked = useCannotPost();
  const org = session?.org;
  const [name, setName] = useState('');
  const [source, setSource] = useState('en');
  const [locales, setLocales] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<Visibility>('public');
  // Matches the server's defaultReviewMode for public projects.
  const recommended: ReviewMode = org?.type === 'nonprofit' && org.verification === 'verified' ? 'standard' : 'community';
  const [reviewMode, setReviewMode] = useState<ReviewMode | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!locales.length) return setError('Pick at least one language to translate into.');
    setBusy(true);
    try {
      const r = await api<{ project: Project }>('/api/v1/projects', {
        body: { name, sourceLocale: source, locales, visibility, ...(visibility === 'public' && reviewMode ? { reviewMode } : {}) },
      });
      navigate(`/new/${r.project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page post-page">
        <Steps at={1} />
        <h1>New project</h1>
        {blocked ? (
          <div className="card">
            <p style={{ marginTop: 0 }}>{blocked}</p>
            <Link to="/">Back to home</Link>
          </div>
        ) : (
          <form className="stack" onSubmit={create}>
            <section className="card stack">
              <label className="field">
                <span>Project name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pantry hours page" required autoFocus maxLength={120} />
              </label>
              <label className="field post-source">
                <span>Written in</span>
                <select value={source} onChange={(e) => (setSource(e.target.value), setLocales(locales.filter((l) => l !== e.target.value)))}>
                  {SOURCES.map((l) => (
                    <option key={l} value={l}>
                      {languageName(l)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section className="card stack">
              <LanguagePicker value={locales} onChange={setLocales} exclude={source} legend="Translate into (pick one or more)" />
            </section>
            <section className="card stack">
              <VisibilityChoice value={visibility} onChange={setVisibility} />
              {visibility === 'public' && <ReviewModeChoice value={reviewMode ?? recommended} onChange={setReviewMode} recommended={recommended} />}
            </section>
            {error && <div className="alert error">{error}</div>}
            <div className="row post-actions">
              <Link to="/" className="btn ghost">
                Cancel
              </Link>
              <span className="spacer" />
              <button className="primary" disabled={busy}>
                Next: add text
              </button>
            </div>
          </form>
        )}
      </main>
    </>
  );
}

/** Steps 2 and 3 for a project just created: add text, then submit it (public) or finish (private). */
export function NewProjectContent() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [step, setStep] = useState<2 | 3>(2);
  const [pasting, setPasting] = useState(false);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProject((await api<{ project: Project }>(`/api/v1/projects/${projectId}`)).project);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const strings = project?.progress[0]?.total ?? 0;

  async function submit() {
    setError('');
    setBusy(true);
    try {
      setResult(await api<SubmitResponse>(`/api/v1/projects/${projectId}/submit`, { method: 'POST' }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page post-page">
        <Steps at={step} />
        {!project ? (
          error ? <div className="alert error">{error}</div> : null
        ) : step === 2 ? (
          <div className="stack">
            <div>
              <h1 style={{ marginBottom: 4 }}>Add text to “{project.name}”</h1>
              <p className="muted" style={{ marginTop: 0 }}>
                {strings ? `${strings} string${strings === 1 ? '' : 's'} so far. Add more, or go on.` : 'Volunteers will see this text one short piece at a time.'}
              </p>
            </div>
            <section className="card">
              <AddContent project={project} onAdded={load} onPending={setPasting} />
            </section>
            {pasting && <div className="alert small">You have pasted text that isn’t added yet. Press Preview, then “Add” under the text box, before you go on.</div>}
            <div className="row post-actions">
              <Link to={`/p/${project.id}`} className="btn ghost">
                Finish later
              </Link>
              <span className="spacer" />
              <button className="primary" disabled={!strings || pasting} onClick={() => setStep(3)}>
                Next: {project.visibility === 'public' ? 'submit' : 'review'}
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <h1 style={{ marginBottom: 0 }}>{project.visibility === 'public' ? 'Submit for volunteers' : 'Ready for your team'}</h1>
            <section className="card stack">
              <dl className="post-summary">
                <dt>Project</dt>
                <dd>{project.name}</dd>
                <dt>Strings</dt>
                <dd>{strings}</dd>
                <dt>From</dt>
                <dd>{languageName(project.sourceLocale)}</dd>
                <dt>Into</dt>
                <dd>{project.locales.map(languageName).join(', ')}</dd>
                <dt>Who translates</dt>
                <dd>{project.visibility === 'public' ? `Volunteers, ${project.reviewMode === 'community' ? 'community review' : 'standard review'}` : 'Your team'}</dd>
              </dl>
            </section>
            {project.visibility === 'public' && (
              <section className="card stack">
                {project.moderation === 'none' || project.moderation === 'rejected' ? (
                  <p style={{ margin: 0 }}>Before volunteers see it, we check every public project for spam and ads. Most projects go live right away.</p>
                ) : (
                  <>
                    <div className={`alert ${project.moderation === 'approved' ? 'ok' : 'warn'}`}>{MODERATION_TEXT[project.moderation]}</div>
                    {!!result?.reasons.length && (
                      <div className="small">
                        A person will check it because of:
                        <ul className="post-reasons">
                          {result.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
            {error && <div className="alert error">{error}</div>}
            <div className="row post-actions">
              <button className="ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <span className="spacer" />
              {project.visibility === 'public' && (project.moderation === 'none' || project.moderation === 'rejected') ? (
                <button className="primary" disabled={busy} onClick={() => void submit()}>
                  Submit for review
                </button>
              ) : (
                <button className="primary" onClick={() => navigate(`/p/${project.id}`)}>
                  Go to the project
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
