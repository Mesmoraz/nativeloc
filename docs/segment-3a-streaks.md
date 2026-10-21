# Segment 3A: streaks and the daily goal

Piece A of Segment 3 ([platform-vision.md](platform-vision.md) §4 and §9). Segment 3 is done when "we see
week-over-week return rates for volunteers", and that needs a record of which days each volunteer was active.
This piece builds that record, puts a streak, streak freezes and a daily goal on the volunteer home screen, and
gives staff the return-rate table.

The other Segment 3 pieces, for reference: B badges and hour certificates, C new card types, D favorites, org
Approved Reviewers and thank-you notes, E leaderboards and progress bars.

## Built

Where each piece lives, and what differed from the design below:

- **Data:** `apps/server/src/schema/streaks.ts` (the table, the prefs columns, and the one-time fill from
  `xp_events`).
- **Logic:** `apps/server/src/streaks.ts`. It has `validTimeZone`, `localDay`, `localMidnightUtc`,
  `recordActivity`, `streakOf`, `saveTimeZone` and `returnRates`, plus the goal presets and the freeze constants
  (`FREEZE_EVERY`, `MAX_FREEZES`).
- **Recording:** six calls in `services/review.ts`, one per path in the table under Server. Each runs inside that
  path's transaction.
- **Endpoints:**
  - `stats()` in `xp.ts`
  - settings in `routes/volunteer.ts`
  - `PUT /api/v1/me/time-zone` and `/me`'s `timeZone` in `routes/auth.ts`
  - `GET /api/v1/staff/engagement` in `routes/staff.ts`
- **Web:**
  - `App.tsx` (`syncTimeZone`) saves the time zone before the app renders, so the first stats already use it.
  - `volunteer/VolunteerApp.tsx` has `StreakGoal`, `GoalBar` and `GoalPicker`.
  - `staff/StaffConsole.tsx` has the "Return rates" tab, newest week first.
- **Demo:** `apps/server/src/seed/streaks.ts`. It moves María's seed-day saves to yesterday so her home screen
  shows "today still to do".
- **Tests:** `apps/server/test/streaks.test.ts`. One existing assertion in `pool.test.ts` gained `dailyGoal`.
- **Differences from the design:**
  - `validTimeZone` also refuses offsets like `-07:00`. Node 22's `Intl` accepts them, and they're wrong half
    the year.
  - Past the goal, the bar reads "7 cards today · goal 5" instead of "7 of 5".
  - Days are stamped in the zone saved for the person. The demo's seeded days are UTC, so a browser west of UTC
    in its evening sees María's "yesterday" as today. That's the rule working as designed, not a bug.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | What makes a day count toward the streak? | At least one translation or review saved that day, in the volunteer's time zone. Pending work counts. | The streak is a habit signal; XP stays accepted-only and remains the quality signal. Counting only accepted work would let a streak break days later when a reviewer rejects that day's work. A "finished session" rule can't be met on days with fewer than 5 cards, which is common in small languages. |
| 2 | What does the daily goal count? | Cards saved today (translations and reviews), pending included. | Same rule as the streak, from the same rows. Accepted XP arrives days after the work, so an accepted-XP goal couldn't be met on the day. Minutes would need client-reported timing. |
| 3 | Do volunteers pick the goal? | Presets 3, 5, 10 or 20, in Settings. Default 5 (one "5 in 5" session). | A small-language volunteer can drop to 3. 1 would duplicate the streak. |
| 4 | Time zone | Detected by the browser and saved. Each activity is stamped with the local day **when it happens**; past days are never recomputed. | Recomputing past days with the current zone would erase a day when someone travels. Offsets (−7) break at daylight saving changes; IANA names don't. |
| 5 | Freezes and reminders in this piece? | Freezes yes. Reminders move to Segment 4. | Reminders have no channel: there's no push until Segment 4, and email only goes to the server console. Freezes need nothing outside the server, and without them one missed day resets a long streak. |
| 6 | Freezes | Earn 1 for every 7 active days in a streak; hold at most 2; used automatically on a missed day. New volunteers start with 0. | Consistency earns protection. Spending XP on freezes would lower rank for protecting a habit, mixing the two signals. |
| 7 | Return rates | Staff-only endpoint and a table in the Staff Console: the last 8 weeks. | Same pattern as the existing staff tools. Per-org numbers belong to piece E, with its privacy questions. |
| 8 | What is recorded, and whose activity counts | Every successful save, vote, flag or approval in `services/review.ts`, XP or not, with the role acted with. Return rates leave out activity as an org admin or reviewer. | `xp_events` misses real activity (below). Org admins and reviewers often do this as their job and would inflate the return rate. |

Calls made without asking (the user asked to proceed): the web layout and wording, the endpoint shapes, the
demo data, and the tests below. Each is open to change at review.

**Correction to an earlier assumption.** `xp_events` is not one row per save. Re-saving your own pending
translation books nothing (`onSave`/`onCommunitySave`), a new volunteer's uncounted flag books nothing, a community
review books at most once per person per string, and staff or community-mode outright approvals book nothing. A
day record built from `xp_events` would miss real activity, so this piece adds its own table.

**Assumptions** (stated during design, not corrected):
- No real volunteers have used the app yet, so filling in existing days from `xp_events` in UTC only affects
  development and demo databases.
- `localizer` counts as a volunteer for return rates. This isn't optional: open-pool volunteers act as `localizer`
  too (`openPoolRole` in `pool/access.ts`), so leaving localizers out would leave out every volunteer.
- Things that aren't translation or review work (reports, settings, opening a session) never count.
- Moderation that voids someone's work leaves their activity in place: they still showed up.
- Meeting the goal earns no XP or badge. Only today's goal progress is tracked; past days don't record whether the
  goal was met (that would need each day's goal saved, because changing the goal would otherwise rewrite history).
- There's no "repair a broken streak". Changing the freeze rules later recomputes everyone's history (harmless
  before launch).
- Weeks start on Monday.

**Not in this piece:** reminders (Segment 4, with push), badges for streaks (piece B), streaks shown to orgs or on
leaderboards (piece E), per-language or signup-cohort return rates (add when the basic number raises a question it
can't answer).

## Data

New feature schema `apps/server/src/schema/streaks.ts`, registered in `FEATURE_SCHEMAS` after `poolSchema` (it adds
columns to `poolSchema`'s `volunteer_prefs`).

```sql
-- What a person did, on which of their local days. One row per card per day: saving the same string
-- twice in a day counts once. Feeds streaks, the daily goal and staff return rates (see streaks.ts).
-- key_id and project_id have no foreign keys, as in xp_events, so activity outlives deleted strings.
CREATE TABLE volunteer_activity (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,          -- YYYY-MM-DD in the person's time zone when they acted
  kind       TEXT NOT NULL CHECK (kind IN ('translate', 'review')),
  key_id     INTEGER NOT NULL,
  locale     TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  role       TEXT,                   -- role acted with: admin, reviewer, localizer; NULL = unknown (filled in from old XP)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, day, kind, key_id, locale)
);
CREATE INDEX volunteer_activity_day ON volunteer_activity(day);
```

- `translate` is saving or improving a translation; `review` is a vote, flag, community approval or outright
  approval. Flagging and approving one string on the same day is one card; translating and reviewing it is two.
- The primary key makes the goal a `COUNT(*)` and a streak day "any row". Writes are `INSERT OR IGNORE`; if one card
  is touched twice in a day under different roles, the first role stays.
- The `day` index serves the staff query (9 weeks across everyone). Streak reads use the primary key.

`volunteer_prefs` gains, in `migrate` (guarded by `PRAGMA table_info`):
- `time_zone TEXT`: IANA name. NULL means UTC.
- `daily_goal INTEGER NOT NULL DEFAULT 5 CHECK (daily_goal IN (3, 5, 10, 20))`.

A volunteer has no prefs row until they change a setting, so readers default to UTC and 5.

**Filling in history.** `migrate` creates `volunteer_activity` itself (checking `sqlite_master` first), so it knows
when the table is new, and in that case copies `xp_events` once: `day = substr(created_at, 1, 10)` (the UTC day),
the same `kind`, `role = NULL`, voided events included. Old re-saves and staff approvals left no `xp_events` row
and can't be recovered.

Not stored: the streak, freezes, and whether the goal is met. They're computed when read, like XP totals.

## Server

Every translation and review write goes through `services/review.ts`. Its only route is `routes/localize.ts`,
which the volunteer cards and the dashboards both use.

New module `apps/server/src/streaks.ts`:

- `validTimeZone(tz)`: `new Intl.DateTimeFormat('en', { timeZone: tz })` doesn't throw.
- `localDay(tz, now = Date.now())`: `YYYY-MM-DD` (`en-CA` format). Null or invalid zone → UTC.
- `timeZoneOf(db, userId)`, `dailyGoalOf(db, userId)`: prefs with defaults.
- `recordActivity(db, user: Member, kind, s: StringRef, now = Date.now())`: `INSERT OR IGNORE` with
  `localDay(timeZoneOf(...))` and `user.role`. Called inside the existing `tx(...)` in `review.ts`, so activity
  and the change it records commit together:

  | Function | Kind | When |
  |---|---|---|
  | `saveTranslation` | `translate` | every successful save, both review modes |
  | `communityVote` | `review` | every successful call, a repeat approval included |
  | `flagTranslation` | `review` | counted and uncounted flags |
  | `approveTranslation`: community outright, outright, peer vote | `review` | every successful call, a duplicate vote included |

- `streakOf(days: string[], today: string)` → `{ current, freezes, activeToday, lastFreezeUsed }`. Pure. Replay
  each calendar day from the first active day to the day before `end = max(today, last active day)`:
  - active: `streak += 1`, `sinceEarn += 1`; at 7, `freezes = min(freezes + 1, 2)` and `sinceEarn = 0` (an earn
    at the cap is lost);
  - missed: with a freeze, `freezes -= 1`, the streak holds, `lastFreezeUsed = day`; without, `streak = 0`,
    `sinceEarn = 0`.

  Then `end` itself adds 1 if active and is never a miss (the day isn't over). A frozen day neither adds to the
  streak nor counts toward `sinceEarn`. `max(...)` covers flying west, when today can be earlier than a day already
  recorded. Days are calendar dates stepped with `Date.UTC`, so daylight saving can't add or drop one. Cost: one
  primary-key query plus about 365 steps per year of history.

`stats()` in `xp.ts` gains `streak` and `goal: { target, done }` (`done` = today's `volunteer_activity` rows).
"Today" XP starts at local midnight: now minus the local time of day elapsed (from `Intl`), formatted like
`CURRENT_TIMESTAMP`. On the two daylight-saving changeover days that cutoff is an hour off; it affects only the
"Today" XP figure, not streaks or the goal, which use stamped days.

## API

Types live in `apps/web/src/volunteer/types.ts` (volunteer) and `apps/web/src/contracts.ts` (staff), as now.

- **`GET /api/v1/volunteer/stats`** adds:
  ```ts
  streak: { current: number; freezes: number; activeToday: boolean; lastFreezeUsed: string | null };
  goal: { target: 3 | 5 | 10 | 20; done: number };
  ```
- **`GET/PUT /api/v1/volunteer/settings`**: `VolunteerSettings` adds `dailyGoal: 3 | 5 | 10 | 20`. PUT takes either
  field or both; 400 if neither is given, or "Daily goal must be 3, 5, 10 or 20."
- **`PUT /api/v1/me/time-zone`** `{ timeZone }` → `{ timeZone }`. Any signed-in user. 400 "That isn't a time zone we
  know." if invalid. Writes only when it differs from the saved value. `GET /api/v1/me` adds `timeZone: string | null`.
- **`GET /api/v1/staff/engagement`** (staff only, 403 otherwise):
  ```ts
  interface EngagementResponse {
    /** Oldest first. `start` is a Monday. `returned`: active in this week and the next. */
    weeks: { start: string; active: number; returned: number; complete: boolean }[];
  }
  ```
  Eight weeks ending with last week. Last week's row is `complete: false`, because the week it's measured against
  is still running. Weeks are taken from the stamped local days; "current week" is the server's UTC week. Activity
  with role `admin` or `reviewer` is left out. Counts people, never names. Weeks with no activity come back as
  zeros. The query:
  ```sql
  WITH w AS (
    SELECT DISTINCT user_id,
           date(day, printf('-%d days', (CAST(strftime('%w', day) AS INTEGER) + 6) % 7)) AS wk
    FROM volunteer_activity
    WHERE day >= :first AND (role IS NULL OR role = 'localizer')
  )
  SELECT a.wk AS start, COUNT(*) AS active, COUNT(b.user_id) AS returned
  FROM w a LEFT JOIN w b ON b.user_id = a.user_id AND b.wk = date(a.wk, '+7 days')
  WHERE a.wk < :thisMonday
  GROUP BY a.wk ORDER BY a.wk
  ```

## Web

- **Time zone** (`App.tsx`): after `/api/v1/me` loads, if `Intl.DateTimeFormat().resolvedOptions().timeZone`
  differs from `session.timeZone`, PUT it. Failures are ignored; the next load tries again.
- **Home** (`VolunteerApp.tsx`), above the Start button as §4 describes ("today's goal, streak"):
  - Streak: "🔥 12-day streak", or "Start a streak with one card today" at 0. Freezes: "🧊 2" with the hint "A
    freeze covers a day you miss. You earn one for every 7 days in a row, up to 2."
  - When the streak is above 0 and today isn't active: "One card today keeps your streak going."
  - When `lastFreezeUsed` is yesterday: "A freeze covered yesterday. Your streak is safe."
  - Goal: a progress bar, "3 of 5 cards today", then "Daily goal met 🎉".
  - Wording stays encouraging, never guilt-driven. The existing Today XP and Approved strings tiles stay.
- **Settings** (home screen, under Nonprofits only): "Daily goal" as four buttons, 3 / 5 / 10 / 20.
- **Summary**: after a session, stats are reloaded so the summary shows goal progress and the streak.
- **Staff Console**: a third tab, "Return rates": Week of · Active volunteers · Came back next week · Return
  rate. The incomplete row reads "so far". A line under the table says who's counted.

## Demo data

`apps/server/src/seed/streaks.ts`, run last in `seed.ts`. It inserts activity rows with days relative to the seed
date:
- María (localizer, es): 15 active days in a row ending yesterday. Home shows a 15-day streak, 🧊 2, and "One card
  today keeps your streak going."
- Sam, Yuki, María: varied patterns across 9 weeks, so the staff table shows rates that aren't all 0% or 100%.
- Lucas (reviewer): active every weekday. He's left out of the staff table, showing the rule at work.

The online demo's database is built at deploy, so María's streak ages: her two freezes carry it 2 days past the
deploy, then it reads 0 (still a valid screen). Accepted; the next deploy refreshes it.

## Tests

Server (`apps/server/test/streaks.test.ts`, vitest, in-memory DB like `volunteer.test.ts`):
- `streakOf`: empty; today only; yesterday only (alive, not active today); a gap without freezes resets; 7 days
  earns 1, 14 earns 2, 21 still 2; a gap uses a freeze and holds the count; three missed days with two freezes
  resets; a frozen day doesn't count toward the next freeze; a last active day later than `today` (flying west).
- `localDay`: a time in UTC that's still the previous day in `America/Los_Angeles`; invalid zone → UTC.
- Recording: one row per save, vote, flag (uncounted too) and approval, with the role; a second save of the same
  string the same day adds nothing; the day follows the saved time zone.
- `GET /stats`: streak and goal from seeded rows; "Today" XP uses local midnight.
- Settings: goal round-trip, 400 on 4 or "five", PUT with only one field keeps the other.
- `PUT /me/time-zone`: saves, 400 on `Mars/Olympus`, `/me` returns it.
- Engagement: 403 for non-staff; counts and returns across weeks; admin and reviewer activity left out; last
  week marked incomplete; empty weeks are zeros.
- Migration: an existing database's `xp_events` fill in once, and restarting doesn't fill again.

Web: `npm run typecheck`, and a run of the app (volunteer home, settings, a session, staff tab) in the browser.

## Doc changes

- `platform-vision.md` §9: Segment 3's list says "Streaks, daily goal, streak freezes"; "reminders" moves to
  Segment 4's list with push notifications.
