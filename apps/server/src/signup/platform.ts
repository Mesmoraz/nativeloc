import { get, run, type DB } from '../db.js';

/** The NativeLoc community org: owns the platform-wide placement check; its members grade those attempts. */
export const PLATFORM_ORG_NAME = 'NativeLoc Community';

export const platformOrgId = (db: DB): number | null => get<{ id: number }>(db, 'SELECT id FROM orgs WHERE platform = 1 ORDER BY id LIMIT 1')?.id ?? null;

/** Creates the platform org if there is none (the demo seed, tests, or a first deploy's setup script). */
export function ensurePlatformOrg(db: DB): number {
  const id = platformOrgId(db);
  if (id) return id;
  const sql = "INSERT INTO orgs (name, type, verification, description, platform) VALUES (?, 'small_org', 'verified', 'Run by the NativeLoc team.', 1)";
  return Number(run(db, sql, PLATFORM_ORG_NAME).lastInsertRowid);
}
