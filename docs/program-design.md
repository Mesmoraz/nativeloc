# Program design: scope, speed, proof of quality, motivation and proficiency

This is the companion to [org-adoption-plan.md](org-adoption-plan.md). That plan covers how organizations
say yes. This one covers what we translate, how we get it done quickly and well, and how we show both.

**A sizing data point.** `nativeloc crawl --dry-run` on U-District Food Bank's site (October 2026):
- the first 6 help pages are 258 distinct strings and about 2,850 words;
- 15 pages are 413 strings and about 4,000 words.

At an assumed 250 words per volunteer-hour (translating plus checking), the help pages take about
11–12 volunteer-hours per language. Five languages need about 60 hours. Ten active volunteers per
language can finish that in a weekend.

## 1. Scope: what we translate

Two lanes. They have different promises.

**Foundation lane: the help path (days).** This is everything a person needs to get help:
- the home page, navigation and footer;
- what services exist, who is eligible, and what to bring;
- hours and locations;
- how to apply or sign up, and how to contact the org;
- emergency and crisis information;
- the page description that shows in search results.

The crawler already reads these pages first. Typical size is 1,500–3,000 words per organization.

**Urgent lane: notices (hours).** This covers closures, weather and holiday hours, "we're out of X", and
emergency changes. These are short (under 50 words), time-sensitive, and go to on-call volunteers (see §2).
This is where speed matters most and where machine translation does the most harm.

**Next, once the foundation lane is live:** linked intake forms and flyers. The crawler already lists the
PDFs and Word files it finds.

**Out of scope at first:**
- blogs, news, event listings and other content that churns daily;
- donor and fundraising pages, annual reports, staff bios and job posts;
- privacy and legal policies (liability: we link to the English version).

**In scope, but always with a vetted reviewer:** medical instructions, legal rights, crisis lines,
eligibility and benefit rules. Peer approval alone isn't enough for these. This needs per-string
"high-stakes" tagging; today review rules are set per project.

## 2. Getting it done fast

- **Make the work tiny.** One sentence at a time, on a phone, with "5 strings in 5 minutes" sessions. The
  queue already serves one string at a time with context. The next step is a mobile-first PWA, then a
  native iOS and Android app with push notifications (see [platform-vision.md](platform-vision.md) §6).
- **Time-boxed campaigns, not an endless queue.** For example: "Get Rainier Valley Food Bank's help pages
  live in Somali by Friday." Each language team shares a progress bar, there's a clear finish line, and
  the launch is announced to the volunteers who did it.
- **On-call rota for urgent notices.** Each language has a few volunteers on call each week. An urgent
  string pings them; two approvals publish it. Target: live within 24 hours.
- **Pre-sort the work.** Translation memory fills repeats across organizations, so "food bank", "hours"
  and "no ID required" get translated once. The shared menu and footer are translated once per site.
  This already works.
- **Reward approved work, not submissions** (see §4), so speed never beats accuracy.
- **Measure one number: time-to-live.** That's the time from crawl to published, per organization and
  language. Report it publicly.

## 3. Showing organizations it's good, and on time

Before they say yes:
- **Their own pages, already translated.** The preview from the adoption plan.
- **Back-translation sample.** For about 10 key sentences, a second volunteer who hasn't seen the original
  translates them back into English. Staff can judge the meaning themselves without speaking Somali.
- **"Every sentence was checked by at least 2 native speakers,"** with the actual counts.

After launch:
- **Independent spot audits.** A paid professional reviewer grades a random 5% sample per language
  each quarter, using an error-rate score. The score goes in the impact email. Grant-funded; this is the
  most credible signal we can offer.
- **Community check.** A partner community organization has 3–5 people try real tasks in the language,
  such as "find this week's hours in Somali".
- **Report-a-problem rate** from the page footer, and how fast we fix reports.

On timeliness:
- **Promise only what volunteer supply supports.** We commit to a language for an organization only
  when it has at least 3 active qualified reviewers. Then: the help path within a set number of days,
  urgent notices within 24 hours.
- **Publish our median time-to-live** so the promise has a track record behind it.
- **Pilot first.** Five organizations, with before/after case studies (visits by language, coverage).

## 4. Is it a gamified app?

> **Update:** [platform-vision.md](platform-vision.md) §4 adopts a Duolingo-style app (XP, streaks, badges,
> opt-in leagues and org leaderboards). It keeps the concerns below by awarding XP only when work is
> *accepted* by reviewers, never when it is submitted, and by keeping public rankings opt-in.

**Light motivation design, not a game.** Points-per-string leaderboards reward speed over care. They
invite gaming the review system and can put off the older native speakers we most need, especially for
Somali and Tagalog.

What we use instead:
- **Impact first.** "Your translations were read 1,240 times this month." "You helped 3 food banks."
- **Team goals over individual ranks.** Progress bars per language community and per campaign, with
  shared launches.
- **Milestones tied to quality.** For example, "100 approved strings", or "Trusted reviewer" when your
  approvals are rarely overturned. Never raw submission counts.
- **Things with real-world value:**
  - verified volunteer-hour records (students need service hours; employers run volunteer-grant
    programs);
  - opt-in public credit on the organization's site;
  - reference letters for consistent contributors.
- **Optional streaks.** Off by default, and never shown publicly.

## 5. Proving proficiency (native or C1–C2)

We can't cheaply prove someone is "native", and it isn't really what matters. What matters is proven
ability at this task, and a record that keeps confirming it. Use layers, so no single test has to be
perfect:

1. **Sign-up self-assessment.** A CEFR "can do" grid plus how they learned the language (home, school,
   work). Low signal, but it sorts people and sets expectations.
2. **Placement task, about 15 minutes, inside the app:**
   - Translate 10 gold sentences that have vetted reference translations. A vetted reviewer grades them.
   - Review 10 translations that contain planted errors (a wrong number, a dropped negation, a mistranslated
     eligibility rule). These are graded automatically: did they catch them?
3. **Trust tiers that gate approval rights:**
   - **New:** can translate. Their work needs 2 approvals. Their own approvals don't count.
   - **Trusted:** passed the placement task. Their approvals count.
   - **Lead:** vetted by staff or a partner organization. Can approve high-stakes strings.

   This also fixes the fake-account risk of open sign-up: a new account can't approve anything.
4. **Ongoing hidden checks:**
   - Gold strings with known answers mixed into the review queue.
   - How often a reviewer's approvals are later overturned.
   - How often they agree with other qualified reviewers.

   A trust score drops quietly; people aren't publicly flagged.
5. **External credentials can skip the placement task.** For example: state court or medical interpreter
   certification, translator association certification, a high-school Seal of Biliteracy (a strong path
   for Seattle-area students), college heritage-language coursework, or an official oral proficiency
   rating.
6. **Community vouching.** Partner organizations that serve a language community can vouch for volunteers
   they know. This is often the fastest route to Lead for scarce languages.

## 6. What to build next, in order

1. Trust tiers and the placement task. These replace "any localizer can approve" and close the
   fake-account gap.
2. Automatic screenshots for crawled pages (headless browser). Translators currently see "No screenshot
   for this text yet."
3. The urgent lane: a per-string priority flag, an on-call rota and push notifications.
4. Campaigns: per-organization, per-language goals with a deadline and a shared progress bar.
5. The in-page snippet and hosted preview from the adoption plan.
