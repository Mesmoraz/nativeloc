# Segment 3B implementation plan: badges and hour certificates

Design: [segment-3b-badges.md](segment-3b-badges.md). Work on `claude/segment-3b`, branched from PR #5's head
(the user's call, so piece B stays out of PR #5). It carries PR #5's commits underneath; once #5 merges, merge
`main` in so a 3B PR shows only its own work.

Same rules as 3A: tests first for server logic. **Checks** means `npm test`, `npm run typecheck`, and
`python -m unittest discover -s sdks/python`. Commit after each task with the session's attribution lines. Use
`git add` with the paths you changed, not `-A`: `npm install` flips the CLI bin's file mode.

---

## Task 1: schema

**Files:** new `apps/server/src/schema/badges.ts` (both tables and the index from the design); `db.ts` (register
after `streaksSchema`); new `apps/server/test/badges.test.ts`.

- Test: both tables exist with the design's columns. `(user_id, badge)` is unique.
- Commit: "Add badge and certificate tables".

## Task 2: awarding badges

**Files:** new `apps/server/src/badges.ts`; tests.

Test helpers, the same pattern as `streaks.test.ts`:
- `accepted(user, kind, keyId, locale, projectId, settledAt)` inserts an `xp_events` row with
  `status = 'accepted'`.
- One org and project per test where orgs matter.

1. Tests, one per row of the design's badge table:
   - **Count badges:** 0 strings, then 1 string → `approved_1` with that row's `settled_at`. 99 → no
     `approved_100`; 100 → `approved_100` dated at the 100th row's `settled_at`. Insert the rows directly; it's
     fast. Two accepted events on the same string count once.
   - **Bridge builder:** accepted work in 9 orgs, then a 10th → dated at the 10th org's first acceptance. A
     review counts as much as a translation.
   - **Trusted, Lead:** a `trusted` tier → `trusted` only. `lead` → both. Demote to `new` → both stay.
   - **Rare voice:**
     - activity rows for 5 people in `xx` in the last 30 days, plus accepted work by the subject in `xx` → earned,
       `detail: 'xx'`
     - 6 people → not earned
     - earn it, then add 3 more people → still held
     - activity older than 30 days isn't counted
     - activity as `admin` or `reviewer` isn't counted
   - **What never counts:** pending and voided XP earn nothing.
   - **Repeat runs:** `awardBadges` twice adds nothing the second time.
2. Implement. Write one small function per badge returning `{ earnedAt, detail } | null`, run only for badges not
   yet held. Sketch for count badges:
   ```sql
   SELECT settled_at FROM (
     SELECT key_id, locale, MIN(settled_at) AS settled_at FROM xp_events
     WHERE user_id = ? AND kind = 'translate' AND status = 'accepted' GROUP BY key_id, locale
   ) ORDER BY settled_at LIMIT 1 OFFSET ?   -- n - 1
   ```
   Bridge builder uses the same shape over `MIN(settled_at)` per org (join `projects`). Rare voice:
   ```sql
   SELECT a.locale FROM (SELECT DISTINCT locale FROM xp_events WHERE user_id = ? AND status = 'accepted') a
   WHERE (SELECT COUNT(DISTINCT user_id) FROM volunteer_activity v
          WHERE v.locale = a.locale AND v.day >= ? AND (v.role IS NULL OR v.role = 'localizer')) <= 5
   ORDER BY a.locale LIMIT 1
   ```
3. `badgesOf` and `markSeen`. Commit: "Award badges when stats load".

## Task 3: badges in stats and the seen endpoint

**Files:** `xp.ts` (`stats` calls `awardBadges(db, userId, now)` and returns `badges`); `routes/volunteer.ts`
(`POST /api/v1/volunteer/badges/seen`); `apps/web/src/volunteer/types.ts` (`BadgeId`, `EarnedBadge`,
`StatsResponse.badges`); `mock.ts`.

- Tests (HTTP):
  - `GET /stats` after one accepted string has `badges` with `approved_1` and `new: true`
  - after `POST /badges/seen { ids: ['approved_1'] }` it has `new: false`
  - 400 when `ids` isn't an array of known ids
  - someone else's ids are harmless: the update is scoped by `user_id`
- Commit: "Badges in volunteer stats".

## Task 4: certificates

**Files:** new `apps/server/src/certificates.ts` (`RATES`, `RATES_VERSION`, `issueCertificate`, `certificatesOf`,
`revokeCertificate`, `publicCertificate`, `toJson`); `routes/volunteer.ts` (three volunteer routes plus the public
`GET /api/v1/certificates/:code`); `apps/web/src/volunteer/types.ts` (`Certificate`); tests.

1. Tests:
   - **Minutes and rounding:**
     - 14 accepted translations and 1 accepted review = 29 minutes → 422
     - 15 translations = 30 → 0.5 hours
     - 29 translations and 1 review = 59 → 0.5 hours
     - 30 translations = 60 → 1 hour
   - **Pending and voided** work counts in neither the counts nor the minutes.
   - **Period:**
     - work done on `from` and on `to` counts; the day before `from` and the day after `to` don't
     - work done before `to` but accepted after it counts, by when it was done
     - no `from` means from the start
   - **Organizations** are listed once each, sorted by name.
   - **Validation:** `to` in the future → 400. `from` after `to` → 400. `'2026-13-01'` → 400.
   - **Public read:** the code read signed out returns the certificate with `verifyUrl`.
   - **Revoking:**
     - another user revoking → 404
     - revoking your own → `revokedAt` set
     - the public read then gives `{ revoked: true, name, periodFrom, periodTo, issuedAt, revokedAt }` and no counts
   - **Fixed copy:** an issued certificate is unchanged after more work is accepted. Re-reading it returns the same
     JSON.
   - **Account deletion:** deleting the user → public read 404.
   - **List** is newest first.
2. Implement.
   - Validate dates with `/^\d{4}-\d{2}-\d{2}$/`, then check that `Date.parse` round-trips.
   - "Today" is the volunteer's local day (`localDay(timeZoneOf(...))` from piece A).
   - `verifyUrl` uses `publicUrl` from `signup/mailer.ts` (check its signature), plus `/certificate/<code>`.
3. Commit: "Volunteer-hour certificates".

## Task 5: web — badges

**Files:** new `apps/web/src/volunteer/badges.ts` (catalog of names, emoji and how to earn each, in the app's
plain voice); `VolunteerApp.tsx` (a badge row on Home, a "New badge" banner on Summary and Home, which then calls
`client.markBadgesSeen`); `client.ts` (`markBadgesSeen`, plus the certificate calls); `mock.ts`;
`volunteer.css`.

- Wording (open to change):

  | Badge | Emoji | How to earn |
  |---|---|---|
  | First approved string | ✅ | Get one translation approved. |
  | 100 approved | 💯 | |
  | 1,000 approved | 🏆 | |
  | Bridge builder | 🌉 | Help 10 different organizations. |
  | Trusted | 🛡️ | Pass the placement check or be vouched for. |
  | Lead | ⭐ | |
  | Rare voice | 🗣️ | Do approved work in a language with few volunteers. |
  | Eagle eye | 🦅 | Coming soon. |
  | First responder | 🚨 | Coming soon. |

- Typecheck. Commit: "Badges on the volunteer home screen".

## Task 6: web — achievements screen and certificate page

**Files:**
- `VolunteerApp.tsx`: a new screen, or a route `/v/achievements`. Use whichever fits the router setup in
  `App.tsx`; the volunteer app keeps its screens in state, so a state screen is likely simpler.
- New `apps/web/src/volunteer/Achievements.tsx`.
- New `apps/web/src/certificates/CertificatePage.tsx` and its routes file.
- `App.tsx`: register the public route outside the session gate, like `/join/:code`.
- Print CSS.

What to build:
- **Achievements:** the badge grid, then certificates: period presets and custom dates, the issue button, and
  the list with Open, Copy link and Revoke (confirm before revoking).
- **Certificate page:**
  - fetches `/api/v1/certificates/:code` and works signed out
  - the content from the design, with a Print button (`window.print()`)
  - `@media print` hides the top bar and buttons
  - looks right on A4 and Letter

Commit: "Badges & hours screen and printable certificates".

## Task 7: demo data

**Files:** new `apps/server/src/seed/badges.ts`; `seed.ts` (run after `seedStreaks`).

- Yuki: 3 accepted `ja` translations on a project that has `ja` (add `ja` to the pantry or the open-pool project
  if neither has it; check `seed/pool.ts`, whose Eastside project has `ja`).
- One certificate for María, issued through `issueCertificate`, so the code path is the real one.
- Don't pre-award badges. The first stats load awards them, and that's the moment worth seeing.

Commit: "Demo badges and a certificate".

## Task 8: check in the browser, then docs

1. `npm run seed:reset && npm run dev`. Use Playwright from the scratchpad, as in 3A, with Chromium at
   `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
   - **As Yuki:** the "New badge" banner shows once, then not after reload. The home badge row and the
     achievements screen show.
   - **As María:**
     - issue an "All time" certificate
     - open it signed out in a fresh context, and `page.pdf()` it on A4 and Letter (look at both)
     - revoke it, then check the public page
   - Light and dark mode, at phone width.
2. `npm run build:demo -w @nativeloc/web`, preview, and repeat the Yuki and certificate checks on sql.js.
3. Docs:
   - `platform-vision.md` §9: the Eagle eye and First responder note
   - `segment-3b-badges.md`: a "Built" section
4. Final checks. Commit: "Document Segment 3B".
5. Push `claude/segment-3b`. No PR until asked (and until PR #5 merges; see the top of this plan).
