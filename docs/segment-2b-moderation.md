# Segment 2B: verification and moderation

Endpoints are in [segment-2-contracts.md](segment-2-contracts.md) §3 (2B). What's worth knowing beyond that:

- **IRS data.** `eo_bmf` holds the Exempt Organizations Business Master File. Download the CSVs (eo1–eo4.csv or per state)
  from https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf and run
  `npx tsx --no-warnings apps/server/scripts/import-eo-bmf.ts [--replace] eo1.csv eo2.csv ...` (refresh monthly). With no
  files it loads `apps/server/scripts/fixtures/eo-bmf-sample.csv`, the demo and test data. Don't commit the real files.
- **Verification rule** (`moderation/verify.ts`, `checkOrg`): EIN listed + name matches (IRS name or sort name, ignoring
  case, punctuation, "Inc", "&") + `orgs.state` matches. Otherwise `pending` for staff. `orgs.state` is a column 2B added;
  2A's org form must set it before calling `startVerification`.
- **Screen rules** are all in `RULES` in `moderation/screen.ts`. It never rejects: it approves or holds with reasons.
  Resubmitting after staff rejected or asked for changes, or while reports are open, always holds.
- **Reports**: `fileReport(db, userId, project, {...})`. One open report per person per project; three distinct reporters
  pause an `approved` project to `pending` (`PAUSE_REPORTS` in `moderation/reports.ts`). A staff decision resolves them.
- **Extra endpoint:** `GET /api/v1/projects/:id/moderation` (project admins): current moderation, last screen reasons,
  last staff decision with its reason, for the poster to see why changes were asked for.
- Staff console: `/staff` (web `staff/`). Staff only; the demo admin is staff. No link to it yet: 2A's `AccountMenu`
  should show one when `session.user.isStaff`.
