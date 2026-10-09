import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TopBar } from '../App';
import { api, type JoinLink, type Project, type Tier, type User } from '../api';
import { ChipText, ProgressBar, StatusBadge } from '../components';
import { languageName, nativeLanguageName } from '../types';
import { Screenshots } from './Screenshots';

type Tab = 'overview' | 'strings' | 'import' | 'screens' | 'team' | 'questions' | 'devices';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['strings', 'Strings'],
  ['import', 'Import & export'],
  ['screens', 'Screenshots'],
  ['team', 'Team'],
  ['questions', 'Questions'],
  ['devices', 'Devices & API'],
];

export interface Manifest {
  version: number;
  publishedAt: string;
  locales: Record<string, { sha256: string; url: string; completeness: number }>;
}

export function ProjectAdmin() {
  const { projectId = '' } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'overview');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ project: Project; manifest: Manifest | null }>(`/api/v1/projects/${projectId}`);
      setProject(r.project);
      setManifest(r.manifest);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const pick = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };

  return (
    <>
      <TopBar />
      <main className="page">
        {error && <div className="alert error">{error}</div>}
        {project && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <Link to="/" className="muted small">
                ← Projects
              </Link>
            </div>
            <h1>{project.name}</h1>
            <nav className="tabs">
              {TABS.map(([id, label]) => (
                <button key={id} className={tab === id ? 'active' : ''} onClick={() => pick(id)}>
                  {label}
                </button>
              ))}
            </nav>
            {tab === 'overview' && <Overview project={project} manifest={manifest} reload={load} />}
            {tab === 'strings' && <Strings project={project} />}
            {tab === 'import' && <ImportExport project={project} reload={load} />}
            {tab === 'screens' && <Screenshots projectId={project.id} />}
            {tab === 'team' && <Team project={project} />}
            {tab === 'questions' && <Questions projectId={project.id} />}
            {tab === 'devices' && <Devices project={project} manifest={manifest} reload={load} />}
          </>
        )}
      </main>
    </>
  );
}

function Overview({ project, manifest, reload }: { project: Project; manifest: Manifest | null; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [locales, setLocales] = useState(project.locales.join(', '));

  async function publish() {
    setBusy(true);
    try {
      const r = await api<{ manifest: Manifest }>(`/api/v1/projects/${project.id}/publish`, { method: 'POST' });
      setMsg(`Published version ${r.manifest.version}. Devices will pick it up on their next check.`);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(patch: Record<string, unknown>) {
    await api(`/api/v1/projects/${project.id}`, { method: 'PATCH', body: patch });
    await reload();
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>Languages</h2>
          <span className="spacer" />
          <span className="small muted">
            {project.progress[0]?.total ?? 0} strings · source: {languageName(project.sourceLocale)}
          </span>
        </div>
        <table className="list">
          <thead>
            <tr>
              <th>Language</th>
              <th style={{ width: '40%' }}>Progress</th>
              <th>Done</th>
              <th>In review</th>
              <th>To do</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {project.progress.map((p) => (
              <tr key={p.locale}>
                <td>
                  {languageName(p.locale)} <span className="muted small">{p.locale}</span>
                </td>
                <td style={{ verticalAlign: 'middle' }}>
                  <ProgressBar p={p} />
                </td>
                <td>{p.approved}</td>
                <td>{p.review}</td>
                <td>{p.todo + p.outdated}</td>
                <td className="row" style={{ gap: 6 }}>
                  <Link className="btn small" to={`/p/${project.id}/${p.locale}/translate`}>
                    Translate
                  </Link>
                  <Link className="btn small" to={`/p/${project.id}/${p.locale}/review`}>
                    Review
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void saveSettings({ locales: locales.split(/[\s,]+/).filter(Boolean) });
          }}
        >
          <label className="field" style={{ flex: 1 }}>
            Target languages (codes like es, fr-CA, ja)
            <input value={locales} onChange={(e) => setLocales(e.target.value)} />
          </label>
          <button style={{ alignSelf: 'flex-end' }}>Update languages</button>
        </form>
        <label className="row small">
          <input type="checkbox" checked={project.requireReview} onChange={(e) => void saveSettings({ requireReview: e.target.checked })} />
          Translations by localizers need a reviewer's approval before they ship
        </label>
        <label className="row small">
          Peer review:
          <select value={project.peerApprovals} onChange={(e) => void saveSettings({ peerApprovals: Number(e.target.value) })} disabled={!project.requireReview}>
            <option value={0}>Off (only reviewers approve)</option>
            <option value={1}>1 other volunteer approves</option>
            <option value={2}>2 other volunteers approve</option>
            <option value={3}>3 other volunteers approve</option>
          </select>
          <span className="muted">Localizers check each other's work; reviewers can still approve directly.</span>
        </label>
      </div>

      <WebsitePreview project={project} saveSettings={saveSettings} reload={reload} />

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Publish to devices</h2>
        <p className="muted" style={{ margin: 0 }}>
          Publishing snapshots every approved translation. Untranslated text falls back to {languageName(project.sourceLocale)}.
          {manifest ? ` Live now: version ${manifest.version}, published ${new Date(manifest.publishedAt).toLocaleString()}.` : ' Nothing published yet.'}
        </p>
        <div className="row">
          <button className="primary" onClick={() => void publish()} disabled={busy}>
            Publish version {project.version + 1}
          </button>
          {msg && <span className="small">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

interface KeyRowJson {
  id: number;
  name: string;
  displayName: string;
  source: string;
  description: string | null;
  maxLength: number | null;
  screenshots: number;
  translation: { text: string; status: string } | null;
}

function Strings({ project }: { project: Project }) {
  const [q, setQ] = useState('');
  const [locale, setLocale] = useState(project.locales[0] ?? '');
  const [keys, setKeys] = useState<KeyRowJson[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ keys: KeyRowJson[] }>(`/api/v1/projects/${project.id}/keys?${new URLSearchParams({ q, locale })}`).then((r) => setKeys(r.keys));
    }, 200);
    return () => clearTimeout(t);
  }, [q, locale, project.id]);

  async function patch(id: number, body: Record<string, unknown>) {
    await api(`/api/v1/keys/${id}`, { method: 'PATCH', body });
  }

  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Search text or ID…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <select value={locale} onChange={(e) => setLocale(e.target.value)}>
          {project.locales.map((l) => (
            <option key={l} value={l}>
              {languageName(l)}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        The note and character limit are what localizers see next to each string. Good notes are the biggest quality win.
      </p>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="list">
          <thead>
            <tr>
              <th>Original</th>
              <th>{languageName(locale)}</th>
              <th style={{ width: '28%' }}>Note for localizers</th>
              <th style={{ width: 80 }}>Max chars</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>
                  <div>
                    <ChipText text={k.source} placeholders={[]} />
                  </div>
                  <div className="small muted mono">
                    {k.displayName}
                    {k.screenshots ? ' · 📷' : ''}
                  </div>
                </td>
                <td>
                  {k.translation ? <ChipText text={k.translation.text} placeholders={[]} /> : <span className="muted">—</span>}
                  <div>
                    <StatusBadge status={k.translation?.status} />
                  </div>
                </td>
                <td>
                  <textarea rows={2} defaultValue={k.description ?? ''} style={{ width: '100%' }} onBlur={(e) => e.target.value !== (k.description ?? '') && void patch(k.id, { description: e.target.value })} placeholder="Where is it shown? Button or title?" />
                </td>
                <td>
                  <input type="number" min={1} defaultValue={k.maxLength ?? ''} style={{ width: 70 }} onBlur={(e) => void patch(k.id, { maxLength: e.target.value ? Number(e.target.value) : null })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImportExport({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState('');
  const [format, setFormat] = useState('');
  const [locale, setLocale] = useState('');
  const [exp, setExp] = useState({ format: 'android-xml', locale: project.locales[0] ?? project.sourceLocale });

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setResult('');
    const form = new FormData(e.currentTarget);
    try {
      const r = await api<{ entries: number; created: number; updated: number; unchanged: number; translations: number; skipped: string[] }>(`/api/v1/projects/${project.id}/import`, { form });
      setResult(
        `Read ${r.entries} strings: ${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged` +
          (r.translations ? `, ${r.translations} translations imported` : '') +
          (r.skipped.length ? `. Skipped ${r.skipped.length} unknown IDs.` : '.'),
      );
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <form className="card stack" onSubmit={upload}>
        <h2 style={{ margin: 0 }}>Upload strings</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Android <code>strings.xml</code>, gettext <code>.po/.pot</code> or JSON. Comments become notes for localizers; write <code>max=20</code> in a comment to set a character limit.
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 2 }}>
            File
            <input type="file" name="file" required accept=".xml,.po,.pot,.json" />
          </label>
          <label className="field">
            Format
            <select name="format" value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="">Detect from name</option>
              <option value="android-xml">Android XML</option>
              <option value="po">gettext .po</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label className="field">
            This file is
            <select name="locale" value={locale} onChange={(e) => setLocale(e.target.value)}>
              <option value="">the original ({languageName(project.sourceLocale)})</option>
              {project.locales.map((l) => (
                <option key={l} value={l}>
                  existing {languageName(l)} translations
                </option>
              ))}
            </select>
          </label>
          <button className="primary">Upload</button>
        </div>
        {result && <div className="alert ok">{result}</div>}
        {error && <div className="alert error">{error}</div>}
      </form>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Download</h2>
        <p className="muted small" style={{ margin: 0 }}>
          For builds that ship translations inside the app (offline fallback). Only approved translations are included.
        </p>
        <div className="row">
          <select value={exp.format} onChange={(e) => setExp({ ...exp, format: e.target.value })}>
            <option value="android-xml">Android XML</option>
            <option value="po">gettext .po</option>
            <option value="json">JSON (flat)</option>
            <option value="json-nested">JSON (nested)</option>
          </select>
          <select value={exp.locale} onChange={(e) => setExp({ ...exp, locale: e.target.value })}>
            {[project.sourceLocale, ...project.locales].map((l) => (
              <option key={l} value={l}>
                {languageName(l)}
              </option>
            ))}
          </select>
          <a className="btn" href={`/api/v1/projects/${project.id}/export?${new URLSearchParams(exp)}`}>
            Download
          </a>
        </div>
      </div>
    </div>
  );
}

function Team({ project }: { project: Project }) {
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
                  <select value={u.role} onChange={(e) => void update(u, { role: e.target.value as User['role'] })}>
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

interface Question {
  id: number;
  locale: string;
  text: string;
  answer: string | null;
  user: string;
  key: string;
  source: string;
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

function Questions({ projectId }: { projectId: number }) {
  const [qs, setQs] = useState<Question[]>([]);
  const load = () => api<{ questions: Question[] }>(`/api/v1/projects/${projectId}/questions`).then((r) => setQs(r.questions));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function answer(e: React.FormEvent<HTMLFormElement>, id: number) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api(`/api/v1/questions/${id}/answer`, { body: { answer: f.get('answer'), description: f.get('note') === 'on' } });
    await load();
  }

  if (!qs.length) return <div className="card muted">No questions from localizers yet.</div>;
  return (
    <div className="stack">
      {qs.map((q) => (
        <div key={q.id} className="card stack">
          <div className="small muted">
            {q.user} · {languageName(q.locale)} · “{q.source}”
          </div>
          <div>{q.text}</div>
          {q.answer ? (
            <div className="alert ok">{q.answer}</div>
          ) : (
            <form className="row" onSubmit={(e) => void answer(e, q.id)}>
              <input name="answer" placeholder="Your answer" style={{ flex: 1 }} required />
              <label className="row small">
                <input type="checkbox" name="note" defaultChecked /> also add to the string's note
              </label>
              <button className="primary">Answer</button>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}

interface Token {
  id: number;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
}

function WebsitePreview({ project, saveSettings, reload }: { project: Project; saveSettings: (patch: Record<string, unknown>) => Promise<void>; reload: () => Promise<void> }) {
  const [site, setSite] = useState(project.siteUrl ?? '');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const base = project.previewToken ? `${location.origin}/preview/${project.previewToken}` : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await saveSettings({ siteUrl: site });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rotate() {
    if (!confirm('The current preview links will stop working, and new ones will replace them. Continue?')) return;
    await api(`/api/v1/projects/${project.id}/rotate-preview-token`, { method: 'POST' });
    await reload();
  }

  function copy(url: string) {
    void navigator.clipboard.writeText(url);
    setCopied(url);
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Website preview</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Shows the organization's live website with the translations approved so far, before anything is published. Text that isn't translated yet stays in{' '}
        {languageName(project.sourceLocale)}. The link is private: search engines never index it, and only people you send it to can open it.
      </p>
      <form className="row" onSubmit={(e) => void save(e)}>
        <label className="field" style={{ flex: 1 }}>
          Website address
          <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://example.org" inputMode="url" />
        </label>
        <button style={{ alignSelf: 'flex-end' }}>Save</button>
      </form>
      {error && <p className="small" style={{ margin: 0, color: 'var(--danger, #b91c1c)' }}>{error}</p>}
      {project.siteUrl && base && (
        <>
          <table className="list">
            <tbody>
              {project.locales.map((l) => {
                const url = `${base}/${l}/`;
                return (
                  <tr key={l}>
                    <td>
                      {nativeLanguageName(l)}
                      {nativeLanguageName(l) !== languageName(l) && <span className="muted small"> {languageName(l)}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <a href={url} target="_blank" rel="noreferrer">
                        Open preview
                      </a>{' '}
                      <button type="button" onClick={() => copy(url)}>
                        {copied === url ? 'Copied' : 'Copy link'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row small">
            <span className="muted">
              All languages: <a href={`${base}/`} target="_blank" rel="noreferrer">{`${base}/`}</a>
            </span>
            <span className="spacer" />
            <button className="danger" type="button" onClick={() => void rotate()}>
              Replace links
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Devices({ project, manifest, reload }: { project: Project; manifest: Manifest | null; reload: () => Promise<void> }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [fresh, setFresh] = useState('');
  const base = `${location.origin}/b/${project.bundleToken}`;
  const load = () => api<{ tokens: Token[] }>(`/api/v1/projects/${project.id}/tokens`).then((r) => setTokens(r.tokens));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await api<{ token: string }>(`/api/v1/projects/${project.id}/tokens`, { body: { name: f.get('name'), scopes: [f.get('scope')] } });
    setFresh(r.token);
    await load();
  }

  async function rotate() {
    if (!confirm('Devices using the current link will stop receiving updates until reconfigured. Continue?')) return;
    await api(`/api/v1/projects/${project.id}/rotate-bundle-token`, { method: 'POST' });
    await reload();
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Device endpoint</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Android and Linux devices poll this URL (it is cache-friendly and returns 304 when nothing changed). Any device that can fetch JSON works; the SDKs add caching and offline fallback.
        </p>
        <code style={{ wordBreak: 'break-all' }}>{base}/manifest.json</code>
        {manifest && (
          <div className="small">
            Bundles:{' '}
            {Object.entries(manifest.locales).map(([l, v]) => (
              <a key={l} href={v.url} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                {l}.json ({Math.round(v.completeness * 100)}%)
              </a>
            ))}
          </div>
        )}
        <pre className="card mono small" style={{ margin: 0, overflowX: 'auto', boxShadow: 'none' }}>{`// Android (Kotlin)
NativeLoc.init(context, "${location.origin}", "${project.bundleToken}", locale = "es")
textView.text = NativeLoc.t("welcome_title")

# Linux (Python)
loc = NativeLoc("${location.origin}", "${project.bundleToken}", locale="es")
print(loc.t("cart_items", count=3))`}</pre>
        <div>
          <button className="danger" onClick={() => void rotate()}>
            Rotate device link
          </button>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>API tokens (CLI, CI, REST)</h2>
        <form className="row" onSubmit={create}>
          <input name="name" placeholder="e.g. GitHub Actions" required style={{ flex: 1 }} />
          <select name="scope">
            <option value="push">push (upload strings, screenshots, publish)</option>
            <option value="read">read (download files)</option>
          </select>
          <button className="primary">Create token</button>
        </form>
        {fresh && (
          <div className="alert ok stack" style={{ gap: 6 }}>
            <div>Copy this token now; it will not be shown again.</div>
            <code style={{ wordBreak: 'break-all' }}>{fresh}</code>
            <code className="small">NATIVELOC_TOKEN={fresh.slice(0, 6)}… npx nativeloc push</code>
          </div>
        )}
        <table className="list">
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <span className="badge">{t.scopes.join(', ')}</span>
                </td>
                <td className="small muted">{t.last_used_at ? `used ${t.last_used_at}` : 'never used'}</td>
                <td>
                  <button className="ghost danger small" onClick={() => void api(`/api/v1/projects/${project.id}/tokens/${t.id}`, { method: 'DELETE' }).then(load)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
