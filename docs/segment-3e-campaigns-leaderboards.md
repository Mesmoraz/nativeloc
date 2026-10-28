# Segment 3E: campaigns, progress bars and org leaderboards

Piece E of Segment 3 ([platform-vision.md](platform-vision.md) §4, §5 and §9). The last piece of Segment 3:
- **Campaigns**, with a shared progress bar and a finish line. Program-design §2: "Time-boxed campaigns, not an
  endless queue … a clear finish line, and the launch is announced to the volunteers who did it."
- **Team progress bars** per language community and per campaign.
- **Org leaderboards** that volunteers choose to appear on.

Leagues stay in Segment 4.

## Built

Where each piece lives, and what differs from the design below:

- **Data:** `apps/server/src/schema/campaigns.ts`, with the tables, the `volunteer_messages` rebuild and the
  leaderboard opt-in column. Piece D's `CREATE TABLE` gained `'launch'` for new databases.
- **Campaigns:** `apps/server/src/campaigns.ts`.
  - `afterApproved` runs at each of the six approval points in `services/review.ts`.
  - Routes are in `routes/org.ts`.
  - `campaignsFor` feeds the stats route.
- **Sessions:**
  - `campaignBoost` in `pool/score.ts`.
  - `Source.campaign`, and each card's `campaign` line, in `pool/session.ts`. `sources` is now exported.
- **Leaderboards:** `apps/server/src/leaderboards.ts`. Routes are in `routes/org.ts` and `routes/volunteer.ts`;
  `showOnLeaderboards` is in the volunteer settings.
- **Web:**
  - `CampaignCard` in `admin/Overview.tsx`; `TopTranslators` in `admin/Team.tsx`.
  - `Campaigns` and the launch message in `VolunteerApp.tsx`; the card line in `CardHead`.
  - `Leaderboards` in `Achievements.tsx`.
- **Demo:** `apps/server/src/seed/campaigns.ts`.
- **Tests:** `apps/server/test/campaigns.test.ts`, 10 tests. Settings assertions in `streaks.test.ts` and
  `pool.test.ts` gained `showOnLeaderboards`.
- **Differences from the design:**
  - **Launches run after XP settles.** At first the launch check ran before some paths settled XP, so the
    volunteer whose string finished the language wasn't told. Now every path checks after XP settles.
  - **`daysLeft` is calendar days** (due tomorrow is 1, due today is 0), not hours rounded up.
  - **Campaigns are added in the stats route, not in `stats()`.** `xp.ts` importing the session code made an
    import cycle, and the `services.ts` re-exports weren't ready when the routes loaded, which broke 84 tests.
  - **A language that's already fully translated can't be put in a campaign** (400). It would launch the moment
    the campaign started.
  - **The past campaign in the demo is written directly,** because it's history.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | What a campaign is | **A project, in one or more of its languages, with a deadline.** Progress per language is approved strings ÷ the project's strings, computed live. A language **launches** at 100%, and everyone with accepted work on it gets a "🎉 Launched!" message. The campaign's cards get a deadline boost that grows from +0 to +72 hours over its last three days. | A project already is what small orgs post (a page, a flyer, a site), so no new way to group strings is needed. The launch is the finish line program-design asks for. `score.ts` already plans for a deadline boost. |
| 2 | How leaderboards work | **Off by default; a volunteer opts in once.** Per org, per calendar month (UTC), ranked by **accepted translated words** (counted from the English source). The top 10 opted-in volunteers show as "María L.", then "and 6 more volunteers". Shown to the org's admins and to volunteers who've worked for it; never public. Reviews aren't ranked. | §4 warns that older native speakers "are often put off by public rankings", and program-design asks for "age-appropriate defaults" for minors. Opting in covers both without asking anyone's age. §5 says "top translators … ranked by accepted words". |

**Assumptions** (stated during design, not corrected):
- Org admins create campaigns on their own projects, from the project's languages, with a deadline at least a day
  away. One active campaign per project.
- A missed deadline closes the campaign quietly, showing how far it got. No failure screen.
- Volunteers see campaign progress on its cards and on their home screen.
- Leaderboards show this month and last month. One switch covers every org. Opting out removes you from every
  board at once, past months included.

**Calls made without asking** (open to change at review):
- **When a launch is noticed:** right after every approval in `services/review.ts`, and again whenever a campaign is
  read (that catches CLI and file imports).
- **What a language community bar is:** the sum of the active campaigns in that language. With no active
  campaigns, it isn't shown, because a bar needs a finish line.
- **What "this month" means:** the month the work was **accepted**.
- **Where the screens go:** campaigns on the project's **Overview** tab, the leaderboard on the **Team** tab, and
  the volunteer's leaderboards on **Badges & hours**.
- **Plus:** the endpoint shapes, demo data and tests.

## Campaigns

### Data (new feature schema `apps/server/src/schema/campaigns.ts`)

```sql
-- Campaigns (campaigns.ts): get a project live in some languages by a deadline. Progress is computed, not stored.
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  deadline TEXT NOT NULL,          -- YYYY-MM-DD; the campaign runs to the end of that day, UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IN ('launched', 'deadline', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS campaigns_project ON campaigns(project_id, ended_at);
CREATE TABLE IF NOT EXISTS campaign_locales (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  launched_at TEXT,                -- when it reached 100% approved
  PRIMARY KEY (campaign_id, locale)
);
```

`volunteer_messages.kind` (from piece D) gains `'launch'`. SQLite can't change a CHECK in place, so `migrate`
rebuilds the table when its SQL lacks `'launch'`.

### Logic (`apps/server/src/campaigns.ts`)

- **`createCampaign(db, project, by, { name?, locales, deadline })`:**
  - 400 when `locales` is empty or not all the project's, or when `deadline` isn't a date at least tomorrow (UTC)
  - 409 when the project already has an active campaign
  - the default name is "Get *Project* live"
- **`campaignView(db, campaign, now)`** returns, per language: `{ locale, total, approved, ready, launchedAt }`.
  It also includes `daysLeft` and `ended`.
- **`refreshCampaign(db, campaign, now)`** runs inside the callers' transactions:
  - a language at 100% approved gets `launched_at`, and every volunteer with accepted work on that project and
    language (not the org's admins or reviewers) gets one `'launch'` message
  - when every language has launched: `ended_reason = 'launched'`
  - after the deadline: `ended_reason = 'deadline'`
- **`afterApproved(db, projectId, locale)`:** refreshes the project's active campaign if it covers that language.
  It's called wherever text becomes `approved` in `services/review.ts`:
  - `saveTranslation`
  - `approveTranslation`, both outright and on the last peer vote
  - `makeReady`, when an Approved Reviewer publishes at agreement
  - `publishReady`
- **`deadlineBoost(deadline, now)`:** 0 until 72 hours before the end of the deadline day, then rising in a
  straight line to 72. Pushed onto `BOOSTS` in `score.ts` as `campaignBoost`. `buildSession` passes it for
  Translate, Review, Pick and Final check candidates in a campaign's project and languages.

### API

- `GET /api/v1/projects/:id/campaign` (org admin) → `{ active: CampaignView | null, past: CampaignView[] }`.
- `POST /api/v1/projects/:id/campaign` `{ name?, locales, deadline }` → `CampaignView`.
- `DELETE /api/v1/projects/:id/campaign` cancels the active one.
- `GET /volunteer/stats` gains:
  - `campaigns`: the active campaigns in projects the volunteer can draw from, in their languages. Each is
    `{ id, name, project, org, deadline, daysLeft, locales: [{ locale, total, approved }] }`.
  - `languageBars`: for each of the volunteer's languages, `{ locale, total, approved, campaigns }`, summed over
    those campaigns.
- Cards gain `campaign: { name, daysLeft, approved, total } | null` (for the card's own language).

## Org leaderboards

- `volunteer_prefs` gains `show_on_leaderboards INTEGER NOT NULL DEFAULT 0`. `VolunteerSettings` gains
  `showOnLeaderboards`, which the existing `PUT /volunteer/settings` sets.
- **`leaderboard(db, orgId, month)`** (`apps/server/src/leaderboards.ts`):
  - **Counts:** accepted `translate` XP on the org's projects whose `settled_at` falls in `month`, summing the
    words of each string's English source.
  - **The board:** the top 10 opted-in volunteers as `{ name: 'María L.', words }`, ties broken by name, plus
    `others` (everyone else with words that month, opted in or not) and `totalWords`.
  - **Left out:** the org's admins and reviewers, as everywhere.
  - **Words** are the non-empty runs between whitespace in the source text, which is English in this product. A
    string accepted twice in a month counts twice, because both were real work.
- `GET /api/v1/org/leaderboard?month=YYYY-MM` (org admin). The default is this month, and only this month and
  last month are allowed.
- `GET /api/v1/volunteer/leaderboards` → this month's board for each org the volunteer has accepted work with (up
  to 5, most work first). Each has an `you` field: your words and your place, or `null` when you've opted out.

## Web

- **Project Overview → "Campaign" card:**
  - with no active campaign: a form (name, language checkboxes, deadline date)
  - with one: a progress bar per language, "Launched 🎉" on finished ones, days left, and Cancel
  - past campaigns listed under it, with how far they got
- **Team tab → "Top translators this month":** the board, with "and 6 more volunteers", and a month switch
  (this month, last month).
- **Volunteer home:** under the streak card, "🏁 Campaigns" with one bar per active campaign (project, language,
  days left). The language community bars sit above those when the volunteer has more than one campaign in a
  language.
- **Cards:** one line, "🏁 Get Pantry hours live · 46% · 2 days left".
- **Badges & hours → "Leaderboards":** each org's board, with you highlighted, and the "Show me on leaderboards"
  switch.
- **Inbox:** `'launch'` messages read "🎉 *Pantry hours page* is live in Spanish! You helped make it happen."

## Demo data

`apps/server/src/seed/campaigns.ts`:
- **An active campaign** on the community hours page in Spanish, with the deadline two days away, so the boost and
  bars show.
- **A launched campaign** on an older project with a launch message for María, so the celebration shows.
- **Leaderboards:** María and Sam opted in.

## Tests (`apps/server/test/campaigns.test.ts`)

- **Creating campaigns:**
  - validation: languages, a past or today deadline, a second active campaign
  - a non-admin gets 404 (the repo's convention)
  - cancelling
- **Progress and launch:**
  - progress counts approved strings, with ready strings shown separately
  - approving the last string launches the language, from each approval path
  - one launch message per volunteer, none to admins or reviewers
  - all languages launched ends the campaign
  - a read after the deadline ends it as `'deadline'`
- **Deadline boost:** 0 at 4 days out, 36 at 36 hours, 72 at the end. A campaign string outranks an equal
  non-campaign one inside the window.
- **Stats:** `campaigns` and `languageBars` for a volunteer; cards carry `campaign`.
- **Leaderboards:**
  - words summed from the source
  - this month only
  - only opted-in volunteers named, the rest counted in `others`
  - top 10 only
  - admins and reviewers left out
  - `month` validation
  - the volunteer view's `you` field
- **Migration:** an old `volunteer_messages` table is rebuilt with its rows, and a `'launch'` row then inserts.

Web: `npm run typecheck`, and a run in Chromium and in the online demo build:
- as the admin: create a campaign, see its bars, and see the leaderboard
- as María: campaign bars on Home, the campaign line on a card, the launch message, and her leaderboard with the
  opt-in switch

## Doc changes

`platform-vision.md` §9: link here, and say Segment 3 is complete apart from its "done when", which needs real
use.
