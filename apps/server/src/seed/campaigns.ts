import { createCampaign } from '../campaigns.js';
import { get, run, type DB, type ProjectRow } from '../db.js';
import type { Demo } from './types.js';

/**
 * Demo data for campaigns and leaderboards (docs/segment-3e-campaigns-leaderboards.md).
 *
 * - A running campaign on the community hours page in Spanish, due in two days, so its bar and deadline boost show.
 * - A past campaign that launched the Community Pantry app in Spanish, with an unseen "🎉 live" message for María.
 *   It's history, so it's written directly rather than played out.
 * - María and Sam have opted in to leaderboards.
 */
export function seedCampaigns(db: DB, demo: Demo) {
  const hours = get<ProjectRow>(db, "SELECT * FROM projects WHERE bundle_token = 'pb_demo_hours'")!;
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  createCampaign(db, hours, demo.users.admin, { name: 'Get the pantry hours page live', locales: ['es'], deadline: due });

  const pantry = demo.projects.pantry;
  const id = Number(
    run(
      db,
      "INSERT INTO campaigns (project_id, name, deadline, created_by, created_at, ended_at, ended_reason) VALUES (?, 'Launch the pantry app in Spanish', date('now', '-9 days'), ?, datetime('now', '-20 days'), datetime('now', '-10 days'), 'launched')",
      pantry.id, demo.users.admin,
    ).lastInsertRowid,
  );
  run(db, "INSERT INTO campaign_locales (campaign_id, locale, launched_at) VALUES (?, 'es', datetime('now', '-10 days'))", id);
  run(db, "INSERT INTO volunteer_messages (user_id, org_id, project_id, kind, body, created_at) VALUES (?, ?, ?, 'launch', 'es', datetime('now', '-10 days'))", demo.users.maria, demo.orgId, pantry.id);

  for (const u of [demo.users.maria, demo.users.sam]) {
    run(db, 'INSERT INTO volunteer_prefs (user_id, show_on_leaderboards) VALUES (?, 1) ON CONFLICT (user_id) DO UPDATE SET show_on_leaderboards = 1', u);
  }
}
