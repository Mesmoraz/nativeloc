/**
 * Demo data for local development. Run `npm run seed` (`npm run seed:reset` starts over).
 *
 * Test accounts (local demo only):
 *   admin@demo.test   / demo-admin-pass      admin
 *   lucas@demo.test   / demo-reviewer-pass   reviewer   es, fr
 *   maria@demo.test   / demo-localizer-pass  localizer  es
 *   yuki@demo.test    / demo-localizer-pass  localizer  ja
 *
 * CLI / REST push token for the "FreshMart Kiosk" project: nl_demo_kiosk_push_token
 * Volunteer sign-up link (Spanish, French; the kiosk uses peer review): /join/demo-volunteers
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, sha256 } from './auth.js';
import { get, openDb, run, type ProjectRow } from './db.js';
import { importFile, publish, saveTranslation } from './services.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const dataDir = resolve(process.env.NATIVELOC_DATA ?? resolve(root, 'data'));
const dbPath = resolve(dataDir, 'nativeloc.sqlite');

if (process.argv.includes('--reset')) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) rmSync(f);
  rmSync(resolve(dataDir, 'screenshots'), { recursive: true, force: true });
}

const db = openDb(dbPath);
if (get(db, 'SELECT 1 FROM orgs')) {
  console.log('Database already has data; run `npm run seed:reset` to start over.');
  process.exit(0);
}

const orgId = Number(run(db, "INSERT INTO orgs (name) VALUES ('FreshMart Demo')").lastInsertRowid);
const user = (email: string, name: string, password: string, role: string, locales: string[]) =>
  Number(run(db, 'INSERT INTO users (org_id, email, name, password_hash, role, locales) VALUES (?, ?, ?, ?, ?, ?)', orgId, email, name, hashPassword(password), role, JSON.stringify(locales)).lastInsertRowid);

user('admin@demo.test', 'Avery Admin', 'demo-admin-pass', 'admin', []);
const lucas = user('lucas@demo.test', 'Lucas Ortega', 'demo-reviewer-pass', 'reviewer', ['es', 'fr']);
user('maria@demo.test', 'María López', 'demo-localizer-pass', 'localizer', ['es']);
user('yuki@demo.test', 'Yuki Tanaka', 'demo-localizer-pass', 'localizer', ['ja']);

function project(name: string, token: string, locales: string[]): ProjectRow {
  const id = Number(run(db, "INSERT INTO projects (org_id, name, source_locale, bundle_token) VALUES (?, ?, 'en', ?)", orgId, name, token).lastInsertRowid);
  for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', id, l);
  return get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!;
}

const kiosk = project('FreshMart Kiosk (Android)', 'pb_demo_kiosk', ['es', 'fr', 'ja', 'ru']);
const scale = project('Produce Scale (Linux)', 'pb_demo_scale', ['es', 'pl']);
const signage = project('Store Signage (web player)', 'pb_demo_signage', ['es', 'fr']);

const example = (p: string) => readFileSync(resolve(root, 'examples', p), 'utf8');
importFile(db, kiosk, example('android/res/values/strings.xml'), 'android-xml', {});
importFile(db, scale, example('linux/messages.pot'), 'po', {});
importFile(db, signage, example('json/en.json'), 'json', {});

// Volunteers can sign themselves up, and on the kiosk two of them approving a translation ships it.
run(db, "INSERT INTO join_links (code, org_id, locales) VALUES ('demo-volunteers', ?, ?)", orgId, JSON.stringify(['es', 'fr']));
run(db, 'UPDATE projects SET peer_approvals = 2 WHERE id = ?', kiosk.id);

// Spanish placement check. Volunteers from the sign-up link take it before their reviews count.
const placement = (kind: 'translate' | 'review', source: string, text: string, problem?: string) =>
  run(
    db,
    "INSERT INTO placement_items (org_id, locale, kind, source, reference, candidate, has_error, error_note) VALUES (?, 'es', ?, ?, ?, ?, ?, ?)",
    orgId, kind, source, kind === 'translate' ? text : null, kind === 'review' ? text : null, problem ? 1 : 0, problem ?? null,
  );
placement('translate', 'The food bank is open Monday through Friday, 9 AM to 5 PM.', 'El banco de alimentos está abierto de lunes a viernes, de 9 a. m. a 5 p. m.');
placement('translate', 'No ID is required to get food.', 'No se necesita identificación para recibir alimentos.');
placement('translate', 'Please bring your own bags if you can.', 'Si puede, traiga sus propias bolsas.');
placement('translate', 'Call us if you need a home delivery.', 'Llámenos si necesita entrega a domicilio.');
placement('translate', 'Anyone under 18 eats free all summer.', 'Los menores de 18 años comen gratis durante todo el verano.');
placement('review', 'We are closed on Thanksgiving Day.', 'Estamos cerrados el Día de Acción de Gracias.');
placement('review', 'You can visit once a week.', 'Puede venir una vez al mes.', '“week” became “month”');
placement('review', 'Do not share your account password.', 'Comparta la contraseña de su cuenta.', 'the “not” was dropped');
placement('review', 'Free groceries for anyone who needs them.', 'Alimentos gratis para cualquier persona que los necesite.');
placement('review', 'Appointments are available until 4 PM.', 'Hay citas disponibles hasta las 4 p. m.');
placement('review', 'Pick up your order at the side door.', 'Recoja su pedido en la puerta principal.', '“side door” became “main door”');
placement('review', 'Fresh produce arrives every Tuesday.', 'Las frutas y verduras frescas llegan todos los martes.');
placement('review', 'Applications must be received by March 1.', 'Las solicitudes deben recibirse antes del 1 de mayo.', '“March” became “May”');

run(db, 'INSERT INTO api_tokens (project_id, name, token_hash, scopes) VALUES (?, ?, ?, ?)', kiosk.id, 'demo CLI', sha256('nl_demo_kiosk_push_token'), JSON.stringify(['push']));

// Approved translations for part of the kiosk, so the device simulator visibly changes language
// right away. The rest is left untranslated so localizers have a queue to work through.
const reviewer = get<{ id: number; org_id: number; email: string; name: string; password_hash: string; role: 'reviewer'; locales: string }>(db, 'SELECT * FROM users WHERE id = ?', lucas)!;
const keyId = (p: ProjectRow, name: string) => get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ? AND name = ?', p.id, name)!.id;
const approve = (p: ProjectRow, locale: string, strings: Record<string, string>) => {
  for (const [name, text] of Object.entries(strings)) saveTranslation(db, p, reviewer, keyId(p, name), locale, text, true);
};

approve(kiosk, 'es', {
  welcome_title: '¡Hola! Toca para empezar', // the key has a max=28 hint
  checkout: 'Pagar',
  cart_total: 'Total: {arg1}',
  'departments[0]': 'Frutas y verduras',
  'departments[1]': 'Panadería',
  change_language: 'Cambiar idioma',
  yes: 'Sí',
  no: 'No',
});
approve(kiosk, 'fr', {
  welcome_title: 'Touchez pour commencer',
  checkout: 'Payer',
  yes: 'Oui',
  no: 'Non',
});
approve(signage, 'es', { 'menu.title': 'Ofertas de hoy' });
approve(scale, 'es', { 'Place item on the scale': 'Coloque el producto en la báscula' });

// Publish v1 of every project so devices have bundles to download immediately.
for (const p of [kiosk, scale, signage]) publish(db, get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', p.id)!);

console.log(`
Seeded ${dbPath}

  Web app        http://localhost:5173   (the sign-in page has one-click demo accounts)
  Kiosk device   http://localhost:5174

  admin@demo.test  / demo-admin-pass       admin
  lucas@demo.test  / demo-reviewer-pass    reviewer   es, fr
  maria@demo.test  / demo-localizer-pass   localizer  es
  yuki@demo.test   / demo-localizer-pass   localizer  ja

  Push token (CLI / kiosk capture): nl_demo_kiosk_push_token
  Volunteer sign-up: http://localhost:5173/join/demo-volunteers
`);
