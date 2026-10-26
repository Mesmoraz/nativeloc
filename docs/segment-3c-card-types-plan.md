# Segment 3C implementation plan: new card types

Design: [segment-3c-card-types.md](segment-3c-card-types.md). Work on `claude/segment-3c`, branched from
`claude/segment-3b` (C changes B's badge and certificate queries).

Same rules as 3A and 3B:
- tests first for server logic
- **Checks** means `npm test`, `npm run typecheck`, and `python -m unittest discover -s sdks/python`
- commit per task with the session's attribution lines
- `git add` the paths you changed, not `-A`

---

## Task 1: ledger kinds

**Files:** `db.ts` (`SCHEMA`'s `xp_events` CHECK gains `'check', 'pick'`; `migrate` rebuilds `xp_events` when its
SQL lacks `'pick'`, the same way as `translations`, and re-creates its indexes); `xp.ts` (`XpKind` stays
translate/review for points; add `XP.check = 5`, `XP.pick = 5`); new `apps/server/test/cards.test.ts`.

- Test: an old-shaped `xp_events` (build one in a file database with the old CHECK and some rows) is rebuilt on
  open, with every row and index kept, and `check` and `pick` rows insert.
- Commit: "xp_events gains check and pick kinds".

## Task 2: B counts only real work

**Files:** `badges.ts` (Bridge builder and Rare voice: `kind IN ('translate', 'review', 'pick')`);
`certificates.ts` (minutes: `pick` counts at the review rate, `check` is ignored; organizations: no `check`);
`badges.test.ts`.

- Tests:
  - 30 accepted `check` rows earn no certificate and no Bridge builder
  - `pick` rows count as reviews in a certificate's numbers and in Bridge builder
- Commit: "Badges and certificates count real work only".

## Task 3: numbers and planting

**Files:** new `apps/server/src/cards/spot.ts`, with these pure functions:
- `numbersIn(text) → { value: string; start; end; digits: string[] }[]`
- `plant(source, text, rand) → { shown, original, changed } | null`

Tests:
- `numbersIn` finds `5`, `555-0100` (as `555` and `0100`), `٥` and `５`
- `plant('Open until 5 PM', 'Abierto hasta las 5 p. m.')` → `6`
- `plant` with `9` → `0`
- Arabic-Indic digits stay Arabic-Indic
- a collision (the source also contains the changed value) → `null`
- no shared number → `null`

Commit: "Plant number errors for Spot the problem".

## Task 4: Spot cards — schema, dealing, answering

**Files:** new `apps/server/src/schema/cards.ts` (`spot_checks`, `picks`, `reviews.previous_text` in `migrate`);
`db.ts` (register it); `cards/spot.ts` (`dealSpot`, `answerSpot`); `pool/session.ts` (an injectable chance, so
tests can force it, and the extra step from the design); `routes/volunteer.ts` (`POST /volunteer/checks/:id`);
`badges.ts` (Eagle eye, and drop `later`); `apps/web/src/volunteer/types.ts` (a `spot` card type and the answer
response).

- **Card shape:** a `spot` card carries `{ checkId, source, shown }` plus the usual project and org fields. It
  carries no `QueueItem`, so `queue()` is untouched.
- **Tests:** everything in the design's Dealing, Answering and Eagle eye bullets. Force the chance with
  `buildSession(..., { spotChance: 1 })` and its opposite.
- Commit: "Spot the problem cards".

## Task 5: Pick cards — previous wording, dealing, answering, settling, tally

**Files:**
- `services/review.ts`:
  - the Improve insert stores `previous_text = prev.text`
  - `settleCommunity` (in `xp.ts`) settles `pick` XP
  - `reviewOf` adds `picks`
- New `apps/server/src/cards/pick.ts`: `pickCandidates` and `savePick`.
- `pool/session.ts`: Pick candidates join the review slots.
- `routes/localize.ts`: `POST /translations/:keyId/:locale/pick`.
- Types:
  - `contracts.ts`: `CommunityReview.picks`
  - `volunteer/types.ts`: a `pick` card type `{ a, b }` with the order shuffled on the server

**Tests:** the design's Pick bullets, plus "an Improve stores the previous wording".

Commit: "Pick the better one cards".

## Task 6: web

**Files:** `Cards.tsx` (`SpotCard`, `PickCard`); `VolunteerApp.tsx` (dispatch by card type, plus the dots and
summary); `client.ts` (`answerSpot`, `pick`); `mock.ts` (one of each); `volunteer/badges.ts` (Eagle eye loses
`later`); the review tally where `CommunityReview` is shown (find its uses: `ReviewCard`'s community line, and the
poster's review view); CSS.

- In dev and mock only, `?spot=1` asks the session for a forced Spot card, through a query param that the server
  honors only when `NODE_ENV !== 'production'`. Check how the server tells that it's in dev. If there's no clean
  signal, use the mock only.
- Typecheck. Commit: "Spot and Pick cards in the volunteer app".

## Task 7: demo data and checks in the browser

**Files:** new `apps/server/src/seed/cards.ts` (an Improved string with a previous wording for María to pick, and
two picks on another string for the tally); `seed.ts`.

1. Reseed and run in Chromium:
   - a forced Spot card answered right, then a fresh one answered wrong
   - a Pick card as María
   - the tally on the poster's view
   - phone width, light and dark
2. Build the online demo and repeat the Spot and Pick checks on sql.js.
3. Commit: "Demo cards".

## Task 8: docs and wrap-up

- `platform-vision.md` §9: link the design. `segment-3b-badges.md`: Eagle eye is built. A "Built" section in the
  3C design.
- Final checks. Commit, then push `claude/segment-3c` once the user allows it.
