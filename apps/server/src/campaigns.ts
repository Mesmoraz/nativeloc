import { HttpError } from './auth.js';
import { REAL_WORK } from './badges.js';
import { all, get, run, tx, type DB, type ProjectRow } from './db.js';
import { projectLocales } from './services/progress.js';

/**
 * Campaigns (docs/segment-3e-campaigns-leaderboards.md): get a project live in some of its languages by a deadline.
 * Progress is the share of the project's strings approved in each language, computed when read. A language launches
 * at 100%, and the volunteers who worked on it are told. Near the deadline the campaign's cards rise in sessions.
 */

export interface CampaignRow {
  id: number;
  project_id: number;
  name: string;
  deadline: string;
  created_at: string;
  ended_at: string | null;
  ended_reason: 'launched' | 'deadline' | 'cancelled' | null;
}

const DAY = 86_400_000;
/** The deadline boost's window and size, in hours (pool/score.ts). */
export const BOOST_HOURS = 72;

/** The end of the deadline day, UTC. */
const endOf = (deadline: string) => Date.parse(`${deadline}T00:00:00Z`) + DAY;
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

/** Rises in a straight line from 0 to BOOST_HOURS over the campaign's last BOOST_HOURS hours; 0 before and after. */
export function deadlineBoost(deadline: string, now = Date.now()): number {
  const hoursLeft = (endOf(deadline) - now) / 3_600_000;
  if (hoursLeft <= 0 || hoursLeft >= BOOST_HOURS) return 0;
  return BOOST_HOURS * (1 - hoursLeft / BOOST_HOURS);
}

export const activeCampaign = (db: DB, projectId: number) =>
  get<CampaignRow>(db, 'SELECT * FROM campaigns WHERE project_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', projectId) ?? null;

export const campaignLocales = (db: DB, campaignId: number) =>
  all<{ locale: string; launched_at: string | null }>(db, 'SELECT locale, launched_at FROM campaign_locales WHERE campaign_id = ? ORDER BY locale', campaignId);

function counts(db: DB, projectId: number, locale: string) {
  const total = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM keys WHERE project_id = ? AND archived = 0', projectId)!.n;
  const by = Object.fromEntries(
    all<{ status: string; n: number }>(
      db,
      `SELECT t.status, COUNT(*) AS n FROM translations t JOIN keys k ON k.id = t.key_id
       WHERE k.project_id = ? AND k.archived = 0 AND t.locale = ? AND t.status IN ('approved', 'ready') GROUP BY t.status`,
      projectId, locale,
    ).map((r) => [r.status, r.n]),
  );
  return { total, approved: by.approved ?? 0, ready: by.ready ?? 0 };
}

export function campaignView(db: DB, c: CampaignRow, now = Date.now()) {
  return {
    id: c.id,
    projectId: c.project_id,
    name: c.name,
    deadline: c.deadline,
    // Calendar days: due tomorrow is 1, due today is 0.
    daysLeft: Math.max(0, Math.round((Date.parse(`${c.deadline}T00:00:00Z`) - Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`)) / DAY)),
    createdAt: c.created_at,
    endedAt: c.ended_at,
    endedReason: c.ended_reason,
    locales: campaignLocales(db, c.id).map((l) => ({ locale: l.locale, ...counts(db, c.project_id, l.locale), launchedAt: l.launched_at })),
  };
}
export type CampaignView = ReturnType<typeof campaignView>;

/**
 * Launches any language that reached 100% (telling the volunteers who worked on it), and ends the campaign when all
 * have launched or the deadline has passed. Safe to call any number of times; callers run it in their transaction.
 */
export function refreshCampaign(db: DB, c: CampaignRow, now = Date.now()) {
  if (c.ended_at) return;
  const project = get<{ org_id: number }>(db, 'SELECT org_id FROM projects WHERE id = ?', c.project_id)!;
  let pending = 0;
  for (const l of campaignLocales(db, c.id)) {
    if (l.launched_at) continue;
    const { total, approved } = counts(db, c.project_id, l.locale);
    if (!total || approved < total) {
      pending++;
      continue;
    }
    const launched = run(db, 'UPDATE campaign_locales SET launched_at = ? WHERE campaign_id = ? AND locale = ? AND launched_at IS NULL', stamp(now), c.id, l.locale);
    if (!Number(launched.changes)) continue;
    // Everyone who did accepted work on it, except the org's admins and reviewers (it's their job).
    const who = all<{ user_id: number }>(
      db,
      `SELECT DISTINCT user_id FROM xp_events
       WHERE project_id = ? AND locale = ? AND status = 'accepted' AND kind IN ${REAL_WORK}
         AND user_id NOT IN (SELECT user_id FROM memberships WHERE org_id = ? AND role IN ('admin', 'reviewer'))`,
      c.project_id, l.locale, project.org_id,
    );
    for (const w of who) {
      run(db, "INSERT INTO volunteer_messages (user_id, org_id, project_id, kind, body) VALUES (?, ?, ?, 'launch', ?)", w.user_id, project.org_id, c.project_id, l.locale);
    }
  }
  const reason = pending === 0 ? 'launched' : now >= endOf(c.deadline) ? 'deadline' : null;
  if (reason) run(db, 'UPDATE campaigns SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL', stamp(now), reason, c.id);
}

/** Text in `locale` of `projectId` just became approved: its campaign may have launched. */
export function afterApproved(db: DB, projectId: number, locale: string, now = Date.now()) {
  const c = activeCampaign(db, projectId);
  if (c && campaignLocales(db, c.id).some((l) => l.locale === locale && !l.launched_at)) refreshCampaign(db, c, now);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

export function createCampaign(db: DB, project: ProjectRow, byUserId: number, body: { name?: unknown; locales?: unknown; deadline?: unknown }, now = Date.now()) {
  const offered = projectLocales(db, project.id);
  const locales = Array.isArray(body.locales) ? [...new Set(body.locales)] : [];
  if (!locales.length || !locales.every((l): l is string => typeof l === 'string' && offered.includes(l))) {
    throw new HttpError(400, "Pick one or more of the project's languages.");
  }
  if (!realDate(body.deadline)) throw new HttpError(400, 'deadline must be a date like 2026-11-14.');
  const today = new Date(now).toISOString().slice(0, 10);
  if (body.deadline <= today) throw new HttpError(400, 'The deadline has to be tomorrow or later.');
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : `Get ${project.name} live`;
  for (const l of locales) {
    const c = counts(db, project.id, l);
    if (c.total && c.approved === c.total) throw new HttpError(400, `${l} is already fully translated.`);
  }
  if (activeCampaign(db, project.id)) throw new HttpError(409, 'This project already has a campaign running. End it first.');
  return tx(db, () => {
    const id = Number(run(db, 'INSERT INTO campaigns (project_id, name, deadline, created_by) VALUES (?, ?, ?, ?)', project.id, name, body.deadline as string, byUserId).lastInsertRowid);
    for (const l of locales) run(db, 'INSERT INTO campaign_locales (campaign_id, locale) VALUES (?, ?)', id, l);
    return campaignView(db, get<CampaignRow>(db, 'SELECT * FROM campaigns WHERE id = ?', id)!, now);
  });
}

export function cancelCampaign(db: DB, projectId: number, now = Date.now()) {
  const c = activeCampaign(db, projectId);
  if (!c) throw new HttpError(404, 'No campaign is running on this project.');
  run(db, "UPDATE campaigns SET ended_at = ?, ended_reason = 'cancelled' WHERE id = ?", stamp(now), c.id);
  return campaignView(db, get<CampaignRow>(db, 'SELECT * FROM campaigns WHERE id = ?', c.id)!, now);
}

/** The project's campaigns for its admins. Refreshes the active one first, which catches imports and deadlines. */
export function projectCampaigns(db: DB, projectId: number, now = Date.now()) {
  const active = activeCampaign(db, projectId);
  if (active) tx(db, () => refreshCampaign(db, active, now));
  const rows = all<CampaignRow>(db, 'SELECT * FROM campaigns WHERE project_id = ? ORDER BY id DESC LIMIT 11', projectId);
  const views = rows.map((r) => campaignView(db, r, now));
  return { active: views.find((v) => !v.endedAt) ?? null, past: views.filter((v) => v.endedAt).slice(0, 10) };
}

/**
 * The volunteer's side (stats): running campaigns in projects they can draw from, in their languages, and a bar per
 * language summing those campaigns. A language with no campaign gets no bar: a bar needs a finish line.
 */
export function campaignsFor(
  db: DB,
  sources: { project: { id: number; name: string }; org: { id: number; name: string }; campaign: { row: CampaignRow } | null }[],
  locales: string[],
  now = Date.now(),
) {
  const campaigns: { id: number; name: string; project: { id: number; name: string }; org: { id: number; name: string }; deadline: string; daysLeft: number; locales: { locale: string; total: number; approved: number; launched: boolean }[] }[] = [];
  for (const s of sources) {
    if (!s.campaign) continue;
    // Catches deadlines and imported text, as reading it does for the org's admins.
    tx(db, () => refreshCampaign(db, s.campaign!.row, now));
    const row = get<CampaignRow>(db, 'SELECT * FROM campaigns WHERE id = ?', s.campaign.row.id)!;
    if (row.ended_at) continue;
    const v = campaignView(db, row, now);
    const mine = v.locales.filter((l) => locales.includes(l.locale)).map(({ locale, total, approved, launchedAt }) => ({ locale, total, approved, launched: !!launchedAt }));
    if (!mine.length) continue;
    campaigns.push({ id: v.id, name: v.name, project: { id: s.project.id, name: s.project.name }, org: { id: s.org.id, name: s.org.name }, deadline: v.deadline, daysLeft: v.daysLeft, locales: mine });
  }
  const languageBars = locales
    .map((locale) => {
      const parts = campaigns.flatMap((c) => c.locales.filter((l) => l.locale === locale));
      return { locale, campaigns: parts.length, total: parts.reduce((n, l) => n + l.total, 0), approved: parts.reduce((n, l) => n + l.approved, 0) };
    })
    .filter((b) => b.campaigns > 0);
  return { campaigns, languageBars };
}
