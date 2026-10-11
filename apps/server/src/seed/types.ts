import type { ProjectRow } from '../db.js';

/** What the core demo seed created, handed to each piece's seeder. Ids of rows in the demo database. */
export interface Demo {
  orgId: number;
  users: { admin: number; lucas: number; maria: number; yuki: number; sam: number };
  projects: { kiosk: ProjectRow; scale: ProjectRow; signage: ProjectRow; pantry: ProjectRow };
}
