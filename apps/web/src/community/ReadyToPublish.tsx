import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Project } from '../api';
import type { FlagReason, ReadyListResponse } from '../contracts';
import { languageName } from '../types';
import './community.css';

type Item = ReadyListResponse['items'][number];

const FLAG_LABELS: Record<FlagReason, string> = { meaning: 'wrong meaning', grammar: 'grammar', tone: 'tone', offensive: 'offensive' };
const itemId = (i: { keyId: number; locale: string }) => `${i.keyId}:${i.locale}`;

/**
 * The poster's "Ready to publish" list (community review): text volunteers agreed on, with its review count and
 * any flags or disagreement. Publish all, publish one, edit (saves and publishes), or send back with a note.
 * Publishing here makes text approved; the bundle still goes to devices with "Publish version N" as before.
 */
export function ReadyToPublish({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [locale, setLocale] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [sending, setSending] = useState<{ id: string; note: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<ReadyListResponse>(`/api/v1/projects/${project.id}/ready${locale ? `?locale=${locale}` : ''}`);
    setItems(r.items);
  }, [project.id, locale]);
  useEffect(() => {
    void load().catch((e) => setMsg({ kind: 'error', text: (e as Error).message }));
  }, [load]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      setEditing(null);
      setSending(null);
      await Promise.all([load(), reload()]);
      setMsg({ kind: 'ok', text });
    } catch (e) {
      const issues = e instanceof ApiError ? e.details?.issues : undefined;
      setMsg({ kind: 'error', text: issues?.length ? issues.map((i) => i.message).join(' ') : (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const publishItems = (list?: Item[]) =>
    act(async () => {
      const r = await api<{ approved: number }>(`/api/v1/projects/${project.id}/ready/approve`, {
        body: list ? { items: list.map((i) => ({ keyId: i.keyId, locale: i.locale })) } : {},
      });
      return `${r.approved} translation${r.approved === 1 ? '' : 's'} approved. Publish a new version on the Overview tab to send ${r.approved === 1 ? 'it' : 'them'} to devices.`;
    });

  const saveEdit = (item: Item, text: string) =>
    act(async () => {
      await api(`/api/v1/translations/${item.keyId}/${item.locale}`, { method: 'PUT', body: { text, approve: true } });
      return `Saved your wording of "${item.key}" and approved it.`;
    });

  const sendBack = (item: Item, note: string) =>
    act(async () => {
      await api(`/api/v1/projects/${project.id}/ready/send-back`, { body: { keyId: item.keyId, locale: item.locale, note: note.trim() || undefined } });
      return `Sent "${item.key}" back to reviewers. It now needs 5 approvals.`;
    });

  const locales = project.locales.filter((l) => l !== project.sourceLocale);
  const all = items ?? [];
  // When the list is filtered, "Publish all" means everything shown, not text in other languages.
  const publishAll = () => void publishItems(locale ? all : undefined);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>Ready to publish</h2>
          <span className="spacer" />
          {locales.length > 1 && (
            <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label="Language">
              <option value="">All languages</option>
              {locales.map((l) => (
                <option key={l} value={l}>
                  {languageName(l)}
                </option>
              ))}
            </select>
          )}
          <button className="primary" disabled={busy || !all.length} onClick={publishAll}>
            Publish all{all.length ? ` (${all.length})` : ''}
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Volunteers reviewed these and agreed. Nothing reaches your devices until you publish it here and then publish a new version.
          Community-reviewed text is labelled "Community-reviewed, not verified" in the apps.
        </p>
        {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      </div>

      {items && !items.length && <div className="card muted">Nothing is waiting for you. Text shows up here once volunteers agree on it.</div>}

      {all.map((item) => {
        const id = itemId(item);
        return (
          <div key={id} className="card stack ready-item">
            <div className="row">
              <code className="small">{item.key}</code>
              <span className="badge">{languageName(item.locale)}</span>
              <span className="small muted">
                {item.review.reviews} review{item.review.reviews === 1 ? '' : 's'} · {item.review.approvals} approval{item.review.approvals === 1 ? '' : 's'}
                {item.review.escalated ? ' · settled by a lead reviewer' : ''}
              </span>
              <span className="spacer" />
              {item.disagreement && <span className="badge ready-disagree">reviewers disagreed</span>}
              {item.flags.map((f) => (
                <span key={f.reason} className="badge ready-flag">
                  flagged: {FLAG_LABELS[f.reason]}
                  {f.count > 1 ? ` ×${f.count}` : ''}
                </span>
              ))}
            </div>
            <div className="ready-texts">
              <div>
                <div className="small muted">{languageName(project.sourceLocale)}</div>
                <div>{item.source}</div>
              </div>
              <div>
                <div className="small muted">{languageName(item.locale)}</div>
                {editing?.id === id ? (
                  <textarea rows={3} value={editing.text} onChange={(e) => setEditing({ id, text: e.target.value })} autoFocus />
                ) : (
                  <div lang={item.locale}>{item.text}</div>
                )}
              </div>
            </div>
            {sending?.id === id && (
              <label className="field">
                Note for reviewers (optional)
                <input value={sending.note} onChange={(e) => setSending({ id, note: e.target.value })} placeholder="e.g. Too formal, use tú" autoFocus />
              </label>
            )}
            <div className="row" style={{ gap: 6 }}>
              {editing?.id === id ? (
                <>
                  <button className="primary small" disabled={busy || !editing.text.trim()} onClick={() => void saveEdit(item, editing.text)}>
                    Save and publish
                  </button>
                  <button className="small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </>
              ) : sending?.id === id ? (
                <>
                  <button className="small" disabled={busy} onClick={() => void sendBack(item, sending.note)}>
                    Send back
                  </button>
                  <button className="small" onClick={() => setSending(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="primary small" disabled={busy} onClick={() => void publishItems([item])}>
                    Publish
                  </button>
                  <button className="small" disabled={busy} onClick={() => setEditing({ id, text: item.text })}>
                    Edit
                  </button>
                  <button className="small" disabled={busy} onClick={() => setSending({ id, note: '' })}>
                    Send back
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
