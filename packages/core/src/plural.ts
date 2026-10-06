export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export const CLDR_ORDER: PluralCategory[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** Plural categories a language needs, in CLDR order (always ends with "other"). */
export function pluralCategories(locale: string): PluralCategory[] {
  let cats: string[];
  try {
    cats = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    cats = ['one', 'other'];
  }
  return CLDR_ORDER.filter((c) => cats.includes(c));
}

const CANDIDATES = [
  ...Array.from({ length: 201 }, (_, i) => i),
  1000, 1001, 1_000_000, 2_000_000, 0.5, 1.5, 2.5,
];

/** A few example numbers per category so localizers know which form is which. */
export function pluralExamples(locale: string, perCategory = 3): Record<PluralCategory, number[]> {
  const rules = new Intl.PluralRules(locale);
  const out = Object.fromEntries(pluralCategories(locale).map((c) => [c, [] as number[]])) as Record<PluralCategory, number[]>;
  for (const n of CANDIDATES) {
    const cat = rules.select(n) as PluralCategory;
    if (out[cat] && out[cat].length < perCategory) out[cat].push(n);
  }
  return out;
}
