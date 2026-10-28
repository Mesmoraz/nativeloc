# Segment 3E implementation plan: campaigns, progress bars and org leaderboards

Design: [segment-3e-campaigns-leaderboards.md](segment-3e-campaigns-leaderboards.md). Work on `claude/segment-3e`,
branched from `claude/segment-3d`.

Same rules as before:
- tests first for server logic
- **Checks** means `npm test`, `npm run typecheck`, and `python -m unittest discover -s sdks/python`
- run the checks, read the result, then commit, as separate steps
- `git add` the paths you changed

---

## Task 1: schema

**Files:** new `apps/server/src/schema/campaigns.ts`:
- the two tables
- `migrate`: rebuild `volunteer_messages` when its SQL lacks `'launch'`, keeping rows and the index
- `migrate`: add `volunteer_prefs.show_on_leaderboards`

Register it in `db.ts`. New `apps/server/test/campaigns.test.ts`.

- Test: the migration, with an old-shaped `volunteer_messages` file database, like `cards.test.ts`'s `xp_events`
  test.
- Commit: "Campaign tables; launch messages; leaderboard opt-in column".

## Task 2: campaigns

**Files:** new `apps/server/src/campaigns.ts` (`createCampaign`, `cancelCampaign`, `campaignView`,
`refreshCampaign`, `afterApproved`, `activeCampaignFor`, `deadlineBoost`); `services/review.ts` (call
`afterApproved` at the four approval points, inside their transactions); `routes/org.ts` (the three campaign
routes); tests.

- `refreshCampaign` must be safe to call twice: a language only launches once (`launched_at IS NULL`).
- Tests: the design's create, progress and launch bullets.
- Commit: "Campaigns: progress, launch and messages".

## Task 3: the deadline boost in sessions

**Files:** `pool/score.ts` (`Candidate.campaignBoost`, a boost); `pool/session.ts` (load the active campaigns for
the session's projects once; pass the boost; cards gain `campaign`); tests.

- Commit: "Campaign cards rise as the deadline nears".

## Task 4: volunteer stats

**Files:** `campaigns.ts` (`campaignsFor(db, user)`: the active campaigns in the volunteer's sources and
languages, plus language sums). `pool/session.ts` exports `sources` for this, or the projects query is shared.
`xp.ts` (`stats` adds `campaigns` and `languageBars`). Tests.

- Commit: "Campaign and language bars in volunteer stats".

## Task 5: leaderboards

**Files:** new `apps/server/src/leaderboards.ts`; `routes/org.ts` (`GET /org/leaderboard`); `routes/volunteer.ts`
(`GET /volunteer/leaderboards`, plus `showOnLeaderboards` in settings); tests.

- Commit: "Org leaderboards, opt-in".

## Task 6: web

**Files:**
- **Types:** `contracts.ts` (`CampaignView`, `Leaderboard`); `volunteer/types.ts` (`StatsResponse.campaigns`,
  `languageBars`, `Card.campaign`, `VolunteerSettings.showOnLeaderboards`, and the `'launch'` message kind).
- **Admin:** `admin/Overview.tsx` (the Campaign card); `admin/Team.tsx` (the leaderboard).
- **Volunteer app:**
  - `VolunteerApp.tsx` (campaign bars on Home; the launch message)
  - `Cards.tsx` (the campaign line in `CardHead` or `OrgLine`)
  - `Achievements.tsx` (leaderboards and the opt-in switch)
  - `client.ts`, `mock.ts`, CSS

- Typecheck. Commit: "Campaigns and leaderboards in the app".

## Task 7: demo data, browser checks, docs

1. New `apps/server/src/seed/campaigns.ts`, run after `seedOrgVolunteers` and before the streak and badge seeds.
2. Reseed, then check in Chromium and in the online demo build, as the design's Tests section lists.
3. Docs:
   - `platform-vision.md` §9
   - a "Built" section in the design
4. Final checks. Commit, then push `claude/segment-3e` once the user allows it.
