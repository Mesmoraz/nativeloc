# Segment 3D: favorites, Approved Reviewers and thank-you notes

Piece D of Segment 3 ([platform-vision.md](platform-vision.md) §5 and §9): ways for an organization to recognise
and trust the volunteers who work on its content. Segment 3 is done when "at least one pilot org uses Approved
Reviewers instead of checking every string itself", so this piece also gives staff a way to see that happening.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | What an Approved Reviewer's approval does | It **stands in for the poster's click**, after the normal review rounds. When a community string reaches agreement and one of its approvals came from an Approved Reviewer for that org, it goes straight to `approved` instead of the Ready list. Approved Reviewers also get **Final check** cards for strings already on the Ready list: Publish, or Send back. | §5 says their approval "counts as the poster's vetting", and vetting is the step after the rounds. The 3 to 5 independent reviews still happen, so one person never decides alone. Making it an outright approval would let one person replace those reviews and duplicate member reviewers. |
| 2 | What favorites get | A **+48-hour boost** on the starring org's cards in the favorite's sessions (the same as high priority). The volunteer is told. | "First" means ranked higher. Nothing is held back from anyone else, so work never waits on an inactive favorite. `score.ts` already plans for this boost. |
| 3 | What a thank-you goes to | **A project**. An org admin writes a short note, and it goes to every volunteer with accepted work on that project since its last thank-you. At most one per project per day. | Campaigns don't exist yet, and building them is bigger than the rest of this piece. For a small org, a project already is the campaign: one page or one flyer. |

**Assumptions** (stated during design, not corrected):
- Approved Reviewers apply to **community-review projects only**. Standard projects already have member reviewers.
- An org admin picks Approved Reviewers and favorites from **volunteers with accepted work on the org's projects**.
  Nobody applies.
- Being an Approved Reviewer is per org and changes no platform tier. Removing someone takes effect at once and
  doesn't undo what they published.
- An Approved Reviewer must be at least **Trusted** in the language to act as one there.
- Favorites and Approved Reviewers are separate.
- Favorite boosts don't stack beyond +48 and don't apply to Spot the problem cards.
- Thank-you notes are one-way, from any admin of the org, not checked by staff, up to 280 characters. They don't
  go to Spot the problem practice or to the org's own admins and reviewers.

**Calls made without asking** (open to change at review):
- one inbox for things orgs tell volunteers (thank-yous, "you're a favorite", "you're an Approved Reviewer")
- XP for Final check cards
- the staff measure of Approved Reviewer use
- that members of the org aren't listed (they already have roles)
- where the screens live, the endpoint shapes, the demo data and the tests

## Data

New feature schema `apps/server/src/schema/orgVolunteers.ts`:

```sql
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
```

## Approved Reviewers

`apps/server/src/org/volunteers.ts`:
- `isApprovedReviewer(db, orgId, user, locale)`: the row says so **and** the volunteer is at least Trusted in
  `locale`.
- **At agreement** (`makeReady` in `services/review.ts`): if any counted, current approval of the final text came
  from an Approved Reviewer for the project's org, the string goes to `approved` instead of `ready`. It's recorded
  in `approvers` (for the manifest's "Checked by") and in `publications` with `via 'approved_reviewer'`. XP
  settles as it does today.
- **The poster's click** (`publishReady`) writes `publications` with `via 'poster'` for each string it publishes.

### Final check cards

- **Dealt to:** an Approved Reviewer for that org, at least Trusted in the language, who didn't write the current
  text.
- **Which strings:** `ready` strings in the org's community projects.
- **Slot and scoring:** they take a Review slot, like Pick cards, scored by how long they've waited on the Ready
  list (`translations.updated_at`).
- **The card shows:** the source, the text, the review summary (reviews, approvals, flags, picks) and the poster's
  earlier send-back note, if any.
- **`POST /api/v1/translations/:keyId/:locale/final`** `{ decision: 'publish' | 'send_back', note? }`:
  - `publish` calls `publishReady` for that one string, with `via 'approved_reviewer'`.
  - `send_back` calls the existing `sendBack`, with the note.
  - Either decision earns 5 accepted `review` XP (it's real review work, and final) and records review activity.
  - 403 when you're not an Approved Reviewer there. 409 when the string isn't `ready` anymore.

## Favorites

- `score.ts` gains a `favorite` boost of +48, pushed onto `BOOSTS`.
- `buildSession` loads the orgs that have starred the volunteer once per session and passes `favorite` to
  `score()` for those orgs' Translate, Review, Pick and Final check candidates. Spot cards are dealt separately, so
  they're unaffected.
- `CardOrg` gains `favorite: boolean`, so a card can say "⭐ You're a favorite here".

## Thank-you notes

`apps/server/src/org/thanks.ts`:
- **Recipients:** distinct users with accepted `translate`, `review` or `pick` XP on the project, created after the
  project's last thank-you (or ever, for the first), minus members of the org with the `admin` or `reviewer` role.
- **`GET /api/v1/projects/:id/thanks`** (org admin) → `{ recipients, lastSentAt, nextAllowedAt }`, so the screen
  can say "This goes to 7 volunteers".
- **`POST /api/v1/projects/:id/thanks`** `{ body }` (org admin):
  - 400 when the note is empty or over 280 characters
  - 409 when nobody is waiting for thanks
  - 429 within 24 hours of the last one
  - writes `thank_yous` plus one `volunteer_messages` row per recipient, and returns `{ recipients }`

## The volunteer's inbox

- `GET /volunteer/stats` gains `messages`: unseen messages, oldest first, each
  `{ id, kind, org: { id, name }, project: { id, name } | null, body, createdAt }`.
- `POST /api/v1/volunteer/messages/seen` `{ ids }`.
- **The home screen** shows each message once, under the new-badge banner, then marks them seen:
  - "💌 Eastside Food Bank: *Thank you! Our hours page is now in Spanish.*"
  - "⭐ Eastside Food Bank made you a favorite. You'll see their work first."
  - "✅ Eastside Food Bank made you an Approved Reviewer. Your approval can now publish their text."
- **Setting favorite or Approved Reviewer** (off to on) writes a message. Turning it off writes none.

## The org's side

`GET /api/v1/org/volunteers` (admin of the current org) lists volunteers with accepted work on the org's
projects, excluding the org's own members:
`{ id, name, locales, tiers, accepted, lastActive, favorite, approvedReviewer }[]`, most accepted work first.

`PUT /api/v1/org/volunteers/:userId` `{ favorite?, approvedReviewer? }` sets either one:
- 404 for someone not on that list
- an Approved Reviewer who isn't Trusted in any of the org's languages is allowed, but the list warns that it
  won't take effect until they are

**Web:** the project admin's **Team** tab gains two cards.
- **"Volunteers who've helped you":** the list, with ⭐ and "Approved Reviewer" toggles, and a short explanation
  of each.
- **"Thank your volunteers":** a note box with a suggested text, the recipient count, and Send, disabled with the
  reason when not allowed.

## Staff

`GET /api/v1/staff/engagement` gains `approvedReviewers`: per org that has any, the last 30 days of community
publications split `{ org, viaApprovedReviewer, viaPoster }`. The Return rates tab shows it as a second small
table. "At least one pilot org uses Approved Reviewers" is then a row where most publications come from Approved
Reviewers.

## Demo data

`apps/server/src/seed/orgVolunteers.ts`:
- **Ana:** an Approved Reviewer for FreshMart Demo. Ana is Trusted in Spanish.
- **María:** a favorite of FreshMart Demo. She gets an unseen "favorite" message and an unseen thank-you for the
  community hours page.
- **One string on the Ready list,** for Ana's Final check card. The hours-page strings already reach `ready`,
  which gives one.
- **Publications history:** some by Ana, some by the poster, so the staff table has data.

## Tests (`apps/server/test/orgVolunteers.test.ts`)

- **Agreement:**
  - with an Approved Reviewer's approval among the counted ones → `approved`, plus an `approvers` row and a
    `publications` row via `approved_reviewer`
  - without one → `ready`
  - an Approved Reviewer who's only `new` in the language doesn't count
  - another org's Approved Reviewer doesn't count
- **Final check, dealing:** dealt only to an Approved Reviewer, only for `ready` strings in that org's community
  projects, never for their own text.
- **Final check, deciding:**
  - publish → `approved`, a publication via `approved_reviewer`, accepted review XP and activity
  - send back → `review`, with the note
  - 403 for a non-Approved Reviewer; 409 when the string isn't `ready`
- **Favorites:**
  - a favorite's session ranks the starring org's string above an otherwise equal one
  - the card says `favorite: true`
  - no boost for other orgs, and none for Spot cards
- **Thank-yous:**
  - the recipients are exactly the volunteers since the last thanks, not admins, not reviewers, and not Spot-only
    practice
  - 400 for an empty or over-long note; 409 with nobody to thank; 429 within a day
  - non-admin → 403
  - messages arrive in stats and clear when seen
- **The org's list and settings:**
  - only volunteers with accepted work, no members
  - 404 for others
  - a message on off-to-on only
  - another org's admin can't set yours
- **Publications:** the poster's click records `via 'poster'`, and staff engagement splits the two.

Web: `npm run typecheck`, and a run in Chromium:
- as the admin: the Team tab's volunteer list, the toggles and a thank-you
- as María: her messages on Home and the ⭐ on a card
- as Ana: a Final check card, published
- as staff: the Approved Reviewer table

Also in the online demo build.

## Doc changes

`platform-vision.md` §9: link here. Note that campaigns, and thanking by campaign, move to piece E with campaign
progress bars.
