import { hashPassword } from '../auth.js';
import { addMembership, get, getUser, run, type DB, type Member, type ProjectRow } from '../db.js';
import { approveTranslation, flagTranslation, saveTranslation } from '../services/review.js';
import { upsertEntries } from '../services/ingest.js';
import type { Demo } from './types.js';

/**
 * Owned by Segment 2 piece 2C. Demo data for the community review engine: a community-reviewed project with text
 * waiting on the poster's "Ready to publish" list (one clean, one disputed), one string still in review with a flag,
 * and five Spanish volunteers who did the reviewing (password demo-localizer-pass).
 */
export function seedReview(db: DB, demo: Demo) {
  const id = Number(
    run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token, review_mode) VALUES (?, 'Pantry Hours Page (community)', 'en', 'pb_demo_hours', 'community')", demo.orgId).lastInsertRowid,
  );
  run(db, "INSERT INTO project_locales (project_id, locale) VALUES (?, 'es')", id);
  const project = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!;
  upsertEntries(db, project, [
    { key: 'hours.title', source: 'Pantry hours', description: 'Page heading' },
    { key: 'hours.weekdays', source: 'Open Monday to Friday, 9 AM to 5 PM.' },
    { key: 'hours.limit', source: 'You can visit once a week.' },
    { key: 'hours.holidays', source: 'We are closed on public holidays.' },
    { key: 'hours.call', source: 'Call us for delivery.' },
  ]);

  const pw = hashPassword('demo-localizer-pass');
  const as = (userId: number): Member => ({ ...getUser(db, userId)!, orgId: demo.orgId, role: 'localizer' });
  const volunteers = ['Ana Ruiz', 'Bea Castro', 'Carlos Díaz', 'Dani Flores', 'Elena Gómez'].map((name) => {
    const email = `${name.split(' ')[0].toLowerCase()}@demo.test`;
    const uid = Number(run(db, "INSERT INTO users (email, name, password_hash, locales) VALUES (?, ?, ?, '[\"es\"]')", email, name, pw).lastInsertRowid);
    addMembership(db, uid, demo.orgId, 'localizer');
    run(db, "INSERT INTO user_languages (user_id, locale, tier, reason) VALUES (?, 'es', 'trusted', 'demo community reviewer')", uid);
    return as(uid);
  });
  const maria = as(demo.users.maria);
  const keyId = (name: string) => get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ? AND name = ?', id, name)!.id;
  const save = (who: Member, name: string, text: string) => saveTranslation(db, project, who, keyId(name), 'es', text, false);
  const approve = (who: Member[], name: string) => who.forEach((v) => approveTranslation(db, project, v, keyId(name), 'es'));
  const [ana, bea, carlos, dani, elena] = volunteers;

  // Clean consensus: three approvals.
  save(maria, 'hours.title', 'Horario de la despensa');
  approve([ana, bea, carlos], 'hours.title');
  // Disputed: a tone flag and an Improve, then five approvals of the better wording.
  save(maria, 'hours.limit', 'Usted puede visitar una vez por semana.');
  flagTranslation(db, project, ana, keyId('hours.limit'), 'es', 'tone', 'Too formal for a pantry page');
  save(bea, 'hours.limit', 'Puedes venir una vez por semana.');
  approve([maria, ana, carlos, dani, elena], 'hours.limit');
  // Still in review, with one flag.
  save(maria, 'hours.weekdays', 'Abierto de lunes a viernes, de 9 a 5.');
  flagTranslation(db, project, dani, keyId('hours.weekdays'), 'es', 'meaning', 'Says 9 to 5 but not AM/PM');
  approve([elena], 'hours.weekdays');
}
