// The calls the card flow makes. In dev, `?mock=1` swaps in an in-memory stand-in (mock.ts) so the UI works
// without the server; production builds never load it.
import { api } from '../api';
import type { FlagReason, FlagResponse, ReportReason, ReportResponse } from '../contracts';
import type { BadgeId, Certificate, DailyGoal, SessionResponse, SpotAnswer, StatsResponse, VolunteerSettings, XpAward } from './types';

export type SaveResult = { status: 'approved' | 'review' } & XpAward;
export type ApproveResult = { status: 'approved' | 'review'; approvals?: { count: number; needed: number } } & XpAward;

export interface VolunteerClient {
  /** `nonprofitsOnly` given: filter and remember the choice; omitted: use the saved one. */
  session(size?: number, nonprofitsOnly?: boolean): Promise<SessionResponse>;
  stats(): Promise<StatsResponse>;
  settings(): Promise<VolunteerSettings>;
  setNonprofitsOnly(on: boolean): Promise<VolunteerSettings>;
  setDailyGoal(goal: DailyGoal): Promise<VolunteerSettings>;
  markBadgesSeen(ids: BadgeId[]): Promise<void>;
  certificates(): Promise<Certificate[]>;
  /** Dates are YYYY-MM-DD; omitted `from` is "from the start", omitted `to` is today. Throws ApiError 422 under half an hour. */
  issueCertificate(from?: string, to?: string): Promise<Certificate>;
  revokeCertificate(code: string): Promise<Certificate>;
  /** Throws ApiError 422 with `details.issues` when the text doesn't pass validation. */
  save(keyId: number, locale: string, text: string, approve: boolean): Promise<SaveResult>;
  approve(keyId: number, locale: string): Promise<ApproveResult>;
  answerSpot(checkId: number, verdict: 'ok' | 'problem'): Promise<SpotAnswer>;
  /** Throws ApiError 409 when the string moved on since the card was dealt. */
  pick(keyId: number, locale: string, chosen: string, other: string): Promise<XpAward>;
  /** A Review card's third choice, on community-reviewed projects only (the card's `item.review` is set). */
  flag(keyId: number, locale: string, reason: FlagReason, note?: string): Promise<FlagResponse>;
  /** Report a project (and optionally the string) to NativeLoc staff. */
  report(projectId: number, keyId: number, reason: ReportReason, note?: string): Promise<ReportResponse>;
}

/** Dev only: /v?spot=1 asks for a Spot the problem card in every session (the server ignores it in production). */
const forceSpot = import.meta.env.DEV && new URLSearchParams(window.location.search).get('spot') === '1';

export const isMock = import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1';

const real: VolunteerClient = {
  session: (size = 5, nonprofitsOnly) =>
    api<SessionResponse>(`/api/v1/volunteer/session?size=${size}${nonprofitsOnly === undefined ? '' : `&nonprofitsOnly=${nonprofitsOnly ? 1 : 0}`}${forceSpot ? '&spot=1' : ''}`),
  stats: () => api<StatsResponse>('/api/v1/volunteer/stats'),
  settings: () => api<VolunteerSettings>('/api/v1/volunteer/settings'),
  setNonprofitsOnly: (on) => api<VolunteerSettings>('/api/v1/volunteer/settings', { method: 'PUT', body: { nonprofitsOnly: on } }),
  setDailyGoal: (goal) => api<VolunteerSettings>('/api/v1/volunteer/settings', { method: 'PUT', body: { dailyGoal: goal } }),
  markBadgesSeen: async (ids) => {
    await api('/api/v1/volunteer/badges/seen', { method: 'POST', body: { ids } });
  },
  certificates: async () => (await api<{ certificates: Certificate[] }>('/api/v1/volunteer/certificates')).certificates,
  issueCertificate: (from, to) => api<Certificate>('/api/v1/volunteer/certificates', { method: 'POST', body: { from, to } }),
  revokeCertificate: (code) => api<Certificate>(`/api/v1/volunteer/certificates/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  save: (keyId, locale, text, approve) => api<SaveResult>(`/api/v1/translations/${keyId}/${locale}`, { method: 'PUT', body: { text, approve } }),
  approve: (keyId, locale) => api<ApproveResult>(`/api/v1/translations/${keyId}/${locale}/approve`, { method: 'POST' }),
  answerSpot: (checkId, verdict) => api<SpotAnswer>(`/api/v1/volunteer/checks/${checkId}`, { method: 'POST', body: { verdict } }),
  pick: (keyId, locale, chosen, other) => api<XpAward>(`/api/v1/translations/${keyId}/${locale}/pick`, { method: 'POST', body: { chosen, other } }),
  flag: (keyId, locale, reason, note) => api<FlagResponse>(`/api/v1/translations/${keyId}/${locale}/flag`, { method: 'POST', body: { reason, note } }),
  report: (projectId, keyId, reason, note) => api<ReportResponse>('/api/v1/reports', { method: 'POST', body: { projectId, keyId, reason, note } }),
};

let client: Promise<VolunteerClient> | null = null;
export function volunteerClient(): Promise<VolunteerClient> {
  client ??= isMock ? import('./mock').then((m) => m.mockClient) : Promise.resolve(real);
  return client;
}
