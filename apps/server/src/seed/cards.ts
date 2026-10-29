import { savePick } from '../cards/pick.js';
import { get, getUser, run, type DB, type Member, type ProjectRow } from '../db.js';
import { approveTranslation, saveTranslation } from '../services/review.js';
import type { Demo } from './types.js';

/**
 * Demo data for the newer card types (docs/segment-3c-card-types.md).
 *
 * - Spot the problem: two approved Spanish strings with numbers on the Eastside Food Bank page (seed/pool.ts), by
 *   Lucas, so any other Spanish volunteer can get a Spot card from them.
 * - "We are closed on public holidays" (the community project from seed/review.ts): Improved three days ago and
 *   still in review, so María gets a Pick card for it. Pick cards compete with Review cards on how long they've
 *   waited, so a fresh one would rarely make a 5-card session.
 * - "Call us for delivery": Improved, picked by three volunteers, then agreed on, so the poster's Ready to publish
 *   list shows "2 of 3 volunteers preferred this wording".
 */
export function seedCards(db: DB, demo: Demo) {
  const project = get<ProjectRow>(db, "SELECT * FROM projects WHERE bundle_token = 'pb_demo_hours'")!;
  const as = (email: string): Member => {
    const u = get<{ id: number }>(db, 'SELECT id FROM users WHERE email = ?', email)!;
    return { ...getUser(db, u.id)!, orgId: demo.orgId, role: 'localizer' };
  };
  const [ana, bea, carlos, dani, elena] = ['ana', 'bea', 'carlos', 'dani', 'elena'].map((n) => as(`${n}@demo.test`));
  const maria = as('maria@demo.test');
  const key = (name: string) => get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ? AND name = ?', project.id, name)!.id;
  const save = (who: Member, name: string, text: string) => saveTranslation(db, project, who, key(name), 'es', text, false);

  const eastside = get<ProjectRow>(db, "SELECT * FROM projects WHERE bundle_token = 'pb_demo_eastside'")!;
  const lucas: Member = { ...getUser(db, demo.users.lucas)!, orgId: eastside.org_id, role: 'reviewer' };
  const eastKey = (name: string) => get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ? AND name = ?', eastside.id, name)!.id;
  run(db, "INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, 'es', ?, 'approved', ?)", eastKey('p1'), 'Abrimos de lunes a viernes, de 9 a. m. a 5 p. m.', lucas.id);
  run(db, "INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, 'es', ?, 'approved', ?)", eastKey('p2'), 'Llame al 555-0100 para pedir una entrega a domicilio.', lucas.id);

  save(dani, 'hours.holidays', 'Cerramos los días festivos.');
  save(elena, 'hours.holidays', 'Estamos cerrados en los días feriados.');
  run(db, "UPDATE translations SET updated_at = datetime('now', '-3 days') WHERE key_id = ? AND locale = 'es'", key('hours.holidays'));

  save(carlos, 'hours.call', 'Llámanos para entregas.');
  save(ana, 'hours.call', 'Llámenos para pedir una entrega a domicilio.');
  const [now, before] = ['Llámenos para pedir una entrega a domicilio.', 'Llámanos para entregas.'];
  savePick(db, project, bea, key('hours.call'), 'es', now, before);
  savePick(db, project, dani, key('hours.call'), 'es', now, before);
  savePick(db, project, elena, key('hours.call'), 'es', before, now);
  for (const v of [bea, carlos, dani, elena, maria]) approveTranslation(db, project, v, key('hours.call'), 'es');
}
