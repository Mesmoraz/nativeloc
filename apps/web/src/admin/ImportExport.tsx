import { useState } from 'react';
import { api, type Project } from '../api';
import { languageName } from '../types';

export function ImportExport({ project, reload }: { project: Project; reload: () => Promise<void> }) {
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
          <a
            className="btn"
            href={`/api/v1/projects/${project.id}/export?${new URLSearchParams(exp)}`}
            onClick={
              import.meta.env.VITE_DEMO
                ? (e) => {
                    e.preventDefault();
                    const href = e.currentTarget.getAttribute('href')!;
                    void import('../demo/download').then((m) => m.demoDownload(href));
                  }
                : undefined
            }
          >
            Download
          </a>
        </div>
      </div>
    </div>
  );
}
