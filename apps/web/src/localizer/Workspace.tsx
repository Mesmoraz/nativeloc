import { fromEditorModel, sourceFormFor, targetTemplate, validateTranslation, type EditorModel, type Issue } from '@nativeloc/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TopBar, useSession } from '../App';
import { api, ApiError, type QueueItem, type QueueResponse } from '../api';
import { ChipText, ProgressBar, StatusBadge } from '../components';
import { languageName, nativeLanguageName, textDirection } from '../types';
import { Screenshot } from './Screenshot';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';
const ALT = isMac ? '⌥' : 'Alt';

/** Gentle labels for CLDR plural categories, with example numbers. */
function formLabel(cat: string, examples: number[] | undefined, locale: string): { title: string; hint: string } {
  if (cat.startsWith('=')) return { title: `Exactly ${cat.slice(1)}`, hint: '' };
  const ex = examples?.length ? examples.filter((n) => Number.isInteger(n)).slice(0, 3) : [];
  const nums = ex.length ? `${ex.map((n) => n.toLocaleString(locale)).join(', ')}${cat === 'other' ? ', …' : ''}` : '';
  return { title: cat === 'other' ? 'Other numbers' : `When the number is like ${nums}`, hint: cat === 'other' && nums ? `e.g. ${nums}` : cat };
}

function isEmptyModel(m: EditorModel) {
  return m.kind === 'plural' ? Object.values(m.forms).every((f) => !f.trim()) : !m.text.trim();
}

export function Workspace() {
  const { projectId = '', locale = '', mode: modeParam = 'translate' } = useParams();
  const mode = modeParam === 'review' ? 'review' : 'translate';
  const { session } = useSession();
  const canReview = session!.user.role !== 'localizer';

  const [meta, setMeta] = useState<Omit<QueueResponse, 'items'> | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [model, setModel] = useState<EditorModel>({ kind: 'text', text: '' });
  const [handled, setHandled] = useState<number[]>([]);
  const [history, setHistory] = useState<number[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const [serverError, setServerError] = useState('');
  const [triedSave, setTriedSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  const focused = useRef<{ el: HTMLTextAreaElement; form: string | null } | null>(null);
  const firstInput = useRef<HTMLTextAreaElement | null>(null);
  const item = items[0];
  const dir = textDirection(locale);

  const fetchMore = useCallback(
    async (exclude: number[], replace = false) => {
      const q = new URLSearchParams({ locale, mode, limit: '15', exclude: exclude.join(',') });
      const r = await api<QueueResponse>(`/api/v1/projects/${projectId}/queue?${q}`);
      const { items: next, ...rest } = r;
      setMeta(rest);
      setItems((cur) => {
        if (replace) return next;
        const have = new Set(cur.map((i) => i.keyId));
        return [...cur, ...next.filter((i) => !have.has(i.keyId))];
      });
      setLoaded(true);
    },
    [projectId, locale, mode],
  );

  useEffect(() => {
    setHandled([]);
    setHistory([]);
    setDoneCount(0);
    setLoaded(false);
    fetchMore([], true).catch((e) => setServerError(e.message));
  }, [fetchMore]);

  // Reset the editor whenever a new string comes up.
  useEffect(() => {
    if (!item) return;
    setModel(item.template);
    setServerError('');
    setTriedSave(false);
    setAsking(null);
    setShowDetails(false);
    requestAnimationFrame(() => firstInput.current?.focus());
  }, [item?.keyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = useMemo(() => fromEditorModel(model), [model]);
  const issues: Issue[] = useMemo(() => {
    if (!item || isEmptyModel(model)) return [];
    const all = validateTranslation(item.source, text, { locale, maxLength: item.maxLength });
    // Don't nag about empty plural boxes until the localizer tries to save.
    return triedSave ? all : all.filter((i) => i.code !== 'plural-empty' && i.code !== 'missing-placeholder');
  }, [item, model, text, locale, triedSave]);
  const errors = issues.filter((i) => i.level === 'error');
  const unchanged = item?.current?.text === text;

  const advance = useCallback(
    (keyId: number, saved: boolean) => {
      const nextHandled = [...handled, keyId];
      setHandled(nextHandled);
      if (saved) {
        setHistory((h) => [...h, keyId]);
        setDoneCount((n) => n + 1);
      }
      setItems((cur) => {
        const rest = cur.filter((i) => i.keyId !== keyId);
        if (rest.length < 4) void fetchMore([...nextHandled, ...rest.map((i) => i.keyId)]);
        return rest;
      });
    },
    [handled, fetchMore],
  );

  async function save() {
    if (!item || saving) return;
    setTriedSave(true);
    const all = validateTranslation(item.source, text, { locale, maxLength: item.maxLength });
    if (isEmptyModel(model) || all.some((i) => i.level === 'error')) return;
    setSaving(true);
    try {
      if (mode === 'review' && unchanged && item.current) {
        await api(`/api/v1/translations/${item.keyId}/${locale}/approve`, { method: 'POST' });
      } else {
        await api(`/api/v1/translations/${item.keyId}/${locale}`, { method: 'PUT', body: { text, approve: mode === 'review' } });
      }
      advance(item.keyId, true);
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : 'Could not save. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function sendBack() {
    if (!item) return;
    await api(`/api/v1/translations/${item.keyId}/${locale}/reject`, { method: 'POST' });
    advance(item.keyId, false);
  }

  function skip() {
    if (item) advance(item.keyId, false);
  }

  async function previous() {
    const last = history[history.length - 1];
    if (last === undefined) return;
    const r = await api<QueueResponse>(`/api/v1/projects/${projectId}/queue?locale=${locale}&mode=${mode}&keyId=${last}`);
    if (!r.items[0]) return;
    setHistory((h) => h.slice(0, -1));
    setHandled((h) => h.filter((id) => id !== last));
    setItems((cur) => [r.items[0], ...cur.filter((i) => i.keyId !== last)]);
  }

  async function sendQuestion() {
    if (!item || !asking?.trim()) return;
    await api(`/api/v1/keys/${item.keyId}/questions`, { body: { locale, text: asking } });
    setAsking(null);
    setNotice('Question sent. You can skip this one and come back later.');
    setTimeout(() => setNotice(''), 4000);
  }

  function insert(token: string) {
    const target = focused.current ?? (firstInput.current ? { el: firstInput.current, form: model.kind === 'plural' ? Object.keys(model.forms)[0] : null } : null);
    if (!target) return;
    const { el, form } = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const value = el.value.slice(0, start) + token + el.value.slice(end);
    if (model.kind === 'plural' && form) setModel({ ...model, forms: { ...model.forms, [form]: value } });
    else if (model.kind !== 'plural') setModel({ ...model, text: value });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function applySuggestion(s: string) {
    // Re-derive the editor shape from the suggestion so plural forms land in the right boxes.
    if (item) setModel(targetTemplate(item.source, s, locale));
  }

  // Keyboard-first: everything important has a shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (asking !== null) {
        if (e.key === 'Escape') setAsking(null);
        if (mod && e.key === 'Enter') {
          e.preventDefault();
          void sendQuestion();
        }
        return;
      }
      if (mod && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        setAsking('');
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        void save();
      } else if (mod && e.key === 'ArrowDown') {
        e.preventDefault();
        skip();
      } else if (mod && e.key === 'ArrowUp') {
        e.preventDefault();
        void previous();
      } else if (e.altKey && /^Digit[1-9]$/.test(e.code) && item) {
        const p = item.placeholders[Number(e.code.slice(5)) - 1];
        if (p) {
          e.preventDefault();
          insert(p.token);
        }
      } else if (e.altKey && e.key === 'Enter' && item?.suggestions[0]) {
        e.preventDefault();
        applySuggestion(item.suggestions[0].text);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const header = (
    <TopBar>
      <div className="row" style={{ flex: 1, minWidth: 0, flexWrap: 'nowrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {meta?.project.name}
          </div>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
            {mode === 'review' ? 'Reviewing' : 'Translating'} · {nativeLanguageName(locale)}
          </div>
        </div>
        {meta?.progress && (
          <div className="hide-sm" style={{ width: 200 }}>
            <ProgressBar p={meta.progress} />
          </div>
        )}
        <span className="small muted hide-sm">{doneCount} done this session</span>
        <span className="spacer" />
        <Link to="/" className="btn ghost">
          Exit
        </Link>
      </div>
    </TopBar>
  );

  if (!loaded) return header;

  if (!item) {
    return (
      <>
        {header}
        <div className="done">
          <div className="big">🎉</div>
          <h1>All caught up</h1>
          <p className="muted">
            {doneCount ? `You finished ${doneCount} string${doneCount === 1 ? '' : 's'} this session. ` : ''}
            Nothing else is waiting in {languageName(locale)} {mode === 'review' ? 'review' : 'right now'}.
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link className="btn primary" to="/">
              Back to my languages
            </Link>
            {canReview && mode === 'translate' && (
              <Link className="btn" to={`/p/${projectId}/${locale}/review`}>
                Review translations
              </Link>
            )}
            {mode === 'review' && (
              <Link className="btn" to={`/p/${projectId}/${locale}/translate`}>
                Translate
              </Link>
            )}
          </div>
        </div>
      </>
    );
  }

  const srcModel = item.sourceModel;
  const sourceName = languageName(meta?.project.sourceLocale ?? 'en');

  return (
    <>
      {header}
      <main className="ws">
        {/* ---------- context: where & why ---------- */}
        <section className="ws-context">
          <Screenshot shot={item.screenshot} />
          {item.description && (
            <div className="context-note">
              <b>Note: </b>
              {item.description}
            </div>
          )}
          {item.questions.map((q) => (
            <div key={q.id} className="card small">
              <div>
                <b>{q.user} asked:</b> {q.text}
              </div>
              <div className={q.answer ? '' : 'muted'}>{q.answer ? <><b>Answer:</b> {q.answer}</> : 'Waiting for an answer…'}</div>
            </div>
          ))}
          <div>
            <button className="ghost small" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? '▾' : '▸'} Technical details
            </button>
            {showDetails && (
              <div className="card small stack" style={{ marginTop: 8 }}>
                <div>
                  <span className="muted">ID:</span> <code>{item.key}</code>
                </div>
                <div>
                  <span className="muted">Status:</span> <StatusBadge status={item.current?.status} />
                </div>
                {item.maxLength && (
                  <div>
                    <span className="muted">Space on screen:</span> {item.maxLength} characters
                  </div>
                )}
                <div>
                  <span className="muted">Raw message:</span> <code style={{ wordBreak: 'break-all' }}>{item.source}</code>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ---------- work: what to say ---------- */}
        <section className="ws-work">
          <div className="card">
            <div className="label-row">{sourceName} original</div>
            {item.prevSource && (
              <div className="alert warn small" style={{ marginTop: 8 }}>
                The original text changed. It used to say: <span className="diff-old">{item.prevSource}</span>
              </div>
            )}
            {srcModel.kind === 'plural' ? (
              <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                {Object.entries(srcModel.forms).map(([cat, f]) => (
                  <div key={cat} className="source-text" style={{ fontSize: '1.15rem' }}>
                    <span className="badge" style={{ marginRight: 8 }}>
                      {cat.startsWith('=') ? cat.slice(1) : cat === 'one' ? '1' : cat}
                    </span>
                    <ChipText text={f} placeholders={item.placeholders} pound />
                  </div>
                ))}
              </div>
            ) : (
              <p className="source-text">
                <ChipText text={srcModel.text} placeholders={item.placeholders} />
              </p>
            )}
          </div>

          <div className="card editor" dir={dir} lang={locale}>
            <div className="label-row" dir="ltr">
              Your {languageName(locale)} translation
              {item.current && <StatusBadge status={item.current.status} />}
            </div>

            {item.placeholders.length > 0 && (
              <div className="row small" style={{ margin: '8px 0', gap: 6 }} dir="ltr">
                <span className="muted">Keep these in your text:</span>
                {item.placeholders.map((p, i) => (
                  <button key={p.token} type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.token)} title={`Insert ${p.token} (${ALT}+${i + 1})`}>
                    {p.label} <kbd style={{ marginLeft: 6 }}>{ALT}+{i + 1}</kbd>
                  </button>
                ))}
              </div>
            )}

            {model.kind === 'plural' ? (
              Object.keys(model.forms).map((cat, i) => {
                const lab = formLabel(cat, item.pluralExamples[cat], locale);
                return (
                  <div className="form-block" key={cat}>
                    <div className="form-head" dir="ltr">
                      <span className="cat">{lab.title}</span>
                      <span className="ref">
                        ↳ <ChipText text={sourceFormFor(srcModel, cat)} placeholders={item.placeholders} pound />
                      </span>
                    </div>
                    <textarea
                      ref={i === 0 ? firstInput : undefined}
                      rows={2}
                      value={model.forms[cat]}
                      onFocus={(e) => (focused.current = { el: e.currentTarget, form: cat })}
                      onChange={(e) => setModel({ ...model, forms: { ...model.forms, [cat]: e.target.value } })}
                      aria-label={lab.title}
                    />
                    <LengthMeter text={model.forms[cat]} max={item.maxLength} />
                  </div>
                );
              })
            ) : (
              <div className="form-block">
                {model.kind === 'advanced' && (
                  <div className="alert warn small" dir="ltr">
                    This text has choices built in. Translate only the words; keep the {'{ }'} structure as it is.
                  </div>
                )}
                <textarea
                  ref={firstInput}
                  rows={3}
                  value={model.text}
                  onFocus={(e) => (focused.current = { el: e.currentTarget, form: null })}
                  onChange={(e) => setModel({ ...model, text: e.target.value })}
                  aria-label="Translation"
                />
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="preview">{model.text && item.placeholders.length > 0 && <ChipText text={model.text} placeholders={item.placeholders} />}</div>
                  <LengthMeter text={model.text} max={item.maxLength} />
                </div>
              </div>
            )}

            {isEmptyModel(model) && (
              <button className="ghost small" style={{ marginTop: 6 }} onClick={() => setModel(item.template.kind === 'plural' ? { ...item.template, forms: Object.fromEntries(Object.keys(item.template.forms).map((c) => [c, sourceFormFor(srcModel, c)])) } : { ...item.template, text: srcModel.kind === 'plural' ? '' : srcModel.text })}>
                Start from the original text
              </button>
            )}

            <div className="stack" style={{ gap: 6, marginTop: issues.length || serverError ? 12 : 0 }} dir="ltr">
              {issues.map((i) => (
                <div key={i.code + i.message} className={`alert ${i.level === 'error' ? 'error' : 'warn'}`}>
                  <ChipText text={i.message} placeholders={item.placeholders} />
                </div>
              ))}
              {triedSave && isEmptyModel(model) && <div className="alert error">Type your translation first.</div>}
              {serverError && <div className="alert error">{serverError}</div>}
              {notice && <div className="alert ok">{notice}</div>}
            </div>
          </div>

          {asking !== null && (
            <div className="card stack">
              <div className="label-row">Ask the team about this text</div>
              <textarea autoFocus rows={3} value={asking} onChange={(e) => setAsking(e.target.value)} placeholder="e.g. Is “Checkout” a button or a page title?" />
              <div className="row">
                <button className="primary" onClick={() => void sendQuestion()}>
                  Send question <span className="kbd-hint">{MOD}+Enter</span>
                </button>
                <button className="ghost" onClick={() => setAsking(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {item.suggestions.length > 0 && (
            <div className="card stack" style={{ gap: 8 }}>
              <div className="label-row">Similar text you've translated before</div>
              {item.suggestions.map((s, i) => (
                <button key={i} className="suggestion" onClick={() => applySuggestion(s.text)}>
                  <span className="score">{s.score}%</span>
                  <span style={{ flex: 1 }}>
                    <div dir={dir} lang={locale}>
                      <ChipText text={s.text} placeholders={item.placeholders} pound={s.text.includes('plural')} />
                    </div>
                    <div className="small muted">{s.source}</div>
                  </span>
                  {i === 0 && <kbd>{ALT}+Enter</kbd>}
                </button>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="actionbar">
        <div className="actionbar-inner">
          <button onClick={() => void previous()} disabled={!history.length} title={`${MOD}+↑`}>
            ← Back
          </button>
          <button onClick={skip} title={`${MOD}+↓`}>
            Skip <span className="kbd-hint hide-sm">{MOD}+↓</span>
          </button>
          <button className="ghost" onClick={() => setAsking('')} title={`${MOD}+Shift+Enter`}>
            Ask a question
          </button>
          <span className="spacer" />
          {mode === 'review' && (
            <button className="danger" onClick={() => void sendBack()}>
              Send back
            </button>
          )}
          <button className="primary" onClick={() => void save()} disabled={saving || (triedSave && errors.length > 0)}>
            {mode === 'review' ? (unchanged ? 'Approve' : 'Save & approve') : 'Save'} & next <span className="kbd-hint">{MOD}+Enter</span>
          </button>
        </div>
      </footer>
    </>
  );
}

function LengthMeter({ text, max }: { text: string; max: number | null }) {
  if (!max) return null;
  // Counts like the server check: placeholders take no space, numbers take two.
  const len = [...text.replace(/\{[^{}]+\}/g, '').replace(/#/g, '00')].length;
  return <div className={`meter ${len > max ? 'over' : ''}`}>{len} / {max}</div>;
}
