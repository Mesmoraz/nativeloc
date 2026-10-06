import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Tag {
  key: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
}
interface Shot {
  id: number;
  url: string;
  label: string;
  width: number;
  height: number;
  keys: Tag[];
}

export function Screenshots({ projectId }: { projectId: number }) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = () =>
    api<{ screenshots: Shot[] }>(`/api/v1/projects/${projectId}/screenshots`).then((r) => {
      setShots(r.screenshots);
      return r.screenshots;
    });
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ id: number }>(`/api/v1/projects/${projectId}/screenshots`, { form: new FormData(e.currentTarget) });
      e.currentTarget?.reset();
      await load();
      setSelected(r.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const shot = shots.find((s) => s.id === selected);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <form className="card stack" onSubmit={upload}>
        <h2 style={{ margin: 0 }}>Add a screenshot</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Devices can upload these automatically with the SDK (with exact positions). Here you can add one by hand and draw boxes around each text.
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1 }}>
            PNG or JPEG
            <input type="file" name="file" accept="image/png,image/jpeg" required />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Screen name
            <input name="label" placeholder="e.g. Cart screen" />
          </label>
          <button className="primary">Upload</button>
        </div>
        {error && <div className="alert error">{error}</div>}
      </form>

      {shot ? (
        <Tagger key={shot.id} shot={shot} projectId={projectId} onDone={() => (setSelected(null), void load())} />
      ) : (
        <div className="grid-cards">
          {shots.map((s) => (
            <button key={s.id} className="card stack" style={{ padding: 10, alignItems: 'stretch', whiteSpace: 'normal' }} onClick={() => setSelected(s.id)}>
              <img src={s.url} alt={s.label} style={{ width: '100%', borderRadius: 6 }} />
              <div className="row small">
                <b>{s.label}</b>
                <span className="spacer" />
                <span className="muted">{s.keys.length} texts</span>
              </div>
            </button>
          ))}
          {!shots.length && <div className="card muted">No screenshots yet.</div>}
        </div>
      )}
    </div>
  );
}

function Tagger({ shot, projectId, onDone }: { shot: Shot; projectId: number; onDone: () => void }) {
  const [tags, setTags] = useState<Tag[]>(shot.keys);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [options, setOptions] = useState<{ name: string; source: string }[]>([]);
  const [msg, setMsg] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ keys: { name: string; source: string }[] }>(`/api/v1/projects/${projectId}/keys?q=${encodeURIComponent(keyInput)}`).then((r) => setOptions(r.keys.slice(0, 30)));
    }, 150);
    return () => clearTimeout(t);
  }, [keyInput, projectId]);

  const point = (e: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  function onDown(e: React.MouseEvent) {
    start.current = point(e);
    setPending(null);
  }
  function onMove(e: React.MouseEvent) {
    if (!start.current) return;
    const p = point(e);
    const s = start.current;
    setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  }
  function onUp() {
    start.current = null;
    if (draft && draft.w > 0.01 && draft.h > 0.01) setPending(draft);
    setDraft(null);
  }

  function assign(name: string) {
    if (!pending || !name) return;
    setTags((t) => [...t.filter((x) => x.key !== name), { key: name, ...pending }]);
    setPending(null);
    setKeyInput('');
  }

  async function save() {
    const r = await api<{ missingKeys: string[] }>(`/api/v1/screenshots/${shot.id}/keys`, { method: 'PUT', body: { keys: tags } });
    setMsg(r.missingKeys.length ? `Saved. Unknown IDs ignored: ${r.missingKeys.join(', ')}` : 'Saved.');
  }

  async function remove() {
    if (!confirm('Delete this screenshot?')) return;
    await api(`/api/v1/screenshots/${shot.id}`, { method: 'DELETE' });
    onDone();
  }

  const pct = (v: number) => `${v * 100}%`;
  const rect = draft ?? pending;

  return (
    <div className="card stack">
      <div className="row">
        <button className="ghost" onClick={onDone}>
          ← All screenshots
        </button>
        <h2 style={{ margin: 0 }}>{shot.label}</h2>
        <span className="spacer" />
        <button className="danger" onClick={() => void remove()}>
          Delete
        </button>
        <button className="primary" onClick={() => void save()}>
          Save boxes
        </button>
      </div>
      {msg && <div className="alert ok">{msg}</div>}
      <p className="small muted" style={{ margin: 0 }}>
        Drag a box around a piece of text, then pick which string it is.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(220px, 1fr)', gap: 16 }}>
        <div ref={box} className="tagger" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => start.current && onUp()}>
          <img src={shot.url} alt={shot.label} draggable={false} />
          {tags.filter((t) => t.x != null).map((t) => (
            <div key={t.key} className="tag" style={{ left: pct(t.x!), top: pct(t.y!), width: pct(t.w!), height: pct(t.h!) }}>
              <span>{t.key}</span>
            </div>
          ))}
          {rect && <div className="tag" style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h), borderStyle: 'dashed' }} />}
        </div>
        <div className="stack">
          {pending && (
            <div className="stack" style={{ gap: 6 }}>
              <b className="small">Which text is this?</b>
              <input autoFocus value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="Search text or ID" />
              <div className="stack" style={{ gap: 4, maxHeight: 260, overflowY: 'auto' }}>
                {options.map((o) => (
                  <button key={o.name} className="small" style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => assign(o.name)}>
                    <span>
                      {o.source}
                      <br />
                      <span className="muted mono">{o.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <b className="small">On this screen ({tags.length})</b>
          {tags.map((t) => (
            <div key={t.key} className="row small" style={{ flexWrap: 'nowrap' }}>
              <code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.key}</code>
              {t.x == null && <span className="muted">no box</span>}
              <button className="ghost small" onClick={() => setTags(tags.filter((x) => x.key !== t.key))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
