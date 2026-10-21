# Segment 3A implementation plan: streaks and the daily goal

Design: [segment-3a-streaks.md](segment-3a-streaks.md). Work on `claude/eloquent-edison-8uzsd8`.

Each task is test-first where there's server logic: write the failing test, see it fail, make it pass, then run
the checks and commit. **Checks** means `npm test`, `npm run typecheck` and, when a task touches the SDKs,
`python -m unittest discover -s sdks/python`. All three pass before this plan starts (188 tests).

Commit messages end with the session's attribution lines.

---

## Task 1: schema and history fill

**Files:** new `apps/server/src/schema/streaks.ts`; `apps/server/src/db.ts` (import, add to `FEATURE_SCHEMAS`
after `poolSchema`); new `apps/server/test/streaks.test.ts`.

1. Test (`describe('schema')`):
   - A fresh `:memory:` app has `volunteer_activity` with the design's columns, and `volunteer_prefs` has
     `time_zone` and `daily_goal`.
   - Migration fill: open a database file, drop `volunteer_activity`, insert two `xp_events` rows (one `voided`)
     on known `created_at` values, then rebuild the app on the same file. You get two activity rows with the UTC
     days, matching kinds and `role IS NULL`. Rebuild again and there are still two.
   - `daily_goal` rejects 4 (CHECK).
2. Implement. Use `db.exec` and `db.prepare` directly, as `schema/pool.ts` explains. `db.ts` runs each feature's
   `sql` and then its `migrate`, so create the table **and** its index in `migrate` (leave `sql` out). That way
   `migrate` knows when the table is new:
   ```ts
   migrate(db) {
     const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'volunteer_activity'").get();
     if (!exists) {
       db.exec(`CREATE TABLE volunteer_activity (...as in the design...);`);
       // History from before this table: XP events, on their UTC day (no time zone was known). See segment-3a-streaks.md.
       db.exec(`INSERT OR IGNORE INTO volunteer_activity (user_id, day, kind, key_id, locale, project_id, role, created_at)
                SELECT user_id, substr(created_at, 1, 10), kind, key_id, locale, project_id, NULL, created_at FROM xp_events`);
     }
     db.exec('CREATE INDEX IF NOT EXISTS volunteer_activity_day ON volunteer_activity(day)');
     const cols = (db.prepare('PRAGMA table_info(volunteer_prefs)').all() as { name: string }[]).map((c) => c.name);
     if (!cols.includes('time_zone')) db.exec('ALTER TABLE volunteer_prefs ADD COLUMN time_zone TEXT');
     if (!cols.includes('daily_goal')) db.exec('ALTER TABLE volunteer_prefs ADD COLUMN daily_goal INTEGER NOT NULL DEFAULT 5 CHECK (daily_goal IN (3, 5, 10, 20))');
   }
   ```
3. Check that the in-page demo's sql.js shim (`apps/web/src/demo/shims/sqlite.ts`) runs `migrate` the same way.
   It builds the real server, so it should, but confirm `ALTER ... CHECK` works on sql.js's SQLite version.
4. Run the checks and commit: "Add volunteer_activity and streak prefs".

## Task 2: days and streaks (pure)

**Files:** new `apps/server/src/streaks.ts`; `apps/server/test/streaks.test.ts`.

1. Tests:
   - `validTimeZone('America/Los_Angeles')` is true; `'Mars/Olympus'`, `''` and `'-07:00'` are false.
   - `localDay('America/Los_Angeles', Date.UTC(2026, 9, 21, 3))` is `'2026-10-20'`. With `null`, or with
     `'Mars/Olympus'`, it's `'2026-10-21'`.
   - `streakOf` cases from the design. Write a helper `run(n, end)` that makes `n` consecutive days ending at
     `end`, to keep the cases short:
     - `[]` → `{ current: 0, freezes: 0, activeToday: false, lastFreezeUsed: null }`
     - today only → 1, active
     - yesterday only → 1, not active (alive)
     - 3 days, a 1-day gap, then today, with no freezes → 1
     - 7 in a row ending yesterday → current 7, freezes 1
     - 14 → 2; 21 → still 2
     - 7, a 1-day gap, then today → current 8, freezes 0, `lastFreezeUsed` is the gap day
     - 14, 3 missed days, then today → current 1, freezes 0
     - a frozen day doesn't count toward the next freeze: 7 days, a gap, 6 days → freezes 0; one more → 1
     - flying west: last active day is `today + 1` → it's counted, and `today` isn't a miss
2. Implement:
   ```ts
   const DAY = 86_400_000;
   const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

   export function streakOf(days: string[], today: string): Streak {
     const active = new Set(days);
     const sorted = [...active].sort();
     if (!sorted.length) return { current: 0, freezes: 0, activeToday: false, lastFreezeUsed: null };
     const last = sorted[sorted.length - 1];
     const end = last > today ? last : today;
     let streak = 0, freezes = 0, sinceEarn = 0, lastFreezeUsed: string | null = null;
     for (let d = sorted[0]; d < end; d = addDays(d, 1)) {
       if (active.has(d)) {
         streak += 1;
         if (++sinceEarn === 7) { freezes = Math.min(freezes + 1, 2); sinceEarn = 0; }
       } else if (freezes > 0) {
         freezes -= 1;
         lastFreezeUsed = d;
       } else {
         streak = 0;
         sinceEarn = 0;
       }
     }
     const activeToday = active.has(end);
     if (activeToday) streak += 1;
     return { current: streak, freezes, activeToday, lastFreezeUsed };
   }
   ```
   (When `activeToday` brings `sinceEarn` to 7, the freeze shows up the next day. That's fine and keeps `end`
   simple; add a test that makes this explicit.)
3. Add a header comment for the module explaining what a day is, why days are stamped rather than recomputed,
   and the freeze rule, pointing at the design doc. Match `xp.ts`'s style.
4. Run the checks and commit: "Add streak replay and local days".

## Task 3: record activity

**Files:** `apps/server/src/streaks.ts` (`timeZoneOf`, `dailyGoalOf`, `recordActivity`);
`apps/server/src/services/review.ts`; `apps/server/test/streaks.test.ts`.

1. Tests, through HTTP (copy the `user`/`project`/`key`/`put`/`approve` helpers from `volunteer.test.ts`):
   - A save adds one `translate` row with today's UTC day and role `localizer`. Saving again the same day adds
     nothing.
   - Peer vote, outright approval (reviewer, with role `reviewer`), community vote, a counted flag and an
     uncounted flag (new tier) each add a `review` row.
   - With `time_zone = 'Pacific/Kiritimati'` (UTC+14) set in prefs, the row's day is
     `localDay('Pacific/Kiritimati')`. Pick a zone so that at least one of a +14 or −11 zone differs from UTC's
     date at any moment of the test run, and assert against `localDay` rather than a fixed date.
   - A failed save (422 validation) adds nothing.
2. Implement `recordActivity` and call it in each `tx` from the design's table, just before the `return`.
   `kind` is `'translate'` in `saveTranslation` and `'review'` everywhere else.
3. Run the checks (the existing review and XP tests have to stay green) and commit: "Record volunteer activity
   on every save and review".

## Task 4: stats

**Files:** `apps/server/src/xp.ts` (`stats`); `apps/web/src/volunteer/types.ts` (`StatsResponse`);
`apps/server/test/streaks.test.ts`.

1. Tests:
   - Insert activity rows directly (yesterday and the 6 days before, all in the user's zone). `GET /stats` returns
     `streak: { current: 7, freezes: 1, activeToday: false, lastFreezeUsed: null }` and `goal: { target: 5, done: 0 }`.
   - After 2 saves today: `goal.done` is 2, `activeToday` is true, and `current` is 8.
   - "Today" XP: put a pending `xp_events` row at "local midnight minus 1 minute" in a far-off zone. It isn't in
     `today.pending`, and a row 1 minute after midnight is. Compute both from the same `Intl` math the code uses,
     or pin the zone to `Etc/GMT+10` (no daylight saving) and compute by hand.
   - The existing `volunteer.test.ts` stats assertions still pass. The new fields are additions.
2. Implement. Add `localMidnightUtc(tz, now)` to `streaks.ts`, and use it as `since` in `totals`. Update the
   comment on `stats()`.
3. Update `StatsResponse` in `types.ts` with the design's fields and doc comments. Update the mock
   (`volunteer/mock.ts`) so `?mock=1` still typechecks and shows a streak.
4. Run the checks and commit: "Streak and daily goal in volunteer stats".

## Task 5: settings and time zone

**Files:** `apps/server/src/routes/volunteer.ts`; `apps/server/src/routes/auth.ts` (`meResponse`, new
`PUT /api/v1/me/time-zone`); `apps/web/src/volunteer/types.ts`; `apps/web/src/App.tsx` (`Session` type); tests.

1. Tests:
   - `GET /settings` defaults to `{ nonprofitsOnly: false, dailyGoal: 5 }`.
   - `PUT { dailyGoal: 10 }` keeps `nonprofitsOnly`. `PUT { nonprofitsOnly: true }` keeps `dailyGoal`.
   - `PUT {}`, `{ dailyGoal: 4 }` and `{ dailyGoal: 'five' }` each return 400 with the design's message.
   - `PUT /me/time-zone { timeZone: 'Asia/Tokyo' }` returns 200, and `/me` then has `timeZone: 'Asia/Tokyo'`.
     `'Mars/Olympus'` returns 400, and so does a missing body. Signed out returns 401.
   - Saving the same zone again leaves `updated_at` alone.
2. Implement. Replace `saveNonprofitsOnly` with one `savePrefs(db, userId, { nonprofitsOnly?, dailyGoal?, timeZone? })`
   upsert that sets only the fields it's given. The session route's filter save uses it too.
3. Run the checks and commit: "Daily goal setting and saved time zone".

## Task 6: staff return rates

**Files:** new `apps/server/src/streaks.ts` export `returnRates(db, now)` (or `apps/server/src/engagement.ts` if it
reads better); `apps/server/src/routes/staff.ts`; `apps/web/src/contracts.ts` (`EngagementResponse`); tests.

1. Tests. Pin `now` by passing it in (`returnRates(db, now)`), and have the route call it with `Date.now()`:
   - A non-staff user gets 403.
   - Fix `now` to a Wednesday. Seed users A, B and C:
     - A active in weeks −3 and −2
     - B active in week −3 only
     - C active in week −1 and the current week
     - an admin and a reviewer active every week
     
     Expect 8 rows, oldest first, Mondays. Week −3 has `active` 2 and `returned` 1. Week −2 has 1 and 0.
     Week −1 has 1, 1, and `complete: false`. Earlier weeks are zeros.
   - A row with `role IS NULL` (filled in from history) is counted.
2. Implement with the design's query, then fill in missing weeks in TypeScript.
3. Run the checks and commit: "Staff return-rate endpoint".

## Task 7: web, volunteer side

**Files:** `apps/web/src/volunteer/client.ts` (`setDailyGoal`); `mock.ts`; `VolunteerApp.tsx` (`Home`,
settings, `Summary`); the volunteer CSS file next to it; `apps/web/src/App.tsx` (time-zone sync).

1. `App.tsx`: after the session loads, read `Intl.DateTimeFormat().resolvedOptions().timeZone`. If it's truthy and
   differs from `session.user`'s `timeZone` (or `session.timeZone`, wherever Task 5 put it), call
   `api('/api/v1/me/time-zone', { method: 'PUT', body: { timeZone } })` and ignore errors.
2. `Home`: add a streak-and-goal block above the existing stats, using the design's wording. Add the goal picker
   under "Nonprofits only".
3. `Summary`: check whether stats reload after a session (`loadStats`). If not, reload when the summary screen
   opens, then show goal progress and the streak there.
4. Run `npm run typecheck`. Then run the app (`npm run seed:reset && npm run dev`, or the `run` skill) and check
   in Chromium at phone width:
   - home as María (seeded in Task 9; until then, insert rows by hand)
   - the goal picker saves
   - a session moves the goal bar
   - `?mock=1` still works

   Take screenshots.
5. Commit: "Streak, freezes and daily goal on the volunteer home screen".

## Task 8: web, Staff Console

**Files:** `apps/web/src/staff/StaffConsole.tsx`; `staff.css`.

1. Add a third tab, "Return rates", to the tab union and nav. Fetch `/api/v1/staff/engagement` when it's opened.
   The table has: Week of (e.g. "Oct 12"), Active volunteers, Came back next week, Return rate (`—` when
   `active` is 0; "so far" when not complete). Under it: "Counts volunteers, not names. Activity as an org admin
   or reviewer is left out."
2. Typecheck, look at it in the browser as the staff demo user, and commit: "Return rates in the Staff Console".

## Task 9: demo data

**Files:** new `apps/server/src/seed/streaks.ts`; `apps/server/src/seed.ts` (run it last, after `seedPool`).

1. `seedStreaks(db, demo)`:
   - inserts `volunteer_activity` rows on days relative to the seed date, as the design describes (María's 15
     days ending yesterday; varied 9-week patterns for Sam, Yuki and María; Lucas every weekday as a reviewer)
   - uses `INSERT OR IGNORE`, and real key ids from the pantry project
   - gives María `daily_goal = 5`
2. Check: `npm run seed:reset`; sign in as María and see a 15-day streak with 🧊 2; sign in as staff and see
   rates in the table that aren't all 0% or 100%. Then check the online demo build (`VITE_DEMO`) the way
   `docs/` or the README describes it. That confirms the seed and the migration run on sql.js.
3. Run the checks and commit: "Demo streaks and return rates".

## Task 10: docs and wrap-up

1. `platform-vision.md` §9: change Segment 3's line to "Streaks, daily goal, streak freezes." Add "Reminders
   (gentle, can be turned off)" to Segment 4's list.
2. `docs/segment-3a-streaks.md`: add a short "Built" section listing where each piece lives, in the style of
   `segment-2d-posting.md`, plus anything that differed from the design.
3. If the README's feature list or demo-accounts table mentions volunteer features, update it.
4. Final checks: `npm test`, `npm run typecheck`, `python -m unittest discover -s sdks/python`. Report the test
   count against 188.
5. Commit ("Document Segment 3A") and push to `claude/eloquent-edison-8uzsd8`. No PR unless asked.

---

## Risks to watch

- **sql.js in the demo.** The demo's Fastify stand-in has a no-op `addHook()`, which is why nothing here uses
  hooks. Its SQLite version also has to accept `ALTER TABLE ... ADD COLUMN ... CHECK`. That's checked in
  Tasks 1 and 9.
- **Clock-dependent tests.** Everything that reads the clock takes `now`, and tests compare against
  `localDay(...)` rather than fixed dates, so they pass at any hour.
- **`stats()` cost.** One more indexed query and a replay over calendar days since the first activity. That's
  fine at volunteer scale. Measure again if a stats call ever exceeds 10 ms.
