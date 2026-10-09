# Segment 1: volunteer cards on phones — build spec

Segment 1 of [platform-vision.md](platform-vision.md) §9. **Goal:** prove that people will translate in short
sessions on a phone, and that XP awarded only for accepted work keeps quality up.

The work is split into three parallel pieces with **no shared files**. They meet at the contract in
[apps/web/src/volunteer/types.ts](../apps/web/src/volunteer/types.ts). Change the contract only together.

## The contract

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /api/v1/volunteer/session?size=5` | `SessionResponse` | Cards from the signed-in volunteer's org, in their languages |
| `GET /api/v1/volunteer/stats` | `StatsResponse` | Totals for the home screen and session summary |
| `PUT /api/v1/translations/:keyId/:locale` (existing) | existing fields + `XpAward` | The Translate card saves through this |
| `POST /api/v1/translations/:keyId/:locale/approve` (existing) | existing fields + `XpAward` | The Review card approves through this |

Reviewers' "improve the text" uses the existing PUT, which counts as a new translation by the editor.

### Building a session

- Draw from every project in the user's org and every locale in `user.locales`.
- Only localizers whose tier in that locale isn't `new` get Review cards, and only for translations they can
  act on today (`reviewable` rules: not their own, not already approved by them).
- Mix: when both kinds exist, alternate Translate and Review, starting with Translate. Otherwise fill with
  whichever exists.
- Keep the existing queue order (strings that share a screenshot come together).
- `empty: 'no_languages'` if the user has no locales; `'nothing_to_do'` if there's no work.

### XP rules (the important part)

Stored as a ledger: `xp_events(id, user_id, kind, key_id, locale, project_id, points, status, created_at,
settled_at)`, with `status` one of `pending`, `accepted`, `voided`. Totals are sums, never stored counters.

| Event | Effect |
|---|---|
| A localizer saves a translation that goes to `review` | +10 **pending** for the author |
| A save that is approved immediately (no review required, or a lead/reviewer) | +10 **accepted** |
| The translation becomes `approved` (enough peer votes, or a reviewer/lead approves) | The author's pending XP for that key+locale → **accepted**; voters' pending votes → **accepted** |
| A peer approval vote | +5 **pending** for the voter |
| Someone else changes the text, or a reviewer sends it back (`reject`) | The previous author's pending XP and all pending vote XP for that key+locale → **voided** |
| A reviewer/admin approves outright | No XP for them (it's their job); the author's pending → accepted |

Rules: one pending translate event per user per key+locale (re-saving your own text doesn't stack); XP
never goes negative; accepted XP is never taken back.

## The three pieces

### A. Server: XP ledger and volunteer API

**Owns:** `apps/server/src/xp.ts` (new), `apps/server/src/routes/volunteer.ts` (new), `apps/server/src/app.ts`
(register routes), `apps/server/src/db.ts` (table + migration), `apps/server/src/services.ts` and
`apps/server/src/routes/localize.ts` (ledger hooks + `xp` in responses), `apps/server/src/seed.ts` (enough
demo strings for a few sessions), `apps/server/test/volunteer.test.ts` (new).

**Done when:** every row of the XP table has a test; session building is tested for tiers, alternation,
peer filtering and both empty reasons; `npm test` and `npm run typecheck` pass.

### B. Web: the card flow

**Owns:** `apps/web/src/volunteer/*` (except `types.ts`, the contract), `apps/web/src/App.tsx` (add the
`/v` route), `apps/web/src/pages/Home.tsx` (a prominent **Start a 5-minute session** entry for localizers).

- `/v` home: one big **Start** button, today's XP (accepted solid, pending faded), approved-strings count.
- Session: one card per screen, one-thumb layout, progress dots, big **Next** at the bottom.
  - **Translate:** source, context note, screenshot (tap to zoom), placeholder chips, plural forms. Reuse
    pieces from `localizer/Workspace.tsx` by importing; don't edit that file.
  - **Review:** source, translation, **Approve** / **Improve** (opens the text) / **Skip**.
  - Validation errors (HTTP 422 `issues`) shown inline on the card.
- After each card: a short animation and the XP award (pending shown faded).
- Summary: cards done, XP earned (pending vs accepted), projects helped, **Another 5** and **Done**.
- Styles in `apps/web/src/volunteer/volunteer.css`, using the existing color variables from `styles.css`,
  light and dark. Design for 360–430px wide first; it should still look right on desktop.
- A dev-only mock (`?mock=1`, in `volunteer/mock.ts`) so the UI can be built before piece A lands.

**Done when:** a full session works end to end against the real server on a phone-sized viewport, in
light and dark mode; `npm run typecheck` passes.

### C. Web: installable app shell (PWA)

**Owns:** `apps/web/public/*` (new), `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/vite.config.ts`
if needed.

- `manifest.webmanifest`: name, short name, theme and background colors matching the brand teal,
  `display: standalone`, `start_url: /v`, icons (192, 512, maskable), generated from the existing 文A mark.
- `index.html`: manifest link, `theme-color` (light and dark), Apple touch icon and web-app meta tags,
  `viewport-fit=cover`.
- A small hand-written service worker (no new dependencies): cache the app shell for fast start and an
  offline "You're offline; your work is saved when you reconnect" screen. **Never cache `/api/`**.
  Registered from `main.tsx` in production builds only.

**Done when:** a production build (`npm run build -w @nativeloc/web`, served by `npm start`) passes
Chrome's installability check, shows the offline screen with the network off, and `/api` requests are
never served from cache.

## Merging

Each piece works on its own branch off this commit. Merge A first, then B (drop the mock fallback's use in
production paths, keep `?mock=1`), then C. After merging: run a full session against the seeded demo on a
phone-sized viewport and note the three Segment 1 numbers: session completion rate, strings per session,
and share accepted.
