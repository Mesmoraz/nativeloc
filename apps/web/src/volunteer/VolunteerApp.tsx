import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../App';
import { ApiError } from '../api';
import { ReviewCard, TranslateCard, type CardResult } from './Cards';
import { isMock, volunteerClient, type VolunteerClient } from './client';
import type { Card, SessionResponse, StatsResponse, VolunteerSettings, XpTotals } from './types';
import './volunteer.css';

type Screen =
  | { name: 'home'; empty?: SessionResponse['empty'] }
  | { name: 'session'; cards: Card[]; index: number; results: CardResult[] }
  | { name: 'summary'; cards: Card[]; results: CardResult[] };

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** `/v`: the phone-first "5 cards in 5 minutes" volunteer flow. */
export function VolunteerApp() {
  const [client, setClient] = useState<VolunteerClient | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [pop, setPop] = useState<CardResult['xp'] | 'saved' | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  // No settings yet (or an older server): no filter, and no Flag or Report buttons.
  const [settings, setSettings] = useState<VolunteerSettings | null>(null);
  const actions = settings?.actions ?? { flag: false, report: false };

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

      {screen.name === 'home' && <Home stats={stats} empty={screen.empty} error={error} starting={starting || !client} onStart={() => void start()} settings={settings} onNonprofitsOnly={(on) => void toggleNonprofitsOnly(on)} />}

      {screen.name === 'session' && client && (
        <main className="v-card" key={screen.cards[screen.index].id}>
          {screen.cards[screen.index].type === 'review' ? (
            <ReviewCard card={screen.cards[screen.index]} client={client} onDone={onCardDone} actions={actions} />
          ) : (
            <TranslateCard card={screen.cards[screen.index]} client={client} onDone={onCardDone} actions={actions} />
          )}
          {pop && <XpPop xp={pop} />}
        </main>
      )}

      {screen.name === 'summary' && <Summary cards={screen.cards} results={screen.results} stats={stats} starting={starting} onAgain={() => void start()} onDone={() => setScreen({ name: 'home' })} />}
    </div>
  );
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

function Home({
  stats,
  empty,
  error,
  starting,
  onStart,
  settings,
  onNonprofitsOnly,
}: {
  stats: StatsResponse | null;
  empty?: SessionResponse['empty'];
  error: string;
  starting: boolean;
  onStart: () => void;
  settings: VolunteerSettings | null;
  onNonprofitsOnly: (on: boolean) => void;
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

function Summary({ cards, results, stats, starting, onAgain, onDone }: { cards: Card[]; results: CardResult[]; stats: StatsResponse | null; starting: boolean; onAgain: () => void; onDone: () => void }) {
  const done = results.map((r, i) => ({ r, card: cards[i] })).filter(({ r }) => r.outcome === 'done');
  const earned: XpTotals = { accepted: 0, pending: 0 };
  for (const { r } of done) if (r.xp) earned[r.xp.status] += r.xp.points;
  const projects = [...new Map(done.map(({ card }) => [card.project.id, card.project.name])).values()];
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
