import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { get, run, tx, type DB } from '../db.js';

/**
 * The IRS Exempt Organizations Business Master File (EO-BMF): every organization the IRS recognizes as
 * tax-exempt, published as CSVs (eo1.csv … eo4.csv by region, or eo_xx.csv per state) at
 * https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf
 * and refreshed monthly. scripts/import-eo-bmf.ts loads them into the eo_bmf table with importEoBmf.
 */

export interface EoMatch {
  ein: string;
  name: string;
  city: string;
  state: string;
}

/** "12-3456789" → "123456789"; null unless it's 9 digits. */
export function normalizeEin(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/[\s-]/g, '');
  return /^\d{9}$/.test(digits) ? digits : null;
}

export function lookupEin(db: DB, ein: string | null): EoMatch | null {
  if (!ein) return null;
  return get<EoMatch>(db, 'SELECT ein, name, city, state FROM eo_bmf WHERE ein = ?', ein) ?? null;
}

/** sort_name is the IRS's secondary name (often a "doing business as" or chapter name). */
export const eoNames = (db: DB, ein: string) => get<{ name: string; sort_name: string | null }>(db, 'SELECT name, sort_name FROM eo_bmf WHERE ein = ?', ein);

/** Splits one CSV line (RFC 4180 quoting; the IRS files rarely quote, but names can contain commas). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export interface ImportResult {
  rows: number;
  skipped: number;
}

const BATCH = 5000;

/** Feeds CSV lines (header first) into eo_bmf in batches. Columns are found by header name, so the IRS can add or reorder them. */
function importer(db: DB, file: string) {
  let col: Record<string, number> | null = null;
  let batch: string[][] = [];
  const result: ImportResult = { rows: 0, skipped: 0 };
  const insert = db.prepare('INSERT OR REPLACE INTO eo_bmf (ein, name, sort_name, city, state, zip, subsection) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const flush = () => {
    tx(db, () => {
      for (const f of batch) {
        const at = (name: string) => (col![name] === undefined ? '' : (f[col![name]] ?? '').trim());
        const ein = normalizeEin(at('EIN'));
        const name = at('NAME');
        if (!ein || !name) {
          result.skipped++;
          continue;
        }
        insert.run(ein, name, at('SORT_NAME') || null, at('CITY'), at('STATE').toUpperCase(), at('ZIP') || null, at('SUBSECTION') || null);
        result.rows++;
      }
    });
    batch = [];
  };
  return {
    line(raw: string) {
      const line = raw.replace(/^﻿/, '');
      if (!line.trim()) return;
      if (!col) {
        col = Object.fromEntries(parseCsvLine(line).map((h, i) => [h.trim().toUpperCase(), i]));
        if (col.EIN === undefined || col.NAME === undefined) throw new Error(`${file} doesn't look like an EO-BMF CSV (no EIN and NAME columns in the header).`);
        return;
      }
      batch.push(parseCsvLine(line));
      if (batch.length >= BATCH) flush();
    },
    done() {
      if (batch.length) flush();
      return result;
    },
  };
}

/**
 * Streams one EO-BMF CSV into eo_bmf (insert or replace by EIN). Works offline: download the files first.
 * Pass `replace` on the first file of a full refresh to clear the table.
 */
export async function importEoBmf(db: DB, file: string, opts: { replace?: boolean } = {}): Promise<ImportResult> {
  if (opts.replace) run(db, 'DELETE FROM eo_bmf');
  const imp = importer(db, file);
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) imp.line(line);
  return imp.done();
}

/** The same for a small file already in memory (the demo seed and tests). */
export function importEoBmfSync(db: DB, file: string, opts: { replace?: boolean } = {}): ImportResult {
  if (opts.replace) run(db, 'DELETE FROM eo_bmf');
  const imp = importer(db, file);
  for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) imp.line(line.trimEnd());
  return imp.done();
}
