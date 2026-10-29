# Segment 3C: new card types

Piece C of Segment 3 ([platform-vision.md](platform-vision.md) §4 and §9): **Spot the problem** (a translation
that might contain a planted error, graded automatically) and **Pick the better one** (two wordings of a string;
choose one). Builds on pieces A (activity, streaks) and B (badges, certificates): Spot the problem unlocks the
*Eagle eye* badge.

## Built

Where each piece lives, and what differs from the design below:

- **Ledger:** `xp_events.kind` gains `check` and `pick`. `db.ts` rebuilds the table on older databases, as it
  does for `users` and `translations`. `badges.ts` exports `REAL_WORK`, which `certificates.ts` also uses.
- **Spot the problem:**
  - `apps/server/src/cards/spot.ts`: `numbersIn`, `plant`, `dealSpot`, `answerSpot`.
  - `apps/server/src/schema/cards.ts`: the tables, plus `reviews.previous_text` and `previous_by`.
  - `buildSession` in `pool/session.ts`: `SPOT_CHANCE`, and an `opts` argument so tests can fix the chance and
    the random choices.
  - `POST /api/v1/volunteer/checks/:id`.
  - Eagle eye, in `badges.ts`.
- **Pick the better one:**
  - `apps/server/src/cards/pick.ts`: `pickCandidates`, `pickCard`, `savePick`, `pickTally`.
  - `settleCommunity` in `xp.ts` settles picks before `settle()`, which would otherwise accept every pending row.
  - `POST /api/v1/translations/:keyId/:locale/pick`.
- **Web:**
  - `SpotCard`, `PickCard` and `PickTally` in `volunteer/Cards.tsx`.
  - `CardFor` in `VolunteerApp.tsx`.
  - `Card` in `volunteer/types.ts` is now a union of `WorkCard`, `SpotCardData` and `PickCardData`.
  - The tally appears on Review cards and on the poster's Ready to publish list.
  - `?spot=1` in dev forces a Spot card; the server ignores it when `NODE_ENV` is `production`.
- **Demo:** `apps/server/src/seed/cards.ts`.
- **Tests:** `apps/server/test/cards.test.ts`, 16 tests. The badge tests gained one, and one Ready to publish
  assertion gained `picks: []`.
- **Differences from the design:**
  - **`previous_by` is stored too.** The replaced wording's author isn't otherwise known, and they shouldn't get a
    Pick card between their own text and its replacement.
  - **Placeholders and plurals are left out of Spot cards** (any `{` in the source or translation), so the card
    shows plain text.
  - **Spot cards have no Skip.** Three buttons didn't fit on a 390-pixel-wide phone; the ✕ still ends the session.
  - **The answer feedback doesn't highlight the number.** It names the change ("0100 became 0101").
  - **Starting a new review round deletes the last round's picks,** like it deletes the reviews. They were settled
    with that round.
  - **The demo needed approved Spanish strings with numbers.** The design assumed the existing ones would do, but
    those are still in review or untranslated.
  - **Pick cards compete with Review cards on how long they've waited,** so a fresh Improve rarely makes a 5-card
    session. The demo's Improve is dated three days back.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where Spot the problem's planted errors come from | Generated from approved translations: change a **number the source and translation share** (a time, price, phone number, date or count). Unchanged approved translations are dealt as controls. | Works in every language with no one writing content, so small languages get cards as soon as they have approved strings with numbers. Grading is exact. A wrong number is program-design §5's first example, and the most harmful error in hours, phone numbers and eligibility amounts. Its limit is that it only tests numbers. |
| 2 | Where Pick the better one's pairs come from, and what a pick does | Pairs from community review, where an **Improve** replaced a wording. A pick **advises**: it's saved and shown as a tally to the poster and to the Lead who settles an escalated string. It never counts as an approval. XP is pending until the string settles, then accepted if you picked the wording that won. | Community review already decides between wordings. A quick tap is weaker evidence than a deliberate review, and counting it as one would change rules Segment 2 settled. |
| 3 | How often, and for whom | Spot the problem: at most 1 per session, in about 1 session in 3 (random), for everyone including new volunteers. It never fills a session that has no real work. Pick the better one takes the place of a Review card, for volunteers who can review that project. | A Spot card does no real work, so each one replaces a real card. It's a check, not filler. New volunteers can't review real work, so Spot cards are their only review practice and evidence for promotion later. "All caught up" stays honest. |

**Assumptions** (stated during design, not corrected):
- Spot cards are labelled as what they are ("This one might have a planted error"), not disguised as real reviews.
- A Spot result is saved, but nothing uses a hidden trust score in this piece. That changes who may approve, so it
  gets its own decision.
- A volunteer never sees the same planted text twice. The same string may come back with a different number
  changed, or as a control.
- Pick cards appear only in community-reviewed projects (where Improves exist), never for a string you translated,
  improved, or already reviewed or picked.
- When there's nothing to pick, sessions deal other cards.

**Calls made without asking** (open to change at review):
- the mutation rule (below)
- a 50% chance of a control
- feedback shown after each Spot answer
- new XP kinds
- what counts for hours and badges
- storing the replaced wording on an Improve
- the endpoint shapes, screens, demo data and tests

## How it fits the ledger

New `xp_events.kind` values, so B's badges and certificates can tell real work from checks:

| Kind | From | Points | Status | Hours (certificates) | Bridge builder, Rare voice |
|---|---|---|---|---|---|
| `check` | a correct Spot answer | 5 | accepted at once | **no**: practice, not help to an org | **no** |
| `pick` | a pick | 5 | pending → accepted if your wording won, voided if not | yes, at the review rate (1 minute) | yes |

- SQLite can't change a CHECK in place, so `xp_events` is rebuilt the way `db.ts` already rebuilds `users` and
  `translations`.
- `badges.ts` (Bridge builder, Rare voice) and `certificates.ts` (minutes, organizations) gain
  `kind IN ('translate', 'review', 'pick')`. Certificates count picks as reviews; the method line says "reviews",
  which a pick is.
- XP totals, the "Today" figure and streaks include both kinds, as all work does.
- Both kinds record activity as `review` (piece A), so they count toward the streak and the daily goal.

## Spot the problem

### Finding and planting numbers (`apps/server/src/cards/spot.ts`)

- A **number** is a run of decimal digits in any script (`\p{Nd}+`), read by digit value, so `٥` and `５` read as 5.
- A string is **eligible** when:
  - it has an approved translation in one of the volunteer's languages, in a project the session can draw from
    (`sources()` in `pool/session.ts`)
  - the translation isn't the volunteer's own (`updated_by`)
  - its source and translation share at least one number value
- **Planting** picks one shared number at random and adds 1 to its last digit (9 wraps to 0), keeping that
  digit's script: "5 PM" becomes "6 PM", "555-0100" becomes "555-0101". Two rules:
  - the new value must not appear anywhere in the source, or the card would be ambiguous
  - if every shared number fails that test, the string is dealt only as a control
- **Controls:** half of all Spot cards, chosen at random, show the approved text unchanged.
- **Never the same text twice:** a string whose shown text this volunteer has already had is skipped.

### Data

```sql
-- Spot the problem cards (cards/spot.ts): what was dealt, and the answer. Written when dealt, so the server knows
-- what it planted; answered_at stays NULL for a card that was skipped.
CREATE TABLE IF NOT EXISTS spot_checks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL,
  locale TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  shown TEXT NOT NULL,          -- the text on the card
  planted INTEGER NOT NULL,     -- 1: a number was changed
  original TEXT,                -- the number as it was, when planted
  changed TEXT,                 -- the number as shown, when planted
  verdict TEXT CHECK (verdict IN ('ok', 'problem')),
  correct INTEGER,
  dealt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS spot_checks_user ON spot_checks(user_id, key_id, locale);
```

### Dealing

`buildSession` gets one extra step after the normal deal. With probability 1/3, and only when it dealt at least
2 real cards:
- pick an eligible string at random
- write a `spot_checks` row
- put a `spot` card at a random position after the first card

That card replaces the last real card if the session is full. So a session always has at least one real card,
and an "empty" session stays empty.

### Answering

`POST /api/v1/volunteer/checks/:id` `{ verdict: 'ok' | 'problem' }` →
`{ correct, planted, original, changed, xp }`. Your own unanswered checks only (404 otherwise, 409 if already
answered). It's correct when the verdict matches whether a number was planted.

A correct answer books 5 accepted XP of kind `check` and records activity. The answer is the feedback:
"Right: 5 PM had been changed to 6 PM", or "Right: this one was correct", and the reverse when wrong.

### Eagle eye

Earned at the 25th planted error caught (`planted = 1 AND correct = 1`), dated at that answer. It drops its
`later` flag in `badges.ts` and in the web catalog. Correct controls don't count, because "Eagle eye" is about
catching errors.

## Pick the better one

### Remembering the replaced wording

An Improve (`saveTranslation` in community mode, by someone other than the author, with different text) now
stores the wording it replaced: a new `reviews.previous_text` column. Improves from before this piece have no
previous text and get no Pick cards.

### Data

```sql
-- Pick the better one (cards/pick.ts): which of two wordings a volunteer preferred. Advice only: shown to the
-- poster and the settling Lead, never counted as an approval.
CREATE TABLE IF NOT EXISTS picks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  chosen TEXT NOT NULL,
  other TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, key_id, locale)
);
```

### Dealing

A string can be a Pick card for a viewer when all of these hold:
- it's in a community project and in review
- its latest Improve has a `previous_text` that differs from the current text
- the viewer may review it there (`reviewFilter`, the same as Review cards)
- the viewer isn't its author or the improver, and hasn't reviewed or picked it

When `buildSession` fills a review slot, a Pick candidate competes with the Review candidates. The scoring is
the same (how long it has waited, plus boosts), and the card type is `pick`.

### Answering

`POST /api/v1/translations/:keyId/:locale/pick` `{ chosen: string, other: string }` → `{ ok, xp }`.
- 409 when the pair is no longer current (the text changed since the card was dealt). The card then says it moved
  on, like Review cards do.
- Saves the pick, books 5 pending `pick` XP, and records review activity.
- The two wordings are shown in random order. The client sends back the texts, so the order can't leak.

### Settling

- `settleCommunity` (consensus, or an outright approval) accepts pending `pick` XP whose `chosen` equals the
  final text and voids the rest.
- `voidPending` (send-back) voids them, the same as other pending XP.

### The tally

`CommunityReview` (returned by `reviewOf`) gains `picks: { text: string; count: number }[]`. Every screen that
shows a community review (the poster's review view, and Review cards for the settling Lead) shows "7 of 9
volunteers preferred: …" when there are any.

## Web

- **`SpotCard`** (`Cards.tsx`): the source and the shown text, with "Looks right" and "Something's wrong"
  buttons. Then the feedback, with the changed number highlighted in both texts, and Next.
- **`PickCard`:** the source and two wordings as large tap targets labelled A and B, then a short "Thanks: your
  pick goes to the reviewers" confirmation and Next.
- **Review cards** for Leads on escalated strings, and the poster's review screen, show the pick tally.
- **Dots and summary:** Spot results count like other cards. A correct Spot shows its XP as accepted; a pick shows
  pending.

## Demo data

`apps/server/src/seed/cards.ts`:
- One community-review string with an Improve whose previous wording is stored, so María can get a Pick card.
- Two picks on another disputed string, so the tally shows.
- Approved strings with numbers already exist (the pantry hours and phone number), so Spot cards need no seeding.
  A dev query param (`?spot=1`, dev and mock only) forces a Spot card, so it can be seen without waiting for the
  1-in-3 chance.

## Tests (`apps/server/test/cards.test.ts`)

- **Numbers:**
  - found in Latin, Arabic-Indic and full-width digits
  - planting changes exactly one shared number and keeps its script
  - 9 wraps to 0
  - a string whose only change would collide with the source becomes a control
- **Dealing:**
  - with the chance forced on, one Spot card after position 0
  - never in an empty session, or one with fewer than 2 real cards
  - never the volunteer's own translation
  - never the same shown text twice
- **Answering Spot cards:**
  - correct and incorrect on planted cards and on controls
  - XP of kind `check`, accepted
  - activity recorded
  - 404 for someone else's check, 409 when answered twice
- **Eagle eye:** at the 25th caught error, not at 24, and not from controls.
- **Certificates and Bridge builder** ignore `check`, and count `pick` as review work.
- **Pick cards, dealing:**
  - offered only with a stored previous wording
  - not to the author or the improver, or to someone who already reviewed or picked the string
  - not in standard-review projects
- **Pick cards, answering:**
  - 409 when the text changed
  - settling accepts the matching picks and voids the others
  - a send-back voids them
  - `reviewOf` returns the tally
- **Migration:** an old database's `xp_events` is rebuilt, with every row kept and `check` and `pick` accepted.

Web: `npm run typecheck`, and a run in Chromium (a forced Spot card answered both ways, a Pick card, and the
tally on the poster's view). Also in the online demo build.

## Doc changes

- `platform-vision.md` §9: the card-types line links here.
- `segment-3b-badges.md`: Eagle eye is now built.
