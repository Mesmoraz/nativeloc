import { useEffect, useState } from 'react';
import { api, type Project } from '../api';
import { ChipText, StatusBadge } from '../components';
import { languageName } from '../types';

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

export function Strings({ project }: { project: Project }) {
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
