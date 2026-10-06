export type { EditorModel, Issue, Placeholder } from '@nativeloc/core';

export interface LocaleProgressLike {
  locale: string;
  total: number;
  approved: number;
  review: number;
  outdated: number;
  todo: number;
}

/** "es" → "Spanish", "pt-BR" → "Portuguese (Brazil)". */
export function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export function nativeLanguageName(locale: string): string {
  try {
    const n = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
    return n.charAt(0).toLocaleUpperCase(locale) + n.slice(1);
  } catch {
    return locale;
  }
}

export function textDirection(locale: string): 'rtl' | 'ltr' {
  return /^(ar|he|fa|ur|ps|yi|dv)\b/.test(locale) ? 'rtl' : 'ltr';
}
