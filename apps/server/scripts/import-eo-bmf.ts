/**
 * Imports IRS Exempt Organizations Business Master File CSVs into the local eo_bmf table (works offline).
 *
 * Download the extracts (free, public, refreshed monthly; eo1.csv - eo4.csv by region, or eo_xx.csv per state) from
 * https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf
 * Don't commit them: the full set is several hundred MB.
 *
 *   npx tsx --no-warnings apps/server/scripts/import-eo-bmf.ts path/to/eo1.csv path/to/eo2.csv ...
 *   npx tsx --no-warnings apps/server/scripts/import-eo-bmf.ts --replace eo1.csv eo2.csv   (monthly refresh: clear the table first)
 *
 * With no files it loads the tiny sample used by the demo and tests (scripts/fixtures/eo-bmf-sample.csv).
 * The database is data/nativeloc.sqlite, or $NATIVELOC_DATA.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importEoBmf } from '../src/moderation/eobmf.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const dataDir = resolve(process.env.NATIVELOC_DATA ?? resolve(root, 'data'));
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) files.push(resolve(fileURLToPath(import.meta.url), '../fixtures/eo-bmf-sample.csv'));

const db = openDb(resolve(dataDir, 'nativeloc.sqlite'));
let first = true;
for (const f of files) {
  const r = await importEoBmf(db, resolve(f), { replace: replace && first });
  first = false;
  console.log(`${f}: ${r.rows} organizations imported, ${r.skipped} rows skipped`);
}
