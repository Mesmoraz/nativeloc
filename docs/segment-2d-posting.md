# Segment 2D: posting content

Endpoints are in [segment-2-contracts.md](segment-2-contracts.md) §3 (2D). What's worth knowing beyond that:

- **Decisions in one place** (`apps/server/src/posting/policy.ts`): `BUSINESS_MAY_POST = false` (businesses are
  waitlisted; marked `integration: assertMayPost` for 2A), `CRAWL_PAGE_LIMIT = 15` (pages per crawl, plan §4), and
  `defaultReviewMode(org, visibility)`: private → `standard`; public → verified nonprofit ? `standard` : `community`.
  An explicit `reviewMode` on create or PATCH wins.
- **Business orgs** get 403 on project create, paste, crawl, submit, and on PATCH to public.
- **Paste** (`posting/split.ts`): paragraphs by default (blank lines or single line breaks; hard-wrapped lines are
  rejoined; bullets dropped, numbering kept), or sentences (`Intl.Segmenter` in the source language). Paragraphs over
  600 characters become runs of whole sentences; nothing is longer than 1,500. Limits: 100,000 characters and 1,000
  strings per paste (413 with a sentence). The context note becomes each string's description.
- **Keys are derived from the text** (`@nativeloc/site`'s `keyFor`, e.g. `w.3fa…`), not `p1`/`p2` as in the contract's
  example. Pasting the same text again finds the same strings (`unchanged`), and pasted text shares keys with the
  same text crawled from a website. The paste request also takes `dryRun: true` (preview, nothing saved) and the
  response adds `updated`.
- **Crawl jobs** (`posting/crawlJobs.ts`, table `crawl_jobs`): one runner per server, one job at a time, one
  queued/running job per org (409). On start, a job left `running` is marked `failed` ("The server restarted…") and
  queued jobs run. `pages` updates as pages are read; `strings` when done. The crawl is `@nativeloc/site`'s `crawl`
  (help pages first) with user agent `NativeLocBot/0.1 (volunteer translation for nonprofits)`. robots.txt groups
  now match on our product token (`nativelocbot`), so a group naming NativeLocBot applies (fixed in `packages/site`).
- **Network guard** (`posting/netguard.ts`): every crawler request goes through `guardedFetch`: http/https only, no
  credentials in URLs, ports 80/443, hosts that resolve only to public addresses (checked on submit and again at
  connect time), redirects followed by hand with each hop checked, 15 s timeout, 2 MB cap, 1 s between requests to a
  host. `netSettings.allowHosts` lets tests reach a local server; it's empty in production.
- **Submit** runs 2B's `screenProject` only when moderation is `none` or `rejected` (`pending` and `approved` are
  returned as they are), and needs a public project, at least one string and one target language. Changing
  visibility resets moderation to `none`. New content (paste, crawl, file import, CLI push) on an `approved` public
  project re-runs the screen.
- **Web:** `/new` (project, languages, visibility, review mode) → `/new/:id` (paste, file or website, then submit).
  Project admin gains "Add text" and "Sharing" tabs (visibility, review mode, moderation state with 2B's reasons and
  staff note, submit). Home's "New project" goes to `/new`; business orgs see the waitlist note instead.
- The server package depends on `@nativeloc/site` for the crawler.
