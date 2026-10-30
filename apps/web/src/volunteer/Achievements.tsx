import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import { BADGE_INFO, BADGE_ORDER, languageName, shortDate } from './badges';
import type { VolunteerClient } from './client';
import type { Certificate, StatsResponse, VolunteerBoard } from './types';

/** The link a school or employer opens to check a certificate (works signed out). */
export const certificateUrl = (code: string) => `${window.location.origin}${import.meta.env.BASE_URL}certificate/${code}`;

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = () => ymd(new Date());
/** A year ago today (29 February becomes 1 March). */
const yearAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return ymd(d);
};
const PRESETS = [
  { id: 'all', label: 'All time', from: () => undefined },
  { id: 'year', label: 'This year', from: () => `${today().slice(0, 4)}-01-01` },
  { id: '12m', label: 'Last 12 months', from: yearAgo },
  { id: 'custom', label: 'Custom', from: () => undefined },
] as const;

const period = (c: Pick<Certificate, 'periodFrom' | 'periodTo'>) => `${c.periodFrom ? shortDate(c.periodFrom) : 'From the start'} – ${shortDate(c.periodTo)}`;

/** Every badge (earned, still to earn, coming), then volunteer-hour certificates. */
export function Achievements({ stats, client, onBack }: { stats: StatsResponse | null; client: VolunteerClient; onBack: () => void }) {
  const earned = new Map((stats?.badges ?? []).map((b) => [b.id, b]));
  const [certs, setCerts] = useState<Certificate[] | null>(null);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    client.certificates().then(setCerts, () => setCerts([]));
  }, [client]);

  async function issue() {
    setBusy(true);
    setError('');
    try {
      const p = PRESETS.find((x) => x.id === preset)!;
      const c = preset === 'custom' ? await client.issueCertificate(from || undefined, to || undefined) : await client.issueCertificate(p.from());
      setCerts([c, ...(certs ?? [])]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the certificate. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(c: Certificate) {
    if (!window.confirm(`Withdraw this certificate? Anyone who opens its link will see it was withdrawn.`)) return;
    try {
      const r = await client.revokeCertificate(c.code);
      setCerts((certs ?? []).map((x) => (x.code === r.code ? r : x)));
    } catch {
      setError('Could not withdraw it. Try again.');
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(certificateUrl(code));
      setCopied(code);
    } catch {
      window.prompt('Copy this link:', certificateUrl(code));
    }
  }

  return (
    <>
      <main className="v-body v-achievements">
        <h1>Badges &amp; hours</h1>
        <section>
          <h2 className="v-section">Badges</h2>
          <ul className="v-badges-grid">
            {BADGE_ORDER.map((id) => {
              const info = BADGE_INFO[id];
              const b = earned.get(id);
              return (
                <li key={id} className={b ? 'earned' : 'todo'}>
                  <span className="v-badge-emoji" aria-hidden>
                    {info.emoji}
                  </span>
                  <span>
                    <b>{info.name}</b>
                    {b?.detail && <span className="muted"> · {languageName(b.detail)}</span>}
                    <br />
                    <span className="small muted">{b ? `Earned ${shortDate(b.earnedAt)}` : info.later ? 'Coming soon' : info.how}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <Leaderboards client={client} />

        <section className="v-certs">
          <h2 className="v-section">Volunteer hours</h2>
          <p className="small muted">
            A certificate you can print or send to a school or employer. Hours are estimated from your approved work: 2 minutes per translation and 1 per review. Each one has a link anyone can use to check it.
          </p>
          <div className="v-seg v-seg-wrap" role="radiogroup" aria-label="Period">
            {PRESETS.map((p) => (
              <button key={p.id} role="radio" aria-checked={preset === p.id} className={preset === p.id ? 'on' : ''} onClick={() => setPreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="v-dates">
              <label>
                From <input type="date" value={from} max={to || today()} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                To <input type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
          )}
          <button className="v-btn primary" onClick={() => void issue()} disabled={busy}>
            {busy ? 'Creating…' : 'Create certificate'}
          </button>
          {error && <div className="alert error">{error}</div>}
          {certs && certs.length > 0 && (
            <ul className="v-cert-list">
              {certs.map((c) => (
                <li key={c.code} className={c.revokedAt ? 'revoked' : ''}>
                  <div>
                    <b>{c.revokedAt ? 'Withdrawn' : `${c.hours} ${c.hours === 1 ? 'hour' : 'hours'}`}</b> <span className="small muted">· {period(c)}</span>
                  </div>
                  <div className="v-cert-actions">
                    <a className="v-btn ghost small" href={certificateUrl(c.code)} target="_blank" rel="noreferrer">
                      Open
                    </a>
                    {!c.revokedAt && (
                      <>
                        <button className="v-btn ghost small" onClick={() => void copy(c.code)}>
                          {copied === c.code ? 'Copied ✓' : 'Copy link'}
                        </button>
                        <button className="v-btn ghost small" onClick={() => void revoke(c)}>
                          Withdraw
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <div className="v-actions">
        <button className="v-btn primary v-main" onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}

/** This month's board for each org you've translated for, and the opt-in that puts your name on them. */
function Leaderboards({ client }: { client: VolunteerClient }) {
  const [boards, setBoards] = useState<VolunteerBoard[] | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const load = () => client.leaderboards().then(setBoards, () => setBoards([]));
  useEffect(() => {
    void load();
    client.settings().then((s) => setOn(s.showOnLeaderboards), () => setOn(false));
  }, [client]);

  async function toggle(next: boolean) {
    setOn(next);
    try {
      setOn((await client.setShowOnLeaderboards(next)).showOnLeaderboards);
      await load();
    } catch {
      setOn(!next);
    }
  }

  return (
    <section className="v-certs">
      <h2 className="v-section">Leaderboards</h2>
      {on !== null && (
        <label className="v-filter">
          <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
          <span>
            <b>Show me on leaderboards</b>
            <br />
            <span className="small muted">Only the organizations you translate for see them, and only as your first name and last initial.</span>
          </span>
        </label>
      )}
      {boards && !boards.length && <p className="small muted">Leaderboards appear once your translations for an organization are approved.</p>}
      {boards?.map((b) => (
        <div key={b.org.id} className="v-board">
          <b>Top translators for {b.org.name} this month</b>
          {b.top.length ? (
            <ol>
              {b.top.map((t, i) => (
                <li key={i} className={b.you?.place === i + 1 ? 'you' : ''}>
                  {t.name} · {t.words.toLocaleString()} words
                </li>
              ))}
            </ol>
          ) : (
            <span className="small muted">Nobody has opted in yet.</span>
          )}
          {b.others > 0 && (
            <span className="small muted">
              and {b.others} more volunteer{b.others === 1 ? '' : 's'} · {b.totalWords.toLocaleString()} words in all
            </span>
          )}
          {b.you && b.you.place === null && <span className="small muted">You haven’t translated for them this month yet.</span>}
        </div>
      ))}
    </section>
  );
}
