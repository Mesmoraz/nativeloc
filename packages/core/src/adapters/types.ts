export interface SourceEntry {
  key: string;
  /** ICU MessageFormat text. */
  source: string;
  description?: string;
  maxLength?: number;
  /** Format-specific details needed to export faithfully (e.g. gettext flags). */
  meta?: Record<string, unknown>;
  /** Already-translated text when the file carries both (e.g. a filled-in .po). */
  translation?: string;
}

export interface ParseResult {
  locale?: string;
  entries: SourceEntry[];
}

export interface ExportEntry {
  key: string;
  source: string;
  /** Translated ICU text, or null when untranslated (omitted from target exports). */
  text: string | null;
  description?: string | null;
  meta?: Record<string, unknown> | null;
}

export type FormatId = 'android-xml' | 'po' | 'json' | 'json-nested';

export interface Adapter {
  id: FormatId;
  label: string;
  extensions: string[];
  /** `locale` is the language of the file, when known (needed to map gettext plural indexes). */
  parse(content: string, locale?: string): ParseResult;
  serialize(entries: ExportEntry[], locale: string): string;
}
