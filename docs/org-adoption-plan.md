# Getting nonprofits to say yes: zero-friction adoption plan

**Goal:** a nonprofit says one "yes". After that they get their website (and later their flyers, forms and
devices) in Seattle's top languages, with no install, no logins and no maintenance. They can see the reach
it adds.

Seattle's top five non-English languages are Spanish, Chinese (Traditional for written material), Vietnamese,
Somali and Tagalog, per the City's 2023 Top Languages report. Our October 2026 scan of 80 Seattle nonprofits
found that none of the 73 we could check covers all five. About 38 had nothing in any of them. About 13 rely
only on a Google Translate–style widget. Somali and Tagalog were almost never covered by a person.

## 1. The core idea: do the work first, then ask

Asking an org to "adopt a localization platform" means meetings, IT and someone owning it. Instead:

1. **We pick the org from the scan.** We start where language access matters most: food, housing, health and
   crisis services.
2. **We crawl their public site** (read-only, like a search engine) and pull out the text of the pages that
   matter most: home, "get help", hours and locations, eligibility, contact.
3. **Volunteers translate those pages** through the existing queue and peer review, with automatic
   screenshots for context.
4. **We send one email with a working preview:** "Here is your *Get Food* page in Somali and Vietnamese,
   checked by 3 native-speaking volunteers. Reply *yes* and we'll make it live. It's free, and you never need
   to touch it."

The org's decision becomes "yes" or "no" to something that already exists. A "no" costs us volunteer time
on a few pages. That time still trains volunteers and grows translation memory.

## 2. Delivery: three levels of "almost nothing"

| Level | What the org does | What visitors get | Notes |
|---|---|---|---|
| **0. Hosted copy** | Nothing. Optionally link to it. | `orgname.nativeloc.org/so/…` shows their live pages with translated text | Works for any site, with no access needed. Forms and links pass through to the real site. We give them a QR-code poster for the front desk. Mark it `noindex` until they agree. |
| **1. One-line snippet** | Paste one `<script>` into the site header. We do it on a 10-minute call, or they forward us an editor invite. | A language switcher in native script (Soomaali, Tiếng Việt, 中文…) on their own domain | Uses the same published bundles devices already use. Step-by-step guides for WordPress, Squarespace, Wix and Webflow. |
| **2. Deeper integrations** | Opt in per item | Translated PDFs and flyers, intake forms, SMS templates, check-in kiosks and signage | Kiosks and signage already work today (Android, Linux and JS SDKs). |

**Zero maintenance is built into the design.** Strings are keyed by a hash of their English text. If the org
edits a page, the changed sentence no longer matches and shows in English. It never shows a stale
translation. Meanwhile the nightly recrawl puts the new sentence into the volunteer queue. Nothing breaks and
nobody at the org has to do anything.

## 3. Showing impact, with no login

- **Monthly one-page impact email** (and a private link to a live page). It shows:
  - visits per language
  - top translated pages
  - coverage per language ("*Get Food* is 100% in Somali")
  - volunteers who contributed and how many strings they checked
  - a before/after against our scan baseline

  Counts are aggregate only: no cookies and no IP storage.
- **Announcement kit:** "Now available in Soomaali" social cards, a printable poster with QR codes, and a
  short paragraph for their newsletter. Reach only happens if communities know it exists, so we also share
  through community and ethnic-media partners.
- **Per-page "Translated by community volunteers · report a problem" footer.** Reports go into the existing
  *Questions* inbox, so the org never handles them.

## 4. Trust, quality and safety

- **Consent first.** Nothing goes live without a recorded yes from a named contact. One click turns it off.
  Translations are exportable (XLIFF, .po, WordPress) with no lock-in.
- **High-stakes content** (crisis lines, medical, legal, eligibility rules) is tagged per string and requires
  a vetted reviewer, not just peer approval. This needs a per-key review setting; today it is per project.
- **Attribution and tone:** use the org's own glossary (program names stay in English), put context notes on
  key terms, and use translation memory across orgs so "food bank" reads the same everywhere.
- **Volunteer supply:** Somali and Tagalog are the scarce languages. Recruit through community orgs, UW and
  community-college heritage-language students (service-learning hours), and corporate volunteer days. Each
  volunteer sees their own impact ("your translations were read 1,240 times this month"). The volunteer
  sign-up link and peer review are built (see README).

## 5. How it maps onto the current architecture

| Need | Existing piece | New work |
|---|---|---|
| Strings in | Format adapters → ICU keys | **HTML adapter:** split pages into block-level segments. Inline links and bold become tag placeholders (shown as chips, like `{name}` today). Key = page path + hash of the normalized text. |
| Context | Screenshot boxes | **Crawler with a headless browser** (Playwright) that captures each page and the box of every segment automatically |
| Queue and review | Localizer queue, peer review | **Priority:** critical pages first, then by traffic |
| Change handling | "Outdated" on source change | **Nightly recrawl;** hash keys make edits fall back safely |
| Delivery | Versioned JSON bundles, ETag/304 | **Bundles split per page** (sites are larger than device string sets). **Browser snippet** that swaps text nodes (MutationObserver for JS-built pages). **Hosted proxy** for level 0. |
| Impact | — | **Aggregate view beacon,** monthly report job |

## 6. Phases

1. **Proof (first):** HTML adapter, crawler with screenshots, and a read-only `noindex` preview of the hosted
   copy. Translate the critical pages for 5 pilot orgs from the scan and send the one-email pitch.
2. **Live:** the snippet with language switcher, the impact beacon and monthly email, and the announcement
   kit.
3. **Hands-off:** nightly recrawl, priority queue, per-string high-stakes review, and "report a problem".
4. **Wider:** a search-indexable hosted copy with `hreflang`, a WordPress plugin, and PDF/DOCX and form
   translation.

## 7. Open questions

- **Hosting the copy legally and politely:** we need explicit permission before making a level-0 copy
  public. Also decide how to treat donation pages and forms that collect personal data (pass them through
  untranslated at first?).
- **Funding:** grants for immigrant and refugee language access, community foundations, and corporate
  volunteer-grant programs. Confirm which of the target orgs have public contracts with language-access
  requirements; that is a strong reason for them to say yes.
- **Machine pre-fill:** should volunteers start from a machine draft to go faster? The tradeoff is
  anchoring bias. If so, show it as a suggestion, never pre-filled into the box.
