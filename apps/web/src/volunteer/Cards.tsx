import { fromEditorModel, sourceFormFor, validateTranslation, type EditorModel, type Issue } from '@nativeloc/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type QueueItem } from '../api';
import { ChipText } from '../components';
import { formLabel, isEmptyModel, LengthMeter, noGrammarly, sourceExample } from '../localizer/Workspace';
import { languageName, nativeLanguageName, textDirection } from '../types';
import type { VolunteerClient } from './client';
import type { CardOrg, FlagReason, ReportReason } from '../contracts';
import type { Card, VolunteerSettings, XpAward } from './types';

export interface CardResult {
  outcome: 'done' | 'skipped';
  xp: XpAward['xp'];
}

interface CardProps {
  card: Card;
  client: VolunteerClient;
  onDone: (r: CardResult) => void;
  /** Card actions this server offers (from /volunteer/settings); hidden until the other pieces' routes exist. */
  actions: VolunteerSettings['actions'];
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd/Ctrl+Enter runs the main action, for people doing a session at a desk. */
function useSubmitKey(action: () => void) {
  const ref = useRef(action);
  ref.current = action;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function CardHead({ card, kind }: { card: Card; kind: string }) {
  return (
    <div className="v-card-head">
      <span className={`v-kind ${card.type}`}>{kind}</span>
      <span className="v-where">
        {card.project.name} · {nativeLanguageName(card.locale)}
      </span>
    </div>
  );
}

/** "Nonprofit", "Community group" or "Individual": unverified nonprofits are served as community groups. */
export function orgKind(org: CardOrg): string {
  if (org.verified) return 'Nonprofit';
  return org.type === 'individual' ? 'Individual' : 'Community group';
}

/** Who this card helps. */
function OrgLine({ org }: { org: CardOrg }) {
  return (
    <div className="v-org">
      <div className="v-org-name">
        <span>{org.name}</span>
        <span className={`v-org-kind ${org.verified ? 'verified' : ''}`}>
          {org.verified ? '✓ ' : ''}
          {orgKind(org)}
        </span>
      </div>
      {org.description && <p className="v-org-about small muted">{org.description}</p>}
    </div>
  );
}

const FLAG_REASONS: { id: FlagReason; label: string }[] = [
  { id: 'meaning', label: 'Wrong meaning' },
  { id: 'grammar', label: 'Grammar' },
  { id: 'tone', label: 'Tone' },
  { id: 'offensive', label: 'Offensive' },
];
const REPORT_REASONS: { id: ReportReason; label: string }[] = [
  { id: 'spam', label: 'Spam' },
  { id: 'commercial', label: 'Selling something' },
  { id: 'harmful', label: 'Harmful' },
];

/** A row of reason chips; picking one sends it. */
function ReasonPicker<R extends string>({ title, reasons, busy, note, onPick, onCancel }: { title: string; reasons: { id: R; label: string }[]; busy: boolean; note: string; onPick: (r: R) => void; onCancel: () => void }) {
  return (
    <div className="v-reasons" role="group" aria-label={title} dir="ltr">
      <div className="small">{title}</div>
      <div className="v-reason-row">
        {reasons.map((r) => (
          <button key={r.id} type="button" className="chip" disabled={busy} onClick={() => onPick(r.id)}>
            {r.label}
          </button>
        ))}
        <button type="button" className="chip ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {note && (
        <div className="alert error" role="alert">
          {note}
        </div>
      )}
    </div>
  );
}

/** "Report this project" (2B): spam, selling, or harmful. The card is skipped once the report is in. */
function ReportLink({ card, client, onDone }: Pick<CardProps, 'card' | 'client' | 'onDone'>) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  async function send(reason: ReportReason) {
    setBusy(true);
    setNote('');
    try {
      await client.report(card.project.id, card.item.keyId, reason);
      setSent(true);
      setTimeout(() => onDone({ outcome: 'skipped', xp: null }), 900);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not send the report. Try again.');
      setBusy(false);
    }
  }
  if (sent)
    return (
      <p className="small muted v-report" role="status">
        Thanks. Our team will take a look.
      </p>
    );
  if (open) return <ReasonPicker title="What's wrong with this project?" reasons={REPORT_REASONS} busy={busy} note={note} onPick={(r) => void send(r)} onCancel={() => setOpen(false)} />;
  return (
    <button type="button" className="v-report small" onClick={() => setOpen(true)}>
      Report this project
    </button>
  );
}

function SourceBlock({ item, source }: { item: QueueItem; source: string }) {
  const src = item.sourceModel;
  return (
    <section className="v-source" aria-label={`${languageName(source)} original`}>
      <div className="label-row">{languageName(source)}</div>
      {src.kind === 'plural' ? (
        Object.entries(src.forms).map(([cat, f]) => (
          <p key={cat} className="v-source-text">
            <ChipText text={f} placeholders={item.placeholders} pound num={sourceExample(cat, source)} locale={source} />
          </p>
        ))
      ) : (
        <p className="v-source-text">
          <ChipText text={src.text} placeholders={item.placeholders} />
        </p>
      )}
    </section>
  );
}

function Context({ item }: { item: QueueItem }) {
  if (!item.description && !item.screenshot) return null;
  return (
    <div className="v-context">
      {item.description && <div className="context-note">{item.description}</div>}
      {item.screenshot && <ShotZoom shot={item.screenshot} />}
    </div>
  );
}

/** Screenshot thumbnail with the string's area highlighted; tap to see it full screen. */
function ShotZoom({ shot }: { shot: NonNullable<QueueItem['screenshot']> }) {
  const [open, setOpen] = useState(false);
  const pct = (v: number) => `${v * 100}%`;
  const picture = (
    <span className="v-shot-pic">
      <img src={shot.url} alt={shot.label ?? 'Screen where this text appears'} width={shot.width} height={shot.height} />
      {shot.box && <span className="v-shot-box" style={{ left: pct(shot.box.x), top: pct(shot.box.y), width: pct(shot.box.w), height: pct(shot.box.h) }} />}
    </span>
  );
  // The thumbnail is a strip of the screen centred on the highlight (--cy: its centre, as a share of the height).
  const cy = shot.box ? shot.box.y + shot.box.h / 2 : 0;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button type="button" className="v-shot" onClick={() => setOpen(true)} aria-label="Show the screen where this text appears">
        <span className="v-shot-strip" style={{ '--cy': cy } as React.CSSProperties}>
          {picture}
        </span>
        <span className="v-shot-hint small">Where it appears · tap to zoom</span>
      </button>
      {open && (
        <div className="v-zoom" role="dialog" aria-modal="true" aria-label="Screenshot" onClick={() => setOpen(false)}>
          {picture}
          <button type="button" className="v-zoom-close" aria-label="Close">
            ✕
          </button>
        </div>
      )}
    </>
  );
}

/** The translation boxes: placeholder chips, one box per plural form, live checks and the server's 422 issues. */
function Editor({ item, source, locale, model, setModel, issues, note }: { item: QueueItem; source: string; locale: string; model: EditorModel; setModel: (m: EditorModel) => void; issues: Issue[]; note?: string }) {
  const focused = useRef<{ el: HTMLTextAreaElement; form: string | null } | null>(null);
  const firstInput = useRef<HTMLTextAreaElement | null>(null);
  const dir = textDirection(locale);
  const sourceName = languageName(source);

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

  const forms = model.kind === 'plural' ? Object.keys(model.forms) : [];

  return (
    <section className="v-editor editor" dir={dir} lang={locale}>
      <div className="label-row" dir="ltr">
        Your {languageName(locale)}
      </div>
      {item.placeholders.length > 0 && (
        <div className="v-chips" dir="ltr">
          <span className="small muted">Tap to add:</span>
          {item.placeholders.map((p) => (
            <button key={p.token} type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.token)} title={`Insert ${p.token}`}>
              + {p.label}
            </button>
          ))}
        </div>
      )}
      {model.kind === 'plural' && (
        <p className="plural-intro" dir="ltr">
          {forms.length > 1 ? `${languageName(locale)} needs ${forms.length} versions of this sentence. Write each one for the numbers shown.` : `${languageName(locale)} uses one wording for any number.`} The <b>number</b> chip shows as <code>#</code>.
        </p>
      )}
      {model.kind === 'plural' ? (
        forms.map((cat, i) => {
          const lab = formLabel(cat, item.pluralExamples[cat], locale, forms.length === 1);
          return (
            <div className="form-block" key={cat}>
              <div className="form-head" dir="ltr">
                <span className="cat">{lab.title}</span>
              </div>
              <div className="ref" dir="ltr">
                {sourceName}: <ChipText text={sourceFormFor(item.sourceModel, cat)} placeholders={item.placeholders} pound num={lab.example} locale={source} />
              </div>
              <textarea
                {...noGrammarly}
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
          <textarea
            {...noGrammarly}
            ref={firstInput}
            rows={3}
            value={model.text}
            onFocus={(e) => (focused.current = { el: e.currentTarget, form: null })}
            onChange={(e) => setModel({ ...model, text: e.target.value })}
            aria-label={`Your ${languageName(locale)} translation`}
            placeholder="Type your translation"
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="preview">{model.text && item.placeholders.length > 0 && <ChipText text={model.text} placeholders={item.placeholders} />}</div>
            <LengthMeter text={model.text} max={item.maxLength} />
          </div>
        </div>
      )}
      {(issues.length > 0 || note) && (
        <div className="stack v-issues" dir="ltr" role="alert">
          {issues.map((i) => (
            <div key={i.code + i.message} className={`alert ${i.level === 'error' ? 'error' : 'warn'}`}>
              <ChipText text={i.message} placeholders={item.placeholders} />
            </div>
          ))}
          {note && <div className="alert error">{note}</div>}
        </div>
      )}
    </section>
  );
}

/**
 * Editor state shared by Translate and Review → Improve. Live checks stay quiet about missing pieces until the
 * volunteer taps Next; after that, the server's answer (a 422 with `issues`) is what's shown until they edit.
 */
function useTranslation(card: Card, client: VolunteerClient, onDone: (r: CardResult) => void, approve: boolean) {
  const { item, locale } = card;
  const [model, setModelState] = useState<EditorModel>(item.template);
  const [tried, setTried] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[] | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const text = useMemo(() => fromEditorModel(model), [model]);
  const live = useMemo(() => {
    if (isEmptyModel(model)) return [];
    const all = validateTranslation(item.source, text, { locale, maxLength: item.maxLength });
    return tried ? all : all.filter((i) => i.code !== 'plural-empty' && i.code !== 'missing-placeholder');
  }, [item, text, model, locale, tried]);

  function setModel(m: EditorModel) {
    setModelState(m);
    setServerIssues(null);
    setNote('');
  }

  async function submit() {
    if (saving) return;
    setTried(true);
    if (isEmptyModel(model)) {
      setNote('Type your translation first, or tap Skip.');
      return;
    }
    setSaving(true);
    setNote('');
    try {
      const r = await client.save(item.keyId, locale, text, approve);
      setSaved(true);
      onDone({ outcome: 'done', xp: r.xp });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.details?.issues?.length) setServerIssues(e.details.issues);
      else setNote(e instanceof ApiError ? e.message : 'Could not save. Check your connection and try again.');
      setSaving(false);
    }
    // On a small screen the message can sit under the keyboard or below the fold.
    requestAnimationFrame(() => document.querySelector('.v-issues')?.scrollIntoView({ block: 'nearest' }));
  }

  return { model, setModel, issues: serverIssues ?? live, note, saving, label: saved ? 'Saved ✓' : 'Saving…', submit };
}

export function TranslateCard({ card, client, onDone, actions }: CardProps) {
  const t = useTranslation(card, client, onDone, false);
  useSubmitKey(() => void t.submit());
  return (
    <>
      <div className="v-body">
        <CardHead card={card} kind="Translate" />
        <OrgLine org={card.org} />
        <SourceBlock item={card.item} source={card.project.sourceLocale} />
        <Context item={card.item} />
        <Editor item={card.item} source={card.project.sourceLocale} locale={card.locale} model={t.model} setModel={t.setModel} issues={t.issues} note={t.note} />
        {actions.report && <ReportLink card={card} client={client} onDone={onDone} />}
      </div>
      <div className="v-actions">
        <button className="v-btn ghost" onClick={() => onDone({ outcome: 'skipped', xp: null })} disabled={t.saving}>
          Skip
        </button>
        <button className="v-btn primary v-main" onClick={() => void t.submit()} disabled={t.saving} title={`${isMac ? '⌘' : 'Ctrl'}+Enter`}>
          {t.saving ? t.label : 'Next'}
        </button>
      </div>
    </>
  );
}

export function ReviewCard({ card, client, onDone, actions }: CardProps) {
  const { item, locale } = card;
  const [improving, setImproving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [note, setNote] = useState('');
  const [flagging, setFlagging] = useState(false);
  const [flagBusy, setFlagBusy] = useState(false);
  const t = useTranslation(card, client, onDone, true);
  const current = item.template;
  const forms = current.kind === 'plural' ? Object.keys(current.forms) : [];

  async function approve() {
    if (approving) return;
    setApproving(true);
    setNote('');
    try {
      const r = await client.approve(item.keyId, locale);
      setApproved(true);
      onDone({ outcome: 'done', xp: r.xp });
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not save. Check your connection and try again.');
      setApproving(false);
    }
  }
  async function flag(reason: FlagReason) {
    setFlagBusy(true);
    setNote('');
    try {
      const r = await client.flag(item.keyId, locale, reason);
      onDone({ outcome: 'done', xp: r.xp });
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not send the flag. Try again.');
      setFlagBusy(false);
    }
  }
  useSubmitKey(() => void (improving ? t.submit() : approve()));

  return (
    <>
      <div className="v-body">
        <CardHead card={card} kind="Review" />
        <OrgLine org={card.org} />
        <SourceBlock item={item} source={card.project.sourceLocale} />
        <Context item={item} />
        {improving ? (
          <Editor item={item} source={card.project.sourceLocale} locale={locale} model={t.model} setModel={t.setModel} issues={t.issues} note={t.note} />
        ) : (
          <section className="v-translation" dir={textDirection(locale)} lang={locale}>
            <div className="label-row" dir="ltr">
              {languageName(locale)} translation
              {item.approvals && (
                <span className="approvals" title={`${item.approvals.count} of ${item.approvals.needed} approvals`}>
                  {Array.from({ length: item.approvals.needed }, (_, i) => (
                    <span key={i} className={`dot ${i < item.approvals!.count ? 'on' : ''}`} />
                  ))}
                </span>
              )}
            </div>
            {current.kind === 'plural' ? (
              forms.map((cat) => {
                const lab = formLabel(cat, item.pluralExamples[cat], locale, forms.length === 1);
                return (
                  <div key={cat} className="v-form">
                    <div className="small muted" dir="ltr">
                      {lab.title}
                    </div>
                    {current.forms[cat].trim() ? (
                      <p className="v-target-text">
                        <ChipText text={current.forms[cat]} placeholders={item.placeholders} pound num={lab.example} locale={locale} />
                      </p>
                    ) : (
                      <p className="small muted" dir="ltr" style={{ margin: 0 }}>
                        Not written yet. Tap Improve to add it.
                      </p>
                    )}
                  </div>
                );
              })
            ) : (
              <p className="v-target-text">
                <ChipText text={current.text} placeholders={item.placeholders} />
              </p>
            )}
            <p className="small muted" dir="ltr" style={{ margin: 0 }}>
              Does it say the same thing, and read naturally? Approve it, or improve the wording.
            </p>
            {actions.flag &&
              (flagging ? (
                <ReasonPicker title="What's wrong with it?" reasons={FLAG_REASONS} busy={flagBusy} note="" onPick={(r) => void flag(r)} onCancel={() => setFlagging(false)} />
              ) : (
                <button type="button" className="v-flag small" dir="ltr" onClick={() => setFlagging(true)} disabled={approving}>
                  ⚑ Flag a problem
                </button>
              ))}
            {note && (
              <div className="alert error" dir="ltr" role="alert">
                {note}
              </div>
            )}
          </section>
        )}
        {actions.report && <ReportLink card={card} client={client} onDone={onDone} />}
      </div>
      <div className="v-actions">
        {improving ? (
          <>
            <button className="v-btn ghost" onClick={() => setImproving(false)} disabled={t.saving}>
              Cancel
            </button>
            <button className="v-btn primary v-main" onClick={() => void t.submit()} disabled={t.saving}>
              {t.saving ? t.label : 'Submit my version'}
            </button>
          </>
        ) : (
          <>
            <button className="v-btn ghost" onClick={() => onDone({ outcome: 'skipped', xp: null })} disabled={approving}>
              Skip
            </button>
            <button className="v-btn" onClick={() => setImproving(true)} disabled={approving}>
              Improve
            </button>
            <button className="v-btn primary v-main" onClick={() => void approve()} disabled={approving}>
              {approving ? (approved ? 'Approved ✓' : 'Saving…') : 'Approve'}
            </button>
          </>
        )}
      </div>
    </>
  );
}
