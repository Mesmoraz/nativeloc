import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { all, get, openDb, run, type DB } from '../src/db.js';

let app: FastifyInstance;
let db: DB;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nativeloc-'));
  ({ app, db } = await buildApp({ dbPath: ':memory:', dataDir: dir }));
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ledger kinds', () => {
  it('rebuilds an old xp_events table, keeping its rows, so check and pick XP fit', () => {
    const path = join(dir, 'old-xp.db');
    const old = openDb(path);
    const u = Number(run(old, "INSERT INTO users (email, name, password_hash) VALUES ('x@c.test', 'x', 'x')").lastInsertRowid);
    run(old, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status) VALUES (?, 'translate', 1, 'es', 1, 10, 'accepted')", u);
    old.exec('PRAGMA foreign_keys = OFF');
    old.exec(`
      CREATE TABLE xp_old (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('translate', 'review')), key_id INTEGER NOT NULL, locale TEXT NOT NULL,
        project_id INTEGER NOT NULL, points INTEGER NOT NULL CHECK (points > 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'voided')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, settled_at TEXT);
      INSERT INTO xp_old SELECT * FROM xp_events; DROP TABLE xp_events; ALTER TABLE xp_old RENAME TO xp_events;`);
    old.close();

    const db2 = openDb(path);
    expect(all(db2, 'SELECT kind, points, status FROM xp_events')).toEqual([{ kind: 'translate', points: 10, status: 'accepted' }]);
    for (const kind of ['check', 'pick']) run(db2, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status) VALUES (?, ?, 1, 'es', 1, 5, 'pending')", u, kind);
    const indexes = all<{ name: string }>(db2, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'xp_events' AND name LIKE 'xp_%'").map((r) => r.name).sort();
    expect(indexes).toEqual(['xp_one_pending', 'xp_string', 'xp_user']);
    db2.close();
  });

  it('accepts the new kinds on a fresh database', () => {
    expect(get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE name = 'xp_events'")!.sql).toContain("'pick'");
  });
});
