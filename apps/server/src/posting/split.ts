import { escapeIcu } from '@nativeloc/core';
import { keyFor } from '@nativeloc/site';

/** Longest paste we accept, in characters (about 15,000 words). Longer text should come as a file or a website. */
export const PASTE_MAX_CHARS = 100_000;
/** Most strings one paste may create. */
export const PASTE_MAX_STRINGS = 1_000;
/** A paragraph longer than this is split at sentence ends, so one string stays a comfortable size to translate. */
export const PARAGRAPH_MAX_CHARS = 600;
/** No string is longer than this, even a single run-on sentence: it is cut at a word boundary. */
export const STRING_MAX_CHARS = 1_500;

export type SplitMode = 'sentences' | 'paragraphs';

export interface PastedString {
  /** Derived from the text, like website strings: pasting the same text again finds the same string. */
  key: string;
  /** ICU source (braces escaped). */
  source: string;
}

/** List markers people paste from documents: "- ", "* ", "• ", "1. ", "a) ". */
const BULLET = /^\s*(?:[-*•‣◦▪●–]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;
/** A line that ends a thought; the next line starts a new paragraph. */
const ENDS = /[.!?:;…"'”’)\]]$/;

/**
 * Paragraphs of pasted text. Blank lines always separate paragraphs. A single line break does too, unless it looks
 * like a hard wrap (the line runs on without closing punctuation and the next line starts in lower case), as in
 * text copied from an email or a PDF.
 */
export function paragraphs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/[\t  ]+/g, ' ').trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = BULLET.test(line);
    if (current && !bullet && !ENDS.test(current) && /^\p{Ll}/u.test(line)) current += ' ' + line;
    else {
      flush();
      // Keep numbering ("1. Bring an ID"), drop bullet symbols.
      current = /^\s*[-*•‣◦▪●–]\s+/.test(line) ? line.replace(/^\s*[-*•‣◦▪●–]\s+/, '') : line;
    }
  }
  flush();
  return out;
}

/** Sentences of one paragraph, with the platform's sentence rules for the source language. */
export function sentences(paragraph: string, locale = 'en'): string[] {
  let seg: Intl.Segmenter;
  try {
    seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
  } catch {
    seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  }
  return [...seg.segment(paragraph)].map((s) => s.segment.trim()).filter(Boolean);
}

/** Cut text longer than `max` at word boundaries (a last resort for run-on text with no sentence ends). */
function hardWrap(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Long paragraphs become runs of whole sentences, each under PARAGRAPH_MAX_CHARS where the sentences allow. */
function chunkParagraph(p: string, locale: string): string[] {
  if (p.length <= PARAGRAPH_MAX_CHARS) return [p];
  const out: string[] = [];
  let current = '';
  for (const s of sentences(p, locale).flatMap((s) => hardWrap(s, STRING_MAX_CHARS))) {
    if (current && current.length + 1 + s.length > PARAGRAPH_MAX_CHARS) {
      out.push(current);
      current = s;
    } else current = current ? `${current} ${s}` : s;
  }
  if (current) out.push(current);
  return out;
}

export class PasteTooLong extends Error {}

/**
 * Split pasted text into strings, in reading order, each text once. Throws PasteTooLong past the limits rather than
 * silently dropping text.
 */
export function splitPaste(text: string, mode: SplitMode = 'paragraphs', locale = 'en'): PastedString[] {
  if (text.length > PASTE_MAX_CHARS) {
    throw new PasteTooLong(`That's ${text.length.toLocaleString('en')} characters; one paste can hold up to ${PASTE_MAX_CHARS.toLocaleString('en')}. Split it into a few pastes, or upload a file.`);
  }
  const pieces = paragraphs(text).flatMap((p) => (mode === 'sentences' ? sentences(p, locale).flatMap((s) => hardWrap(s, STRING_MAX_CHARS)) : chunkParagraph(p, locale)));
  const seen = new Set<string>();
  const out: PastedString[] = [];
  for (const piece of pieces) {
    // Strings need at least one letter or digit: a line of "***" or "—" isn't something to translate.
    if (!/[\p{L}\p{N}]/u.test(piece)) continue;
    const source = escapeIcu(piece);
    const key = keyFor(source);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, source });
  }
  if (out.length > PASTE_MAX_STRINGS) {
    throw new PasteTooLong(`That text splits into ${out.length.toLocaleString('en')} strings; one paste can add up to ${PASTE_MAX_STRINGS.toLocaleString('en')}. Split it into a few pastes.`);
  }
  return out;
}
