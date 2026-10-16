import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Project } from '../api';
import { ProgressBar } from '../components';
import { languageName, nativeLanguageName } from '../types';
import type { ManifestQuality } from '../contracts';

export interface Manifest {
  version: number;
  publishedAt: string;
  /** quality/reviewers are missing on releases published before quality labels existed. */
  locales: Record<string, { sha256: string; url: string; completeness: number } & Partial<ManifestQuality>>;
}

/** How devices label a locale's text: "Checked by N native speakers" or "Community-reviewed, not verified". */
export function qualityLabel(q: Partial<ManifestQuality> | undefined): string | null {
  if (!q?.quality) return null;
  if (q.quality === 'community') return 'Community-reviewed, not verified';
  return `Checked by ${q.reviewers ?? 0} native speaker${q.reviewers === 1 ? '' : 's'}`;
}

export function Overview({ project, manifest, reload }: { project: Project; manifest: Manifest | null; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [locales, setLocales] = useState(project.locales.join(', '));

  async function publish() {
    setBusy(true);
    try {
      const r = await api<{ manifest: Manifest }>(`/api/v1/projects/${project.id}/publish`, { method: 'POST' });
      const labels = Object.entries(r.manifest.locales)
        .filter(([l]) => l !== project.sourceLocale)
        .map(([l, q]) => (qualityLabel(q) ? `${languageName(l)}: ${qualityLabel(q)}` : null))
        .filter(Boolean);
      setMsg(`Published version ${r.manifest.version}. ${project.reviewMode === 'community' ? 'It is live now.' : 'Devices will pick it up on their next check.'}${labels.length ? ` ${labels.join(' · ')}.` : ''}`);
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
              {project.reviewMode === 'community' && <th>Ready</th>}
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
                {project.reviewMode === 'community' && <td>{p.ready}</td>}
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
        {project.reviewMode !== 'community' && (
        <label className="row small">
          <input type="checkbox" checked={project.requireReview} onChange={(e) => void saveSettings({ requireReview: e.target.checked })} />
          Translations by localizers need a reviewer's approval before they ship
        </label>
        )}
        {project.reviewMode === 'community' ? (
          <p className="small muted" style={{ margin: 0 }}>
            Community review: volunteers agree on each translation (3 approvals, or 5 after a flag or an edit), then it waits for you under Ready to publish.
          </p>
        ) : (
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
        )}
      </div>

      <WebsitePreview project={project} saveSettings={saveSettings} reload={reload} />

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{project.reviewMode === 'community' ? 'Publish a new version' : 'Publish to devices'}</h2>
        <p className="muted" style={{ margin: 0 }}>
          Publishing snapshots every approved translation. Untranslated text falls back to {languageName(project.sourceLocale)}.
          {manifest ? ` Live now: version ${manifest.version}, published ${new Date(manifest.publishedAt).toLocaleString()}.` : ' Nothing published yet.'}
        </p>
        {manifest && (
          <div className="row quality">
            {Object.entries(manifest.locales)
              .filter(([l]) => l !== project.sourceLocale && qualityLabel(manifest.locales[l]))
              .map(([l, q]) => (
                <span key={l}>
                  {languageName(l)}: {qualityLabel(q)}
                </span>
              ))}
          </div>
        )}
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

function WebsitePreview({ project, saveSettings, reload }: { project: Project; saveSettings: (patch: Record<string, unknown>) => Promise<void>; reload: () => Promise<void> }) {
  const [site, setSite] = useState(project.siteUrl ?? '');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  // The online demo renders previews in preview.html, since GitHub Pages can't route /preview/.
  const previewRoot = import.meta.env.VITE_DEMO ? `${location.origin}${import.meta.env.BASE_URL}preview.html#/preview/` : `${location.origin}/preview/`;
  const base = project.previewToken ? `${previewRoot}${project.previewToken}` : null;

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
