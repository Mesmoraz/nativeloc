import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type JoinLink, type Project, type Tier, type User } from '../api';
import type { OrgVolunteer, ThanksStatus } from '../contracts';
import { languageName, nativeLanguageName } from '../types';

export function Team({ project }: { project: Project }) {
  const [users, setUsers] = useState<User[]>([]);
  const [invite, setInvite] = useState({ role: 'localizer', locales: project.locales[0] ?? '' });
  const [link, setLink] = useState('');

  const load = () => api<{ users: User[] }>('/api/v1/users').then((r) => setUsers(r.users));
  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await api<{ path: string }>('/api/v1/invites', { body: { role: invite.role, locales: invite.locales.split(/[\s,]+/).filter(Boolean) } });
    setLink(location.origin + r.path);
  }

  async function update(u: User, patch: Partial<User>) {
    await api(`/api/v1/users/${u.id}`, { method: 'PATCH', body: patch });
    await load();
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <ThankVolunteers project={project} />
      <HelpedVolunteers project={project} />
      <VolunteerLinks project={project} />

      <form className="card stack" onSubmit={create}>
        <h2 style={{ margin: 0 }}>Invite a native speaker</h2>
        <p className="small muted" style={{ margin: 0 }}>
          They get a link, choose a password, and land straight in their language's queue. No setup or file handling on their side.
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            Role
            <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="localizer">Localizer (translates)</option>
              <option value="reviewer">Reviewer (translates + approves)</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            Languages
            <input value={invite.locales} onChange={(e) => setInvite({ ...invite, locales: e.target.value })} placeholder="es, fr" />
          </label>
          <button className="primary">Create invite link</button>
        </div>
        {link && (
          <div className="alert ok row">
            <code style={{ flex: 1, wordBreak: 'break-all' }}>{link}</code>
            <button type="button" onClick={() => void navigator.clipboard.writeText(link)}>
              Copy
            </button>
          </div>
        )}
      </form>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Languages</th>
              <th>Trust</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name}
                  <div className="small muted">{u.email}</div>
                </td>
                <td>
                  <select value={u.role ?? ''} onChange={(e) => void update(u, { role: e.target.value as User['role'] })}>
                    <option value="localizer">Localizer</option>
                    <option value="reviewer">Reviewer</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td>
                  {u.role === 'admin' ? (
                    <span className="muted small">all</span>
                  ) : (
                    <input defaultValue={u.locales.join(', ')} onBlur={(e) => void update(u, { locales: e.target.value.split(/[\s,]+/).filter(Boolean) })} />
                  )}
                </td>
                <td>
                  {u.role === 'localizer' ? (
                    <div className="stack" style={{ gap: 4 }}>
                      {u.locales.map((l) => (
                        <label key={l} className="row small" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <span style={{ width: 70 }}>{languageName(l)}</span>
                          <select value={u.tiers[l] ?? 'trusted'} onChange={(e) => void update(u, { tiers: { [l]: e.target.value as Tier } })}>
                            <option value="new">New (translates)</option>
                            <option value="trusted">Trusted (approvals count)</option>
                            <option value="lead">Lead (approves outright)</option>
                          </select>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <span className="muted small">{u.role === 'admin' ? 'everything' : 'approves outright'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PlacementContent project={project} />
    </div>
  );
}

interface PlacementItem {
  id: number;
  kind: 'translate' | 'review';
  source: string;
  reference: string | null;
  candidate: string | null;
  hasError: boolean;
  errorNote: string | null;
}

/**
 * The questions in each language's placement check. "Spot the problem" items grade themselves;
 * translation items are compared with the reference by a reviewer or lead.
 */
function PlacementContent({ project }: { project: Project }) {
  const [locale, setLocale] = useState(project.locales[0] ?? '');
  const [items, setItems] = useState<PlacementItem[]>([]);
  const empty = { kind: 'review' as PlacementItem['kind'], source: '', reference: '', candidate: '', hasError: false, errorNote: '' };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (locale) void api<{ items: PlacementItem[] }>(`/api/v1/placement-items?locale=${locale}`).then((r) => setItems(r.items));
  }, [locale]);
  useEffect(load, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/v1/placement-items', { body: { ...form, locale } });
      setForm({ ...empty, kind: form.kind });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function remove(id: number) {
    await api(`/api/v1/placement-items/${id}`, { method: 'DELETE' });
    load();
  }

  const review = items.filter((i) => i.kind === 'review');
  const translate = items.filter((i) => i.kind === 'translate');
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>Placement check</h2>
        <span className="spacer" />
        <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label="Language">
          {project.locales.map((l) => (
            <option key={l} value={l}>
              {languageName(l)}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Volunteers who join from a sign-up link take this check before their reviews count. Each attempt draws up to 8 spot-the-problem items, which grade
        themselves, and up to 5 sentences to translate, which a reviewer or lead grades against your reference. Passing takes 80% on both. Plant real
        mistakes: a wrong number or day, a dropped “not”, a changed eligibility rule.
      </p>
      <div className="small">
        <b>{review.length}</b> spot-the-problem items ({review.filter((i) => i.hasError).length} with a planted problem) · <b>{translate.length}</b> sentences to
        translate
      </div>
      {items.map((i) => (
        <div key={i.id} className="row small" style={{ alignItems: 'flex-start', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <span className="badge">{i.kind === 'review' ? (i.hasError ? 'problem planted' : 'correct') : 'translate'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{i.source}</div>
            <div className="muted" lang={locale}>
              {i.kind === 'review' ? i.candidate : `Reference: ${i.reference}`}
            </div>
            {i.errorNote && <div className="muted">Problem: {i.errorNote}</div>}
          </div>
          <button type="button" className="ghost" onClick={() => void remove(i.id)}>
            Remove
          </button>
        </div>
      ))}
      <form className="stack" onSubmit={add} style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="row">
          <label className="field">
            Type
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PlacementItem['kind'] })}>
              <option value="review">Spot the problem</option>
              <option value="translate">Translate</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            English
            <input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="e.g. You can visit once a week." />
          </label>
        </div>
        {form.kind === 'translate' ? (
          <label className="field">
            Reference translation (what a good answer looks like)
            <input lang={locale} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </label>
        ) : (
          <>
            <label className="field">
              Translation volunteers will judge
              <input lang={locale} value={form.candidate} onChange={(e) => setForm({ ...form, candidate: e.target.value })} />
            </label>
            <label className="row small">
              <input type="checkbox" checked={form.hasError} onChange={(e) => setForm({ ...form, hasError: e.target.checked })} />
              This translation has a planted problem
            </label>
            {form.hasError && (
              <label className="field">
                What the problem is (graders see this; volunteers never do)
                <input value={form.errorNote} onChange={(e) => setForm({ ...form, errorNote: e.target.value })} placeholder="e.g. “week” became “month”" />
              </label>
            )}
          </>
        )}
        {error && <div className="alert error">{error}</div>}
        <div>
          <button className="primary">Add to {languageName(locale)} check</button>
        </div>
      </form>
    </div>
  );
}

/** Reusable sign-up links: share one in a community group, newsletter or flyer and volunteers join themselves. */
function VolunteerLinks({ project }: { project: Project }) {
  const [links, setLinks] = useState<JoinLink[]>([]);
  const [picked, setPicked] = useState<string[]>(project.locales);
  const [copied, setCopied] = useState('');

  const load = () => api<{ links: JoinLink[] }>('/api/v1/join-links').then((r) => setLinks(r.links));
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    await api('/api/v1/join-links', { body: { locales: picked } });
    await load();
  }
  async function disable(code: string) {
    await api(`/api/v1/join-links/${code}`, { method: 'DELETE' });
    await load();
  }
  function copy(url: string) {
    void navigator.clipboard.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Volunteer sign-up link</h2>
      <p className="small muted" style={{ margin: 0 }}>
        One link for everyone. Volunteers pick their language, create an account and start translating straight away.
        {project.peerApprovals > 0
          ? ` Their work goes live once ${project.peerApprovals} other volunteer${project.peerApprovals === 1 ? '' : 's'} approve it.`
          : ' Turn on peer review in Overview so volunteers can approve each other’s work.'}
      </p>
      <div className="row small">
        {project.locales.map((l) => (
          <label key={l} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={picked.includes(l)} onChange={() => setPicked((p) => (p.includes(l) ? p.filter((x) => x !== l) : [...p, l]))} />
            {languageName(l)}
          </label>
        ))}
        <span className="spacer" />
        <button className="primary" onClick={() => void create()} disabled={!picked.length}>
          Create sign-up link
        </button>
      </div>
      {links.map((l) => {
        const url = location.origin + l.path;
        return (
          <div key={l.code} className="alert ok row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <code style={{ wordBreak: 'break-all' }}>{url}</code>
              <div className="small">{l.locales.map(nativeLanguageName).join(' · ')}</div>
            </div>
            <button type="button" onClick={() => copy(url)}>
              {copied === url ? 'Copied ✓' : 'Copy'}
            </button>
            <button type="button" className="ghost" onClick={() => void disable(l.code)}>
              Turn off
            </button>
          </div>
        );
      })}
    </div>
  );
}

const shortDate = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Volunteers who've done accepted work for the org (docs/segment-3d-org-features.md). ⭐ Favorite: they get the org's
 * cards first. Approved Reviewer: on community-reviewed projects, their approval publishes without your click.
 */
function HelpedVolunteers({ project }: { project: Project }) {
  const [list, setList] = useState<OrgVolunteer[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ volunteers: OrgVolunteer[] }>('/api/v1/org/volunteers').then((r) => setList(r.volunteers), (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function set(v: OrgVolunteer, patch: Partial<Pick<OrgVolunteer, 'favorite' | 'approvedReviewer'>>) {
    try {
      const updated = await api<OrgVolunteer>(`/api/v1/org/volunteers/${v.id}`, { method: 'PUT', body: patch });
      setList((l) => l && l.map((x) => (x.id === v.id ? updated : x)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Volunteers who’ve helped you</h2>
      <p className="small muted" style={{ margin: 0 }}>
        <b>⭐ Favorite:</b> they see your work first. <b>Approved Reviewer:</b> on community-reviewed projects, text they approve is published without
        waiting for you, and they can publish what’s on your Ready list. It only counts in languages where they’re Trusted.
      </p>
      {error && <div className="alert error">{error}</div>}
      {list && !list.length && <p className="muted" style={{ margin: 0 }}>Nobody yet. Volunteers show up here once their work on your projects is approved.</p>}
      {list && list.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>Volunteer</th>
              <th>Approved work</th>
              <th>Last active</th>
              <th>Favorite</th>
              <th>Approved Reviewer</th>
            </tr>
          </thead>
          <tbody>
            {list.map((v) => {
              const trustedIn = project.locales.filter((l) => v.tiers[l] === 'trusted' || v.tiers[l] === 'lead');
              return (
                <tr key={v.id}>
                  <td>
                    {v.name}
                    <div className="small muted">{v.locales.map((l) => nativeLanguageName(l)).join(', ')}</div>
                  </td>
                  <td>{v.accepted}</td>
                  <td>{shortDate(v.lastActive)}</td>
                  <td>
                    <input type="checkbox" checked={v.favorite} onChange={(e) => void set(v, { favorite: e.target.checked })} aria-label={`Favorite: ${v.name}`} />
                  </td>
                  <td>
                    <label className="row" style={{ gap: 6 }}>
                      <input type="checkbox" checked={v.approvedReviewer} onChange={(e) => void set(v, { approvedReviewer: e.target.checked })} aria-label={`Approved Reviewer: ${v.name}`} />
                      {v.approvedReviewer && !trustedIn.length && <span className="small muted">Not Trusted in this project’s languages yet</span>}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** One note to everyone with approved work on this project since the last one. At most once a day. */
function ThankVolunteers({ project }: { project: Project }) {
  const [status, setStatus] = useState<ThanksStatus | null>(null);
  const [body, setBody] = useState(`Thank you! Thanks to you, ${project.name} can now be read in more languages.`);
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<ThanksStatus>(`/api/v1/projects/${project.id}/thanks`).then(setStatus, () => setStatus(null));
  }, [project.id]);
  useEffect(load, [load]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ recipients: number }>(`/api/v1/projects/${project.id}/thanks`, { body: { body } });
      setSent(r.recipients);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send. Try again.');
    }
  }

  if (!status) return null;
  const blocked = status.nextAllowedAt ? `You can send the next one after ${new Date(`${status.nextAllowedAt.replace(' ', 'T')}Z`).toLocaleString()}.` : !status.recipients ? 'Nobody new has worked on this project since your last thank-you.' : '';
  return (
    <form className="card stack" onSubmit={send}>
      <h2 style={{ margin: 0 }}>Thank your volunteers</h2>
      <p className="small muted" style={{ margin: 0 }}>
        One note to everyone whose work on this project was approved since your last thank-you. They see it in the volunteer app.
      </p>
      <textarea rows={3} maxLength={280} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Thank-you note" />
      <div className="row" style={{ alignItems: 'center' }}>
        <span className="small muted">{body.trim().length}/280</span>
        <span className="spacer" />
        {sent !== null && <span className="small">Sent to {sent} volunteer{sent === 1 ? '' : 's'} ✓</span>}
        <button className="btn primary" type="submit" disabled={!!blocked || !body.trim()}>
          Send to {status.recipients} volunteer{status.recipients === 1 ? '' : 's'}
        </button>
      </div>
      {blocked && <p className="small muted" style={{ margin: 0 }}>{blocked}</p>}
      {error && <div className="alert error">{error}</div>}
    </form>
  );
}
