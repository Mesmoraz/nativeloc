import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar } from '../App';
import { api } from '../api';
import type { EngagementResponse, ModerationDecision, ProjectPriority, ModerationQueueResponse, OrgType, VerificationDecision, VerificationQueueResponse } from '../contracts';
import './staff.css';

const TYPE_LABEL: Record<OrgType, string> = { nonprofit: 'Nonprofit', individual: 'Individual', small_org: 'Community group', business: 'Business' };

/** NativeLoc staff: verify nonprofits, moderate public projects, and watch volunteer return rates. Server enforces users.is_staff. */
export function StaffConsole() {
  const [tab, setTab] = useState<'verifications' | 'moderation' | 'returns'>('moderation');
  const [verifications, setVerifications] = useState<VerificationQueueResponse['orgs'] | null>(null);
  const [projects, setProjects] = useState<ModerationQueueResponse['projects'] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [v, m] = await Promise.all([api<VerificationQueueResponse>('/api/v1/staff/verifications'), api<ModerationQueueResponse>('/api/v1/staff/moderation')]);
      setVerifications(v.orgs);
      setProjects(m.projects);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <TopBar>
        <div style={{ fontWeight: 600, flex: 1 }}>Staff console</div>
        <Link to="/" className="btn ghost">
          Exit
        </Link>
      </TopBar>
      <main className="page staff">
        <nav className="tabs">
          <button className={tab === 'moderation' ? 'active' : ''} onClick={() => setTab('moderation')}>
            Projects{projects ? ` (${projects.length})` : ''}
          </button>
          <button className={tab === 'verifications' ? 'active' : ''} onClick={() => setTab('verifications')}>
            Nonprofits{verifications ? ` (${verifications.length})` : ''}
          </button>
          <button className={tab === 'returns' ? 'active' : ''} onClick={() => setTab('returns')}>
            Return rates
          </button>
        </nav>
        {error && <div className="alert error">{error}</div>}
        {tab === 'moderation' && projects && (
          <div className="stack" style={{ gap: 16 }}>
            {!projects.length && <div className="card muted">Nothing waiting for moderation.</div>}
            {projects.map((p) => (
              <ProjectCard key={p.project.id} item={p} onDone={load} />
            ))}
          </div>
        )}
        {tab === 'verifications' && verifications && (
          <div className="stack" style={{ gap: 16 }}>
            {!verifications.length && <div className="card muted">No nonprofits waiting for verification.</div>}
            {verifications.map((v) => (
              <OrgCard key={v.org.id} item={v} onDone={load} />
            ))}
          </div>
        )}
        {tab === 'returns' && <ReturnRates />}
      </main>
    </>
  );
}

function ProjectCard({ item, onDone }: { item: ModerationQueueResponse['projects'][number]; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const { project, org } = item;
  const [priority, setPriority] = useState<ProjectPriority>(project.priority);

  async function setProjectPriority(next: ProjectPriority) {
    setError('');
    try {
      await api(`/api/v1/staff/projects/${project.id}/priority`, { method: 'PUT', body: { priority: next } });
      setPriority(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function decide(body: ModerationDecision) {
    setError('');
    try {
      await api(`/api/v1/staff/moderation/${project.id}`, { body });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <div>
          <h2 style={{ margin: 0 }}>{project.name}</h2>
          <div className="small muted">
            {org.name} · {TYPE_LABEL[org.type]}
            {org.verification === 'verified' ? ' · verified' : ''} · {project.strings} strings
            {project.submittedAt ? ` · submitted ${new Date(project.submittedAt + 'Z').toLocaleString()}` : ''}
          </div>
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {item.reasons.map((r) => (
          <span key={r} className="badge outdated">
            {r}
          </span>
        ))}
        {item.reports.map((r) => (
          <span key={r.reason} className="badge outdated">
            {r.count} × reported {r.reason}
          </span>
        ))}
        {!item.reasons.length && !item.reports.length && <span className="badge">No automatic flags</span>}
      </div>
      <ul className="staff-sample">
        {item.sample.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <label className="row small">
        Priority in volunteers' cards
        <select value={priority} onChange={(e) => void setProjectPriority(e.target.value as ProjectPriority)}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </label>
      <input placeholder="Reason (required to reject or ask for changes; the poster sees it)" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <div className="alert error">{error}</div>}
      <div className="row">
        <button className="primary" onClick={() => void decide({ decision: 'approved' })}>
          Approve
        </button>
        <button disabled={!reason.trim()} onClick={() => void decide({ decision: 'changes', reason })}>
          Ask for changes
        </button>
        <button disabled={!reason.trim()} onClick={() => void decide({ decision: 'rejected', reason })}>
          Reject
        </button>
      </div>
    </div>
  );
}

function OrgCard({ item, onDone }: { item: VerificationQueueResponse['orgs'][number]; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const { org, match, admins } = item;

  async function decide(decision: VerificationDecision['decision']) {
    setError('');
    try {
      await api(`/api/v1/staff/verifications/${org.id}`, { body: { decision, note: note.trim() || undefined } satisfies VerificationDecision });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>{org.name}</h2>
        <div className="small muted">
          EIN {org.ein ?? 'not given'}
          {org.website ? ` · ${org.website}` : ''} · {admins.map((a) => `${a.name} <${a.email}>`).join(', ') || 'no admins'}
        </div>
      </div>
      {org.description && <div>{org.description}</div>}
      {(item as { reason?: string }).reason && <div className="small muted">Why not automatic: {(item as { reason?: string }).reason}</div>}
      <div className="small">
        {match ? (
          <>
            IRS record: <strong>{match.name}</strong>, {match.city}, {match.state}
          </>
        ) : (
          <span className="muted">No IRS record found for this EIN.</span>
        )}
      </div>
      <input placeholder="Note (optional)" aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <div className="alert error">{error}</div>}
      <div className="row">
        <button className="primary" onClick={() => void decide('verified')}>
          Verify
        </button>
        <button onClick={() => void decide('rejected')}>Reject</button>
      </div>
    </div>
  );
}

const weekOf = (start: string) => new Date(`${start}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Segment 3's "done when": of the volunteers active in a week, how many came back the next week. */
function ReturnRates() {
  const [weeks, setWeeks] = useState<EngagementResponse['weeks'] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<EngagementResponse>('/api/v1/staff/engagement').then(
      (r) => setWeeks(r.weeks),
      (e: Error) => setError(e.message),
    );
  }, []);
  if (error) return <div className="alert error">{error}</div>;
  if (!weeks) return null;
  return (
    <div className="card">
      <table className="list">
        <thead>
          <tr>
            <th>Week of</th>
            <th>Active volunteers</th>
            <th>Came back next week</th>
            <th>Return rate</th>
          </tr>
        </thead>
        <tbody>
          {[...weeks].reverse().map((w) => (
            <tr key={w.start}>
              <td>{weekOf(w.start)}</td>
              <td>{w.active}</td>
              <td>{w.returned}</td>
              <td>
                {w.active ? `${Math.round((w.returned / w.active) * 100)}%` : '—'}
                {!w.complete && <span className="muted"> so far</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Counts volunteers, not names. Activity as an org admin or reviewer is left out. Weeks start on Monday, in each volunteer&apos;s own time zone.
      </p>
    </div>
  );
}
