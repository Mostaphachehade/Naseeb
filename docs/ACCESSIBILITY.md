# Accessibility

Target: **WCAG 2.2 AA**. Status: **not conformant, and not claimed to be.**

This document records what was measured, what was fixed, and — at least as
importantly — what was *not* verified and why. A green CI job is the easiest
thing in the world to mistake for a conformance statement, so the limits are
stated first.

---

## What the automated job proves, and what it does not

`npm run test:accessibility` runs axe-core over all 23 pages at two viewports —
1280×900 and 390×844 — with authenticated pages visited authenticated. It is a
required CI job and it currently reports:

```
46 page-viewport pairs, 0 serious/critical, 0 moderate/minor
```

**That is a floor, not conformance.** axe-core covers roughly a third of the WCAG
success criteria, and it is the mechanical third: a missing label, a contrast
ratio, a duplicated id, an ARIA attribute that cannot be where it is. It cannot
tell you whether the focus order makes sense, whether an error message helps,
whether a live region announces at a useful moment, or whether a keyboard user
can actually finish entering a giveaway.

Anyone quoting the green tick as "WCAG 2.2 AA compliant" would be overstating it.

### What the job does that is worth knowing

- **Authenticated pages are visited authenticated.** A page that redirects when
  signed out is a redirect, not an accessibility result.
- **`giveaway.html` is visited with a real published campaign**, seeded through
  the submit-then-approve API. It was previously swept with no `?id=`, so it
  rendered its "no such giveaway" error state and reported zero violations —
  measuring the wrong page and calling the result coverage.
- **The mobile pass runs with `prefers-reduced-motion: reduce`**, so the confetti
  and the promotional specks are exercised in both states.
- **Console and page errors are captured.** A page that throws is not accessible
  whatever its markup looks like.
- **axe is injected via `addInitScript`, not `addScriptTag`.** The site's CSP
  (`script-src 'self'`) correctly refuses an injected `<script>`; the policy was
  not relaxed to let a test tool in.

---

## Fixed in this phase

Every one of these was live on production.

| Issue | Was | Now |
| --- | --- | --- |
| "Send inquiry" button, `advertise.html` | `#F7F3EA` on `#FFFFFF` — **1.11:1** | `.btn.ghost.on-light`, ink |
| Hero paragraph, `index.html` | `--text-soft` on `--ink` — **2.2:1** | `.on-dark-soft` — 8.9:1 |
| "LAUNCHING SOON" badge, `index.html` | `--gold` on `--paper` — **2.17:1** | `--gold-deep` — 5.4:1 |
| `applications-search`, `hosts-search`, `ad_image_url` | placeholder only | real `<label>` |
| Verified-badge checkboxes (per row) | no accessible name | named per row |

Two of the three contrast failures were introduced by the mechanical
inline-style extraction documented in `docs/CSP.md`: it moved colours between
light and dark contexts without re-checking the background behind them. The
third, `--gold` as small text, had simply never been checked.

**The invisible button is the one to dwell on.** `advertise.html`'s primary
action — the only conversion path on that page — rendered near-white on white
and had done since launch. Nothing in the test suite could have caught it,
because nothing was looking at rendered colour.

### Design constraints respected

`--gold` itself was **not** changed. As a border, a rule and an accent on the
dark hero it is correct, and contrast is not the question being asked there.
Only gold used as small text on a light surface needed to be darker, so only that
case changed. `.visually-hidden` uses `clip-path`, not `display: none`, which
would remove the label from the accessibility tree and defeat its purpose. **No
page changed visually except the three that were unreadable.**

---

## Not verified

This is the section to read before trusting anything above.

- [ ] **No screen reader was used.** No NVDA, JAWS, VoiceOver or Orca run
      happened. Accessible *names* were checked programmatically; how any of it
      actually *sounds* — announcement order, verbosity, whether a live region
      interrupts usefully or maddeningly — is unknown.
- [ ] **No manual keyboard walkthrough of the full journeys.** The development
      machine has no PostgreSQL, so the application cannot be run locally and
      driven by hand; all evidence comes from CI. Tab order, focus visibility in
      motion, focus restoration after a dialog closes, and keyboard traps are
      therefore **unverified**, not verified-and-passing.
- [ ] **Zoom and reflow at 200% and 400%** (WCAG 1.4.4, 1.4.10) not tested. The
      390×844 viewport approximates the reflow condition; it is not the same
      test.
- [ ] **Touch-target size** (WCAG 2.5.8) not measured.
- [ ] **Focus appearance** (WCAG 2.4.11, new in 2.2) not assessed. A
      `:focus-visible` gold ring exists sitewide; whether it meets the 2.2
      contrast-and-area requirement against every background it lands on has not
      been checked.
- [ ] **Session-expiry communication** (WCAG 2.2.1, 2.2.6) not assessed.
- [ ] **Error-summary and focus-movement after a failed submission** not
      assessed. `aria-live` regions were counted, not exercised.
- [ ] **The axe sweep still runs in English only.** Arabic now covers all 23
      pages and has a browser sweep of its own — CI job `arabic-rtl`, 92
      page/language/viewport combinations — but that suite checks direction,
      language leakage, overflow and console errors, **not accessibility**. axe
      has never been run against an RTL rendering, so RTL-specific failures
      (reading order announced by a screen reader, focus order across a flipped
      layout, a `dir` mismatch between an element and its content) are
      unverified. See `docs/ARABIC_RTL.md`.
- [ ] **Accessible names in Arabic** not checked. `data-i18n-attr` translates
      `aria-label`, `title` and `alt`, and `i18n1`/`i18n3` prove those entries
      exist and contain Arabic script. Whether they *read* as sensible accessible
      names to an Arabic screen-reader user is a native-review question.
- [ ] **One responsive defect is known and unfixed.** `create.html` at 390px
      overflows horizontally by 7px, in English as well as Arabic, and no single
      element is wider than the viewport — so it comes from a margin, a negative
      offset or a transform. It is reported by the `arabic-rtl` job on every run
      rather than suppressed. WCAG 1.4.10 requires content to reflow without
      horizontal scrolling at 320px CSS width; this is a smaller failure than
      that threshold tests for, but it is the same class of defect and it is
      real.

**A screen-reader pass and a manual keyboard walkthrough are prerequisites for
public launch, and neither has happened.** They are listed as owner actions in
`docs/LAUNCH_READINESS.md`.

---

## Incomplete results, and what each one turned out to be

axe returned **12 incomplete `color-contrast` results, 22 nodes across 6 pages**.
"Incomplete" means axe could not decide. It is not a pass, and reporting it as
one would be the quiet kind of dishonesty, so each was measured by hand against
the live site.

| axe's reason | Elements | Measured | Verdict |
| --- | --- | --- | --- |
| "partially obscured by another element" | `#inq_message`, `#request-message`, `#prize_restrictions`, `#description` | **14.62:1** | Passes. The elements sit below the fold, and `elementFromPoint` returns null off-viewport — axe reads that as occlusion. |
| "due to a background gradient" | `.num` (homepage stat tiles) | **12.88:1** | Passes. A gradient in the ancestry defeats axe's background walk; the effective background is solid `rgb(220,238,231)`. |
| "due to a pseudo element" | same family | — | Same cause as the gradient case: decorative `::before`/`::after` in the ancestry. |

None was a real failure. They remain reported rather than suppressed, because
the *reason* axe cannot decide can change when the markup does.

### What the incomplete results led to, which axe never checked

Measuring those by hand surfaced a genuine defect the tool cannot see:

**Placeholder text was `#757575` on `--paper` — 4.16:1, against 4.5:1 required
at 15.2px. Every placeholder on the site failed.** That is the browser default,
inherited because nothing styled `::placeholder`, and **axe does not evaluate
`::placeholder` at all**. Fixed by setting `--text-soft` (6.38:1), which keeps
placeholders visibly secondary to typed input without being unreadable.

This is the clearest illustration in this document of why the green job is a
floor: a site-wide contrast failure on every form on every page, invisible to
the automated sweep, found only by measuring the rendered page.

## Known non-defects

The sweep reports 92 console errors, 46 of each of two kinds, on every page.
**Both are axe-core's own instrumentation, not site defects:**

- axe fetches cross-origin stylesheets to compute contrast, which `connect-src`
  refuses;
- axe applies inline styles, which `style-src-attr 'none'` refuses.

Production serves zero console errors — verified directly against
`https://www.mynaseeb.ae`. Both refusals are the CSP doing its job.

---

## Running it

```
npm run test:accessibility
```

Needs an isolated test database and a Chromium (`npx playwright install
chromium`). Refuses to run against anything that is not a test database, via the
same guard as the rest of the suite.
