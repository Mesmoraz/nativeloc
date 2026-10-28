import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../App';
import { languageName, nativeLanguageName } from '../types';
import { ApiError } from '../api';
import { Achievements } from './Achievements';
import { BADGE_INFO, badgeLabel } from './badges';
import { FinalCard, PickCard, ReviewCard, SpotCard, TranslateCard, type CardResult } from './Cards';
import { isMock, volunteerClient, type VolunteerClient } from './client';
import { DAILY_GOALS, type BadgeId, type Card, type DailyGoal, type SessionResponse, type StatsResponse, type VolunteerSettings, type XpTotals } from './types';
import './volunteer.css';

type Screen =
  | { name: 'home'; empty?: SessionResponse['empty'] }
  | { name: 'session'; cards: Card[]; index: number; results: CardResult[] }
  | { name: 'summary'; cards: Card[]; results: CardResult[] }
  | { name: 'achievements' };

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** `/v`: the phone-first "5 cards in 5 minutes" volunteer flow. */
export function VolunteerApp() {
  const [client, setClient] = useState<VolunteerClient | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [pop, setPop] = useState<CardResult['xp'] | 'saved' | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  // No settings yet: no filter.
  const [settings, setSettings] = useState<VolunteerSettings | null>(null);

  useEffect(() => {
    void volunteerClient().then(setClient);
  }, []);

  const loadStats = useCallback(() => {
    client?.stats().then(setStats, () => setStats(null));
  }, [client]);
  useEffect(loadStats, [loadStats]);
  useEffect(() => {
    client?.settings().then(setSettings, () => setSettings(null));
  }, [client]);

  async function toggleNonprofitsOnly(on: boolean) {
    if (!client || !settings) return;
    setSettings({ ...settings, nonprofitsOnly: on });
    try {
      setSettings(await client.setNonprofitsOnly(on));
    } catch {
      setSettings(settings);
      setError('Could not save the filter. Try again.');
    }
  }

  async function changeDailyGoal(goal: DailyGoal) {
    if (!client || !settings) return;
    setSettings({ ...settings, dailyGoal: goal });
    try {
      setSettings(await client.setDailyGoal(goal));
      loadStats();
    } catch {
      setSettings(settings);
      setError('Could not save your goal. Try again.');
    }
  }

  async function start() {
    if (!client || starting) return;
    setStarting(true);
    setError('');
    try {
      const r = await client.session(5);
      setScreen(r.cards.length ? { name: 'session', cards: r.cards, index: 0, results: [] } : { name: 'home', empty: r.empty ?? 'nothing_to_do' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setError('Quick sessions aren’t switched on for this server yet.');
      else setError(e instanceof ApiError ? e.message : 'Could not start a session. Check your connection and try again.');
    } finally {
      setStarting(false);
    }
  }

  function finish(cards: Card[], results: CardResult[]) {
    setScreen({ name: 'summary', cards, results });
    loadStats();
  }

  function onCardDone(result: CardResult) {
    if (screen.name !== 'session') return;
    const results = [...screen.results, result];
    const next = () => {
      setPop(null);
      if (screen.index + 1 >= screen.cards.length) finish(screen.cards, results);
      else setScreen({ ...screen, index: screen.index + 1, results });
    };
    if (result.outcome === 'skipped') return next();
    // A short beat to see the award before the next card slides in.
    setScreen({ ...screen, results });
    setPop(result.xp ?? 'saved');
    setTimeout(next, reducedMotion() ? 700 : 1100);
  }

  function quit() {
    if (screen.name !== 'session') return;
    if (screen.results.some((r) => r.outcome === 'done')) finish(screen.cards, screen.results);
    else setScreen({ name: 'home' });
  }

  return (
    <div className="v-app">
      <header className="v-top">
        <Link to="/" className="brand" aria-label="NativeLoc home">
          <span className="brand-mark">文A</span>
        </Link>
        {screen.name === 'session' ? <Dots cards={screen.cards} results={screen.results} index={screen.index} /> : <span className="v-title">{isMock ? '5-minute session · mock' : '5-minute session'}</span>}
        {screen.name === 'session' ? (
          <button className="v-close" onClick={quit} aria-label="End session">
            ✕
          </button>
        ) : (
          <span className="v-close" />
        )}
      </header>

      {screen.name === 'home' && <Home stats={stats} empty={screen.empty} error={error} starting={starting || !client} onStart={() => void start()} settings={settings} onNonprofitsOnly={(on) => void toggleNonprofitsOnly(on)} onDailyGoal={(g) => void changeDailyGoal(g)} onAchievements={() => setScreen({ name: 'achievements' })} client={client} />}

      {screen.name === 'achievements' && client && <Achievements stats={stats} client={client} onBack={() => setScreen({ name: 'home' })} />}

      {screen.name === 'session' && client && (
        <main className="v-card" key={screen.cards[screen.index].id}>
          <CardFor card={screen.cards[screen.index]} client={client} onDone={onCardDone} />
          {pop && <XpPop xp={pop} />}
        </main>
      )}

      {screen.name === 'summary' && <Summary cards={screen.cards} results={screen.results} stats={stats} client={client} starting={starting} onAgain={() => void start()} onDone={() => setScreen({ name: 'home' })} />}
    </div>
  );
}

function CardFor({ card, client, onDone }: { card: Card; client: VolunteerClient; onDone: (r: CardResult) => void }) {
  switch (card.type) {
    case 'review':
      return <ReviewCard card={card} client={client} onDone={onDone} />;
    case 'spot':
      return <SpotCard card={card} client={client} onDone={onDone} />;
    case 'pick':
      return <PickCard card={card} client={client} onDone={onDone} />;
    case 'final':
      return <FinalCard card={card} client={client} onDone={onDone} />;
    default:
      return <TranslateCard card={card} client={client} onDone={onDone} />;
  }
}

function Dots({ cards, results, index }: { cards: Card[]; results: CardResult[]; index: number }) {
  return (
    <ol className="v-dots" aria-label={`Card ${index + 1} of ${cards.length}`}>
      {cards.map((c, i) => {
        const r = results[i];
        const cls = r ? (r.outcome === 'skipped' ? 'skipped' : r.xp?.status === 'accepted' ? 'accepted' : 'pending') : i === index ? 'current' : '';
        return <li key={c.id} className={cls} />;
      })}
    </ol>
  );
}

function XpPop({ xp }: { xp: CardResult['xp'] | 'saved' }) {
  const award = xp === 'saved' ? null : xp;
  return (
    <div className="v-pop-layer" role="status" aria-live="polite">
      <div className={`v-pop ${award?.status ?? ''}`}>
        {award ? (
          <>
            <span className="v-pop-points">+{award.points} XP</span>
            <span className="v-pop-note">{award.status === 'accepted' ? 'Accepted ✓' : 'Counts once it’s approved'}</span>
          </>
        ) : (
          <span className="v-pop-points">Saved ✓</span>
        )}
      </div>
    </div>
  );
}

function Xp({ totals, big = false }: { totals: XpTotals; big?: boolean }) {
  return (
    <span className={`v-xp ${big ? 'big' : ''}`}>
      <span className="v-xp-accepted">{totals.accepted}</span>
      {totals.pending > 0 && (
        <span className="v-xp-pending" title="Waiting for review">
          +{totals.pending}
        </span>
      )}
      <span className="v-xp-unit">XP</span>
    </span>
  );
}

/** Yesterday on this device, as YYYY-MM-DD (the same calendar as the server's, once the time zone is saved). */
const yesterday = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() - 86_400_000);

/** Today's goal and the streak: what §4 of the platform vision puts above Start. */
function StreakGoal({ stats }: { stats: StatsResponse }) {
  const { streak, goal } = stats;
  const met = goal.done >= goal.target;
  return (
    <div className="v-streak">
      <div className="v-streak-row">
        <span className="v-streak-count">{streak.current > 0 ? `🔥 ${streak.current}-day streak` : 'Start a streak with one card today'}</span>
        <span className="v-freezes" title="A freeze covers a day you miss. You earn one for every 7 days in a row, up to 2.">
          🧊 {streak.freezes}
        </span>
      </div>
      {streak.lastFreezeUsed === yesterday() && <p className="small v-streak-note">A freeze covered yesterday. Your streak is safe.</p>}
      {streak.current > 0 && !streak.activeToday && streak.lastFreezeUsed !== yesterday() && <p className="small muted v-streak-note">One card today keeps your streak going.</p>}
      <GoalBar goal={goal} />
      {met && <p className="small v-streak-note">Daily goal met 🎉</p>}
    </div>
  );
}

/**
 * Badges the app hasn't shown yet, celebrated once: they're marked seen as soon as this appears, so the banner stays
 * until stats next load and then doesn't come back.
 */
function NewBadges({ stats, client }: { stats: StatsResponse; client: VolunteerClient | null }) {
  const fresh = stats.badges.filter((b) => b.new);
  const ids = fresh.map((b) => b.id).join(',');
  useEffect(() => {
    if (ids && client) client.markBadgesSeen(ids.split(',') as BadgeId[]).catch(() => {});
  }, [ids, client]);
  if (!fresh.length) return null;
  return (
    <div className="v-new-badge" role="status">
      {fresh.map((b) => (
        <div key={b.id}>
          <span className="v-badge-emoji" aria-hidden>
            {BADGE_INFO[b.id].emoji}
          </span>{' '}
          New badge: <b>{badgeLabel(b)}</b>
        </div>
      ))}
    </div>
  );
}

const MESSAGE_LINE: Record<'favorite' | 'approved_reviewer', (org: string) => string> = {
  favorite: (org) => `${org} made you a favorite. You'll see their work first.`,
  approved_reviewer: (org) => `${org} made you an Approved Reviewer. Your approval can now publish their text.`,
};
const MESSAGE_ICON = { thanks: '💌', favorite: '⭐', approved_reviewer: '✅', launch: '🎉' } as const;

/** What orgs told the volunteer: thank-yous, favorite, Approved Reviewer. Shown once, like new badges. */
function Messages({ stats, client }: { stats: StatsResponse; client: VolunteerClient | null }) {
  const ids = stats.messages.map((m) => m.id).join(',');
  useEffect(() => {
    if (ids && client) client.markMessagesSeen(ids.split(',').map(Number)).catch(() => {});
  }, [ids, client]);
  if (!stats.messages.length) return null;
  return (
    <div className="v-messages" role="status">
      {stats.messages.map((m) => (
        <div key={m.id} className="v-message">
          <span aria-hidden>{MESSAGE_ICON[m.kind]}</span>
          <span>
            {m.kind === 'launch' ? (
              <>
                <b>{m.project?.name ?? m.org.name}</b> is live in {languageName(m.body ?? '')}! You helped make it happen.
              </>
            ) : m.kind === 'thanks' ? (
              <>
                <b>{m.org.name}</b>
                {m.project && m.project.name !== m.org.name ? <span className="muted"> · {m.project.name}</span> : null}: <i>{m.body}</i>
              </>
            ) : (
              MESSAGE_LINE[m.kind](m.org.name)
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

const pct = (approved: number, total: number) => (total ? Math.round((approved / total) * 100) : 0);
const daysLeftText = (d: number) => (d === 0 ? 'last day' : d === 1 ? '1 day left' : `${d} days left`);

/** Running campaigns in the volunteer's languages: a shared bar each, and one per language when there are several. */
function Campaigns({ stats }: { stats: StatsResponse }) {
  if (!stats.campaigns.length) return null;
  return (
    <div className="v-campaigns">
      <div className="label-row">🏁 Campaigns</div>
      {stats.languageBars
        .filter((b) => b.campaigns > 1)
        .map((b) => (
          <div key={b.locale} className="v-campaign">
            <div className="v-campaign-head">
              <b>{nativeLanguageName(b.locale)}</b>
              <span className="small muted">
                {b.approved} of {b.total} strings · {b.campaigns} campaigns
              </span>
            </div>
            <Bar value={pct(b.approved, b.total)} />
          </div>
        ))}
      {stats.campaigns.flatMap((c) =>
        c.locales.map((l) => (
          <div key={`${c.id}:${l.locale}`} className="v-campaign">
            <div className="v-campaign-head">
              <span>
                <b>{c.name}</b> <span className="small muted">· {c.org.name}</span>
              </span>
              <span className="small muted">{l.launched ? 'Launched 🎉' : daysLeftText(c.daysLeft)}</span>
            </div>
            <Bar value={pct(l.approved, l.total)} />
            <span className="small muted">
              {nativeLanguageName(l.locale)}: {l.approved} of {l.total} strings live
            </span>
          </div>
        )),
      )}
    </div>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <div className="v-goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

/** Earned badges in a row, and the way to all of them and to certificates. */
function BadgeRow({ stats, onOpen }: { stats: StatsResponse; onOpen: () => void }) {
  return (
    <button className="v-badge-row" onClick={onOpen}>
      <span className="v-badge-row-emoji" aria-hidden>
        {stats.badges.length ? stats.badges.map((b) => BADGE_INFO[b.id].emoji).join(' ') : '🏅'}
      </span>
      <span className="small">
        {stats.badges.length ? `${stats.badges.length} badge${stats.badges.length === 1 ? '' : 's'}` : 'Badges'} &amp; volunteer hours ›
      </span>
    </button>
  );
}

function GoalBar({ goal }: { goal: StatsResponse['goal'] }) {
  return (
    <div className="v-goal">
      <div className="v-goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={Math.min(goal.done, goal.target)} aria-label="Daily goal">
        <span style={{ width: `${Math.min(100, (goal.done / goal.target) * 100)}%` }} />
      </div>
      <span className="small muted">{goal.done > goal.target ? `${goal.done} cards today · goal ${goal.target}` : `${goal.done} of ${goal.target} cards today`}</span>
    </div>
  );
}

function GoalPicker({ goal, onChange }: { goal: DailyGoal; onChange: (g: DailyGoal) => void }) {
  return (
    <div className="v-goal-picker">
      <span>
        <b>Daily goal</b>
        <br />
        <span className="small muted">Cards a day. One card keeps your streak.</span>
      </span>
      <div className="v-seg" role="radiogroup" aria-label="Daily goal">
        {DAILY_GOALS.map((g) => (
          <button key={g} role="radio" aria-checked={g === goal} className={g === goal ? 'on' : ''} onClick={() => g !== goal && onChange(g)}>
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}

function Home({
  stats,
  empty,
  error,
  starting,
  onStart,
  settings,
  onNonprofitsOnly,
  onDailyGoal,
  onAchievements,
  client,
}: {
  stats: StatsResponse | null;
  empty?: SessionResponse['empty'];
  error: string;
  starting: boolean;
  onStart: () => void;
  settings: VolunteerSettings | null;
  onNonprofitsOnly: (on: boolean) => void;
  onDailyGoal: (goal: DailyGoal) => void;
  onAchievements: () => void;
  client: VolunteerClient | null;
}) {
  const { session } = useSession();
  const firstName = session?.user.name.split(' ')[0];
  return (
    <>
      <main className="v-body v-home">
        <div>
          <h1>{firstName ? `Hi ${firstName}` : 'Hi there'} 👋</h1>
          <p className="muted v-lead">Five short cards: translate or check a few lines of text for groups that serve people in your language.</p>
        </div>
        {stats && <NewBadges stats={stats} client={client} />}
        {stats && <Messages stats={stats} client={client} />}
        {stats && <StreakGoal stats={stats} />}
        {stats && <Campaigns stats={stats} />}
        {stats && <BadgeRow stats={stats} onOpen={onAchievements} />}
        {stats && (
          <div className="v-stats">
            <div className="v-stat">
              <span className="small muted">Today</span>
              <Xp totals={stats.today} big />
            </div>
            <div className="v-stat">
              <span className="small muted">Approved strings</span>
              <span className="v-stat-num">{stats.approvedStrings}</span>
            </div>
          </div>
        )}
        {stats && stats.today.pending > 0 && <p className="small muted v-explain">Faded XP is waiting for another volunteer to approve your work. It turns solid once they do.</p>}
        {settings && (
          <label className="v-filter">
            <input type="checkbox" checked={settings.nonprofitsOnly} onChange={(e) => onNonprofitsOnly(e.target.checked)} />
            <span>
              <b>Nonprofits only</b>
              <br />
              <span className="small muted">Only cards from nonprofits we've verified.</span>
            </span>
          </label>
        )}
        {settings && <GoalPicker goal={settings.dailyGoal} onChange={onDailyGoal} />}
        {empty === 'no_languages' && (
          <div className="alert warn">
            You haven't picked a language yet. <Link to="/">Choose your languages</Link> to get cards.
          </div>
        )}
        {empty === 'nothing_to_do' && (
          <div className="alert ok">
            All caught up! Nothing is waiting in your languages{settings?.nonprofitsOnly ? ' from verified nonprofits' : ''} right now. Check back later.
          </div>
        )}
        {error && <div className="alert error">{error}</div>}
      </main>
      <div className="v-actions">
        <button className="v-btn primary v-main" onClick={onStart} disabled={starting}>
          {starting ? 'Starting…' : 'Start'}
        </button>
      </div>
    </>
  );
}

function Summary({ cards, results, stats, client, starting, onAgain, onDone }: { cards: Card[]; results: CardResult[]; stats: StatsResponse | null; client: VolunteerClient | null; starting: boolean; onAgain: () => void; onDone: () => void }) {
  const done = results.map((r, i) => ({ r, card: cards[i] })).filter(({ r }) => r.outcome === 'done');
  const earned: XpTotals = { accepted: 0, pending: 0 };
  for (const { r } of done) if (r.xp) earned[r.xp.status] += r.xp.points;
  // Spot the problem is practice: it doesn't help an organization.
  const projects = [...new Map(done.filter(({ card }) => card.type !== 'spot').map(({ card }) => [card.project.id, card.project.name])).values()];
  return (
    <>
      <main className="v-body v-summary">
        <div className="v-summary-hero">
          <div className="v-summary-check" aria-hidden>
            ✓
          </div>
          <h1>{done.length ? 'Nice work' : 'Session ended'}</h1>
          <p className="muted">
            {done.length} of {cards.length} card{cards.length === 1 ? '' : 's'} done
          </p>
        </div>
        {stats && <NewBadges stats={stats} client={client} />}
        <div className="v-stats">
          <div className="v-stat">
            <span className="small muted">This session</span>
            <Xp totals={earned} big />
          </div>
          {stats && (
            <div className="v-stat">
              <span className="small muted">Today</span>
              <Xp totals={stats.today} big />
            </div>
          )}
        </div>
        {stats && (
          <div className="v-streak">
            {stats.streak.current > 0 && <span className="v-streak-count">🔥 {stats.streak.current}-day streak</span>}
            <GoalBar goal={stats.goal} />
            {stats.goal.done >= stats.goal.target && <p className="small v-streak-note">Daily goal met 🎉</p>}
          </div>
        )}
        {earned.pending > 0 && <p className="small muted v-explain">{earned.pending} XP is waiting for review. It counts once another volunteer approves your work.</p>}
        {projects.length > 0 && (
          <div className="v-helped">
            <div className="label-row">You helped</div>
            <ul>
              {projects.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </main>
      <div className="v-actions">
        <button className="v-btn ghost" onClick={onDone}>
          Done
        </button>
        <button className="v-btn primary v-main" onClick={onAgain} disabled={starting}>
          {starting ? 'Starting…' : 'Another 5'}
        </button>
      </div>
    </>
  );
}
