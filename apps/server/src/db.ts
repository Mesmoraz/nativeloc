import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// Loaded via require so bundlers/test runners that don't know `node:sqlite` leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type DB = DatabaseSyncT;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reviewer', 'localizer')),
  locales TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  role TEXT NOT NULL,
  locales TEXT NOT NULL DEFAULT '[]',
  email TEXT,
  expires_at INTEGER NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  source_locale TEXT NOT NULL,
  bundle_token TEXT NOT NULL UNIQUE,
  require_review INTEGER NOT NULL DEFAULT 1,
  peer_approvals INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS project_locales (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  PRIMARY KEY (project_id, locale)
);
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  prev_source TEXT,
  description TEXT,
  max_length INTEGER,
  meta TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS translations (
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('outdated', 'review', 'approved')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_id, locale)
);
-- Peer review: approvals of the current text by people other than its author. Cleared when the text changes.
CREATE TABLE IF NOT EXISTS votes (
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_id, locale, user_id)
);
-- Reusable sign-up links for volunteers. Anyone with the link joins as a localizer.
CREATE TABLE IF NOT EXISTS join_links (
  code TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  locales TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at TEXT
);
-- Trust per language. No row means the default for the role (see tierOf): people an admin
-- invited are vetted already; volunteers from a sign-up link start as 'new'.
CREATE TABLE IF NOT EXISTS user_languages (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('new', 'trusted', 'lead')),
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, locale)
);
-- Placement check content. 'translate': write a translation, a grader compares it with the reference.
-- 'review': judge the candidate translation; has_error says whether a problem was planted (graded automatically).
CREATE TABLE IF NOT EXISTS placement_items (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  locale TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('translate', 'review')),
  source TEXT NOT NULL,
  reference TEXT,
  candidate TEXT,
  has_error INTEGER NOT NULL DEFAULT 0,
  error_note TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS placement_attempts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted', 'passed', 'failed')),
  review_correct INTEGER,
  review_total INTEGER,
  graded_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TEXT,
  graded_at TEXT
);
CREATE TABLE IF NOT EXISTS placement_answers (
  attempt_id INTEGER NOT NULL REFERENCES placement_attempts(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES placement_items(id),
  position INTEGER NOT NULL,
  text TEXT,
  verdict TEXT CHECK (verdict IN ('ok', 'problem')),
  explanation TEXT,
  correct INTEGER,
  grader_note TEXT,
  PRIMARY KEY (attempt_id, item_id)
);
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  label TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Boxes are stored as fractions of the image so they survive resizing.
CREATE TABLE IF NOT EXISTS screenshot_keys (
  screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  x REAL, y REAL, w REAL, h REAL,
  PRIMARY KEY (screenshot_id, key_id)
);
CREATE TABLE IF NOT EXISTS releases (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  locale TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  completeness REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, version, locale)
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS translations_locale ON translations(locale, status);
CREATE INDEX IF NOT EXISTS keys_project ON keys(project_id, archived);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Columns added after a table was first shipped; CREATE TABLE IF NOT EXISTS won't add them to old databases. */
function migrate(db: DB) {
  const cols = (table: string) => new Set(all<{ name: string }>(db, `PRAGMA table_info(${table})`).map((c) => c.name));
  if (!cols('projects').has('peer_approvals')) db.exec('ALTER TABLE projects ADD COLUMN peer_approvals INTEGER NOT NULL DEFAULT 0');
}

type Param = string | number | bigint | null | Uint8Array;

export function get<T>(db: DB, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(db: DB, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(db: DB, sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params);
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface UserRow {
  id: number;
  org_id: number;
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'reviewer' | 'localizer';
  locales: string;
}
export interface ProjectRow {
  id: number;
  org_id: number;
  name: string;
  source_locale: string;
  bundle_token: string;
  require_review: number;
  peer_approvals: number;
  version: number;
}
export interface KeyRow {
  id: number;
  project_id: number;
  name: string;
  source: string;
  prev_source: string | null;
  description: string | null;
  max_length: number | null;
  meta: string | null;
  archived: number;
}
export interface TranslationRow {
  key_id: number;
  locale: string;
  text: string;
  status: 'outdated' | 'review' | 'approved';
  updated_by: number | null;
}
