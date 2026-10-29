import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../db.js';
import { run } from '../db.js';
import { importEoBmfSync } from '../moderation/eobmf.js';
import { startVerification } from '../moderation/verify.js';
import { screenText } from '../moderation/screen.js';
import type { Demo } from './types.js';

/** Demo data for verification and moderation. Runs once, after the core demo seed, before v1 is published. */
export function seedModeration(db: DB, _demo: Demo) {
  importEoBmfSync(db, join(dirname(fileURLToPath(import.meta.url)), '../../scripts/fixtures/eo-bmf-sample.csv'));

  // A nonprofit whose EIN is listed but which gave no state: waits in the staff queue.
  const org = Number(run(db, "INSERT INTO orgs (name, type, ein, website, description) VALUES ('Eastside Food Bank', 'nonprofit', '12-3456789', 'https://eastside.example', 'Groceries for 3,000 families a month')").lastInsertRowid);
  startVerification(db, { id: org, name: 'Eastside Food Bank', type: 'nonprofit', verification: 'unverified', ein: '12-3456789', website: null, description: null });

  // A public project that the automatic screen held for staff.
  const project = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, visibility, moderation) VALUES (?, 'Weekend sale flyer', 'en', 'pb_demo_flyer', 'public', 'pending')", org).lastInsertRowid);
  const lines = ['Buy now and get free shipping on every order!', 'Spring sale: pizza for $9.99, call 503-555-0100 or 503-555-0101 or 503-555-0102.', 'Open Saturday and Sunday.'];
  lines.forEach((source, i) => run(db, 'INSERT INTO keys (project_id, name, source) VALUES (?, ?, ?)', project, `p${i + 1}`, source));
  run(db, "INSERT INTO moderation_screens (project_id, decision, reasons) VALUES (?, 'pending', ?)", project, JSON.stringify(screenText(lines, 'nonprofit').reasons));
}
