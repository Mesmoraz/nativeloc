import type { FeatureSchema } from '../db.js';

/**
 * Favorites, Approved Reviewers, thank-you notes and the volunteer's inbox (docs/segment-3d-org-features.md).
 * Runs on every start: use CREATE ... IF NOT EXISTS.
 */
export const schema: FeatureSchema = {
  sql: `
-- An org's own recognition of volunteers (org/volunteers.ts): favorites get its cards first, Approved Reviewers
-- stand in for the poster's click. One row per org and volunteer, written the first time either is set.
CREATE TABLE IF NOT EXISTS org_volunteers (
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  favorite INTEGER NOT NULL DEFAULT 0,
  approved_reviewer INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_volunteers_user ON org_volunteers(user_id);

-- What orgs tell volunteers: thank-yous, and that they were made a favorite or an Approved Reviewer. Shown once on
-- the home screen, like new badges.
CREATE TABLE IF NOT EXISTS volunteer_messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thanks', 'favorite', 'approved_reviewer')),
  body TEXT,                     -- the note, for 'thanks'
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS volunteer_messages_user ON volunteer_messages(user_id, seen_at);

-- Thank-you notes as sent, for "last sent" and the once-a-day limit.
CREATE TABLE IF NOT EXISTS thank_yous (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  recipients INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Who published each community string, and how: the poster's click, or an Approved Reviewer (at agreement, or with
-- a Final check). Staff use it to see whether orgs rely on Approved Reviewers (Segment 3's "done when").
CREATE TABLE IF NOT EXISTS publications (
  key_id INTEGER NOT NULL,
  locale TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  user_id INTEGER,
  via TEXT NOT NULL CHECK (via IN ('poster', 'approved_reviewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS publications_project ON publications(project_id, created_at);
`,
};
