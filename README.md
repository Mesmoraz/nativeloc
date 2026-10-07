# NativeLoc

Get your product text translated by **native speakers** and delivered to **Android and Linux
screen devices** (kiosks, panels, tablets, signage), without spreadsheets, file juggling, or
asking translators to learn format syntax.

- **Developers** push strings from their repos (`strings.xml`, gettext `.po`, JSON) with a CLI,
  the REST API, or a web upload. Devices can send screenshots, so every string has visual context.
- **Localizers** get one string at a time: the original, a screenshot with the string highlighted,
  a note, a length meter, placeholder chips, plural forms for their language, and suggestions
  from translation memory. The whole flow works from the keyboard.
- **Devices** pull one small JSON file per language from a cache-friendly URL and keep working
  offline.

## How it fits together

```mermaid
flowchart LR
  subgraph Sources
    A[Android strings.xml]
    L[Linux gettext .po]
    J[JSON / CMS]
    S[Device screenshots]
  end
  A & L & J -- "CLI / REST / upload<br/>(format adapters)" --> K
  S -- "SDK capture / CLI" --> K
  subgraph Server["NativeLoc server (Node + SQLite)"]
    K[(Keys → ICU source<br/>→ per-language translations)]
    Q[Localizer queue<br/>+ validation + TM]
    P[Publish → immutable<br/>versioned bundles]
    K --> Q --> K --> P
  end
  Q <--> W[Web app<br/>localizers · reviewers · admins]
  P -- "GET /b/{token}/{locale}.json<br/>ETag / 304" --> D1[Android SDK]
  P --> D2[Python SDK<br/>Qt · GTK · embedded]
  P --> D3[JS SDK<br/>Electron · Chromium kiosk · Node]
  P --> D4[Anything that fetches JSON]
```

**One model:** every string from any format becomes a *key* with an **ICU MessageFormat** source
message. Platform formats exist only at the edges, as adapters (`packages/core/src/adapters`).
Android `%1$s` becomes `{arg1}`, Android `<plurals>` and gettext `msgid_plural` become ICU plurals,
and the reverse happens on export. Devices only ever see:

```
GET /b/{bundleToken}/manifest.json   → { version, sourceLocale, locales: { es: { sha256, url, completeness } } }
GET /b/{bundleToken}/es.json         → { "checkout": "Pagar", "cart_items": "{arg1, plural, one {…} other {…}}" }
```

Untranslated keys fall back to the source text inside each bundle, so a device that downloads
one file always has every string.

## Run the demo

You need **Node 22.5 or newer** (`node -v`), because the server uses the built-in `node:sqlite`.

```bash
npm install
npm run demo
```

That one command seeds the demo data the first time you run it and starts three things:

| What | URL | What it is |
|---|---|---|
| Web app | http://localhost:5173 | Where translators work and admins manage projects |
| Kiosk simulator | http://localhost:5174 | A pretend store kiosk, standing in for a device in the field |
| API server | http://localhost:4600 | Used by both of the above |

### Try the full loop (about 2 minutes)

1. **See the device.** Open the kiosk at http://localhost:5174 and press **ES**. Some text is
   already in Spanish. The rest is still English because nobody has translated it yet.
2. **Give translators context.** On the kiosk, press **📷 Capture & upload**. The demo token is
   already filled in. This uploads a screenshot of the kiosk screen showing where each string appears.
3. **Translate.** Open http://localhost:5173 and pick **Lucas** under *Demo: sign in as…*.
   Under *FreshMart Kiosk · Español*, press **Start translating**. Each string comes with the
   screenshot from step 2, with that string highlighted. Type a translation and press
   **Save & next** (`Ctrl+Enter`). `Alt+1` inserts a placeholder such as the customer's name.
   Do a few.
4. **Approve.** New translations wait for review, even ones from a reviewer. Go back to the
   start page, press **Review** on the same card, and press **Approve & next** for each one.
5. **Publish.** Sign out, pick **Avery (admin)**, open *FreshMart Kiosk*, and press
   **Publish version 2** on the Overview tab.
6. **Watch it update.** Go back to the kiosk. Within 15 seconds it downloads the new version
   (the label next to the language buttons shows `bundle v2 · es`) and shows your translations.
   It doesn't need a reload. A publish with no text changes leaves the screen as it is.

To see the plain translator view, sign in as **María**. Sign in as **Yuki** to see Japanese.

### Try volunteer sign-up and peer review

The kiosk project has **peer review** turned on: a translation goes live once two volunteers
other than its author approve it. Reviewers like Lucas can still approve directly.

1. Sign out and open http://localhost:5173/join/demo-volunteers. Pick **Español**, enter any name,
   email and password, and press **Join & start translating**. You land on your languages, ready to go.
2. Translate a string on *FreshMart Kiosk*.
3. Sign out and sign in as **María**. *FreshMart Kiosk* now shows **Review (1)**. Approve it, and
   the footer shows it still needs one more volunteer. Your own work never shows up in your review queue.
4. A second volunteer's approval (or Lucas's) ships it. A peer who disagrees edits the text and presses
   **Submit my version**. That resubmits it under their name, and the approvals start over.

Admins make sign-up links under *Project → Team → Volunteer sign-up link* and set the number of
approvals under *Overview → Peer review*.

### Demo accounts

| Name | Email | Password | Role |
|---|---|---|---|
| Avery | admin@demo.test | demo-admin-pass | Admin (everything) |
| Lucas | lucas@demo.test | demo-reviewer-pass | Reviewer, Spanish and French |
| María | maria@demo.test | demo-localizer-pass | Localizer, Spanish |
| Yuki | yuki@demo.test | demo-localizer-pass | Localizer, Japanese |

Push token for the CLI and kiosk capture: `nl_demo_kiosk_push_token`.

### Other demos

- **Linux scale (Python SDK):** with `npm run demo` running, run
  `python examples/linux-demo/scale_demo.py es` (or `node --import tsx examples/linux-demo/scale_demo.mjs es` for the JS SDK).
- **CLI push:** `NATIVELOC_TOKEN=nl_demo_kiosk_push_token npx nativeloc push` from `examples/android`.

### Start over

```bash
npm run demo:reset
```

This deletes `data/` and seeds fresh demo data. Stop any running servers first, because Windows
won't delete the database while it's open. `npm run seed:reset` does the same thing without
starting the servers.

### Production

`docker compose up --build` (one container, data kept in a volume), or `npm start` (builds the
web app and serves it from the API server on :4600).

## The localizer experience

Everything in `apps/web/src/localizer/` aims to remove detail that isn't translation:

| Concern | How it's handled |
|---|---|
| Where is this text? | Device screenshot with the string highlighted; the rest of the screen is dimmed |
| What does it mean? | Context note from developers (taken from code comments automatically) |
| Placeholders | Shown as named chips ("name", "number"); `Alt+1…9` inserts; save is blocked if one is missing or misspelled |
| Plurals | Only the forms *their* language needs (Russian gets one/few/many), each labelled with example numbers. No ICU syntax |
| Fits on screen? | Live character meter from `max=N` hints in comments |
| Seen this before? | Translation-memory suggestions from approved strings; `Alt+Enter` applies the best one |
| Unsure? | `Ctrl+Shift+Enter` asks the team; the answer can be folded into the note for every language |
| Keys, files, formats | Hidden behind "Technical details" |

Keyboard: `Ctrl+Enter` save & next · `Ctrl+↓` skip · `Ctrl+↑` back · `Tab` next plural form.
Reviewers use the same screen with Approve / Save & approve / Send back.

Source changes mark translations **needs update** and show the old wording. Until someone
re-translates them, they keep shipping if they're still structurally valid.

## Getting strings in

**CLI** (`packages/cli`). Add a `nativeloc.config.json` to your repo
(see [examples/android](examples/android/nativeloc.config.json)):

```bash
export NATIVELOC_TOKEN=nl_…              # project → Devices & API → create "push" token
npx nativeloc push                        # upload source strings (comments → notes, max=N → limits)
npx nativeloc push --with-translations    # also import existing values-xx / xx.po
npx nativeloc screenshot shot.png --label "Cart" --keys cart_total,checkout
npx nativeloc publish
npx nativeloc pull                        # write approved translations into values-xx/ for offline builds
```

**REST.** `POST /api/v1/projects/:id/keys` with `Authorization: Bearer <push token>`:

```json
{ "entries": [{ "key": "checkout", "source": "Checkout", "description": "Cart button", "maxLength": 14 }] }
```

Add `"locale": "es"` to import existing translations; add `"prune": true` to archive keys
that are no longer sent.

**Web upload.** Project → *Import & export*.

**Screenshots.** Use the SDK capture helpers (exact boxes), the CLI, or upload and draw boxes in
*Screenshots*.

## Device SDKs

All three share one surface: `init` → `t(key, args)` → automatic refresh. Lookup order is
downloaded bundle → bundled/app fallback → source language → key, and `t` never throws.

| SDK | Path | Notes |
|---|---|---|
| JS / TS | [sdks/js](sdks/js) | `intl-messageformat`; `localStorage` or `fileStorage(dir)` cache; `captureContext()` |
| Python | [sdks/python/nativeloc.py](sdks/python/nativeloc.py) | One file, stdlib only, built-in ICU formatter and CLDR plural rules for common languages |
| Android | [sdks/android](sdks/android) | Kotlin, minSdk 24 (`android.icu.MessageFormat`); falls back to the app's own `res/values*`; `NativeLocCapture` for debug builds |

```kotlin
NativeLoc.init(context, "https://loc.example.com", "pb_…", locale = "es")
cartView.text = NativeLoc.t("cart_items", 3)
```

```python
loc = NativeLoc("https://loc.example.com", "pb_…", locale="es", cache_dir="/var/cache/app/loc")
label.set_text(loc.t("%d label printed", arg1=3))
```

## Project layout

```
packages/core     ICU validation, plural rules, editor model, format adapters (shared by everything)
packages/cli      nativeloc CLI
apps/server       Fastify + node:sqlite API, auth, queue, publish, device endpoints
apps/web          React app: localizer workspace + admin
sdks/{js,python,android}
examples/         sample strings.xml / .pot / JSON, web kiosk simulator, Linux demo
```

## Development

```bash
npm test          # core adapters, validation, server end-to-end, JS SDK
npm run typecheck
python -m unittest discover -s sdks/python
```

Roles: **admin** (everything), **reviewer** (translate + approve, assigned languages),
**localizer** (translate assigned languages, and review each other's work on projects with peer review on).
Admins invite people one at a time with an invite link, or share a reusable **volunteer sign-up link**:
anyone with it picks a language from the link's list and joins as a localizer.

### Not in this MVP

Machine-translation suggestions (the queue's suggestion list is the place to add a provider),
Postgres (the SQL is plain; `apps/server/src/db.ts` is the only storage module), SSO, webhooks
on publish, and iOS/Qt `.ts`/XLIFF adapters.
