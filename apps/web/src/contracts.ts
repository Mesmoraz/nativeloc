// Response shapes for accounts, orgs, moderation, community review, posting and the open volunteer pool.
// The server returns these; docs/segment-2-contracts.md has the endpoints with example JSON.
import type { Tier } from './api';

// ---------- accounts and orgs ----------

export type Role = 'admin' | 'reviewer' | 'localizer';
export type OrgType = 'nonprofit' | 'individual' | 'small_org' | 'business';
export type Verification = 'unverified' | 'pending' | 'verified' | 'rejected';

/** An org as members and volunteers see it. */
export interface OrgSummary {
  id: number;
  name: string;
  type: OrgType;
  verification: Verification;
  website: string | null;
  description: string | null;
}

/** One of the user's orgs, with their role there. */
export interface OrgMembership extends OrgSummary {
  role: Role;
}

/** The signed-in user (GET /api/v1/me `user`, login, invite and join responses, the team list). */
export interface PublicUser {
  id: number;
  email: string;
  name: string;
  /** Role in the current org (team list: in the admin's org). null: no membership there (a volunteer with no org). */
  role: Role | null;
  locales: string[];
  tiers: Record<string, Tier>;
  /** NativeLoc staff: can use the verification and moderation console. */
  isStaff: boolean;
  /** False until the person opens the link in the confirmation email. */
  emailVerified: boolean;
}

/** GET /api/v1/me, and PUT /api/v1/me/org { orgId } (switches the current org; 404 if not a member). */
export interface MeResponse {
  user: PublicUser;
  /** The org this sign-in works in: the one picked with PUT /me/org, else the oldest membership. null: no orgs. */
  org: OrgMembership | null;
  /** Every org the user belongs to, oldest membership first. */
  orgs: OrgMembership[];
  /** The saved IANA time zone (PUT /me/time-zone); null until the browser has sent one. */
  timeZone: string | null;
}

// ---------- projects ----------

export type Visibility = 'private' | 'public';
export type Moderation = 'none' | 'pending' | 'approved' | 'rejected';
export type ReviewMode = 'standard' | 'community';
/** How soon volunteers' cards should come from this project: part of the card-order score (server pool/score.ts). */
export type ProjectPriority = 'low' | 'normal' | 'high';
/** 'ready': community review agreed, waiting for the poster. Bundles ship only 'approved'. */
export type TranslationStatus = 'outdated' | 'review' | 'ready' | 'approved';

/** Who sees a project and how it's reviewed (part of Project in api.ts). */
export interface ProjectSharing {
  orgId: number;
  /** 'public' puts the work in the open volunteer pool once moderation is 'approved'. */
  visibility: Visibility;
  moderation: Moderation;
  reviewMode: ReviewMode;
  priority: ProjectPriority;
}

// ---------- sign-up and onboarding ----------

/** POST /api/v1/auth/signup. Sets the session cookie. The new user has no orgs and emailVerified false. */
export interface SignupRequest {
  name: string;
  email: string;
  password: string;
}
/** POST /api/v1/orgs: "Get translation" onboarding. Creates the org, makes the caller its admin and current org. */
export interface CreateOrgRequest {
  type: OrgType;
  /** Optional for 'individual' (defaults to the user's name). */
  name?: string;
  /** Nonprofits: 9 digits, dashes allowed. Starts verification against the IRS list. */
  ein?: string;
  website?: string;
  description?: string;
}
export interface CreateOrgResponse {
  org: OrgMembership;
  /** Businesses are saved but can't post yet. */
  waitlisted: boolean;
}
/** PATCH /api/v1/orgs/:id (org admins). Returns { org: OrgMembership }. Changing the EIN restarts verification. */
export type UpdateOrgRequest = Partial<Pick<CreateOrgRequest, 'name' | 'ein' | 'website' | 'description'>>;

// ---------- verification and moderation (staff) ----------

/** GET /api/v1/orgs/ein/:ein: public lookup for the onboarding form. */
export interface EinLookupResponse {
  match: { ein: string; name: string; city: string; state: string } | null;
}
/** GET /api/v1/staff/verifications: orgs with verification 'pending'. */
export interface VerificationQueueResponse {
  orgs: {
    org: OrgSummary & { ein: string | null; createdAt: string };
    /** Best EO-BMF candidate for the EIN, if any. */
    match: EinLookupResponse['match'];
    admins: { name: string; email: string }[];
  }[];
}
/** POST /api/v1/staff/verifications/:orgId. Returns { org: OrgSummary }. */
export interface VerificationDecision {
  decision: 'verified' | 'rejected';
  note?: string;
}
export type ReportReason = 'spam' | 'commercial' | 'harmful';
/** GET /api/v1/staff/moderation: projects with moderation 'pending' (screened out, or paused by reports). */
export interface ModerationQueueResponse {
  projects: {
    project: { id: number; name: string; visibility: Visibility; priority: ProjectPriority; strings: number; submittedAt: string | null };
    org: OrgSummary;
    /** From the automatic screen, e.g. "3 phone numbers". */
    reasons: string[];
    reports: { reason: ReportReason; count: number }[];
    /** A few source strings for a quick look. */
    sample: string[];
  }[];
}
/** POST /api/v1/staff/moderation/:projectId. Returns { project: { id, moderation } }. */
export interface ModerationDecision {
  /** 'changes' sets moderation 'rejected' with the reason shown to the poster, who can fix and resubmit. */
  decision: 'approved' | 'rejected' | 'changes';
  reason?: string;
}
/** POST /api/v1/reports: any signed-in user who can read the project. Three reporters pause it (moderation 'pending'). */
export interface ReportResponse {
  ok: true;
  /** This report paused the project. */
  paused: boolean;
}

// ---------- community review ----------

export type FlagReason = 'meaning' | 'grammar' | 'tone' | 'offensive';
/** Where a translation stands in community review (review_mode 'community'). */
export interface CommunityReview {
  /** Reviews since the text was first submitted, across edits. */
  reviews: number;
  /** Approvals of the current text. */
  approvals: number;
  flags: number;
  /** 3 while every review so far approved; 5 after any Flag or Improve. */
  needed: 3 | 5;
  /** 8 reviews without consensus: only Trusted and Lead reviewers see it; one Lead approval settles it. */
  escalated: boolean;
}
/** POST /api/v1/translations/:keyId/:locale/flag { reason, note? }: Review cards' third choice. */
export interface FlagResponse {
  status: TranslationStatus;
  review: CommunityReview;
  xp: { points: number; status: 'pending' | 'accepted' } | null;
}
/** GET /api/v1/projects/:id/ready?locale=xx (org admins): the "Ready to publish" list. */
export interface ReadyListResponse {
  items: {
    keyId: number;
    key: string;
    source: string;
    locale: string;
    text: string;
    review: CommunityReview;
    flags: { reason: FlagReason; count: number }[];
    /** Reviewers disagreed (an Improve or a Flag along the way). */
    disagreement: boolean;
  }[];
}
/** Per-locale quality in the bundle manifest (BundleManifest.locales[locale] in @nativeloc/core). */
export interface ManifestQuality {
  /** 'verified': "Checked by N native speakers". 'community': "Community-reviewed, not verified". */
  quality: 'verified' | 'community';
  reviewers: number;
}

// ---------- posting content ----------

/** POST /api/v1/projects/:id/paste { text, context?, split?: 'sentences' | 'paragraphs' }: split into strings. */
export interface PasteResponse {
  created: number;
  unchanged: number;
  keys: { key: string; source: string }[];
}
/** POST /api/v1/projects/:id/crawl { url } → { job }. GET /api/v1/projects/:id/crawl → { jobs }. */
export interface CrawlJob {
  id: number;
  url: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  pages: number;
  strings: number;
  error: string | null;
  createdAt: string;
}
/** POST /api/v1/projects/:id/submit: runs the automatic moderation screen on a public project. */
export interface SubmitResponse {
  moderation: Moderation;
  reasons: string[];
}

// ---------- open volunteer pool ----------

/** Who a card helps (Card.org in volunteer/types.ts). */
export interface CardOrg {
  id: number;
  name: string;
  type: OrgType;
  /** A verified nonprofit. */
  verified: boolean;
  description: string | null;
}

// ---------- web extension points ----------

/** An extra tab on the project admin screen, listed in posting/projectTabs.tsx and rendered by ProjectAdmin. */
export interface ProjectTab {
  id: string;
  label: string;
  render: (props: { project: import('./api').Project; reload: () => Promise<void> }) => React.ReactNode;
}
