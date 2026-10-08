// The calls the card flow makes. In dev, `?mock=1` swaps in an in-memory stand-in (mock.ts) so the UI works
// without the server; production builds never load it.
import { api } from '../api';
import type { SessionResponse, StatsResponse, XpAward } from './types';

export type SaveResult = { status: 'approved' | 'review' } & XpAward;
export type ApproveResult = { status: 'approved' | 'review'; approvals?: { count: number; needed: number } } & XpAward;

export interface VolunteerClient {
  session(size?: number): Promise<SessionResponse>;
  stats(): Promise<StatsResponse>;
  /** Throws ApiError 422 with `details.issues` when the text doesn't pass validation. */
  save(keyId: number, locale: string, text: string, approve: boolean): Promise<SaveResult>;
  approve(keyId: number, locale: string): Promise<ApproveResult>;
}

export const isMock = import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1';

const real: VolunteerClient = {
  session: (size = 5) => api<SessionResponse>(`/api/v1/volunteer/session?size=${size}`),
  stats: () => api<StatsResponse>('/api/v1/volunteer/stats'),
  save: (keyId, locale, text, approve) => api<SaveResult>(`/api/v1/translations/${keyId}/${locale}`, { method: 'PUT', body: { text, approve } }),
  approve: (keyId, locale) => api<ApproveResult>(`/api/v1/translations/${keyId}/${locale}/approve`, { method: 'POST' }),
};

let client: Promise<VolunteerClient> | null = null;
export function volunteerClient(): Promise<VolunteerClient> {
  client ??= isMock ? import('./mock').then((m) => m.mockClient) : Promise.resolve(real);
  return client;
}
