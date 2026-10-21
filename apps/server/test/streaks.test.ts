import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { all, get, openDb, run, type DB } from '../src/db.js';
import { localDay, streakOf, validTimeZone } from '../src/streaks.js';

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

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** `n` consecutive days ending on `end`. */
const days = (n: number, end: string) => Array.from({ length: n }, (_, i) => addDays(end, -i));

describe('schema', () => {
  it('has the activity table and the new prefs columns', () => {
    const cols = (t: string) => all<{ name: string }>(db, `PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols('volunteer_activity')).toEqual(['user_id', 'day', 'kind', 'key_id', 'locale', 'project_id', 'role', 'created_at']);
    expect(cols('volunteer_prefs')).toEqual(expect.arrayContaining(['time_zone', 'daily_goal']));
  });

  it('only allows the preset goals', () => {
    const id = Number(run(db, "INSERT INTO users (email, name, password_hash) VALUES ('goal@x.test', 'g', 'x')").lastInsertRowid);
    expect(() => run(db, 'INSERT INTO volunteer_prefs (user_id, daily_goal) VALUES (?, 4)', id)).toThrow();
    run(db, 'INSERT INTO volunteer_prefs (user_id, daily_goal) VALUES (?, 10)', id);
    expect(get<{ g: number }>(db, 'SELECT daily_goal AS g FROM volunteer_prefs WHERE user_id = ?', id)!.g).toBe(10);
  });

  it('fills in history from xp_events once, on their UTC day', () => {
    const path = join(dir, 'fill.db');
    const old = openDb(path);
    const u = Number(run(old, "INSERT INTO users (email, name, password_hash) VALUES ('old@x.test', 'o', 'x')").lastInsertRowid);
    old.exec('DROP TABLE volunteer_activity');
    run(old, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at) VALUES (?, 'translate', 1, 'es', 1, 10, 'pending', '2026-10-01 23:30:00')", u);
    run(old, "INSERT INTO xp_events (user_id, kind, key_id, locale, project_id, points, status, created_at) VALUES (?, 'review', 2, 'es', 1, 5, 'voided', '2026-10-02 08:00:00')", u);
    old.close();
    const rows = () => {
      const d = openDb(path);
      const r = all<{ day: string; kind: string; role: string | null }>(d, 'SELECT day, kind, role FROM volunteer_activity ORDER BY day');
      d.close();
      return r;
    };
    const want = [
      { day: '2026-10-01', kind: 'translate', role: null },
      { day: '2026-10-02', kind: 'review', role: null },
    ];
    expect(rows()).toEqual(want);
    expect(rows()).toEqual(want);
  });
});

describe('days', () => {
  it('knows real time zones', () => {
    expect(validTimeZone('America/Los_Angeles')).toBe(true);
    for (const tz of ['Mars/Olympus', '', '-07:00']) expect(validTimeZone(tz)).toBe(false);
  });

  it('gives the local day, or the UTC day without a usable zone', () => {
    const at = Date.UTC(2026, 9, 21, 3);
    expect(localDay('America/Los_Angeles', at)).toBe('2026-10-20');
    expect(localDay(null, at)).toBe('2026-10-21');
    expect(localDay('Mars/Olympus', at)).toBe('2026-10-21');
  });
});

describe('streakOf', () => {
  const T = '2026-10-21';
  const Y = addDays(T, -1);
  const s = (d: string[]) => streakOf(d, T);

  it('starts empty', () => expect(s([])).toEqual({ current: 0, freezes: 0, activeToday: false, lastFreezeUsed: null }));
  it('counts today', () => expect(s([T])).toMatchObject({ current: 1, activeToday: true }));
  it('stays alive until today is over', () => expect(s([Y])).toMatchObject({ current: 1, activeToday: false }));
  it('resets on a missed day with no freeze', () => expect(s([...days(3, addDays(T, -2)), T])).toMatchObject({ current: 1, freezes: 0 }));
  it('earns a freeze every 7 days, up to 2', () => {
    expect(s(days(7, Y))).toMatchObject({ current: 7, freezes: 1 });
    expect(s(days(14, Y))).toMatchObject({ current: 14, freezes: 2 });
    expect(s(days(21, Y))).toMatchObject({ current: 21, freezes: 2 });
  });
  it('earns on today only once today is over', () => {
    expect(s(days(7, T))).toMatchObject({ current: 7, freezes: 0 });
    expect(streakOf(days(7, T), addDays(T, 1))).toMatchObject({ current: 7, freezes: 1 });
  });
  it('uses a freeze on a missed day and holds the count', () => {
    expect(s([...days(7, addDays(T, -2)), T])).toEqual({ current: 8, freezes: 0, activeToday: true, lastFreezeUsed: Y });
  });
  it('resets when the freezes run out', () => {
    expect(s([...days(14, addDays(T, -4)), T])).toMatchObject({ current: 1, freezes: 0 });
  });
  it("doesn't count a frozen day toward the next freeze", () => {
    expect(s([...days(7, addDays(T, -8)), ...days(6, Y)])).toMatchObject({ current: 13, freezes: 0 });
    expect(s([...days(7, addDays(T, -9)), ...days(7, Y)])).toMatchObject({ current: 14, freezes: 1 });
  });
  it('handles a recorded day after today (flying west)', () => {
    expect(s([...days(3, T), addDays(T, 1)])).toMatchObject({ current: 4, freezes: 0, activeToday: true });
  });
});
