import { useEffect, useState } from 'react';
import { api, type Project } from '../api';
import type { Moderation, ReviewMode, SubmitResponse, Visibility } from '../contracts';
import './posting.css';

/** 2B's GET /api/v1/projects/:id/moderation: why a project is held or was sent back. */
interface ModerationInfo {
  moderation: Moderation;
  reasons: string[];
  submittedAt: string | null;
  decision: { decision: 'approved' | 'rejected' | 'changes'; reason: string | null; at: string } | null;
}

export const MODERATION_TEXT: Record<Moderation, string> = {
  none: 'Not submitted yet. Volunteers can’t see it.',
  pending: 'Waiting for a NativeLoc staff member to look at it. That usually takes a day or two.',
  approved: 'Live: volunteers who speak your languages are translating it.',
  rejected: 'Sent back. Fix what staff asked for, then submit again.',
};

/** Who sees the project, how it's reviewed, and submitting it for moderation. */
export function Sharing({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [info, setInfo] = useState<ModerationInfo | null>(null);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const strings = project.progress[0]?.total ?? 0;

  useEffect(() => {
    if (project.visibility !== 'public') return setInfo(null);
    api<ModerationInfo>(`/api/v1/projects/${project.id}/moderation`).then(setInfo, () => setInfo(null));
  }, [project.id, project.visibility, project.moderation]);

  async function patch(body: { visibility?: Visibility; reviewMode?: ReviewMode }) {
    setError('');
    setResult(null);
    try {
      await api(`/api/v1/projects/${project.id}`, { method: 'PATCH', body });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit() {
    setError('');
    setBusy(true);
    try {
      setResult(await api<SubmitResponse>(`/api/v1/projects/${project.id}/submit`, { method: 'POST' }));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Who translates it</h2>
        <VisibilityChoice
          value={project.visibility}
          onChange={(v) => {
            if (v === 'private' && project.moderation === 'approved' && !confirm('Volunteers will stop seeing this project. Going public again needs another review. Continue?')) return;
            void patch({ visibility: v });
          }}
        />
        {project.visibility === 'public' && <ReviewModeChoice value={project.reviewMode} onChange={(m) => void patch({ reviewMode: m })} />}
      </section>

      {project.visibility === 'public' && (
        <section className="card stack">
          <div className="row">
            <h2 style={{ margin: 0 }}>Moderation</h2>
            <span className="spacer" />
            <span className={`badge ${project.moderation === 'approved' ? 'approved' : project.moderation === 'rejected' ? 'outdated' : 'review'}`}>{project.moderation === 'none' ? 'not submitted' : project.moderation}</span>
          </div>
          <p style={{ margin: 0 }}>{MODERATION_TEXT[project.moderation]}</p>
          {info?.decision && info.decision.decision !== 'approved' && info.decision.reason && (
            <div className="alert warn">
              <b>{info.decision.decision === 'changes' ? 'Staff asked for changes: ' : 'Staff said: '}</b>
              {info.decision.reason}
            </div>
          )}
          {(result?.reasons.length ? result.reasons : project.moderation === 'pending' ? (info?.reasons ?? []) : []).length > 0 && (
            <div className="small">
              Held for a person to check because of:
              <ul className="post-reasons">
                {(result?.reasons.length ? result.reasons : (info?.reasons ?? [])).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {(project.moderation === 'none' || project.moderation === 'rejected') && (
            <>
              {!strings && <div className="small muted">Add some text first.</div>}
              {!project.locales.length && <div className="small muted">Pick at least one language to translate into.</div>}
              <div className="row">
                <span className="small muted">We check every public project for spam and ads before volunteers see it.</span>
                <span className="spacer" />
                <button className="primary" disabled={busy || !strings || !project.locales.length} onClick={() => void submit()}>
                  {project.moderation === 'rejected' ? 'Submit again' : 'Submit for review'}
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}

export function VisibilityChoice({ value, onChange }: { value: Visibility; onChange: (v: Visibility) => void }) {
  return (
    <fieldset className="post-options">
      <legend className="small">Visibility</legend>
      <button type="button" aria-pressed={value === 'public'} onClick={() => onChange('public')}>
        <b>Public: volunteers translate it</b>
        <span className="small muted">Native speakers from the NativeLoc community help, a few minutes at a time. We check it for spam and ads first.</span>
      </button>
      <button type="button" aria-pressed={value === 'private'} onClick={() => onChange('private')}>
        <b>Private: only your team</b>
        <span className="small muted">People you invite translate it. Nobody else sees it.</span>
      </button>
    </fieldset>
  );
}

export function ReviewModeChoice({ value, onChange, recommended }: { value: ReviewMode; onChange: (m: ReviewMode) => void; recommended?: ReviewMode }) {
  const tag = (m: ReviewMode) => (recommended === m ? ' (recommended)' : '');
  return (
    <fieldset className="post-options">
      <legend className="small">How translations are checked</legend>
      <button type="button" aria-pressed={value === 'community'} onClick={() => onChange('community')}>
        <b>Community review{tag('community')}</b>
        <span className="small muted">3 to 5 volunteers agree on each translation, then you publish it. Labelled “community-reviewed”.</span>
      </button>
      <button type="button" aria-pressed={value === 'standard'} onClick={() => onChange('standard')}>
        <b>Standard review{tag('standard')}</b>
        <span className="small muted">An experienced reviewer approves each translation. Best for verified nonprofits with their own reviewers.</span>
      </button>
    </fieldset>
  );
}
