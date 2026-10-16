import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { schema as moderationSchema } from './schema/moderation.js';
import { schema as poolSchema } from './schema/pool.js';
import { schema as postingSchema } from './schema/posting.js';
import { schema as reviewSchema } from './schema/review.js';
import { schema as signupSchema } from './schema/signup.js';

// Loaded via require so bundlers/test runners that don't know `node:sqlite` leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type DB = DatabaseSyncT;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type TEXT NOT NULL DEFAULT 'small_org' CHECK (type IN ('nonprofit', 'individual', 'small_org', 'business')),
  verification TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified', 'pending', 'verified', 'rejected')),
  ein TEXT,
  website TEXT,
  description TEXT
);
-- Accounts are global; what someone may do in an org comes from memberships. org_id and role are the
-- pre-Segment 2 single org and role: nullable, never read, and kept until every database has migrated.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  org_id INTEGER REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT CHECK (role IN ('admin', 'reviewer', 'localizer')),
  locales TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_staff INTEGER NOT NULL DEFAULT 0
);
-- A person's role in an org; they can have several. 'localizer' means the org's own translator (it opens the
-- org's private projects). Volunteering on public work needs no membership.
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reviewer', 'localizer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS memberships_org ON memberships(org_id, role);
-- org_id: the org this sign-in is working in (see currentMember in auth.ts); NULL means the first membership.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  org_id INTEGER REFERENCES orgs(id) ON DELETE SET NULL
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  moderation TEXT NOT NULL DEFAULT 'none' CHECK (moderation IN ('none', 'pending', 'approved', 'rejected')),
  review_mode TEXT NOT NULL DEFAULT 'standard' CHECK (review_mode IN ('standard', 'community')),
  site_url TEXT,
  preview_token TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_preview_token ON projects(preview_token);
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
-- 'ready': community review agreed on the text and it waits for the poster to publish it. Bundles ship only 'approved'.
CREATE TABLE IF NOT EXISTS translations (
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('outdated', 'review', 'ready', 'approved')),
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
-- Trust per language. No row means 'new' (see tierOf). Invites write the inviting org's vouch (vouchFor);
-- sign-up links and self-serve accounts start at 'new' until the placement check.
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
-- Volunteer XP as a ledger (see xp.ts): totals are sums, never stored counters. key_id and project_id carry no
-- foreign keys on purpose, so accepted XP outlives the strings it was earned on.
CREATE TABLE IF NOT EXISTS xp_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('translate', 'review')),
  key_id INTEGER NOT NULL,
  locale TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'voided')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT
);
-- One pending event per person per string and kind: re-saving your own text doesn't stack.
CREATE UNIQUE INDEX IF NOT EXISTS xp_one_pending ON xp_events(user_id, key_id, locale, kind) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS xp_string ON xp_events(key_id, locale, status);
CREATE INDEX IF NOT EXISTS xp_user ON xp_events(user_id, status);
CREATE INDEX IF NOT EXISTS translations_locale ON translations(locale, status);
CREATE INDEX IF NOT EXISTS keys_project ON keys(project_id, archived);
`;

/**
 * Legacy bridge: a user row written the pre-Segment 2 way (with org_id and role) still gets its membership,
 * so old scripts and fixtures keep working. App code adds memberships itself. Goes when the columns go.
 */
const TRIGGERS = `
DROP TRIGGER IF EXISTS users_legacy_membership;
CREATE TRIGGER users_legacy_membership AFTER INSERT ON users
WHEN NEW.org_id IS NOT NULL AND NEW.role IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO memberships (user_id, org_id, role) VALUES (NEW.id, NEW.org_id, NEW.role);
  INSERT OR IGNORE INTO user_languages (user_id, locale, tier, reason)
  SELECT NEW.id, value, CASE NEW.role WHEN 'localizer' THEN 'trusted' ELSE 'lead' END, 'vouched by their org (legacy insert)'
  FROM json_each(NEW.locales);
END;
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const existing = new Set(all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name));
  migrate(db, existing);
  db.exec(SCHEMA);
  migrateAfter(db, existing);
  db.exec(TRIGGERS);
  for (const feature of FEATURE_SCHEMAS) {
    if (feature.sql) db.exec(feature.sql);
    feature.migrate?.(db);
  }
  return db;
}

const cols = (db: DB, table: string) => new Map(all<{ name: string; notnull: number }>(db, `PRAGMA table_info(${table})`).map((c) => [c.name, c]));
const tableSql = (db: DB, table: string) => get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql ?? '';

/**
 * Changes to tables that already shipped; CREATE TABLE IF NOT EXISTS won't apply them to old databases.
 * Runs before SCHEMA, so SCHEMA's indexes can use the new columns.
 */
function migrate(db: DB, existing: Set<string>) {
  if (!existing.has('users')) return; // a new database: SCHEMA creates everything in its current shape
  const add = (table: string, column: string, ddl: string) => {
    if (!cols(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  add('projects', 'peer_approvals', 'INTEGER NOT NULL DEFAULT 0');
  // Hosted preview: the organization's website, and the unguessable token in the private preview address.
  add('projects', 'site_url', 'TEXT');
  add('projects', 'preview_token', 'TEXT');

  // Segment 2: orgs describe themselves; projects say who sees them and how they're reviewed; sign-ins remember an org.
  add('orgs', 'type', "TEXT NOT NULL DEFAULT 'small_org' CHECK (type IN ('nonprofit', 'individual', 'small_org', 'business'))");
  add('orgs', 'verification', "TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified', 'pending', 'verified', 'rejected'))");
  add('orgs', 'ein', 'TEXT');
  add('orgs', 'website', 'TEXT');
  add('orgs', 'description', 'TEXT');
  add('projects', 'visibility', "TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'))");
  add('projects', 'moderation', "TEXT NOT NULL DEFAULT 'none' CHECK (moderation IN ('none', 'pending', 'approved', 'rejected'))");
  add('projects', 'review_mode', "TEXT NOT NULL DEFAULT 'standard' CHECK (review_mode IN ('standard', 'community'))");
  add('sessions', 'org_id', 'INTEGER REFERENCES orgs(id) ON DELETE SET NULL');

  // SQLite can't relax NOT NULL or change a CHECK in place, so these two tables are rebuilt
  // (https://sqlite.org/lang_altertable.html#otheralter). Foreign keys are off while the old table is swapped out.
  const usersOld = cols(db, 'users').get('org_id')?.notnull === 1;
  const translationsOld = !tableSql(db, 'translations').includes("'ready'");
  if (!usersOld && !translationsOld) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      if (usersOld) {
        db.exec(`
          CREATE TABLE users_new (
            id INTEGER PRIMARY KEY,
            org_id INTEGER REFERENCES orgs(id),
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT CHECK (role IN ('admin', 'reviewer', 'localizer')),
            locales TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_staff INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO users_new (id, org_id, email, name, password_hash, role, locales, created_at)
            SELECT id, org_id, email, name, password_hash, role, locales, created_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
      }
      if (translationsOld) {
        db.exec(`
          CREATE TABLE translations_new (
            key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
            locale TEXT NOT NULL,
            text TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('outdated', 'review', 'ready', 'approved')),
            updated_by INTEGER REFERENCES users(id),
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (key_id, locale)
          );
          INSERT INTO translations_new (key_id, locale, text, status, updated_by, updated_at)
            SELECT key_id, locale, text, status, updated_by, updated_at FROM translations;
          DROP TABLE translations;
          ALTER TABLE translations_new RENAME TO translations;
        `);
      }
      const broken = all(db, 'PRAGMA foreign_key_check');
      if (broken.length) throw new Error(`Migration would break ${broken.length} foreign key(s); nothing was changed.`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Data migrations that need SCHEMA's new tables. */
function migrateAfter(db: DB, existing: Set<string>) {
  // Segment 2: every existing user keeps their one org and role, now as a membership.
  if (existing.has('users') && !existing.has('memberships')) {
    run(db, 'INSERT OR IGNORE INTO memberships (user_id, org_id, role, created_at) SELECT id, org_id, role, created_at FROM users WHERE org_id IS NOT NULL AND role IS NOT NULL');
    // Trust used to default from the role when there was no row; it now defaults to 'new'. Write the old default down.
    run(
      db,
      `INSERT OR IGNORE INTO user_languages (user_id, locale, tier, reason)
       SELECT u.id, l.value, CASE u.role WHEN 'localizer' THEN 'trusted' ELSE 'lead' END, 'vouched by their org before Segment 2'
       FROM users u, json_each(u.locales) l WHERE u.org_id IS NOT NULL AND u.role IS NOT NULL`,
    );
  }
}

/**
 * Each feature keeps its tables and columns in its own file (apps/server/src/schema/). They run after the core
 * schema, in this order, on every start, so their SQL must be idempotent.
 */
export interface FeatureSchema {
  sql?: string;
  migrate?: (db: DB) => void;
}
const FEATURE_SCHEMAS: FeatureSchema[] = [signupSchema, moderationSchema, reviewSchema, postingSchema, poolSchema];

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

export type Role = 'admin' | 'reviewer' | 'localizer';
export const ROLES: Role[] = ['admin', 'reviewer', 'localizer'];

/** A global account. The legacy users.org_id and users.role columns are left out on purpose: use memberships. */
export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  locales: string;
  is_staff: number;
}
/** Select users with this, never `*`, so the legacy columns can't leak into a UserRow. */
export const USER_COLUMNS = 'id, email, name, password_hash, locales, is_staff';
export const getUser = (db: DB, id: number) => get<UserRow>(db, `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id);
export const ORG_COLUMNS = 'id, name, type, verification, ein, website, description';
export const getOrg = (db: DB, id: number) => get<OrgRow>(db, `SELECT ${ORG_COLUMNS} FROM orgs WHERE id = ?`, id);

export interface MembershipRow {
  user_id: number;
  org_id: number;
  role: Role;
}
/** A user acting in one org, with their role there. Permission checks and services take this. */
export interface Member extends UserRow {
  orgId: number;
  role: Role;
}
export function memberOf(db: DB, user: UserRow, orgId: number): Member | null {
  const m = get<{ role: Role }>(db, 'SELECT role FROM memberships WHERE user_id = ? AND org_id = ?', user.id, orgId);
  return m ? { ...user, orgId, role: m.role } : null;
}
/** Adds a membership, or changes the role of an existing one. */
export function addMembership(db: DB, userId: number, orgId: number, role: Role) {
  run(db, 'INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?) ON CONFLICT (user_id, org_id) DO UPDATE SET role = excluded.role', userId, orgId, role);
}

export type OrgType = 'nonprofit' | 'individual' | 'small_org' | 'business';
export type Verification = 'unverified' | 'pending' | 'verified' | 'rejected';
export interface OrgRow {
  id: number;
  name: string;
  type: OrgType;
  verification: Verification;
  ein: string | null;
  website: string | null;
  description: string | null;
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
  site_url: string | null;
  preview_token: string | null;
  visibility: 'private' | 'public';
  moderation: 'none' | 'pending' | 'approved' | 'rejected';
  review_mode: 'standard' | 'community';
  priority: 'low' | 'normal' | 'high';
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
  status: 'outdated' | 'review' | 'ready' | 'approved';
  updated_by: number | null;
}
