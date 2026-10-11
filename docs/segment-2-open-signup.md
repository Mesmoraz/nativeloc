# Segment 2: open sign-up and the community tier — plan

Segment 2 of [platform-vision.md](platform-vision.md) §9. **Goal:** anyone can join as a volunteer, a
requester, or both. **Done when:** a stranger can sign up, post a non-commercial page, and publish it after
community review, with no help from us.

## 1. What has to change first

Today the platform is "one org and its own volunteers":

- Every user belongs to exactly **one org** (`users.org_id`), with one org-wide role. `projectAccess` in
  `apps/server/src/auth.ts` rejects any project outside the user's org. 47 queries use `org_id`.
- Volunteers only ever see their own org's work. The Segment 1 session builder draws from "the user's org".
- There's no platform staff role, so nobody can verify a nonprofit or moderate a post.

Segment 2 needs volunteers who belong to the **platform** and help **many** orgs, and people who are members
of one or more orgs. That change touches auth and most queries, so it goes first, alone (§3, step 2.0).
Everything after it can run in parallel.

Trust tiers are already per user and language, not per org, so they carry over unchanged.

## 2. Design

### Accounts and memberships

- `users` becomes global: drop the meaning of `users.org_id` and `users.role` (keep the columns until the
  migration has run everywhere, then remove).
- New `memberships(user_id, org_id, role)`, role `admin | reviewer | localizer`. A user can have several.
- **Volunteer** is not an org role. Anyone with languages in `users.locales` is a volunteer and sees public
  work. A `localizer` membership means "this org's own translator" and also gives access to the org's
  private projects.
- New `users.is_staff` for NativeLoc staff (verification and moderation).
- Migration: every existing user gets a membership with their current org and role. Behavior for the demo
  must not change.

### Organizations

New columns on `orgs`:

| Column | Values |
|---|---|
| `type` | `nonprofit`, `individual`, `small_org`, `business` |
| `verification` | `unverified`, `pending`, `verified`, `rejected` |
| `ein`, `website`, `description` | For verification and for volunteers to see who they're helping |

- **Individual** accounts get a personal org automatically, so everything still hangs off an org.
- **Business** sign-ups are saved with `type = business` and go on a waitlist; they can't post.
- **Nonprofit verification:** look up the EIN in the IRS Exempt Organizations Business Master File (a public
  CSV, imported into a local table by a script and refreshed monthly). A match on EIN + name + state sets
  `verified`. No match, or a group without an EIN, goes to the staff queue with a short form.
- Until verified, a nonprofit is served as a community org (same as small org).

### Projects: who sees them, how they're reviewed

New columns on `projects`:

| Column | Values | Meaning |
|---|---|---|
| `visibility` | `private`, `public` | `public` puts the work in the open volunteer pool. `private` is today's behavior (members only) |
| `moderation` | `none`, `pending`, `approved`, `rejected` | Public projects need `approved` before volunteers see them |
| `review_mode` | `standard`, `community` | `standard` is today's peer review. `community` is the adaptive 3–5 rounds |

Defaults: verified nonprofits get `standard` review with Trusted/Lead reviewers; community orgs get
`community`.

### Adaptive 3–5 round review (community mode)

A Review card gets a third choice: **Approve**, **Improve**, or **Flag** (with a reason: wrong meaning,
grammar, tone, offensive).

- Count reviews per translation since it was first submitted, across edits.
- If every review so far has been an approval, **3 approvals** of the current text reach consensus.
- After any Flag or Improve, the current text needs **5 approvals** with at most one Flag.
- After **8 reviews** with no consensus, the string is **escalated**: only Trusted and Lead reviewers see it,
  and one Lead approval settles it.

Consensus doesn't publish anything. It moves the translation to a new status, **`ready`** (community agreed,
waiting for the poster). Bundles keep shipping only `approved` text, so nothing goes live without the poster.

**Poster approval.** The org sees a "Ready to publish" list: each string with its review count and any
flags or disagreement. Publish all, publish one, edit, or send back. Publishing sets `approved`.

**XP.** Volunteers' pending XP becomes accepted at consensus (`ready`): their peers accepted the work. A
poster sending text back later doesn't take XP away (accepted XP is never taken back). Flags that match the
final outcome earn review XP like approvals do.

### Quality labels

The bundle manifest gets a per-locale `quality`: `verified` (standard review with a Lead, or a verified
nonprofit's reviewers) shown as "Checked by N native speakers", or `community` shown as
"Community-reviewed, not verified". The SDKs and the future snippet display it; the web app shows it on
publish.

### Moderation

Every public project starts `pending`.

- **Automatic screen** on submit: size limits, link and phone-number density, a blocklist, and a check that
  the content isn't obviously commercial (prices, "buy now", checkout). Clear passes are approved; anything
  else goes to the staff queue.
- **Staff queue:** approve, reject with a reason, or ask for changes.
- **Reports:** volunteers can report a card ("spam", "commercial", "harmful"). Three reports pause the
  project and send it back to the queue.

### The open volunteer pool

The Segment 1 session builder draws from **every public, approved project** plus private projects the user
is a member of, in their languages, in this order:

1. Urgent strings (Segment 4 adds the on-call side; the flag can exist now)
2. Verified nonprofits
3. Community orgs
4. Within each: strings that share a screenshot together, oldest first

Cards show who you're helping: org name, type ("Nonprofit", "Community group", "Individual") and a one-line
description. Volunteers can filter to "Nonprofits only".

### Sign-up and onboarding

- Self-serve sign-up: name, email, password. **Email verification** before posting or reviewing (an outbox
  table plus a mailer interface; dev logs the link to the console; pick a provider before launch).
- Onboarding picks the hats:
  - **Help:** pick languages → placement check (built) → first session.
  - **Get translation:** pick the account type → org details (and EIN for nonprofits) → first post.
- Existing invite and join links keep working; joining through one creates a membership.

### Posting content

A requester creates a project and adds content in one of three ways:

1. **Paste text** (new): split into sentences/paragraphs as strings, with an optional context note.
2. **Upload a file** (built: strings.xml, .po, JSON).
3. **Website** (new on the server): enter a URL; the server runs the existing `@nativeloc/site` crawler as a
   background job, help pages first, capped per org.

Then they choose languages and submit for moderation.

## 3. Build plan: one foundation step, then five parallel pieces

**Prerequisite:** Segment 1's three branches are merged and verified.

### 2.0 Foundation (one session, alone)

Memberships, org columns, `is_staff`, project columns, the new `ready` status, and the migration. Rewrite
`projectAccess` and the org-scoped queries to use memberships. **No behavior change:** existing tests and the
demo pass unchanged, plus migration tests. It also writes the contract for the pieces below (endpoint shapes
and shared types in `apps/web/src/types.ts` or a new `contracts/` file) and a file-ownership table. Done: see [segment-2-contracts.md](segment-2-contracts.md).

### Parallel pieces (after 2.0 merges)

| Piece | Server | Web |
|---|---|---|
| **2A. Sign-up and onboarding** | Sign-up, email verification, mailer interface, memberships on invite/join | Sign-up, the two-hat onboarding, account settings |
| **2B. Verification and moderation** | IRS EO-BMF import script and lookup, verification queue, automatic screen, moderation queue, reports | Staff console: verification and moderation queues |
| **2C. Community review engine** | Adaptive rounds, Flag votes, escalation, `ready`, poster publish, XP changes, quality labels | The poster's "Ready to publish" screen |
| **2D. Posting content** | Paste-text splitter, server-side crawl jobs, project visibility settings | New-project flow: paste, upload, website; language picker; submit for moderation |
| **2E. Open volunteer pool** | Session builder across orgs with priority, "nonprofits only" filter | Org info and filter on cards, the Flag button and Report link on cards |

Each piece owns its own files; 2.0's ownership table settles shared ones (`services.ts` review logic belongs
to 2C, the session builder to 2E, auth routes to 2A).

Merge order: 2C and 2E first (they change review and the pool), then 2A, 2B, 2D. Then run the "done when"
test end to end: a new account posts a page, it passes moderation, volunteers reach consensus, the poster
publishes.

## 4. Decisions needed

| Decision | Recommendation |
|---|---|
| Email provider | Postmark or Resend; the mailer interface keeps it swappable |
| Business sign-ups before Segment 5 | Waitlist only; no posting |
| Commercial-content screen | Automatic heuristics + staff review; a model-based check can come later |
| Do flags from new (unplaced) volunteers count? | No: like approvals, only Trusted and above count; new volunteers' flags go to staff as reports |
| Crawl limit per org on the community tier | 15 pages (about 4,000 words, per program-design's sizing data) |
| Who is staff at launch | You, plus anyone you add by hand |
