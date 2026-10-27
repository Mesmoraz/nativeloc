// Dev-only stand-in for the volunteer API (open /v?mock=1), for working on the card flow without a server.
// It follows the contract in types.ts closely enough to be useful: sessions alternate Translate and Review,
// saves validate like the server (422 with `issues`), and every save or approval returns an `xp` award.
import { listPlaceholders, pluralExamples, targetTemplate, toEditorModel, validateTranslation } from '@nativeloc/core';
import { ApiError, type QueueItem } from '../api';
import type { VolunteerClient } from './client';
import type { CardOrg } from '../contracts';
import type { Card, Certificate, StatsResponse, VolunteerSettings } from './types';
import { XP } from './types';

const LOCALE = 'es';
const FOOD_BANK = { id: 1, name: 'Riverside Food Bank', sourceLocale: 'en' };
const TENANTS = { id: 2, name: 'Tenant Help Line', sourceLocale: 'en' };
const ORGS: Record<number, CardOrg> = {
  1: { id: 11, name: 'Riverside Food Bank', type: 'nonprofit', verified: true, description: 'Groceries for 3,000 families a month', favorite: true },
  2: { id: 12, name: 'Eastside Tenants Union', type: 'small_org', verified: false, description: 'Free advice for renters', favorite: false },
};

/** A fake phone screen with one line highlighted, so the screenshot view has something real to show. */
function shot(id: number, title: string, lines: string[], highlight: number): QueueItem['screenshot'] {
  const W = 360;
  const H = 640;
  const top = 150;
  const step = 64;
  const rows = lines
    .map((l, i) => {
      const y = top + i * step;
      return `<rect x="20" y="${y}" width="320" height="52" rx="10" fill="#f0f2ef"/><text x="36" y="${y + 32}" font-size="17" fill="#1c2420">${l}</text>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/><rect width="${W}" height="96" fill="#0f766e"/>
<text x="20" y="62" font-size="22" font-weight="700" fill="#fff">${title}</text>${rows}
<rect x="20" y="${H - 84}" width="320" height="52" rx="26" fill="#0f766e"/></svg>`;
  return {
    id,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    label: title,
    width: W,
    height: H,
    box: { x: 16 / W, y: (top + highlight * step - 4) / H, w: 328 / W, h: 60 / H },
  };
}

let nextKey = 100;
function item(
  key: string,
  source: string,
  opts: { description?: string; maxLength?: number; current?: string; shot?: QueueItem['screenshot']; approvals?: { count: number; needed: number } } = {},
): QueueItem {
  return {
    keyId: nextKey++,
    key,
    source,
    prevSource: null,
    description: opts.description ?? null,
    maxLength: opts.maxLength ?? null,
    current: opts.current ? { text: opts.current, status: 'review' } : null,
    sourceModel: toEditorModel(source),
    template: targetTemplate(source, opts.current, LOCALE),
    placeholders: listPlaceholders(source),
    pluralExamples: pluralExamples(LOCALE),
    screenshot: opts.shot ?? null,
    suggestions: [],
    questions: [],
    approvals: opts.approvals ?? null,
    // Review items without a peer-approval count stand in for community review, so the Flag button shows.
    review: opts.current && !opts.approvals ? { reviews: 1, approvals: 1, flags: 0, needed: 3, escalated: false, picks: [] } : null,
    sentBack: null,
  };
}

const translatePool: [typeof FOOD_BANK, QueueItem][] = [
  [
    FOOD_BANK,
    item('map.hours', 'Pick-up hours: {start} to {end}', {
      description: 'Shown under the location name on the map card. The times are filled in by the app.',
      shot: shot(1, 'Find food', ['Riverside Pantry', 'Pick-up hours: 9 to 5', '0.4 miles away'], 1),
    }),
  ],
  [
    FOOD_BANK,
    item('orders.ready', '{count, plural, one {# box is ready for pick-up} other {# boxes are ready for pick-up}}', {
      description: 'Banner at the top of the order screen.',
      shot: shot(2, 'My orders', ['2 boxes are ready for pick-up', 'Order #1042', 'Order #1043'], 0),
    }),
  ],
  [TENANTS, item('appt.confirmed', 'Hi {name}, your appointment is confirmed.', { description: 'Text message sent after someone books a call.' })],
  [FOOD_BANK, item('visit.bring', 'Bring your ID and a bag.', { description: 'A reminder on the visit checklist.', shot: shot(3, 'Before you go', ['Check the hours', 'Bring your ID and a bag.', 'Tell us about allergies'], 1) })],
  [TENANTS, item('cta.call', 'Call us', { description: 'Button label. Space is tight.', maxLength: 14 })],
];

const reviewPool: [typeof FOOD_BANK, QueueItem][] = [
  [FOOD_BANK, item('home.find', 'Find food near you', { current: 'Encuentra comida cerca de ti', approvals: { count: 1, needed: 2 }, shot: shot(4, 'Welcome', ['Find food near you', 'Volunteer', 'Donate'], 0) })],
  [FOOD_BANK, item('nav.volunteer', 'Volunteer sign-up', { current: 'Inscripción de voluntarios', approvals: { count: 0, needed: 2 } })],
  [
    FOOD_BANK,
    item('stats.served', '{count, plural, one {# family served today} other {# families served today}}', {
      current: '{count, plural, one {# familia atendida hoy} other {# familias atendidas hoy}}',
      approvals: { count: 0, needed: 2 },
      description: 'Counter on the volunteer dashboard.',
    }),
  ],
  [TENANTS, item('hours.closed', "We're closed on {date}.", { current: 'Estamos cerrados el {date}.', approvals: { count: 1, needed: 2 } })],
];

const byKey = new Map<number, { project: typeof FOOD_BANK; item: QueueItem }>(
  [...translatePool, ...reviewPool].map(([project, it]) => [it.keyId, { project, item: it }]),
);

let sessions = 0;
const settings: VolunteerSettings = { nonprofitsOnly: false, dailyGoal: 5 };
const certificates: Certificate[] = [];
const stats: StatsResponse = {
  xp: { accepted: 140, pending: 20 },
  today: { accepted: 0, pending: 0 },
  approvedStrings: 12,
  projectsHelped: [FOOD_BANK],
  streak: { current: 6, freezes: 0, activeToday: false, lastFreezeUsed: null },
  goal: { target: 5, done: 0 },
  badges: [
    { id: 'approved_1', detail: null, earnedAt: '2026-09-02 18:20:00', new: false },
    { id: 'trusted', detail: null, earnedAt: '2026-09-10 17:05:00', new: false },
    { id: 'rare_voice', detail: 'es', earnedAt: '2026-10-01 16:45:00', new: true },
  ],
  messages: [
    { id: 1, kind: 'favorite', org: { id: 11, name: 'Riverside Food Bank' }, project: null, body: null, createdAt: '2026-10-20 17:00:00' },
    { id: 2, kind: 'thanks', org: { id: 11, name: 'Riverside Food Bank' }, project: { id: 1, name: 'Riverside Food Bank' }, body: 'Thank you! Our hours page is now in Spanish.', createdAt: '2026-10-21 17:00:00' },
  ],
};

const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const rotate = <T,>(a: T[], n: number) => a.map((_, i) => a[(i + n) % a.length]);

/** A card was saved: it counts toward today's goal and keeps the streak going. */
function didCard() {
  stats.goal.done += 1;
  if (!stats.streak.activeToday) stats.streak = { ...stats.streak, current: stats.streak.current + 1, activeToday: true };
}

function award(points: number, status: 'pending' | 'accepted', project: typeof FOOD_BANK) {
  didCard();
  stats.xp[status] += points;
  stats.today[status] += points;
  if (status === 'accepted' && !stats.projectsHelped.some((p) => p.id === project.id)) stats.projectsHelped.push({ id: project.id, name: project.name });
  return { points, status };
}

export const mockClient: VolunteerClient = {
  async session(size = 5, nonprofitsOnly) {
    await wait();
    const n = sessions++;
    if (nonprofitsOnly !== undefined) settings.nonprofitsOnly = nonprofitsOnly;
    const keep = ([p]: [typeof FOOD_BANK, QueueItem]) => !settings.nonprofitsOnly || ORGS[p.id].verified;
    const t = rotate(translatePool, n * 3).filter(keep);
    const r = rotate(reviewPool, n * 2).filter(keep);
    const cards: Card[] = [];
    // Alternate, starting with Translate, like the server.
    let ti = 0;
    let ri = 0;
    while (cards.length < size && (ti < t.length || ri < r.length)) {
      const translate = (cards.length % 2 === 0 && ti < t.length) || ri >= r.length;
      const [project, it] = translate ? t[ti++] : r[ri++];
      cards.push({ id: `${it.current ? 'review' : 'translate'}:${it.keyId}:${LOCALE}`, type: it.current ? 'review' : 'translate', project, org: ORGS[project.id], locale: LOCALE, item: it });
    }
    // Every mock session shows the two newer card types too: a Spot the problem card second (planted in the first
    // session, a control in the next), and a Pick card last.
    if (cards.length >= 2) {
      const org = ORGS[FOOD_BANK.id];
      const base = { project: FOOD_BANK, org, locale: LOCALE };
      cards.splice(1, 0, {
        ...base,
        id: `spot:${n + 1}`,
        type: 'spot',
        spot: { checkId: n + 1, source: 'We are open Monday to Friday, 9 AM to 5 PM.', shown: `Abrimos de lunes a viernes, de 9 a. m. a ${n % 2 ? 5 : 6} p. m.` },
      });
      cards.splice(size - 1);
      cards.push({
        ...base,
        id: `pick:${900 + n}:${LOCALE}`,
        type: 'pick',
        pick: { keyId: 900 + n, source: 'Free groceries for anyone who needs them.', note: null, a: 'Comida gratis para quien la necesite.', b: 'Alimentos gratuitos para cualquier persona que los necesite.' },
      });
    }
    return { cards, empty: cards.length ? null : 'nothing_to_do' };
  },

  async stats() {
    await wait(200);
    return structuredClone(stats);
  },

  async settings() {
    await wait(100);
    return structuredClone(settings);
  },

  async setNonprofitsOnly(on) {
    await wait(100);
    settings.nonprofitsOnly = on;
    return structuredClone(settings);
  },

  async setDailyGoal(goal) {
    await wait(100);
    settings.dailyGoal = goal;
    stats.goal.target = goal;
    return structuredClone(settings);
  },

  async markBadgesSeen(ids) {
    for (const b of stats.badges) if (ids.includes(b.id)) b.new = false;
  },

  async certificates() {
    await wait(100);
    return structuredClone(certificates);
  },

  async issueCertificate(from, to) {
    await wait();
    const c: Certificate = {
      code: `vc_mock${certificates.length + 1}`,
      name: 'Mock Volunteer',
      periodFrom: from ?? null,
      periodTo: to ?? new Date().toISOString().slice(0, 10),
      hours: 3.5,
      translations: 80,
      reviews: 50,
      orgs: [FOOD_BANK.name],
      rates: { version: '2026-10', translate: 2, review: 1 },
      issuedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      revokedAt: null,
    };
    certificates.unshift(c);
    return structuredClone(c);
  },

  async revokeCertificate(code) {
    await wait(100);
    const c = certificates.find((x) => x.code === code)!;
    c.revokedAt ??= new Date().toISOString().slice(0, 19).replace('T', ' ');
    return structuredClone(c);
  },

  async answerSpot(checkId, verdict) {
    await wait(200);
    // Odd ids are planted ("5" became "6"), even ones are controls.
    const planted = checkId % 2 === 1;
    const correct = (verdict === 'problem') === planted;
    if (correct) {
      stats.xp.accepted += 5;
      stats.today.accepted += 5;
    }
    didCard();
    return { correct, planted, original: planted ? '5' : null, changed: planted ? '6' : null, xp: correct ? { points: 5, status: 'accepted' } : null };
  },

  async finalDecision(_keyId, _locale, decision) {
    await wait();
    didCard();
    return { status: decision === 'publish' ? 'approved' : 'review', xp: { points: 5, status: 'accepted' } };
  },

  async markMessagesSeen(ids) {
    stats.messages = stats.messages.filter((m) => !ids.includes(m.id));
  },

  async pick() {
    await wait();
    return { xp: award(5, 'pending', FOOD_BANK) };
  },

  async flag() {
    await wait();
    didCard();
    return { status: 'review', review: { reviews: 1, approvals: 0, flags: 1, needed: 5, escalated: false, picks: [] }, xp: { points: XP.review, status: 'pending' } };
  },

  async report() {
    await wait();
    return { ok: true, paused: false };
  },

  async save(keyId, locale, text) {
    await wait();
    const found = byKey.get(keyId);
    if (!found) throw new ApiError(404, 'String not found.');
    const issues = validateTranslation(found.item.source, text, { locale, maxLength: found.item.maxLength });
    const error = issues.find((i) => i.level === 'error');
    if (error) throw new ApiError(422, error.message, { issues });
    return { status: 'review', xp: award(XP.translate, 'pending', found.project) };
  },

  async approve(keyId) {
    await wait();
    const found = byKey.get(keyId);
    if (!found?.item.approvals) throw new ApiError(404, 'Nothing to approve yet.');
    const approvals = { ...found.item.approvals, count: found.item.approvals.count + 1 };
    // The vote that completes approval settles at once; earlier votes wait for the last one.
    const done = approvals.count >= approvals.needed;
    return { status: done ? 'approved' : 'review', approvals, xp: award(XP.review, done ? 'accepted' : 'pending', found.project) };
  },
};
