import { addMembership, type DB } from '../db.js';
import { ensurePlatformOrg } from '../signup/platform.js';
import { addItem } from '../trust.js';
import type { Demo } from './types.js';

type Item = { kind: 'translate'; source: string; reference: string } | { kind: 'review'; source: string; candidate: string; errorNote?: string };

/**
 * The platform-wide placement check (contract risk 2): volunteers whose org has no check for a language, or who
 * have no org, take this one. NativeLoc staff grade it as members of the NativeLoc Community org.
 */
const PLATFORM_ITEMS: Record<string, Item[]> = {
  es: [
    { kind: 'translate', source: 'The clinic is open on Saturdays.', reference: 'La clínica abre los sábados.' },
    { kind: 'translate', source: 'Bring a photo ID to your first visit.', reference: 'Traiga una identificación con foto a su primera visita.' },
    { kind: 'review', source: 'Classes are free for everyone.', candidate: 'Las clases son gratis para todos.' },
    { kind: 'review', source: 'Call before 5 PM.', candidate: 'Llame después de las 5 p. m.', errorNote: '“before” became “after”' },
    { kind: 'review', source: 'We speak Spanish and English.', candidate: 'Hablamos español e inglés.' },
    { kind: 'review', source: 'Children must be with an adult.', candidate: 'Los niños pueden estar solos.', errorNote: 'the rule was reversed' },
  ],
  fr: [
    { kind: 'translate', source: 'The clinic is open on Saturdays.', reference: 'La clinique est ouverte le samedi.' },
    { kind: 'translate', source: 'Bring a photo ID to your first visit.', reference: "Apportez une pièce d'identité avec photo lors de votre première visite." },
    { kind: 'review', source: 'Classes are free for everyone.', candidate: 'Les cours sont gratuits pour tous.' },
    { kind: 'review', source: 'Call before 5 PM.', candidate: 'Appelez après 17 h.', errorNote: '“before” became “after”' },
    { kind: 'review', source: 'We speak French and English.', candidate: 'Nous parlons français et anglais.' },
    { kind: 'review', source: 'Do not leave bags in the hallway.', candidate: 'Laissez vos sacs dans le couloir.', errorNote: 'the “not” was dropped' },
  ],
  ja: [
    { kind: 'translate', source: 'The clinic is open on Saturdays.', reference: 'クリニックは土曜日も開いています。' },
    { kind: 'translate', source: 'Bring a photo ID to your first visit.', reference: '初回は写真付きの身分証明書をお持ちください。' },
    { kind: 'review', source: 'Classes are free for everyone.', candidate: 'クラスはどなたでも無料です。' },
    { kind: 'review', source: 'Call before 5 PM.', candidate: '午後5時以降にお電話ください。', errorNote: '“before” became “after”' },
    { kind: 'review', source: 'Parking is available behind the building.', candidate: '駐車場は建物の裏にあります。' },
    { kind: 'review', source: 'Applications close on May 1.', candidate: '申し込みは3月1日に締め切ります。', errorNote: '“May” became “March”' },
  ],
};

/** Owned by Segment 2 piece 2A. Demo data for sign-up and onboarding. Runs once, after the core demo seed, before v1 is published. */
export function seedSignup(db: DB, demo: Demo) {
  const platform = ensurePlatformOrg(db);
  // The demo admin is staff, so they run the community org and grade its placement checks (and see the org switcher).
  addMembership(db, demo.users.admin, platform, 'admin');
  for (const [locale, items] of Object.entries(PLATFORM_ITEMS)) {
    for (const item of items) addItem(db, platform, locale, item.kind === 'review' ? { ...item, hasError: !!item.errorNote } : item);
  }
}
