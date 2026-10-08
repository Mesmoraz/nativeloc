import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar, useSession } from '../App';
import { api, type Project } from '../api';
import { ProgressBar } from '../components';
import { languageName, nativeLanguageName } from '../types';

export function Home() {
  const { session } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');
  const isAdmin = session!.user.role === 'admin';

  const load = () => api<{ projects: Project[] }>('/api/v1/projects').then((r) => setProjects(r.projects), (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <TopBar />
      <main className="page">
        {error && <div className="alert error">{error}</div>}
        {projects && (isAdmin ? <AdminHome projects={projects} onCreated={load} /> : <LocalizerHome projects={projects} />)}
      </main>
    </>
  );
}

/** Placement checks waiting for this reviewer or lead to grade. */
function GradingBanner() {
  const [n, setN] = useState(0);
  useEffect(() => {
    api<{ attempts: unknown[] }>('/api/v1/placement-grading').then((r) => setN(r.attempts.length), () => setN(0));
  }, []);
  if (!n) return null;
  return (
    <div className="card row">
      <div>
        <b>
          {n} placement check{n === 1 ? '' : 's'} to grade
        </b>
        <div className="small muted">New volunteers can review once someone experienced checks their translations.</div>
      </div>
      <span className="spacer" />
      <Link className="btn primary" to="/grading">
        Grade
      </Link>
    </div>
  );
}

function LocalizerHome({ projects }: { projects: Project[] }) {
  const { session } = useSession();
  const isReviewer = session!.user.role === 'reviewer';
  const work = projects.flatMap((p) => p.progress.map((pr) => ({ project: p, pr })));
  const firstName = session!.user.name.split(' ')[0];

  return (
    <div className="stack">
      <div>
        <h1>Hi {firstName} 👋</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Pick up where you left off. Strings are shown one at a time with a picture of where they appear.
        </p>
      </div>
      <GradingBanner />
      {!work.length && <div className="card muted">Nothing is assigned to you yet. Your admin will add you to a language, or open a volunteer sign-up link to pick one.</div>}
      <div className="grid-cards">
        {work.map(({ project, pr }) => {
          const toTranslate = pr.todo + pr.outdated;
          // Reviewers and leads review everything; with peer review on, trusted localizers review each other's work.
          const canReview = isReviewer || pr.tier === 'lead' || (project.peerApprovals > 0 && pr.tier === 'trusted');
          const needsPlacement = !isReviewer && pr.tier === 'new' && project.peerApprovals > 0;
          const toReview = pr.reviewable ?? pr.review;
          const waiting = pr.review - toReview;
          return (
            <div className="card stack" key={`${project.id}-${pr.locale}`}>
              <div>
                <div className="muted small">{project.name}</div>
                <h2 style={{ margin: 0 }}>
                  {nativeLanguageName(pr.locale)} <span className="muted small">({languageName(pr.locale)})</span>
                </h2>
              </div>
              <ProgressBar p={pr} />
              <div className="small muted">
                {pr.approved} of {pr.total} done · {toTranslate} to translate
                {canReview ? ` · ${toReview} to review` : ''}
                {(canReview ? waiting : pr.review) > 0 ? ` · ${canReview ? waiting : pr.review} waiting for others` : ''}
              </div>
              {needsPlacement && (
                <div className="small tier-note">
                  Your translations count now. To review others' work, take the 15-minute{' '}
                  <Link to={`/placement/${pr.locale}`}>placement check</Link>.
                </div>
              )}
              {project.peerApprovals > 0 && !isReviewer && !needsPlacement && (
                <div className="small muted">
                  A translation goes live once {project.peerApprovals === 1 ? 'another volunteer approves it' : `${project.peerApprovals} other volunteers approve it`}.
                </div>
              )}
              <div className="row">
                <Link className={`btn ${toTranslate ? 'primary' : ''}`} to={`/p/${project.id}/${pr.locale}/translate`}>
                  {toTranslate ? 'Start translating' : 'All translated ✓'}
                </Link>
                {canReview && (
                  <Link className={`btn ${toReview && !toTranslate ? 'primary' : ''}`} to={`/p/${project.id}/${pr.locale}/review`}>
                    Review ({toReview})
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdminHome({ projects, onCreated }: { projects: Project[]; onCreated: () => void }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', sourceLocale: 'en', locales: 'es, fr' });
  const [error, setError] = useState('');

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ project: Project }>('/api/v1/projects', {
        body: { name: form.name, sourceLocale: form.sourceLocale.trim(), locales: form.locales.split(/[\s,]+/).filter(Boolean) },
      });
      onCreated();
      navigate(`/p/${r.project.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <GradingBanner />
      <div className="row">
        <h1 style={{ margin: 0 }}>Projects</h1>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(!creating)}>
          New project
        </button>
      </div>
      {creating && (
        <form className="card row" onSubmit={create} style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 2 }}>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Lobby check-in tablet" required autoFocus />
          </label>
          <label className="field" style={{ width: 110 }}>
            Source language
            <input value={form.sourceLocale} onChange={(e) => setForm({ ...form, sourceLocale: e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Target languages
            <input value={form.locales} onChange={(e) => setForm({ ...form, locales: e.target.value })} placeholder="es, fr, ja" />
          </label>
          <button className="primary">Create</button>
          {error && <div className="alert error" style={{ width: '100%' }}>{error}</div>}
        </form>
      )}
      <div className="grid-cards">
        {projects.map((p) => (
          <Link key={p.id} to={`/p/${p.id}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="row">
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <span className="spacer" />
              <span className="badge">{p.version ? `v${p.version}` : 'unpublished'}</span>
            </div>
            <div className="small muted">{p.progress[0]?.total ?? 0} strings · source {languageName(p.sourceLocale)}</div>
            {p.progress.map((pr) => (
              <div key={pr.locale} className="row small" style={{ flexWrap: 'nowrap' }}>
                <span style={{ width: 90 }}>{languageName(pr.locale)}</span>
                <div style={{ flex: 1 }}>
                  <ProgressBar p={pr} />
                </div>
                <span className="muted" style={{ width: 40, textAlign: 'right' }}>
                  {pr.total ? Math.round((pr.approved / pr.total) * 100) : 0}%
                </span>
              </div>
            ))}
          </Link>
        ))}
      </div>
    </div>
  );
}
