# Platform vision: accounts, tiers, and a volunteer app people want to open

This builds on [org-adoption-plan.md](org-adoption-plan.md) (how nonprofits say yes) and
[program-design.md](program-design.md) (scope, quality, proficiency). It widens NativeLoc from "we translate
nonprofit websites" to an open platform: anyone can sign up to **help** or to **get something translated**,
on the web, iOS and Android.

**The one-line version:** *I'm bored, I open my phone, I translate three sentences for a food bank, and it
actually goes live.* Later, organizations that can pay will, and that money keeps the nonprofit service free.

**This is built in segments** (§9). Each one ships something volunteers or orgs can use on its own. The
paid tier is the last segment; until then, everything is free and for-profit businesses join a waitlist.

| Segment | Ships | Who it's for |
|---|---|---|
| **1. Volunteer cards on phones** | The "5 in 5" card flow in the web app, with accepted-only XP | Pilot volunteers |
| **2. Open sign-up + community tier** | Self-serve accounts, nonprofit verification, 3–5 round review, poster approval | Anyone who wants to help or needs non-commercial translation |
| **3. Engagement + org features** | Streaks, badges, more card types, favorites, Approved Reviewers, org leaderboards | Keeping volunteers coming back; giving orgs control |
| **4. Native apps** | iOS and Android (Expo), push notifications, urgent lane, leagues | Volunteers on the go |
| **5. Paid tier (later)** | Business accounts, billing, paid translators, payouts | Businesses |

## 1. Accounts: one account, two hats

Everyone signs up the same way. During onboarding they pick one or both:

- **I want to help.** Pick languages, take the 15-minute placement check (already built), start translating.
- **I need something translated.** Create or join an organization, or post as an individual.

An account can wear both hats. A Somali-speaking staff member at a clinic can request translations for
their clinic and also volunteer for other orgs.

**Requester account types:**

| Type | Who | How we verify |
|---|---|---|
| **Nonprofit** | 501(c)(3)s, public agencies, schools, mutual-aid and community groups | EIN lookup against the IRS exempt-org list; manual review for unregistered community groups |
| **Individual** | A person with personal or community content | Email + phone |
| **Small org** | Clubs, faith groups, small non-commercial projects | Email + a short description |
| **Business** | Any for-profit, of any size | Email + billing details. *Waitlist until Segment 5.* |

## 2. Service tiers

| | **Nonprofit** | **Community (free)** | **Trusted (paid) — Segment 5, later** |
|---|---|---|---|
| Who can use it | Verified nonprofits | Individuals, small orgs, community groups (non-commercial content) | Anyone, including businesses |
| Price | Free, always | Free | Per word or subscription |
| Who translates | Volunteers, with Trusted and Lead reviewers | Volunteers of any tier | Paid Trusted / Lead translators |
| Review | Peer review **plus** a Lead for high-stakes strings; spot audits | **3–5 independent rounds** (see §3); the poster vets and publishes | Lead review; turnaround guarantee |
| Priority | Highest in the queue; urgent lane; campaigns | Normal | Contracted turnaround (does not take volunteer time) |
| Label shown on published text | "Checked by N native speakers" | "Community-reviewed, not verified" | "Professionally reviewed" |

**Nonprofits always get the best service.** That means the best reviewers, the urgent lane, the top of the
queue, and the spot audits from program-design §3. It costs them nothing. Grants pay for it at first;
business revenue joins once the paid tier ships.

### The one change to the original idea: volunteers don't work for businesses for free

The first version of this idea had businesses using the free volunteer tier too. I'd change that, for
three reasons:

1. **Law.** In the US, for-profit companies generally can't accept unpaid "volunteer" work (Fair Labor
   Standards Act). A business getting free translation from a crowd of volunteers is a legal risk for us and
   for them. Other countries have similar rules. Get a lawyer to confirm before launch.
2. **Volunteer trust.** Crowdsourced translation for companies has caused public backlash before.
   Volunteers come to help a food bank, not to save a company money. If they find out they're doing that,
   we lose them.
3. **It's a better business.** Paid work pays translators. Volunteers who reach Trusted or Lead can **opt
   in to paid work**. That gives native speakers of scarce languages (Somali, Tagalog) a real career path,
   and gives businesses a quality guarantee.

So: businesses get the **Trusted (paid)** tier when it ships in Segment 5. Until then they can join a
waitlist; they are not served by volunteers. Individuals and small non-commercial orgs get the free
community tier from Segment 2.

Volunteers always see who they're helping (nonprofit or community, and later paid jobs) and can filter by
it.

## 3. "3–5 rounds" in practice

Free community content gets **adaptive peer review** on top of what exists today (`peer_approvals` already
goes from 0 to 5 per project):

1. One volunteer translates.
2. Independent reviewers see the source and the translation. They don't see each other's votes. They
   approve, suggest an edit, or flag it.
3. **Stop at 3** if three reviewers agree. **Go up to 5** if anyone disagrees or edits. If there's still no
   agreement after 5, the string goes to a Trusted reviewer.
4. The result goes to the **poster**, who sees each string with its review count and any disagreement. They
   publish, edit, or send it back. Nothing goes live without the poster's click.

Agreement between reviewers also feeds each volunteer's hidden trust score (program-design §5), so the
review rounds double as quality measurement.

## 4. The volunteer app: Duolingo feel, quality-first scoring

The goal is that a volunteer can do useful work in the time it takes to wait for a bus.

**Opening the app:**
- One big button: **Start** (a "5 in 5" session: five cards, about five minutes).
- Above it: today's goal, streak, and one line of impact ("Your translations were read 312 times this
  week").

**Card types** (each one is a single screen, one-thumb, with a big **Next** button):

| Card | What you do |
|---|---|
| **Translate** | One sentence, with a screenshot of where it appears, a context note, and placeholder chips |
| **Review** | Approve, edit, or flag someone else's translation |
| **Pick the better one** | Two translations; choose one. Quick, and very good data |
| **Spot the problem** | A translation that might contain a planted error (gold check, graded automatically) |
| **Urgent** | A short notice that needs to go live today (on-call volunteers only) |

After each card: a short animation, haptic feedback, and XP. After each session: a summary, plus a line
about who you helped ("You helped Rainier Valley Food Bank and 2 others").

**The rule that keeps it honest: XP is earned when work is accepted, not when it's submitted.**
- A translation earns *pending XP* right away (shown faded). It becomes real XP when reviewers approve it.
  If it's overturned, the pending XP disappears quietly.
- Review cards earn XP for agreeing with the final outcome and for catching planted errors.
- Rushing gets you nothing, so speed never beats care. This resolves the concern in program-design §4:
  the app can feel like a game, while the scoring rewards accuracy.

**Engagement features:**
- **Streaks and a daily goal.** Streak freezes, and gentle reminders that can be turned off.
- **Badges** for milestones that reflect quality and reach, for example:
  - *First approved string*, *100 approved*, *1,000 approved*
  - *Eagle eye*: caught 25 planted errors
  - *First responder*: translated an urgent notice that went live within 24 hours
  - *Bridge builder*: helped 10 different organizations
  - *Rare voice*: active in a language with few volunteers
  - *Trusted* and *Lead*: placement passed, vetted by a partner
- **Leagues** (opt-in): weekly groups of about 30 volunteers ranked by accepted XP. You only appear on a
  public board if you choose to. This matters because older native speakers, who we need most, are often
  put off by public rankings.
- **Team progress:** shared progress bars for each language community and each campaign, with a launch
  celebration when a campaign finishes.
- **Real-world rewards:** verified volunteer-hour certificates, public credit on the org's site, reference
  letters, and for Trusted volunteers, paid work.

## 5. Organization features

- **Favorites.** An org stars volunteers whose work they like. Favorites get that org's new work first.
- **Approved Reviewers.** An org can mark volunteers as approved *for that org*. Their approval counts as
  the poster's vetting, so the org doesn't have to check every string themselves. This is separate from the
  platform-wide Trusted/Lead tiers: it's the org's own trust, not ours.
- **Org leaderboard.** "Top translators for FreshMart Food Bank this month," ranked by accepted words.
  Volunteers choose whether they appear.
- **Thank-you notes.** One tap for the org to thank everyone who worked on a campaign. Volunteers see it
  in the app; it's one of the best motivators there is.
- **Invite links** to bring their own community in (built; see README).

## 6. Platforms: web, iOS and Android

| Surface | Who | What |
|---|---|---|
| **Web app** (existing, React) | Orgs, admins, desktop volunteers | Everything: projects, uploads, crawler, billing, reports, the full translator editor |
| **Mobile app** (iOS + Android) | Mainly volunteers; lightweight for requesters | The card-based volunteer flow, streaks, badges, leagues, push notifications. Requesters can check progress, approve strings and post short text or a photo of a flyer |

**Recommended stack: React Native with Expo**, in the same monorepo.
- Same language (TypeScript) as the web app and server. Shares `@nativeloc/core` (ICU validation,
  placeholders, plurals) and the API types directly.
- Native gestures, haptics and animations make the "Duolingo feel" much easier to get right than a wrapped
  website.
- Expo handles push notifications for both platforms, which the urgent lane needs.
- One codebase, with app-store builds through EAS.

The faster first step, before the native app, is to make the volunteer flow in the existing web app work
well on phones (installable PWA). That tests the card format with real volunteers while the native app is
built.

**Payments happen on the web** with Stripe. Requesters pay on the website, not inside the app. Translation
by people is a service delivered outside the app, which app-store rules generally allow to be billed
outside the app; confirm against current Apple and Google rules before launch.

## 7. How the money flows (once Segment 5 ships)

Until then, NativeLoc runs on grants and donations.

```
Business pays for Trusted translation
   ├── most of it → the translator who did the work
   └── platform fee → servers, staff, spot audits, and the free nonprofit tier
Grants and donations → the nonprofit tier and scarce-language recruiting
```

Keeping the nonprofit tier free and best-in-class is the mission. The paid tier exists to fund it.

## 8. How it maps onto what's built

| Need | Already built | New work |
|---|---|---|
| Accounts | Users, orgs, invite links | Self-serve sign-up, account types, nonprofit verification |
| Volunteer quality | Trust tiers (new / trusted / lead), placement check, peer approvals 0–5 | Adaptive 3–5 rounds, hidden trust score, gold cards in the normal queue |
| Volunteer flow | One-string-at-a-time queue with context | Card types, sessions, XP ledger (pending → accepted), streaks, badges, leagues |
| Org features | Projects, review settings | Favorites, org-scoped Approved Reviewers, org leaderboards, thank-yous |
| Requester flow | CLI, REST, web upload, crawler | Poster approval step, quality labels on published text |
| Paid tier | — | Stripe billing, paid job queue, translator payouts (Stripe Connect), turnaround SLAs |
| Mobile | — | Expo app, push notifications |

## 9. Segments

Each segment has a clear finish line. Segment 1 can start now; the nonprofit delivery work in
[program-design.md](program-design.md) §6 (automatic screenshots, campaigns, the in-page snippet) runs
alongside it.

### Segment 1: Volunteer cards on phones

**Goal:** prove that people will translate in short sessions on a phone, and that accepted-only XP keeps
quality up.

- A mobile-first volunteer screen in the existing web app, installable as a PWA.
- **Start** runs a "5 in 5" session using two card types: **Translate** and **Review**.
- XP ledger: pending when you submit, accepted when reviewers approve, quietly removed if overturned.
- Session summary with impact ("You helped 2 organizations").
- Uses today's accounts and invite links; no new sign-up flow yet.

**Not in this segment:** streaks, badges, leaderboards, native apps.

**Done when:** pilot volunteers complete sessions on their phones, and we can measure session completion
rate, strings per session, and the share of strings accepted.

### Segment 2: Open sign-up and the community tier

**Goal:** anyone can join, as a volunteer, a requester, or both.

- Self-serve sign-up with both hats; requester types Nonprofit, Individual and Small org. Business goes to
  a waitlist.
- Nonprofit verification (IRS exempt-org lookup, manual review for community groups).
- Requesters post content (upload, paste text, or crawl a site with the existing crawler).
- Moderation of every free post before it reaches the volunteer queue (automatic screen plus reporting).
- Adaptive 3–5 round review (§3), the poster approval step, and quality labels on published text.
- Queue priority: nonprofits first.

**Done when:** a stranger can sign up, post a non-commercial page, and publish it after community review,
with no help from us.

### Segment 3: Engagement and organization features

**Goal:** volunteers come back, and organizations have control over who works on their content.

- Streaks, daily goal, reminders, streak freezes.
- Badges (§4).
- More card types: **Pick the better one** and **Spot the problem** (gold checks in the normal queue).
- Favorites, org-scoped Approved Reviewers, org leaderboards (opt-in), thank-you notes.
- Team progress bars per language and per campaign.
- Volunteer-hour certificates.

**Done when:** we see week-over-week return rates for volunteers, and at least one pilot org uses
Approved Reviewers instead of checking every string itself.

### Segment 4: Native apps

**Goal:** the full Duolingo feel, and fast response for urgent notices.

- React Native app with Expo for iOS and Android, sharing `@nativeloc/core` and API types.
- The card flow, with native gestures, haptics and animations.
- Push notifications; the urgent lane with an on-call rota.
- A light requester view: progress, approve strings, post short text or a flyer photo.
- Opt-in weekly leagues, once there are enough volunteers per language to fill them.

**Done when:** both apps are in the stores, and an urgent notice can go from posted to live within 24 hours
through push.

### Segment 5 (later): Paid tier

**Goal:** businesses pay for trusted translation, translators get paid, and the platform fee helps fund
the nonprofit tier.

- Business accounts from the waitlist; Stripe billing on the web (not in the app).
- A paid job queue, kept separate from volunteer work.
- Trusted and Lead volunteers can opt in to paid work; payouts through Stripe Connect.
- Turnaround guarantees and the "Professionally reviewed" label.

**Before starting:** legal review of volunteer vs. paid work, translator rates for scarce languages, and
current app-store payment rules.

## 10. Open questions

- **Where's the line between "small org" and "business"?** Proposed rule: free if the content isn't selling
  something. A church bulletin is free; a restaurant menu is paid.
- **Individuals posting personal documents** (a letter from a landlord, a medical form): very high
  impact, but private data and high stakes. Probably a separate, later flow with stricter privacy and
  Trusted-only translators.
- **Abuse:** spam, hateful content, or people using volunteers to translate scams. Every free post needs
  moderation before it reaches the queue (automatic screen plus reporting).
- **Paid translator rates** for scarce languages, and whether volunteers can be paid and volunteer for the
  same org (Segment 5).
- **Minors:** high-school students are a key volunteer group (Seal of Biliteracy). Leagues, chat and
  public profiles need age-appropriate defaults, and app-store age ratings must match.
