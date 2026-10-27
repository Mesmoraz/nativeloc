import { all, run, type DB } from '../db.js';

/** What orgs have told a volunteer and the app hasn't shown yet (docs/segment-3d-org-features.md), oldest first. */
export function messagesOf(db: DB, userId: number) {
  return all<{ id: number; kind: 'thanks' | 'favorite' | 'approved_reviewer'; org_id: number; org_name: string; project_id: number | null; project_name: string | null; body: string | null; created_at: string }>(
    db,
    `SELECT m.id, m.kind, m.org_id, o.name AS org_name, m.project_id, p.name AS project_name, m.body, m.created_at
     FROM volunteer_messages m JOIN orgs o ON o.id = m.org_id LEFT JOIN projects p ON p.id = m.project_id
     WHERE m.user_id = ? AND m.seen_at IS NULL ORDER BY m.id`,
    userId,
  ).map((m) => ({
    id: m.id,
    kind: m.kind,
    org: { id: m.org_id, name: m.org_name },
    project: m.project_id == null ? null : { id: m.project_id, name: m.project_name! },
    body: m.body,
    createdAt: m.created_at,
  }));
}

export function markMessagesSeen(db: DB, userId: number, ids: number[]) {
  for (const id of ids) run(db, 'UPDATE volunteer_messages SET seen_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND seen_at IS NULL', id, userId);
}
