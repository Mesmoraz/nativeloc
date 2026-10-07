import type { Placeholder } from '@nativeloc/core';
import { Fragment } from 'react';
import type { LocaleProgressLike } from './types';

export function ProgressBar({ p }: { p: LocaleProgressLike }) {
  const pct = (n: number) => `${p.total ? (n / p.total) * 100 : 0}%`;
  return (
    <div className="progress" title={`${p.approved} approved · ${p.review} in review · ${p.outdated} need update · ${p.todo} to do`}>
      <span className="p-approved" style={{ width: pct(p.approved) }} />
      <span className="p-review" style={{ width: pct(p.review) }} />
      <span className="p-outdated" style={{ width: pct(p.outdated) }} />
    </div>
  );
}

const TOKEN_RE = /(\{[^{}]+\}|#)/g;

/**
 * Render ICU-ish text with placeholders as chips. Labels come from the source's
 * placeholder list so `{arg1}` reads as "value 1" and `#` reads as "number".
 * With `num`, `#` is shown as that example number instead, so plural forms read as real sentences.
 */
export function ChipText({ text, placeholders, pound = false, num, locale }: { text: string; placeholders: Placeholder[]; pound?: boolean; num?: number; locale?: string }) {
  const label = (tok: string) => placeholders.find((p) => p.token === tok)?.label ?? tok.replace(/^\{|\}$/g, '');
  const parts = text.split(TOKEN_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (part === '#' && pound && num !== undefined)
          return <span key={i} className="num" title="this number changes">{num.toLocaleString(locale)}</span>;
        if (part === '#' && pound) return <span key={i} className="chip" title="the number">{label('#')}</span>;
        if (/^\{[^{}]+\}$/.test(part)) return <span key={i} className="chip" title={part}>{label(part)}</span>;
        return <Fragment key={i}>{part.replace(/''/g, "'")}</Fragment>;
      })}
    </>
  );
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge">to do</span>;
  const label = { approved: 'approved', review: 'in review', outdated: 'needs update' }[status] ?? status;
  return <span className={`badge ${status}`}>{label}</span>;
}
