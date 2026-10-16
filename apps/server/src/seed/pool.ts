import { get, run, type DB, type ProjectRow } from '../db.js';
import { upsertEntries } from '../services.js';
import type { Demo } from './types.js';

/**
 * Demo data for the open volunteer pool. Runs once, after the core demo seed, before v1 is published.
 * Two orgs outside the demo team with public, approved work, so volunteers' sessions show who else they're helping.
 */
export function seedPool(db: DB, _demo: Demo) {
  const org = (name: string, type: string, verification: string, description: string) =>
    Number(run(db, 'INSERT INTO orgs (name, type, verification, description) VALUES (?, ?, ?, ?)', name, type, verification, description).lastInsertRowid);
  const project = (orgId: number, name: string, token: string, locales: string[]) => {
    const id = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, visibility, moderation, review_mode) VALUES (?, ?, 'en', ?, 'public', 'approved', 'standard')", orgId, name, token).lastInsertRowid);
    for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
    return get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!;
  };

  const foodBank = project(org('Eastside Food Bank', 'nonprofit', 'verified', 'Groceries for 3,000 families a month'), 'Pantry hours page', 'pb_demo_eastside', ['es', 'fr', 'ja']);
  upsertEntries(db, foodBank, [
    { key: 'p1', source: 'We are open Monday to Friday, 9 AM to 5 PM.' },
    { key: 'p2', source: 'Call 555-0100 to ask for a home delivery.' },
    { key: 'p3', source: 'You do not need an ID to get food.' },
    { key: 'p4', source: 'This week we close early on Thursday.', description: 'Changes weekly' },
  ]);
  // Urgent: comes first in every session in these languages.
  run(db, "UPDATE keys SET urgent = 1 WHERE project_id = ? AND name = 'p4'", foodBank.id);

  const tenants = project(org('Maple Street Tenants', 'small_org', 'unverified', 'Neighbors helping renters know their rights'), 'Repair request guide', 'pb_demo_tenants', ['es', 'fr']);
  upsertEntries(db, tenants, [
    { key: 'r1', source: 'Write down the date you asked for the repair.' },
    { key: 'r2', source: 'Take photos of the problem.' },
  ]);
}
