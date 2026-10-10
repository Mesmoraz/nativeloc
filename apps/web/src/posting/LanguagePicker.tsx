import { useState } from 'react';
import { languageName, nativeLanguageName } from '../types';

/** Languages volunteers most often bring, first. Anything else can be added by code. */
export const COMMON_LANGUAGES = ['es', 'zh-Hans', 'vi', 'ko', 'ru', 'ar', 'tl', 'fr', 'ht', 'pt-BR', 'so', 'uk', 'fa', 'am', 'hi', 'ja'];

const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Pick target languages: a grid of common ones plus "add another" by code. */
export function LanguagePicker({ value, onChange, exclude, legend = 'Translate into' }: { value: string[]; onChange: (v: string[]) => void; exclude?: string; legend?: string }) {
  const [other, setOther] = useState('');
  const [error, setError] = useState('');
  const shown = [...COMMON_LANGUAGES, ...value.filter((l) => !COMMON_LANGUAGES.includes(l))].filter((l) => l !== exclude);
  const toggle = (l: string) => onChange(value.includes(l) ? value.filter((x) => x !== l) : [...value, l]);

  function add() {
    const code = other.trim().replace('_', '-');
    if (!code) return;
    if (!LOCALE_RE.test(code)) {
      setError(`"${code}" isn't a language code. Try one like "pl", "km" or "pt-PT".`);
      return;
    }
    setError('');
    if (!value.includes(code)) onChange([...value, code]);
    setOther('');
  }

  return (
    <div className="stack">
      <fieldset className="lang-pick">
        <legend className="small">{legend}</legend>
        {shown.map((l) => (
          <button type="button" key={l} aria-pressed={value.includes(l)} onClick={() => toggle(l)} lang={l}>
            <span className="lang-native">{nativeLanguageName(l)}</span>
            <span className="small muted">{languageName(l)}</span>
          </button>
        ))}
      </fieldset>
      <div className="row post-other">
        <label className="field">
          <span className="small">Another language (code)</span>
          <input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="e.g. pl, km, pt-PT"
          />
        </label>
        <button type="button" onClick={add}>
          Add
        </button>
      </div>
      {error && <div className="alert error small">{error}</div>}
    </div>
  );
}
