import { useState } from 'react';
import { api } from '../api';
import type { OrgMembership, OrgType } from '../contracts';
import { languageName, nativeLanguageName } from '../types';

/** Languages offered as one-tap choices; anything else can be typed as a code. Common US community languages first. */
export const COMMON_LANGUAGES = ['es', 'zh-Hans', 'vi', 'tl', 'ar', 'ko', 'ru', 'ht', 'pt-BR', 'fr', 'so', 'am', 'fa', 'uk', 'ja', 'hi', 'pl', 'de'];

export const ORG_TYPE_LABEL: Record<OrgType, string> = {
  nonprofit: 'Nonprofit',
  individual: 'Individual',
  small_org: 'Community group',
  business: 'Business',
};

/** OrgMembership plus what the org endpoints add for admins. */
export type OrgDetails = OrgMembership & { ein?: string | null; state?: string | null };

/** Pick languages: tap the common ones, or type a code. */
export function LanguagePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [other, setOther] = useState('');
  const options = [...COMMON_LANGUAGES, ...value.filter((l) => !COMMON_LANGUAGES.includes(l))];
  const toggle = (l: string) => onChange(value.includes(l) ? value.filter((x) => x !== l) : [...value, l]);
  function add(e: React.FormEvent | React.MouseEvent) {
    e.preventDefault();
    const code = other.trim();
    if (code && !value.includes(code)) onChange([...value, code]);
    setOther('');
  }
  return (
    <div className="stack">
      <fieldset className="lang-pick">
        <legend className="small">Which languages do you speak well, besides English?</legend>
        {options.map((l) => (
          <button type="button" key={l} aria-pressed={value.includes(l)} onClick={() => toggle(l)} lang={l}>
            <span className="lang-native">{nativeLanguageName(l)}</span>
            <span className="small muted">{languageName(l)}</span>
          </button>
        ))}
      </fieldset>
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          <span className="small">Another language (code, like “pa” or “zh-Hant”)</span>
          <input value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(e as unknown as React.FormEvent)} />
        </label>
        <button type="button" onClick={add} disabled={!other.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

/** "Confirm your email" with a resend button. */
export function ConfirmEmail({ email, compact }: { email: string; compact?: boolean }) {
  const [state, setState] = useState<{ sent?: boolean; error?: string }>({});
  async function resend() {
    try {
      await api('/api/v1/auth/resend-verification', { method: 'POST' });
      setState({ sent: true });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  }
  return (
    <div className={`card stack su-confirm${compact ? ' compact' : ''}`}>
      <div>
        <b>Confirm your email</b>
        <div className="small muted">
          We sent a link to <b>{email}</b>. Open it to start translating or posting.
          {import.meta.env.DEV && ' (Dev: the link is printed in the server console.)'}
          {import.meta.env.VITE_DEMO && ' (Demo: open it from Inbox in the bar at the top.)'}
        </div>
      </div>
      <div className="row">
        <button onClick={resend} disabled={state.sent}>
          {state.sent ? 'Sent. Check your inbox' : 'Send it again'}
        </button>
      </div>
      {state.error && <div className="alert error small">{state.error}</div>}
    </div>
  );
}
