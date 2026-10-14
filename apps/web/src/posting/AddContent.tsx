import { useCallback, useEffect, useState } from 'react';
import { api, type Project } from '../api';
import type { CrawlJob, PasteResponse } from '../contracts';
import './posting.css';

type Way = 'paste' | 'file' | 'website';

/** Matches the server's PASTE_MAX_CHARS, so people see the limit before they hit it. */
const PASTE_MAX_CHARS = 100_000;
/** Matches the server's CRAWL_PAGE_LIMIT. */
const CRAWL_PAGE_LIMIT = 15;

/** The three ways to add text to a project. `onAdded` runs after strings were saved; `onPending` reports pasted text that isn't added yet. */
export function AddContent({ project, onAdded, onPending }: { project: Project; onAdded: () => void | Promise<void>; onPending?: (pending: boolean) => void }) {
  const [way, setWay] = useState<Way>('paste');
  return (
    <div className="stack">
      <div className="post-ways" role="tablist" aria-label="How to add text">
        {(
          [
            ['paste', 'Paste text', 'Copy from a document or email'],
            ['file', 'Upload a file', 'strings.xml, .po or JSON'],
            ['website', 'Website', `We read up to ${CRAWL_PAGE_LIMIT} pages`],
          ] as const
        ).map(([id, label, hint]) => (
          <button key={id} type="button" role="tab" aria-selected={way === id} className={way === id ? 'active' : ''} onClick={() => setWay(id)}>
            <b>{label}</b>
            <span className="small muted">{hint}</span>
          </button>
        ))}
      </div>
      {way === 'paste' && <PasteText project={project} onAdded={onAdded} onPending={onPending} />}
      {way === 'file' && <UploadFile project={project} onAdded={onAdded} />}
      {way === 'website' && <Website project={project} onAdded={onAdded} />}
    </div>
  );
}

function PasteText({ project, onAdded, onPending }: { project: Project; onAdded: () => void | Promise<void>; onPending?: (pending: boolean) => void }) {
  const [text, setText] = useState('');
  const [context, setContext] = useState('');
  const [split, setSplit] = useState<'paragraphs' | 'sentences'>('paragraphs');
  const [preview, setPreview] = useState<PasteResponse | null>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const tooLong = text.length > PASTE_MAX_CHARS;
  useEffect(() => {
    onPending?.(!!text.trim());
    return () => onPending?.(false);
  }, [text, onPending]);

  async function send(dryRun: boolean) {
    setError('');
    setDone('');
    setBusy(true);
    try {
      const r = await api<PasteResponse & { updated?: number }>(`/api/v1/projects/${project.id}/paste`, { body: { text, context: context || undefined, split, dryRun } });
      if (dryRun) setPreview(r);
      else {
        setPreview(null);
        setText('');
        setDone(`Added ${r.created} new string${r.created === 1 ? '' : 's'}` + (r.unchanged ? ` (${r.unchanged} were already there).` : '.'));
        await onAdded();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void send(!preview);
      }}
    >
      <label className="field">
        <span>Text to translate</span>
        <textarea
          rows={8}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          placeholder={'We are open Monday to Friday, 9 to 5.\n\nCall us if you need a delivery.'}
          required
        />
        <span className={`small ${tooLong ? 'post-over' : 'muted'}`}>
          {text.length.toLocaleString()} / {PASTE_MAX_CHARS.toLocaleString()} characters
          {tooLong ? ': too long for one paste. Split it up, or upload a file.' : ''}
        </span>
      </label>
      <fieldset className="post-choice">
        <legend className="small">Split into</legend>
        <label>
          <input type="radio" name="split" checked={split === 'paragraphs'} onChange={() => (setSplit('paragraphs'), setPreview(null))} /> Paragraphs
          <span className="small muted"> (keeps each thought together)</span>
        </label>
        <label>
          <input type="radio" name="split" checked={split === 'sentences'} onChange={() => (setSplit('sentences'), setPreview(null))} /> Sentences
          <span className="small muted"> (shorter cards for volunteers)</span>
        </label>
      </fieldset>
      <label className="field">
        <span>Where does this text appear? (optional)</span>
        <input value={context} maxLength={500} onChange={(e) => setContext(e.target.value)} placeholder="e.g. Our “Get food” page, read by families visiting for the first time" />
      </label>
      {preview && (
        <div className="card post-preview">
          <b>
            {preview.created} new string{preview.created === 1 ? '' : 's'}
            {preview.unchanged ? `, ${preview.unchanged} already in the project` : ''}
          </b>
          <ol>
            {preview.keys.slice(0, 12).map((k) => (
              <li key={k.key}>{k.source.replace(/''/g, "'").replace(/'([{}])'/g, '$1')}</li>
            ))}
          </ol>
          {preview.keys.length > 12 && <div className="small muted">and {preview.keys.length - 12} more</div>}
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      {done && <div className="alert ok">{done}</div>}
      <div className="row">
        {preview && (
          <button type="button" className="ghost" onClick={() => setPreview(null)}>
            Edit text
          </button>
        )}
        <span className="spacer" />
        <button className="primary" disabled={busy || !text.trim() || tooLong || (preview !== null && !preview.created)}>
          {preview ? `Add ${preview.created} string${preview.created === 1 ? '' : 's'}` : 'Preview'}
        </button>
      </div>
    </form>
  );
}

function UploadFile({ project, onAdded }: { project: Project; onAdded: () => void | Promise<void> }) {
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setDone('');
    setBusy(true);
    const form = new FormData(e.currentTarget);
    try {
      const r = await api<{ entries: number; created: number; updated: number; unchanged: number }>(`/api/v1/projects/${project.id}/import`, { form });
      setDone(`Read ${r.entries} strings: ${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged.`);
      (e.target as HTMLFormElement).reset();
      await onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={upload}>
      <label className="field">
        <span>File with your app's text</span>
        <input type="file" name="file" accept=".xml,.po,.pot,.json" required />
        <span className="small muted">Android strings.xml, gettext .po, or a JSON file of key → text. We read the format from the file name.</span>
      </label>
      {error && <div className="alert error">{error}</div>}
      {done && <div className="alert ok">{done}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="primary" disabled={busy}>
          {busy ? 'Reading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}

const STATUS: Record<CrawlJob['status'], string> = { queued: 'Waiting to start', running: 'Reading', done: 'Done', failed: 'Failed' };

function Website({ project, onAdded }: { project: Project; onAdded: () => void | Promise<void> }) {
  const [url, setUrl] = useState('');
  const [jobs, setJobs] = useState<CrawlJob[]>([]);
  const [error, setError] = useState('');
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');

  const load = useCallback(async () => {
    const r = await api<{ jobs: CrawlJob[] }>(`/api/v1/projects/${project.id}/crawl`);
    setJobs((before) => {
      // A crawl just finished: refresh the project's string count.
      if (before.some((b) => (b.status === 'queued' || b.status === 'running') && r.jobs.find((j) => j.id === b.id)?.status === 'done')) void onAdded();
      return r.jobs;
    });
  }, [project.id, onAdded]);

  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [active, load]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ job: CrawlJob }>(`/api/v1/projects/${project.id}/crawl`, { body: { url } });
      setJobs((j) => [r.job, ...j]);
      setUrl('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <form className="stack" onSubmit={start}>
        <label className="field">
          <span>Website address</span>
          <input type="text" inputMode="url" autoComplete="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourgroup.org/get-help" required />
          <span className="small muted">
            We read up to {CRAWL_PAGE_LIMIT} pages on that site, the ones people come to for help first (hours, services, how to apply). We follow the site's robots.txt.
          </span>
        </label>
        {error && <div className="alert error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button className="primary" disabled={active || !url.trim()}>
            Read the site
          </button>
        </div>
      </form>
      {jobs.length > 0 && (
        <ul className="post-jobs">
          {jobs.map((j) => (
            <li key={j.id} className="card">
              <div className="row">
                <span className="post-url">{j.url}</span>
                <span className="spacer" />
                <span className={`badge ${j.status === 'done' ? 'approved' : j.status === 'failed' ? 'outdated' : 'review'}`}>{STATUS[j.status]}</span>
              </div>
              {(j.status === 'running' || j.status === 'queued') && (
                <>
                  <div className="progress" aria-label={`${j.pages} of up to ${CRAWL_PAGE_LIMIT} pages`}>
                    <span className="p-review" style={{ width: `${(j.pages / CRAWL_PAGE_LIMIT) * 100}%` }} />
                  </div>
                  <div className="small muted">
                    {j.pages} of up to {CRAWL_PAGE_LIMIT} pages read. You can leave this page; it keeps going.
                  </div>
                </>
              )}
              {j.status === 'done' && (
                <div className="small muted">
                  Read {j.pages} page{j.pages === 1 ? '' : 's'}, found {j.strings} string{j.strings === 1 ? '' : 's'}.
                </div>
              )}
              {j.status === 'failed' && <div className="small post-over">{j.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
