import { getUser, get, run, type DB } from '../db.js';
import { issueCertificate } from '../certificates.js';
import type { Demo } from './types.js';

/**
 * Demo data for badges and hour certificates (docs/segment-3b-badges.md). Runs after the streaks seed. Badges aren't
 * pre-awarded: the first stats load awards them, and that "New badge" moment is the thing worth seeing.
 *
 * - María: her seeded streak days were real work, so they become accepted translations. That's enough for a
 *   certificate, issued here through the real code path, so its public page opens from the demo.
 * - Yuki: a few accepted Japanese translations. She's the demo's only Japanese volunteer, so they earn Rare voice.
 */
export function seedBadges(db: DB, demo: Demo) {
  const { maria, yuki } = demo.users;
  run(
    db,
    `INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at, settled_at)
     SELECT user_id, 'translate', key_id, locale, project_id, 10, 'accepted', day || ' 12:00:00', day || ' 18:00:00'
     FROM volunteer_activity WHERE user_id = ? AND day < date('now')`,
    maria,
  );

  const eastside = get<{ id: number }>(db, "SELECT id FROM projects WHERE bundle_token = 'pb_demo_eastside'")!.id;
  const keys = [1, 2, 3].map((i) => get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ? AND name = ?', eastside, `p${i}`)!.id);
  const ja = ['月曜日から金曜日まで、午前9時から午後5時まで営業しています。', '宅配をご希望の方は555-0100にお電話ください。', '食料を受け取るのに身分証明書は必要ありません。'];
  keys.forEach((keyId, i) => {
    run(db, "INSERT INTO translations (key_id, locale, text, status, updated_by) VALUES (?, 'ja', ?, 'approved', ?)", keyId, ja[i], yuki);
    run(
      db,
      `INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at, settled_at)
       VALUES (?, 'translate', ?, 'ja', ?, 10, 'accepted', datetime('now', '-17 days'), datetime('now', '-16 days'))`,
      yuki, keyId, eastside,
    );
  });

  issueCertificate(db, getUser(db, maria)!, {});
}
