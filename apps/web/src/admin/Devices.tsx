import { useEffect, useState } from 'react';
import { api, type Project } from '../api';
import type { Manifest } from './Overview';

interface Token {
  id: number;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
}

export function Devices({ project, manifest, reload }: { project: Project; manifest: Manifest | null; reload: () => Promise<void> }) {
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
