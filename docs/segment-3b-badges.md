# Segment 3B: badges and hour certificates

Piece B of Segment 3 ([platform-vision.md](platform-vision.md) §4 and §9): badges for milestones that reflect
quality and reach, and volunteer-hour certificates that a school or employer can check. Builds on piece A
([segment-3a-streaks.md](segment-3a-streaks.md)), whose activity record feeds Rare voice.

## Built

Where each piece lives, and what differs from the design below:

- **Data:** `apps/server/src/schema/badges.ts` (both tables).
- **Badges:** `apps/server/src/badges.ts`.
  - `BADGES` is the catalog. `RARE_MAX`, `RARE_DAYS` and `BRIDGE_ORGS` set the thresholds.
  - Exports `awardBadges`, `badgesOf` and `markSeen`.
  - `stats()` in `xp.ts` awards new badges and returns them.
- **Certificates:** `apps/server/src/certificates.ts` (`RATES`, `RATES_VERSION`, issue, list, revoke, public read).
- **Routes:** in `routes/volunteer.ts`, including the public `GET /api/v1/certificates/:code`.
- **Web:**
  - `volunteer/badges.ts`: names, emoji, and how to earn each badge.
  - `volunteer/VolunteerApp.tsx`: the "New badge" banner on Home and the summary, and the badge row on Home.
  - `volunteer/Achievements.tsx`: the "Badges & hours" screen, a state screen inside `/v`.
  - `certificates/`: the public `/certificate/:code` page and its print styles.
- **Demo:** `apps/server/src/seed/badges.ts`.
  - María's seeded streak days become accepted work, giving her a 1-hour certificate.
  - Yuki earns Rare voice in Japanese. The streaks seed now records her activity in Japanese, not Spanish.
- **Tests:** `apps/server/test/badges.test.ts`, 19 tests.
- **Differences from the design:**
  - **Rare voice is stricter.** You must also have been active in the language in the last 30 days (see the badge
    table).
  - **No `verifyUrl` field.** The API doesn't return one. The web app builds the link from its own address
    (`certificateUrl` in `Achievements.tsx`), because the server's `publicUrl` can't see the online demo's
    `/nativeloc/` base path.
  - **"Withdraw", not "revoke".** The app says "Withdraw", which reads plainer; the API and code still say revoke.
- **Online demo limit:** a certificate's link only opens in the browser that created it, because the demo keeps
  its data on the visitor's device. On a real server anyone can open it.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where certificate hours come from | Estimated from **accepted** work at published rates, with a verification link. | Nothing records time. Accepted-only matches the XP rule, so rushing and idling earn nothing. Anyone can recompute it from the records, and the verify page shows what was issued. Org sign-off can be added later on top. |
| 2 | Rates | 2 minutes per accepted translation, 1 per accepted review. Printed on every certificate. | Writing takes longer than judging. About 1.5 minutes per card on average is conservative next to "5 cards in 5 minutes", and under-claiming is the safer mistake on a document others may audit. |
| 3 | Badges in this piece | First approved, 100 approved, 1,000 approved, Bridge builder, Trusted, Lead, Rare voice. Eagle eye waits for piece C; First responder waits for Segment 4. | Only accepted work and earned trust count (program-design §4: "never raw submission counts"), so there are no streak badges. Eagle eye needs "Spot the problem" cards; First responder needs a record of when a string was marked urgent and when it went live. |
| 4 | Stored or computed | Stored the first time each badge is earned (never removed). New ones are checked whenever stats load. | Rare voice and trust tiers can stop being true; recomputing would quietly take them away. One check in `stats()` replaces about six award points spread through the code. |
| 5 | Certificates | A printable page for a period the volunteer picks. Each is stored as a fixed copy, with an unguessable code and a public `/certificate/<code>` page. The volunteer can revoke it. | The browser's "Save as PDF" makes the file, so there's no PDF library on the server or in the in-browser demo. A fixed copy means later work or rate changes never make a certificate disagree with its verify page. |

**Assumptions** (stated during design, not corrected):
- Badges are private to the volunteer. Showing them publicly or to orgs is piece E.
- A badge that stops being true stays, with no "former" label.
- Existing volunteers get their badges the first time they open the app after release, with real dates where the
  data has them.
- A review earns hours only when its review XP was accepted (it matched the outcome). Staff and org-reviewer
  approvals earn no XP, so no hours: hours are for volunteers.
- Hours round **down** to the nearest half hour. A certificate needs at least half an hour.
- The certificate shows the account name (there's no separate legal-name field; volunteers can change their name
  first). NativeLoc is the issuer; no org signs.
- Any number of certificates.

**Calls made without asking** (open to change at review): which day a piece of work belongs to for a period (when
it was done, not when it was accepted); Rare voice's numbers (5 volunteers, 30 days); badge names and wording;
the endpoint shapes; where the screens live; the demo data; the tests.

## Badges

| Id | Name | Earned when | Earned date |
|---|---|---|---|
| `approved_1` | First approved string | 1 distinct string you translated was accepted | when that string's XP was accepted (`settled_at`) |
| `approved_100` | 100 approved | 100 such strings | when the 100th was accepted |
| `approved_1000` | 1,000 approved | 1,000 such strings | when the 1,000th was accepted |
| `bridge_builder` | Bridge builder | your accepted work (translations or reviews) is in projects of 10 different orgs | when work for the 10th org was first accepted |
| `trusted` | Trusted | you hold `trusted` or `lead` in any language (`user_languages`) | when first noticed |
| `lead` | Lead | you hold `lead` in any language | when first noticed |
| `rare_voice` | Rare voice | you were active in a language in the last 30 days, have accepted work in it, and 5 or fewer volunteers (you included) were active in it in that time | when first noticed; `detail` is the language |

- "Accepted" means `xp_events.status = 'accepted'`, so XP and badges agree. Accepted XP is never taken back
  (`xp.ts`), so the count badges can't become false. Tiers and Rare voice can, which is why badges are stored.
- "Volunteers active" for Rare voice: distinct people with `volunteer_activity` in that locale in the last 30
  days, acting as `localizer` or unknown (the same people return rates count). It counts you too.
- You must be active in the language yourself (§4 says "*active* in a language with few volunteers"). Without that,
  a language nobody has touched in a month would count as rare for anyone with old accepted work in it. This
  was tightened during implementation.
- Before launch nearly every language is rare, so early volunteers will earn Rare voice quickly. That's intended:
  they really are rare voices.
- Eagle eye and First responder are in the catalog as `later: true`, so the app can list them as "coming" without
  any change to the badge model when pieces C and Segment 4 add their data.

### Data

New feature schema `apps/server/src/schema/badges.ts`, registered after `streaksSchema`:

```sql
-- Badges a volunteer has earned (badges.ts). Rows are only ever added: a badge that stops being true stays.
CREATE TABLE IF NOT EXISTS volunteer_badges (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge     TEXT NOT NULL,
  detail    TEXT,                -- e.g. the language for rare_voice
  earned_at TEXT NOT NULL,       -- UTC, CURRENT_TIMESTAMP format
  seen_at   TEXT,                -- set once the app has shown it; NULL = new
  PRIMARY KEY (user_id, badge)
);
```

### Logic (`apps/server/src/badges.ts`)

- `BADGES`: the catalog (id, and `later` for the two placeholders). Names and wording live in the web app, like
  other copy.
- `awardBadges(db, userId, now = Date.now())`: for each badge the person doesn't hold, run its check and insert
  `(badge, detail, earned_at)` when it's true. About five indexed queries, and each is skipped once the badge is
  held. `INSERT OR IGNORE`, so two loads at once can't double-award.
- `badgesOf(db, userId)` → `{ id, detail, earnedAt, new }[]`, oldest first.
- `markSeen(db, userId, ids)`.
- `stats()` calls `awardBadges` and returns `badges`.

## Certificates

### Hours

```
minutes = 2 × accepted translations + 1 × accepted reviews      (xp_events, status 'accepted')
hours   = floor(minutes / 30) / 2
```

- A piece of work belongs to the period in which it was **done** (`xp_events.created_at`), counted if it's
  accepted by the time the certificate is issued. A school-year certificate issued in July includes June's work
  accepted in July.
- `RATES = { translate: 2, review: 1 }` and `RATES_VERSION = '2026-10'` live in `certificates.ts`. Each certificate
  stores the rates it used, so changing them never alters one already issued.
- Orgs helped: the distinct orgs of the projects in the counted work, by name, at issue time.

### Data

In the same schema file:

```sql
-- Volunteer-hour certificates (certificates.ts): a fixed copy of what was issued, so the public verify page shows
-- exactly what was printed. `code` is the unguessable public id.
CREATE TABLE IF NOT EXISTS volunteer_certificates (
  code         TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  period_from  TEXT,              -- YYYY-MM-DD, NULL = from the start
  period_to    TEXT NOT NULL,     -- YYYY-MM-DD, inclusive
  minutes      INTEGER NOT NULL,
  translations INTEGER NOT NULL,
  reviews      INTEGER NOT NULL,
  orgs         TEXT NOT NULL,     -- JSON array of org names
  rates        TEXT NOT NULL,     -- JSON {version, translate, review}
  issued_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS volunteer_certificates_user ON volunteer_certificates(user_id);
```

- The code is `randomToken('vc_')` (24 random bytes, from `auth.ts`).
- Deleting an account deletes its certificates (`ON DELETE CASCADE`). The verify page then says "not found", which
  is the honest answer once the volunteer has left.
- Period days are compared against the UTC date of `created_at`. Volunteers pick whole days, and a day's
  difference at the edge of a school year doesn't matter for a document that rounds to half hours.

## API

- `GET /api/v1/volunteer/stats` adds `badges: { id: BadgeId; detail: string | null; earnedAt: string; new: boolean }[]`.
- `POST /api/v1/volunteer/badges/seen` `{ ids }` → `{ ok: true }`.
- `POST /api/v1/volunteer/certificates` `{ from?: 'YYYY-MM-DD'; to?: 'YYYY-MM-DD' }` → `Certificate`.
  - `to` defaults to today and can't be in the future. `from` must be on or before `to`.
  - 400 for a malformed date. 422 "There isn't half an hour of accepted work in that period yet." below 30
    minutes.
- `GET /api/v1/volunteer/certificates` → `{ certificates: Certificate[] }`, newest first.
- `DELETE /api/v1/volunteer/certificates/:code` revokes one (yours only; 404 otherwise) and returns it.
- `GET /api/v1/certificates/:code`: **no sign-in.** Returns the certificate, `revoked: true` with only the name and
  dates when revoked, or 404.

```ts
interface Certificate {
  code: string;
  name: string;
  periodFrom: string | null;
  periodTo: string;
  hours: number;            // in halves: 12.5
  translations: number;
  reviews: number;
  orgs: string[];
  rates: { version: string; translate: number; review: number };
  issuedAt: string;
  revokedAt: string | null;
}
// The verify link is /certificate/<code> on the site; the web app builds it (see Built).
```

## Web

- **Badges:** the home screen shows a row of earned badges under the streak card, with a "See all" link.
  - When stats come back with new badges, the session summary (or home) shows "New badge: Bridge builder 🌉" once,
    then posts them as seen.
- **"Badges & hours" screen** (`/v/achievements`, inside the volunteer app):
  - every badge: earned ones with their dates, unearned ones greyed with how to earn them, and Eagle eye and
    First responder marked "Coming soon"
  - certificates: create one for a period (presets "All time", "This year", "Last 12 months", plus custom
    dates), the list of issued ones with Open, Copy link and Revoke
- **Certificate page** (`/certificate/:code`, public, works signed out):
  - laid out for A4 and Letter printing (`@media print` hides the app chrome), with a "Print or save as PDF" button
  - shows the name, hours, period, counts, orgs, the method line ("Estimated from 240 accepted translations at 2
    minutes and 85 accepted reviews at 1 minute"), the issue date and the verify URL
  - a revoked certificate says so plainly instead

## Demo data

`apps/server/src/seed/badges.ts`, run after the streaks seed:
- María: First approved (she already has an accepted string). Spanish has six active demo volunteers, so it isn't
  rare. Her badges are left unseen, so the first visit shows the "New badge" moment.
- Yuki: a few accepted Japanese strings, giving First approved and Rare voice (she's the demo's only Japanese
  volunteer).
- One issued certificate for María, so the verify page can be opened from the demo.

## Tests

`apps/server/test/badges.test.ts`:
- Each badge: not earned below its threshold, earned at it, with the right date (`settled_at` of the nth string,
  or the 10th org).
- Rare voice: earned in a language with 5 active volunteers, not in one with 6. Once earned, it stays when the
  language gains more volunteers.
- Trusted and Lead: earned, and kept after a demotion.
- `awardBadges` twice in a row adds nothing the second time. `seen` clears `new`.
- Pending and voided XP earn neither badges nor hours.
- Certificate minutes and half-hour rounding (59 minutes → 0.5 hours; 60 → 1).
- The period uses when work was done. Orgs are listed once each.
- 422 under 30 minutes; 400 for bad dates and future `to`.
- Public read without sign-in, revoke (yours only), and the revoked view. Unknown code → 404.
- An issued certificate is unchanged after more work is accepted.

Web: `npm run typecheck`, and a run in Chromium: home badges and the "New badge" moment, the achievements screen,
creating, printing (`page.pdf`) and revoking a certificate, and the public page signed out. Also in the online
demo build.

## Doc changes

`platform-vision.md` §9: note that Eagle eye waits for piece C, and First responder for Segment 4's urgent lane.
