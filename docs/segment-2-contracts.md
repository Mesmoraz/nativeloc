# Segment 2 contracts: what the parallel pieces build against

Step 2.0 of [segment-2-open-signup.md](segment-2-open-signup.md) is done: users belong to orgs through
memberships, and the schema has everything §2 of the plan names. This file is the contract for the five pieces
that now run in parallel (2A–2E): the model they share (§1), how to add things without touching another piece's
files (§2), the endpoints each piece adds, with example JSON (§3), the server functions pieces call across the
boundary (§4), and who owns which file (§5). §6 lists the risks.

Shared TypeScript types are in [`apps/web/src/contracts.ts`](../apps/web/src/contracts.ts). The server returns
the "live" ones today; the others are what the named piece will return.

## 1. The model after 2.0

- **Accounts are global.** `users` has no meaningful org or role any more. `users.org_id` and `users.role` are
  legacy columns: nullable, never read, kept until every database has migrated. `UserRow` leaves them out, and
  users are always selected with `USER_COLUMNS` (or `getUser`), never `*`.
- **`memberships(user_id, org_id, role)`**, role `admin | reviewer | localizer`. A user can have any number,
  including none. `memberOf(db, user, orgId)` returns a `Member` (the user plus `orgId` and `role`), or null.
  `addMembership` inserts or changes the role.
- **The role that counts is the one in the project's org.** `projectAccess` looks up the membership for
  `project.org_id`. No membership means 404 (unless 2E's pool hook lets the user in, §4). It returns
  `{ project, actor, member }`; pass `member` to services, never the raw user.
- **Current org.** A sign-in works in one org at a time: `sessions.org_id`, picked with `PUT /api/v1/me/org`.
  When that's unset or no longer a membership, the oldest membership counts. Org-wide endpoints (project list,
  team, invites, join links, placement items, the grading queue) use it. `requireMember(db, req, roles?)` gives
  `{ member }` for the current org and returns 403 when the user has no org or the wrong role there.
  `requireUser` lets in anyone signed in, with or without an org. `requireStaff` checks `users.is_staff`.
- **Trust stays per person and language** (`user_languages`). With no row, the default now comes from the
  user's strongest membership: admin or reviewer anywhere gives `lead`, a localizer membership gives `trusted`,
  and no membership gives `new`. See risk 1.
- **Who reviews** is one function, `reviewRight(db, project, member, locale)` in `services/review.ts`. It returns
  `'approve'` (approves outright), `'vote'` (one peer vote) or `null`. `projectAccess('review')`, Review cards
  and the queues all use it.
- **New columns**, all defaulting to today's behavior:
  - `orgs.type` (`small_org`), `orgs.verification` (`unverified`), `orgs.ein`, `orgs.website`, `orgs.description`
  - `projects.visibility` (`private`), `projects.moderation` (`none`), `projects.review_mode` (`standard`)
  - `users.is_staff` (0); the demo admin is staff
- **`translations.status` may be `ready`.** No code sets it yet. Bundles and exports still ship only `approved`
  (and valid `outdated`). `progress()` counts `ready` separately, and `todo` excludes it.
- **Migration:** `openDb` rebuilds `users` (org_id/role become nullable) and `translations` (the new CHECK) on
  an old database, adds the columns, and gives each existing user a membership for their org and role, once.
  A trigger gives any row still inserted the old way (with `org_id` and `role`) its membership, so old fixtures
  keep working. New code inserts users without those columns and calls `addMembership`.
- **No visible change:** all Segment 1 tests pass unchanged. 340 API responses (every demo user, every
  project, every read endpoint) are identical before and after 2.0, apart from the added fields.

## 2. Rules for the pieces

1. **Edit only files your piece owns (§5).** If you need a frozen or someone else's file changed, ask the
   coordinating session instead of editing it.
2. **Schema:** add tables and columns in your own `apps/server/src/schema/<piece>.ts`. It runs on every start,
   after the core schema, so write idempotent SQL (`CREATE ... IF NOT EXISTS`, and guard `ALTER TABLE ADD
   COLUMN` with `PRAGMA table_info`). Use `db.exec` and `db.prepare` directly in it, because `db.ts` imports it.
3. **Routes:** register endpoints in your own route module (`routes/signup.ts`, `staff.ts`, `community.ts`,
   `posting.ts`; 2E uses `volunteer.ts`). `app.ts` already calls them with `RouteDeps { db, dataDir, screenshotDir }`.
4. **Demo data:** in `apps/server/src/seed/<piece>.ts`. It gets the `Demo` ids and runs before v1 is published.
5. **Web pages:** return `<Route>`s from your `apps/web/src/<piece>/routes.tsx`. App.tsx renders them signed in
   or out (`session` is null when signed out). Other web slots: `signup/AccountMenu.tsx` (top bar),
   `signup/HomeNotice.tsx` and `community/HomeNotice.tsx` (top of Home), and `posting/projectTabs.tsx` (extra
   project admin tabs). Put CSS in a file in your folder, not `styles.css`.
6. **Types:** build against `contracts.ts`. Response shapes may only gain fields. Don't rename or remove any.
7. **Tests:** add your own `apps/server/test/<piece>.test.ts`. Existing tests must keep passing. Only the
   owner of a test file (§5) may change its assertions, and the commit message must say why.
8. **Dependencies:** no new npm packages without asking (the lockfile is shared).
9. Don't decide anything in the plan's §4 table yourself. Build so the decision is one constant or one function,
   and flag it in your hand-over.

## 3. Endpoints by piece

Errors are always `{ "error": "Human sentence." }` with the status code; 422s may add `details`.

### Live since 2.0

`GET /api/v1/me`, and `PUT /api/v1/me/org` with `{ "orgId": 2 }` (404 if not a member). Type: `MeResponse`.

```json
{
  "user": { "id": 3, "email": "maria@demo.test", "name": "María López", "role": "localizer",
            "locales": ["es"], "tiers": { "es": "trusted" }, "isStaff": false },
  "org": { "id": 1, "name": "FreshMart Demo", "type": "small_org", "verification": "unverified",
           "website": null, "description": null, "role": "localizer" },
  "orgs": [ { "id": 1, "name": "FreshMart Demo", "type": "small_org", "verification": "unverified",
              "website": null, "description": null, "role": "localizer" } ]
}
```

A user with no org gets `"org": null, "orgs": []` and `"role": null`. Projects (list and detail) gained
`"orgId", "visibility": "private", "moderation": "none", "reviewMode": "standard"`, and each progress row gained
`"ready": 0`.

### 2A: sign-up and onboarding

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/v1/auth/signup` | `{ "name": "Ana Ruiz", "email": "ana@example.org", "password": "at-least-8" }` | `{ "user": PublicUser }` with session cookie. 409 if the email exists. No org; `emailVerified: false` |
| `POST /api/v1/auth/verify-email` | `{ "token": "…" }` | `{ "user": PublicUser }` (`emailVerified: true`). 404 for a bad or used token |
| `POST /api/v1/auth/resend-verification` | none | `{ "ok": true }` (rate-limited) |
| `PATCH /api/v1/me` | `{ "name": "Ana R.", "locales": ["es", "pt-BR"] }` | `MeResponse`. New languages start at tier `new` |
| `POST /api/v1/orgs` | `{ "type": "nonprofit", "name": "Eastside Food Bank", "ein": "12-3456789", "website": "https://eastside.example", "description": "Groceries for 3,000 families a month" }` | `{ "org": OrgMembership, "waitlisted": false }`. Caller becomes `admin` and the org becomes current |
| `PATCH /api/v1/orgs/:id` | `{ "description": "…", "ein": "…" }` (org admins) | `{ "org": OrgMembership }` |
| `POST /api/v1/invites/:token/accept` | as today. **Signed in:** no body needed | Signed in: adds the membership and returns `{ "user" }` (no new account) |
| `POST /api/v1/join/:code` | as today | Signed in but **not a member**: adds a `localizer` membership, then adds the languages as today |

Example `POST /api/v1/orgs` response for a business: `{ "org": { …, "type": "business" }, "waitlisted": true }`.
Individuals get a personal org named after them (`"type": "individual"`).

### 2B: verification and moderation (staff)

| Endpoint | Request | Response |
|---|---|---|
| `GET /api/v1/orgs/ein/:ein` | public | `{ "match": { "ein": "123456789", "name": "EASTSIDE FOOD BANK", "city": "PORTLAND", "state": "OR" } }` or `{ "match": null }` |
| `GET /api/v1/staff/verifications` | staff | `VerificationQueueResponse` |
| `POST /api/v1/staff/verifications/:orgId` | `{ "decision": "verified", "note": "Matched by phone" }` | `{ "org": OrgSummary }` |
| `GET /api/v1/staff/moderation` | staff | `ModerationQueueResponse` |
| `POST /api/v1/staff/moderation/:projectId` | `{ "decision": "changes", "reason": "Remove the prices on page 2" }` | `{ "project": { "id": 7, "moderation": "rejected" } }` |
| `POST /api/v1/reports` | `{ "projectId": 7, "keyId": 120, "reason": "commercial", "note": "Coupon codes" }` | `{ "ok": true, "paused": false }`. Third distinct reporter: `"paused": true` and moderation goes back to `pending` |

```json
{ "orgs": [ {
  "org": { "id": 9, "name": "Eastside Food Bank", "type": "nonprofit", "verification": "pending",
           "website": "https://eastside.example", "description": "…", "ein": "123456789", "createdAt": "2026-10-09T17:00:00Z" },
  "match": { "ein": "123456789", "name": "EASTSIDE FOOD BANK INC", "city": "PORTLAND", "state": "OR" },
  "admins": [ { "name": "Ana Ruiz", "email": "ana@example.org" } ] } ] }
```

```json
{ "projects": [ {
  "project": { "id": 7, "name": "Pantry hours page", "visibility": "public", "strings": 42, "submittedAt": "2026-10-09T17:05:00Z" },
  "org": { "id": 9, "name": "Eastside Food Bank", "type": "nonprofit", "verification": "verified", "website": null, "description": null },
  "reasons": ["4 phone numbers"], "reports": [ { "reason": "spam", "count": 1 } ],
  "sample": ["Open Monday to Friday", "Call 555-0100 for delivery"] } ] }
```

All `/staff/*` endpoints use `requireStaff` (403 for everyone else).

### 2C: community review engine

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/v1/translations/:keyId/:locale/flag` | `{ "reason": "meaning", "note": "Says month, not week" }` | `FlagResponse` |
| `POST /api/v1/translations/:keyId/:locale/approve` (existing) | none | Community mode adds `"review": CommunityReview`; `status` may be `"ready"` |
| `GET /api/v1/projects/:id/queue` (existing) | | Each item gains `"review": CommunityReview \| null` |
| `GET /api/v1/projects/:id/ready?locale=es` | org admins | `ReadyListResponse` |
| `POST /api/v1/projects/:id/ready/approve` | `{ "items": [ { "keyId": 120, "locale": "es" } ] }`, or `{}` for all | `{ "approved": 1 }` |
| `POST /api/v1/projects/:id/ready/send-back` | `{ "keyId": 120, "locale": "es", "note": "Too formal" }` | `{ "status": "review" }` |
| `GET /b/:token/manifest.json` (existing) | | Each locale gains `"quality": "community", "reviewers": 4` |

```json
{ "status": "review",
  "review": { "reviews": 4, "approvals": 2, "flags": 1, "needed": 5, "escalated": false },
  "xp": { "points": 5, "status": "pending" } }
```

```json
{ "items": [ { "keyId": 120, "key": "visit.limit", "source": "You can visit once a week.", "locale": "es",
  "text": "Puede venir una vez por semana.",
  "review": { "reviews": 6, "approvals": 5, "flags": 1, "needed": 5, "escalated": false },
  "flags": [ { "reason": "meaning", "count": 1 } ], "disagreement": true } ] }
```

Standard projects behave as today. The poster publishes ready text (`ready` → `approved`), then publishes the
bundle as today.

### 2D: posting content

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/v1/projects` (existing) | adds `"visibility": "public"`, `"reviewMode": "community"` (optional; the default comes from the org) | `{ "project": Project }` |
| `PATCH /api/v1/projects/:id` (existing) | adds `visibility`, `reviewMode` | `{ "project": Project }`. Going public sets moderation `none` until submitted |
| `POST /api/v1/projects/:id/paste` | `{ "text": "We are open Monday to Friday.\n\nCall us for delivery.", "context": "Hours page", "split": "paragraphs" }` | `PasteResponse` |
| `POST /api/v1/projects/:id/crawl` | `{ "url": "https://eastside.example/help" }` | `{ "job": CrawlJob }` (status `queued`); capped per org |
| `GET /api/v1/projects/:id/crawl` | | `{ "jobs": [CrawlJob] }` |
| `POST /api/v1/projects/:id/submit` | none (public projects) | `{ "moderation": "pending", "reasons": ["mentions prices"] }` |

```json
{ "created": 2, "unchanged": 0, "keys": [
  { "key": "p1", "source": "We are open Monday to Friday." },
  { "key": "p2", "source": "Call us for delivery." } ] }
```

```json
{ "job": { "id": 3, "url": "https://eastside.example/help", "status": "queued", "pages": 0, "strings": 0, "error": null, "createdAt": "2026-10-09T17:10:00Z" } }
```

### 2E: open volunteer pool

| Endpoint | Request | Response |
|---|---|---|
| `GET /api/v1/volunteer/session?size=5&nonprofitsOnly=1` (existing) | | `SessionResponse`; each card gains `"org": CardOrg` |
| `projectAccess` (no endpoint) | | Non-members reach public, `approved` projects in their languages as `localizer` (via `openPoolRole`) |

```json
{ "id": "translate:120:es", "type": "translate",
  "project": { "id": 7, "name": "Pantry hours page", "sourceLocale": "en" },
  "org": { "id": 9, "name": "Eastside Food Bank", "type": "nonprofit", "verified": true, "description": "Groceries for 3,000 families a month" },
  "locale": "es", "item": { "…": "QueueItem as today" } }
```

Cards' Flag button calls 2C's `/flag`, and the Report link calls 2B's `/api/v1/reports`. Until those merge, the
mock in `volunteer/mock.ts` stands in.

## 4. Server functions across pieces

Each one exists now as a stub with its final signature. The owner fills it in; callers don't change it.

| Function | File (owner) | Called by | Stub behavior |
|---|---|---|---|
| `assertMayContribute(db, user, project, access)` | `signup/gate.ts` (2A) | `projectAccess`, for every signed-in user it admits | Allows all. 2A: 403 for unverified emails on translate/review/admin |
| `openPoolRole(db, user, project, access)` | `pool/access.ts` (2E) | `projectAccess`, when there's no membership | `null` (404). 2E: `'localizer'` for public, `approved` projects |
| `reviewRight(db, project, member, locale)` | `services/review.ts` (2C) | `projectAccess`, `buildSession` (2E), queues | Today's rule. 2C adds community mode |
| `queue(db, project, locale, mode, opts)` | `services/queue.ts` (2C) | localize routes, `buildSession` (2E) | Today's queue; items may only gain fields |
| `screenProject(db, project)` | `moderation/screen.ts` (2B) | 2D's `/submit` | `{ decision: 'pending', reasons: [...] }` |
| `startVerification(db, org)` | `moderation/verify.ts` (2B) | 2A's `POST/PATCH /orgs` | Nonprofits → `pending` |
| `upsertEntries`, `importFile` | `services/ingest.ts` (2D) | projects routes, 2D's paste and crawl | Today's ingest |

## 5. File ownership

Each file has one owner while the pieces run. "Frozen" files belong to 2.0: nobody edits them until all pieces
have merged. Files a piece creates belong to that piece, inside its own folders.

| Owner | Server (`apps/server/`) | Web (`apps/web/src/`) | Elsewhere |
|---|---|---|---|
| **2A** sign-up and onboarding | `src/routes/auth.ts`, `src/routes/signup.ts`, `src/routes/placement.ts`, `src/trust.ts`, `src/signup/*`, `src/schema/signup.ts`, `src/seed/signup.ts`, `test/server.test.ts`, `test/signup.test.ts` | `signup/*`, `pages/Login.tsx`, `pages/Invite.tsx`, `pages/Join.tsx`, `pages/Placement.tsx`, `pages/Grading.tsx` | `docs/segment-2a-*.md` |
| **2B** verification and moderation | `src/routes/staff.ts`, `src/moderation/*`, `src/schema/moderation.ts`, `src/seed/moderation.ts`, `scripts/*` (EO-BMF import), `test/moderation.test.ts` | `staff/*` | `docs/segment-2b-*.md` |
| **2C** community review engine | `src/services/review.ts`, `src/services/queue.ts`, `src/services/publish.ts`, `src/xp.ts`, `src/routes/localize.ts`, `src/routes/community.ts`, `src/routes/bundles.ts`, `src/schema/review.ts`, `src/seed/review.ts`, `test/review.test.ts` | `community/*`, `admin/ProjectAdmin.tsx`, `admin/Screenshots.tsx`, `localizer/Workspace.tsx`, `components.tsx` | `packages/core/src/index.ts` (manifest type only), `sdks/js/**`, `sdks/android/**`, `docs/segment-2c-*.md` |
| **2D** posting content | `src/routes/projects.ts`, `src/routes/posting.ts`, `src/services/ingest.ts`, `src/posting/*`, `src/schema/posting.ts`, `src/seed/posting.ts`, `test/posting.test.ts` | `posting/*`, `pages/Home.tsx` | `packages/site/**`, `docs/segment-2d-*.md` |
| **2E** open volunteer pool | `src/routes/volunteer.ts`, `src/pool/*`, `src/schema/pool.ts`, `src/seed/pool.ts`, `test/volunteer.test.ts`, `test/pool.test.ts` | `volunteer/*` | `docs/segment-2e-*.md`, `docs/segment-1-volunteer-cards.md` |
| **Frozen** (2.0) | `src/app.ts`, `src/auth.ts`, `src/db.ts`, `src/main.ts`, `src/seed.ts`, `src/seed/types.ts`, `src/services.ts`, `src/services/progress.ts`, `src/util.ts`, `test/memberships.test.ts`, `test/fixtures/*`, `package.json` | `App.tsx`, `api.ts`, `contracts.ts`, `types.ts`, `main.tsx`, `styles.css`, `localizer/Screenshot.tsx`, `index.html`, `public/*`, `vite.config.ts`, `package.json` | root `package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, `docs/segment-2-*.md`, `docs/platform-vision.md` |
| Nobody (not needed in Segment 2) | | | `packages/cli/**`, `examples/**`, `Dockerfile`, `docker-compose.yml`, `README.md` |

Where the plan says a piece does something in a file it doesn't own, the hook already exists:

- 2A "memberships on invite/join" → `routes/auth.ts` (2A owns it).
- 2A's email gate on reviewing → `signup/gate.ts`, called from the frozen `projectAccess`.
- 2C's "Ready to publish" screen → a route in `community/routes.tsx` plus a tab or link in `ProjectAdmin.tsx` (2C
  owns it); 2D's project tabs come from `posting/projectTabs.tsx`.
- 2C's poster banner and 2A's onboarding nudge on Home → `community/HomeNotice.tsx` and `signup/HomeNotice.tsx`,
  rendered by `Home.tsx` (2D).
- 2D's submit → 2B's `screenProject`. 2A's org creation → 2B's `startVerification`.
- 2E's pool access → `pool/access.ts`, called from `projectAccess`; Review cards' rule → 2C's `reviewRight`.

## 6. Risks for the parallel pieces

1. **Default trust leaks across orgs (2A, 2E).** With no `user_languages` row, an admin or reviewer of *any* org
   is `lead` in every language. A requester who signs up gets an admin membership in their own org, so once 2E
   opens public projects to non-members, that requester could approve volunteers' work outright. 2A must write
   an explicit `new` row for every language a self-serve user picks (sign-up, `PATCH /me`, org creation), as join
   links already do. 2E should add a test that a requester-admin's first public review is a vote, not an approval.
2. **Placement checks are per org (2A, 2E).** `placement_items.org_id` means a volunteer with no org has no
   placement check, so they can never leave `new`. 2A needs a platform-wide set (e.g. items owned by a staff
   org) before 2E's open pool is useful for reviewing. Coordinate before building.
3. **Languages and tiers are global, but team admins edit them (2A).** `PATCH /api/v1/users/:id` lets an org
   admin change a member's `locales` and tiers, which now affects every org that person helps. Today that's the
   same as before (one org), but 2A should limit what an admin can change for people who are also members
   elsewhere.
4. **"Current org" is invisible in the UI until 2A adds `AccountMenu`.** Someone with two memberships works in
   the oldest one. The project list, team, invites and join links follow the current org; project pages and
   card sessions work across all their orgs.
5. **`reviewRight` couples 2C and 2E.** 2E's session builder deals Review cards only when `reviewRight` says so,
   and 2C changes that rule for community mode. Merge 2C first (as planned), then rerun 2E's tests.
6. **Moderation and pool visibility (2B, 2D, 2E).** Public projects are visible to volunteers only with
   `moderation = 'approved'`. 2D sets `pending` or `approved` on submit, 2B moves `pending` → `approved` or
   `rejected` and back to `pending` on reports. Nobody else writes `moderation`.
7. **Legacy columns.** Don't read `users.org_id` or `users.role`. Insert users without them and call
   `addMembership`. The legacy trigger only exists so old fixtures keep working. When the columns are dropped
   (after Segment 2), drop the trigger in the same migration.
8. **An existing account can't join a second org yet.** Invite and join links still need a new account unless
   you're already a member; 2A changes that in `routes/auth.ts`.
9. **The §4 decisions are still open** (email provider, business waitlist, commercial screen, flags from new
   volunteers, crawl limit, launch staff). Each piece should keep its choice in one constant or function and name
   it in its hand-over.
