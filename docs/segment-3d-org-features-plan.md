# Segment 3D implementation plan: favorites, Approved Reviewers and thank-you notes

Design: [segment-3d-org-features.md](segment-3d-org-features.md). Work on `claude/segment-3d`, branched from
`claude/segment-3c`.

Same rules as 3A–3C:
- tests first for server logic
- **Checks** means `npm test`, `npm run typecheck`, and `python -m unittest discover -s sdks/python`
- **run the checks, read the result, then commit, as separate steps**
- `git add` the paths you changed, not `-A`

---

## Task 1: schema and the org's volunteer list

**Files:** new `apps/server/src/schema/orgVolunteers.ts` (all four tables); `db.ts` (register it); new
`apps/server/src/org/volunteers.ts` (`volunteersOf`, `setVolunteer`, `isApprovedReviewer`, `favoriteOrgsOf`); new
`apps/server/src/routes/org.ts` (`GET` and `PUT /api/v1/org/volunteers`); `app.ts` (register the routes); new
`apps/server/test/orgVolunteers.test.ts`.

- The volunteer list comes from accepted `xp_events` (`REAL_WORK` kinds) on the org's projects, excluding the org's
  members.
- `setVolunteer` upserts the row. On off-to-on it writes a `volunteer_messages` row ('favorite' or
  'approved_reviewer').
- Tests: the design's "org's list and settings" bullets.
- Commit: "Org volunteer list: favorites and Approved Reviewers".

## Task 2: Approved Reviewers at agreement and on the poster's click

**Files:** `services/review.ts` (`makeReady` checks for an Approved Reviewer's approval; `publishReady` takes
`via` and an optional user, and writes `publications`); `routes/community.ts` (passes the poster).

- `makeReady` needs the counted, current approvals of the final text:
  `SELECT user_id FROM reviews WHERE key_id = ? AND locale = ? AND kind = 'approve' AND current = 1 AND counts = 1`.
  Then check `isApprovedReviewer` for each against the project's org.
- When one is found, record an `approvers` row for that reviewer and set the status to `approved`. Write the
  publication in the same transaction.
- Tests: the design's "Agreement" bullets, plus "the poster's click records `via 'poster'`".
- Commit: "Approved Reviewers stand in for the poster's click at agreement".

## Task 3: Final check cards

**Files:** new `apps/server/src/cards/final.ts` (`finalCandidates`, `finalCard`, `decideFinal`); `pool/session.ts`
(Final check candidates join the Review slots, like Pick cards; card type `final`); `routes/localize.ts`
(`POST .../final`); tests.

- The card carries `{ keyId, source, note, text, review, sentBack }`. `review` is `reviewOf`; `sentBack` is the
  poster's latest note (the existing helper below `sendBack`).
- `decideFinal` runs in one transaction: publish or send back, then XP and activity.
- Tests: the design's "Final check" bullets.
- Commit: "Final check cards for Approved Reviewers".

## Task 4: favorites in scoring

**Files:** `pool/score.ts` (`Candidate.favorite`, `WEIGHTS.favorite = 48`, a boost); `pool/session.ts` (load
`favoriteOrgsOf` once and pass `favorite` everywhere `score()` is called; `cardOrg` gains `favorite`); tests.

- Tests: the design's "Favorites" bullets. Compare two otherwise equal strings in two orgs, with one org starring
  the volunteer.
- Commit: "Favorites get the starring org's cards first".

## Task 5: thank-you notes and the inbox

**Files:** new `apps/server/src/org/thanks.ts`; `routes/org.ts` (`GET` and `POST /api/v1/projects/:id/thanks`);
new `apps/server/src/org/messages.ts` (`messagesOf`, `markMessagesSeen`); `xp.ts` (`stats` adds `messages`);
`routes/volunteer.ts` (`POST /volunteer/messages/seen`); tests.

- Tests: the design's "Thank-yous" bullets.
- Commit: "Thank-you notes and the volunteer inbox".

## Task 6: staff measure

**Files:** `streaks.ts` (or a new `org/engagement.ts`): `approvedReviewerUse(db, now)`; `routes/staff.ts` adds
it to the engagement response; tests.

- Commit: "Staff see how orgs publish: Approved Reviewers or the poster".

## Task 7: web

**Files:**
- **Types:** `contracts.ts` (`CardOrg.favorite`, `OrgVolunteer`, `ThanksStatus`,
  `EngagementResponse.approvedReviewers`); `volunteer/types.ts` (a `final` card and `StatsResponse.messages`).
- **Volunteer app:** `client.ts` (`finalDecision`, `markMessagesSeen`); `mock.ts`; `Cards.tsx` (`FinalCard`, and
  the ⭐ in `OrgLine`); `VolunteerApp.tsx` (`CardFor` handles `final`; Home shows `Messages`).
- **Admin and staff:** `admin/Team.tsx` (the volunteer list and the thank-you card); `staff/StaffConsole.tsx` (the
  Approved Reviewer table).

- Typecheck. Commit: "Org features in the app: volunteer list, thank-yous, Final check, favorites".

## Task 8: demo data, browser checks, docs

1. New `apps/server/src/seed/orgVolunteers.ts`, run after `seedCards` and before the streak and badge seeds.
2. Reseed and check in Chromium as the design's Tests section lists. Then build the online demo and repeat the
   volunteer-side checks on sql.js.
3. Docs:
   - `platform-vision.md` §9: the link and the campaigns note
   - a "Built" section in the design
4. Final checks. Commit, then push `claude/segment-3d` once the user allows it.
