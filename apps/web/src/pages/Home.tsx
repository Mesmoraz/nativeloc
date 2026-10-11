import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar, useSession } from '../App';
import { api, type Project } from '../api';
import { HomeNotice as CommunityNotice } from '../community/HomeNotice';
import { ProgressBar } from '../components';
import { HomeNotice as SignupNotice } from '../signup/HomeNotice';
import { languageName, nativeLanguageName } from '../types';
import '../volunteer/volunteer.css';

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
        <SignupNotice />
        {isAdmin && <CommunityNotice />}
        {projects && (isAdmin ? <AdminHome projects={projects} /> : <LocalizerHome projects={projects} />)}
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
      {work.length > 0 && (
        <div className="card v-entry">
          <div style={{ flex: 1, minWidth: 200 }}>
            <b>Got 5 minutes?</b>
            <div className="small muted">Translate or check five short strings on your phone. XP counts once others approve your work.</div>
          </div>
          <Link className="btn primary" to="/v">
            Start a 5-minute session
          </Link>
        </div>
      )}
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

function AdminHome({ projects }: { projects: Project[] }) {
  const { session } = useSession();
  // Business accounts are waitlisted (posting/policy.ts on the server).
  const waitlisted = session!.org?.type === 'business';

  return (
    <div className="stack">
      <GradingBanner />
      <div className="row">
        <h1 style={{ margin: 0 }}>Projects</h1>
        <span className="spacer" />
        {!waitlisted && (
          <Link className="btn primary" to="/new">
            New project
          </Link>
        )}
      </div>
      {waitlisted && <div className="card muted">Business accounts are on the waitlist for now. We’ll email you when posting opens for businesses.</div>}
      {!projects.length && !waitlisted && (
        <div className="card">
          <b>Post your first project</b>
          <div className="small muted">Paste text, upload your app’s strings, or give us your website. Native-speaker volunteers translate it.</div>
        </div>
      )}
      <div className="grid-cards">
        {projects.map((p) => (
          <Link key={p.id} to={`/p/${p.id}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="row">
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <span className="spacer" />
              <span className="badge">{p.version ? `v${p.version}` : 'unpublished'}</span>
            </div>
            <div className="small muted">{p.progress[0]?.total ?? 0} strings · source {languageName(p.sourceLocale)}
              {p.visibility === 'public' ? ` · public${p.moderation === 'approved' ? '' : p.moderation === 'none' ? ', not submitted' : `, ${p.moderation}`}` : ''}
            </div>
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
