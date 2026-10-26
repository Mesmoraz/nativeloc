/**
 * Spot the problem (docs/segment-3c-card-types.md): an approved translation with one planted error, or none (a
 * control). The error is always a number the source and translation share: a time, price, phone number, date or
 * count. It works in every language with no one writing content, and it's graded exactly.
 */

export interface NumberToken {
  /** Digit values, e.g. "0100" (whatever the script: "٥" and "５" are "5"). */
  value: string;
  /** The text as written. */
  text: string;
  start: number;
  end: number;
}

const DIGIT = /\p{Nd}/u;

/** A decimal digit's value. Unicode keeps each script's digits as a run of ten starting at zero. */
function digitZero(ch: string): number {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return cp - ((cp - start) % 10);
}

export function numbersIn(text: string): NumberToken[] {
  return [...text.matchAll(/\p{Nd}+/gu)].map((m) => ({
    value: [...m[0]].map((ch) => String(ch.codePointAt(0)! - digitZero(ch))).join(''),
    text: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
}

/**
 * Changes one number the source and translation share: its last digit goes up by one (9 wraps to 0), in the same
 * script. The new value must not appear in the source, or the card would have no clear answer. `rand` (0 to 1)
 * picks where to start among the shared numbers. Null when nothing can be planted.
 */
export function plant(source: string, text: string, rand: () => number): { shown: string; original: string; changed: string } | null {
  const inSource = new Set(numbersIn(source).map((n) => n.value));
  const shared = numbersIn(text).filter((n) => inSource.has(n.value));
  if (!shared.length) return null;
  const first = Math.floor(rand() * shared.length) % shared.length;
  for (let i = 0; i < shared.length; i++) {
    const n = shared[(first + i) % shared.length];
    const chars = [...n.text];
    const last = chars[chars.length - 1];
    const zero = digitZero(last);
    const next = (last.codePointAt(0)! - zero + 1) % 10;
    const changed = chars.slice(0, -1).join('') + String.fromCodePoint(zero + next);
    const changedValue = n.value.slice(0, -1) + next;
    if (inSource.has(changedValue)) continue;
    return { shown: text.slice(0, n.start) + changed + text.slice(n.end), original: n.text, changed };
  }
  return null;
}
