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
  const res = await fetch(path, init);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, (data as { details?: { issues?: Issue[] } })?.details);
  return data as T;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'reviewer' | 'localizer';
  locales: string[];
}

export interface Project {
  id: number;
  name: string;
  sourceLocale: string;
  locales: string[];
  requireReview: boolean;
  version: number;
  bundleToken: string;
  progress: LocaleProgressLike[];
}

export interface QueueItem {
  keyId: number;
  key: string;
  source: string;
  prevSource: string | null;
  description: string | null;
  maxLength: number | null;
  current: { text: string; status: 'outdated' | 'review' | 'approved' } | null;
  sourceModel: EditorModel;
  template: EditorModel;
  placeholders: Placeholder[];
  pluralExamples: Record<string, number[]>;
  screenshot: { id: number; url: string; label: string | null; width: number; height: number; box: { x: number; y: number; w: number; h: number } | null } | null;
  suggestions: { source: string; text: string; score: number }[];
  questions: { id: number; text: string; answer: string | null; user: string }[];
}

export interface QueueResponse {
  project: { id: number; name: string; sourceLocale: string };
  locale: string;
  mode: 'translate' | 'review';
  progress?: LocaleProgressLike;
  items: QueueItem[];
}
