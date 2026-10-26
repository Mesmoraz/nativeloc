import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { numbersIn, plant } from '../src/cards/spot.js';
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

describe('numbers', () => {
  it('finds numbers in any digit script, by digit value', () => {
    expect(numbersIn('Call 555-0100 by 5 PM').map((n) => n.value)).toEqual(['555', '0100', '5']);
    expect(numbersIn('حتى الساعة ٥').map((n) => n.value)).toEqual(['5']);
    expect(numbersIn('午後５時まで').map((n) => n.value)).toEqual(['5']);
    expect(numbersIn('no numbers')).toEqual([]);
  });

  const once = () => 0; // always the first candidate

  it('changes one shared number, adding 1 to its last digit', () => {
    expect(plant('Open until 5 PM', 'Abierto hasta las 5 p. m.', once)).toEqual({ shown: 'Abierto hasta las 6 p. m.', original: '5', changed: '6' });
    expect(plant('Call 555-0109', 'Llame al 555-0109', () => 0.99)).toEqual({ shown: 'Llame al 555-0100', original: '0109', changed: '0100' });
  });

  it("keeps the digit's script", () => {
    expect(plant('Open until 5', 'مفتوح حتى ٥', once)).toEqual({ shown: 'مفتوح حتى ٦', original: '٥', changed: '٦' });
    expect(plant('Until 5', '５時まで', once)?.shown).toBe('６時まで');
  });

  it("won't plant a number the source also has, or without a shared number", () => {
    expect(plant('Open 5 to 6', 'Abierto de 5 a 6', () => 0)).toEqual({ shown: 'Abierto de 5 a 7', original: '6', changed: '7' });
    expect(plant('Open 5 or 6', 'Abierto 5', once)).toBeNull();
    expect(plant('Open until five', 'Abierto hasta las 5', once)).toBeNull();
    expect(plant('Hello', 'Hola', once)).toBeNull();
  });
});
