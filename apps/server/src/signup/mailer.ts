import { HttpError, randomToken, sha256 } from '../auth.js';
import { get, run, type DB, type UserRow } from '../db.js';

/**
 * Email goes through one interface so the provider is a single choice (plan §4, still open: Postmark or Resend).
 * Every message is written to the `outbox` table first, then handed to the mailer; a failed send stays in the
 * outbox with its error, so nothing is lost and a retry job can pick it up later.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
}
export interface Mailer {
  /** Short name stored in outbox.provider. */
  name: string;
  send(msg: OutgoingEmail): Promise<void>;
}

/** Development: prints the message (and so the link) to the server console. Quiet under tests. */
export const consoleMailer: Mailer = {
  name: 'console',
  async send(msg) {
    if (process.env.VITEST) return;
    console.log(`\n✉️  To: ${msg.to}\n   Subject: ${msg.subject}\n\n${msg.body.replace(/^/gm, '   ')}\n`);
  },
};

/**
 * THE provider decision (§4). Wire Postmark or Resend here (an HTTP call with an API key from the environment);
 * until then every environment uses the console mailer.
 */
export function mailerFromEnv(): Mailer {
  return consoleMailer;
}

let mailer: Mailer = mailerFromEnv();
/** Tests swap in a recording or failing mailer. */
export function setMailer(m: Mailer) {
  mailer = m;
}

/** Where links in emails point (the web app): NATIVELOC_PUBLIC_URL (or APP_URL), else the origin the browser sent (the dev proxy rewrites Host), else the host the request came in on. */
export const publicUrl = (req: { protocol: string; headers: { host?: string; origin?: string } }) =>
  (process.env.NATIVELOC_PUBLIC_URL ?? process.env.APP_URL ?? req.headers.origin ?? `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');

/** Writes the message to the outbox, then tries to deliver it. Never throws for delivery failures. */
export async function sendEmail(db: DB, userId: number | null, kind: string, msg: OutgoingEmail) {
  const id = Number(run(db, 'INSERT INTO outbox (user_id, to_email, kind, subject, body) VALUES (?, ?, ?, ?, ?)', userId, msg.to, kind, msg.subject, msg.body).lastInsertRowid);
  try {
    await mailer.send(msg);
    run(db, 'UPDATE outbox SET sent_at = CURRENT_TIMESTAMP, provider = ?, error = NULL WHERE id = ?', mailer.name, id);
  } catch (e) {
    run(db, 'UPDATE outbox SET provider = ?, error = ? WHERE id = ?', mailer.name, String((e as Error).message ?? e), id);
  }
  return id;
}

// ---------- email verification ----------

const VERIFY_HOURS = 48;
/** Resending: at most one email a minute and five a day per account. */
export const RESEND_GAP_SECONDS = 60;
export const RESEND_PER_DAY = 5;

export const isEmailVerified = (db: DB, userId: number) => get<{ v: number }>(db, 'SELECT email_verified AS v FROM users WHERE id = ?', userId)?.v === 1;

export async function sendVerification(db: DB, user: UserRow, baseUrl: string) {
  const token = randomToken('ev_');
  run(db, "INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (?, ?, 'verify', ?, ?)", sha256(token), user.id, user.email, Date.now() + VERIFY_HOURS * 3600e3);
  const link = `${baseUrl}/verify-email?token=${token}`;
  await sendEmail(db, user.id, 'verify', {
    to: user.email,
    subject: 'Confirm your email for NativeLoc',
    body: `Hi ${user.name},\n\nConfirm your email address to start translating and posting on NativeLoc:\n\n${link}\n\nThe link works for ${VERIFY_HOURS} hours. If you didn't sign up, ignore this email.`,
  });
}

export async function resendVerification(db: DB, user: UserRow, baseUrl: string) {
  if (isEmailVerified(db, user.id)) throw new HttpError(409, 'Your email is already confirmed.');
  const recent = get<{ last: string | null; day: number }>(
    db,
    "SELECT MAX(created_at) AS last, COUNT(*) AS day FROM outbox WHERE user_id = ? AND kind = 'verify' AND created_at > datetime('now', '-1 day')",
    user.id,
  )!;
  if (recent.day >= RESEND_PER_DAY) throw new HttpError(429, 'We have sent several emails today. Check your spam folder, or try again tomorrow.');
  if (recent.last && Date.now() - new Date(recent.last + 'Z').getTime() < RESEND_GAP_SECONDS * 1000) throw new HttpError(429, 'We just sent one. Give it a minute, then try again.');
  await sendVerification(db, user, baseUrl);
}

/** Marks the account verified. 404 for unknown, used or expired tokens, or if the account's email changed since. */
export function verifyEmail(db: DB, token: string): number {
  const row = get<{ user_id: number; email: string; expires_at: number; used_at: string | null }>(
    db,
    "SELECT user_id, email, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = 'verify'",
    sha256(token),
  );
  const current = row && get<{ email: string }>(db, 'SELECT email FROM users WHERE id = ?', row.user_id);
  if (!row || row.used_at || row.expires_at < Date.now() || current?.email.toLowerCase() !== row.email.toLowerCase()) {
    throw new HttpError(404, 'This link has expired or was already used. Sign in and ask for a new one.');
  }
  run(db, 'UPDATE email_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?', sha256(token));
  run(db, 'UPDATE users SET email_verified = 1 WHERE id = ?', row.user_id);
  return row.user_id;
}
