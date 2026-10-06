import { androidAdapter } from './adapters/android.js';
import { jsonAdapter, jsonNestedAdapter } from './adapters/json.js';
import { poAdapter } from './adapters/po.js';
import type { Adapter, FormatId } from './adapters/types.js';

export * from './icu.js';
export * from './plural.js';
export * from './editor.js';
export * from './validate.js';
export * from './printf.js';
export * from './adapters/types.js';
export { androidAdapter, poAdapter, jsonAdapter, jsonNestedAdapter };

export const ADAPTERS: Record<FormatId, Adapter> = {
  'android-xml': androidAdapter,
  po: poAdapter,
  json: jsonAdapter,
  'json-nested': jsonNestedAdapter,
};

export function getAdapter(format: string): Adapter {
  const a = ADAPTERS[format as FormatId];
  if (!a) throw new Error(`Unknown format "${format}". Use one of: ${Object.keys(ADAPTERS).join(', ')}`);
  return a;
}

/** Guess a format from a file name (android res/values*\/*.xml, .po, .json). */
export function detectFormat(fileName: string): FormatId | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xml')) return 'android-xml';
  if (lower.endsWith('.po') || lower.endsWith('.pot')) return 'po';
  if (lower.endsWith('.json')) return 'json';
  return null;
}

/** Display name for a key: gettext context separators become "›". */
export function displayKey(key: string): string {
  return key.replace('\u0004', ' › ');
}

export interface BundleManifest {
  project: string;
  version: number;
  sourceLocale: string;
  publishedAt: string;
  locales: Record<string, { sha256: string; url: string; completeness: number }>;
}
