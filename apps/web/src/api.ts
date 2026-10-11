import type { ProjectSharing, PublicUser, TranslationStatus } from './contracts';
import type { EditorModel, Issue, LocaleProgressLike, Placeholder } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { issues?: Issue[] },
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'), credentials: 'same-origin' };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  // The online demo answers API calls in the page (src/demo); the import is left out of other builds.
  const res = import.meta.env.VITE_DEMO ? await (await import('./demo/runtime')).demoFetch(path, init) : await fetch(path, init);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, (data as { details?: { issues?: Issue[] } })?.details);
  return data as T;
}

/** The signed-in user; see PublicUser in contracts.ts. `role` is the role in the current org, null when they have none. */
export type User = PublicUser;

export type Tier = 'new' | 'trusted' | 'lead';

export interface Project extends ProjectSharing {
  id: number;
  name: string;
  sourceLocale: string;
  locales: string[];
  requireReview: boolean;
  /** 0 = reviewers approve. N > 0 = localizers review each other; N approvals from others ship a translation. */
  peerApprovals: number;
  version: number;
  bundleToken: string;
  /** The organization's website (an origin), for the hosted preview. */
  siteUrl: string | null;
  /** Secret part of the private preview address; set once a website is saved. */
  previewToken: string | null;
  progress: LocaleProgressLike[];
}

export interface QueueItem {
  keyId: number;
  key: string;
  source: string;
  prevSource: string | null;
  description: string | null;
  maxLength: number | null;
  current: { text: string; status: TranslationStatus } | null;
  sourceModel: EditorModel;
  template: EditorModel;
  placeholders: Placeholder[];
  pluralExamples: Record<string, number[]>;
  screenshot: { id: number; url: string; label: string | null; width: number; height: number; box: { x: number; y: number; w: number; h: number } | null } | null;
  suggestions: { source: string; text: string; score: number }[];
  questions: { id: number; text: string; answer: string | null; user: string }[];
  approvals: { count: number; needed: number } | null;
}

export interface QueueResponse {
  project: { id: number; name: string; sourceLocale: string; peerApprovals: number };
  locale: string;
  mode: 'translate' | 'review';
  progress?: LocaleProgressLike;
  items: QueueItem[];
}

export interface JoinLink {
  code: string;
  path: string;
  locales: string[];
  createdAt: string;
  active: boolean;
}
