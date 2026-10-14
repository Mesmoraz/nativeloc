import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { TopBar, useSession } from '../App';
import { api, type Tier } from '../api';
import type { CreateOrgRequest, CreateOrgResponse, EinLookupResponse, OrgType } from '../contracts';
import { languageName, nativeLanguageName } from '../types';
import { ConfirmEmail, LanguagePicker, ORG_TYPE_LABEL } from './shared';
import './signup.css';

type Step = 'hats' | 'languages' | 'placement' | 'type' | 'details' | 'done';
type Hats = { help: boolean; request: boolean };

/**
 * Onboarding picks the hats. Help: languages → placement check → first session (/v).
 * Get translation: account type → org details (EIN and state for nonprofits) → first project.
 * /welcome?hat=help or ?hat=request jumps straight into one path (the account menu uses it).
 */
export function Welcome() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const hat = params.get('hat');
  const [hats, setHats] = useState<Hats>({ help: hat === 'help', request: hat === 'request' });
  const [step, setStep] = useState<Step>(hat === 'help' ? 'languages' : hat === 'request' ? 'type' : 'hats');
  const [orgType, setOrgType] = useState<OrgType | null>(null);
  const [created, setCreated] = useState<CreateOrgResponse | null>(null);
  const user = session!.user;

  const path: Step[] = ['hats', ...(hats.help ? (['languages', 'placement'] as Step[]) : []), ...(hats.request ? (['type', 'details', 'done'] as Step[]) : [])];
  const next = () => setStep(path[path.indexOf(step) + 1] ?? 'hats');

  return (
    <>
      <TopBar />
      <main className="su-page stack">
        {user.emailVerified === false && <ConfirmEmail email={user.email} />}
        {step !== 'hats' && (
          <ol className="su-steps" aria-label={`Step ${path.indexOf(step) + 1} of ${path.length}`}>
            {path.map((s, i) => (
              <li key={s} className={i <= path.indexOf(step) ? 'on' : ''} />
            ))}
          </ol>
        )}
        {step === 'hats' && <HatsStep hats={hats} setHats={setHats} onNext={next} firstName={user.name.split(' ')[0]} />}
        {step === 'languages' && <LanguagesStep onNext={next} />}
        {step === 'placement' && <PlacementStep andThen={hats.request ? next : null} />}
        {step === 'type' && (
          <TypeStep
            value={orgType}
            onPick={(t) => {
              setOrgType(t);
              setStep('details');
            }}
          />
        )}
        {step === 'details' && orgType && (
          <DetailsStep
            type={orgType}
            onBack={() => setStep('type')}
            onCreated={(r) => {
              setCreated(r);
              setStep('done');
            }}
          />
        )}
        {step === 'done' && created && <DoneStep created={created} />}
      </main>
    </>
  );
}

function HatsStep({ hats, setHats, onNext, firstName }: { hats: Hats; setHats: (h: Hats) => void; onNext: () => void; firstName: string }) {
  return (
    <div className="stack">
      <div>
        <h1>Welcome, {firstName}!</h1>
        <p className="muted" style={{ margin: 0 }}>
          What brings you to NativeLoc? Pick one or both; you can always add the other later.
        </p>
      </div>
      <div className="su-choices">
        <button type="button" className="su-choice" aria-pressed={hats.help} onClick={() => setHats({ ...hats, help: !hats.help })}>
          <span className="su-icon" aria-hidden>
            🤝
          </span>
          <b>Help translate</b>
          <span className="small muted">Translate or check short pieces of text for local nonprofits, five minutes at a time.</span>
        </button>
        <button type="button" className="su-choice" aria-pressed={hats.request} onClick={() => setHats({ ...hats, request: !hats.request })}>
          <span className="su-icon" aria-hidden>
            📣
          </span>
          <b>Get translation</b>
          <span className="small muted">Post your organization's pages or app text, and native-speaker volunteers translate it.</span>
        </button>
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="primary" disabled={!hats.help && !hats.request} onClick={onNext}>
          Continue
        </button>
      </div>
    </div>
  );
}

function LanguagesStep({ onNext }: { onNext: () => void }) {
  const { session, refresh } = useSession();
  const [locales, setLocales] = useState<string[]>(session!.user.locales);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/api/v1/me', { method: 'PATCH', body: { locales } });
      await refresh();
      onNext();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <h1>Your languages</h1>
        <p className="muted" style={{ margin: 0 }}>
          Volunteers translate from English into a language they grew up with or use every day.
        </p>
      </div>
      <LanguagePicker value={locales} onChange={setLocales} />
      {error && <div className="alert error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="primary" disabled={!locales.length || busy} onClick={save}>
          Continue
        </button>
      </div>
    </div>
  );
}

interface PlacementInfo {
  locale: string;
  tier: Tier;
  available: boolean;
  attempt: { status: string } | null;
}

function PlacementStep({ andThen }: { andThen: (() => void) | null }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const locales = session!.user.locales;
  const [info, setInfo] = useState<Record<string, PlacementInfo>>({});

  useEffect(() => {
    for (const l of locales) api<PlacementInfo>(`/api/v1/placement/${l}`).then((r) => setInfo((m) => ({ ...m, [l]: r })), () => {});
  }, [locales]);

  return (
    <div className="stack">
      <div>
        <h1>You can start right away</h1>
        <p className="muted" style={{ margin: 0 }}>
          Your translations count from the first one. To also check other volunteers' work, take a short placement check in each language: spot a few
          mistakes and translate five sentences (about 15 minutes).
        </p>
      </div>
      <ul className="su-langs">
        {locales.map((l) => {
          const p = info[l];
          return (
            <li key={l}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <b lang={l}>{nativeLanguageName(l)}</b> <span className="small muted">{languageName(l)}</span>
              </div>
              {p?.tier && p.tier !== 'new' ? (
                <span className="badge">{p.tier === 'lead' ? 'Lead' : 'Trusted'}</span>
              ) : p?.attempt?.status === 'submitted' ? (
                <span className="small muted">Check submitted, waiting for a grader</span>
              ) : p?.available ? (
                <Link className="btn" to={`/placement/${l}`}>
                  Take the placement check
                </Link>
              ) : (
                <span className="small muted">{p ? 'No placement check yet' : '…'}</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="row">
        <span className="spacer" />
        {andThen && <button onClick={andThen}>Next: set up your organization</button>}
        <button className="primary" onClick={() => navigate('/v')} disabled={session!.user.emailVerified === false} title={session!.user.emailVerified === false ? 'Confirm your email first' : undefined}>
          Start your first session
        </button>
      </div>
    </div>
  );
}

const TYPE_HELP: Record<OrgType, string> = {
  nonprofit: 'A 501(c)(3) or similar. We check your EIN with the IRS list; verified nonprofits get priority from volunteers.',
  small_org: 'A tenants’ association, mutual aid group, church or school club, with or without an EIN.',
  individual: 'Just you, for example translating a flyer for your neighbors. We set up a personal account.',
  business: 'Companies and paid services. Business accounts are on a waitlist for now.',
};

function TypeStep({ value, onPick }: { value: OrgType | null; onPick: (t: OrgType) => void }) {
  return (
    <div className="stack">
      <div>
        <h1>Who is the translation for?</h1>
        <p className="muted" style={{ margin: 0 }}>
          Volunteers see this on every card, so they know who they're helping.
        </p>
      </div>
      <div className="su-choices">
        {(['nonprofit', 'small_org', 'individual', 'business'] as OrgType[]).map((t) => (
          <button type="button" key={t} className="su-choice" aria-pressed={value === t} onClick={() => onPick(t)}>
            <b>{ORG_TYPE_LABEL[t]}</b>
            <span className="small muted">{TYPE_HELP[t]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DetailsStep({ type, onBack, onCreated }: { type: OrgType; onBack: () => void; onCreated: (r: CreateOrgResponse) => void }) {
  const { session, refresh } = useSession();
  const [form, setForm] = useState({ name: type === 'individual' ? session!.user.name : '', ein: '', state: '', website: '', description: '' });
  const [match, setMatch] = useState<EinLookupResponse['match']>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const verified = session!.user.emailVerified !== false;

  // Look the EIN up (2B) as it's typed, so a match can fill in the name and state.
  useEffect(() => {
    const digits = form.ein.replace(/\D/g, '');
    if (type !== 'nonprofit' || digits.length !== 9) return setMatch(null);
    api<EinLookupResponse>(`/api/v1/orgs/ein/${digits}`).then((r) => setMatch(r.match), () => setMatch(null));
  }, [form.ein, type]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body: CreateOrgRequest & { state?: string } = { type, name: form.name, website: form.website || undefined, description: form.description || undefined };
    if (type === 'nonprofit') Object.assign(body, { ein: form.ein, state: form.state });
    try {
      const r = await api<CreateOrgResponse>('/api/v1/orgs', { body });
      await refresh();
      onCreated(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <h1>{type === 'individual' ? 'Your account' : `About your ${ORG_TYPE_LABEL[type].toLowerCase()}`}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {type === 'business' ? "We'll save your details and email you when business accounts open." : 'A sentence or two helps volunteers pick your work.'}
        </p>
      </div>
      <div className="card stack">
        <label className="field">
          {type === 'individual' ? 'Name volunteers will see' : 'Name'}
          <input value={form.name} onChange={set('name')} required maxLength={120} autoFocus={type !== 'individual'} />
        </label>
        {type === 'nonprofit' && (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <label className="field" style={{ flex: 2, minWidth: 160 }}>
              EIN <span className="small muted">(leave blank if you don't have one)</span>
              <input value={form.ein} onChange={set('ein')} inputMode="numeric" placeholder="12-3456789" />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 90 }}>
              State
              <input value={form.state} onChange={set('state')} placeholder="OR" maxLength={2} style={{ textTransform: 'uppercase' }} />
            </label>
          </div>
        )}
        {match && (
          <div className="alert small">
            IRS record: <b>{match.name}</b>, {match.city}, {match.state}.{' '}
            {form.state.toUpperCase() !== match.state && (
              <button type="button" className="ghost small" onClick={() => setForm({ ...form, name: form.name || match.name, state: match.state })}>
                Use this state
              </button>
            )}
          </div>
        )}
        {type !== 'individual' && (
          <label className="field">
            Website <span className="small muted">(optional)</span>
            <input type="url" value={form.website} onChange={set('website')} placeholder="https://" />
          </label>
        )}
        <label className="field">
          What you do <span className="small muted">(optional, one line)</span>
          <textarea value={form.description} onChange={set('description')} rows={2} maxLength={280} placeholder="e.g. Groceries for 3,000 families a month" />
        </label>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="row">
        <button type="button" className="ghost" onClick={onBack}>
          Back
        </button>
        <span className="spacer" />
        <button className="primary" disabled={busy || !verified} title={verified ? undefined : 'Confirm your email first'}>
          {type === 'business' ? 'Join the waitlist' : type === 'individual' ? 'Continue' : type === 'nonprofit' ? 'Set up nonprofit' : 'Create group'}
        </button>
      </div>
      {!verified && <p className="small muted" style={{ margin: 0, textAlign: 'right' }}>Confirm your email to finish this step.</p>}
    </form>
  );
}

function DoneStep({ created }: { created: CreateOrgResponse }) {
  const { org, waitlisted } = created;
  if (waitlisted) {
    return (
      <div className="card stack">
        <h1>You're on the waitlist</h1>
        <p className="muted" style={{ margin: 0 }}>
          We saved <b>{org.name}</b>. NativeLoc is open to nonprofits, community groups and individuals first; we'll email you when business accounts can
          post.
        </p>
        <Link className="btn" to="/">
          Go to NativeLoc
        </Link>
      </div>
    );
  }
  return (
    <div className="card stack">
      <h1>{org.name} is set up</h1>
      {org.type === 'nonprofit' && org.verification === 'verified' && <p className="alert small">Verified with the IRS list. Volunteers will see you as a verified nonprofit.</p>}
      {org.type === 'nonprofit' && org.verification === 'pending' && (
        <p className="muted" style={{ margin: 0 }}>
          We're checking your nonprofit status; that usually takes a day or two. You can post now, and volunteers will see you as a community group until then.
        </p>
      )}
      <p className="muted" style={{ margin: 0 }}>
        Next, add what you'd like translated: paste text, upload a file, or point us at your website.
      </p>
      <Link className="btn primary" to="/new">
        Create your first project
      </Link>
    </div>
  );
}
