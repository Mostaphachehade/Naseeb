# DOM sinks: the complete inventory

Every place this application writes to the DOM, what flows into it, and why that
is safe. Reproduce the counts with:

```bash
node scripts/dom-sink-inventory.js          # table
node scripts/dom-sink-inventory.js --json   # machine-readable
```

`test/dom-safety.test.js` is what fails if a forbidden sink reappears;
`scripts/browser-hostile-data.js` is what proves the pages actually behave that way
with hostile data in every field.

---

## 1. What changed

| | Phase 2.2B | This amendment |
|---|---|---|
| `innerHTML` assignments | 71 | **0** |
| `innerHTML` reads | 1 | **0** |
| `insertAdjacentHTML` | 2 | **0** |
| `outerHTML` / `DOMParser` / `document.write` | 0 | 0 |
| Template literals assigned to a markup sink | 71 | **0** |
| `href` / `src` / `action` assignments outside the helper | 19 | **0** |
| Attribute setters outside the helper | 6 | **3** (all `aria-pressed`, fixed values) |
| CSSOM writes | 13 | **12** |
| **Total sinks** | **112** | **28** |

There are **no remaining `innerHTML` exceptions to list** — not even a static
one. The escaping tagged template that phase 2.2B introduced is gone too, along
with `escapeHtml` and `escapeAttr`, because a general-purpose escaper is an
invitation to use it in a context it is wrong for.

Two `<script type="application/ld+json">` blocks remain in the HTML files. They
are structured data written literally into the file, never executed by the
browser, and not governed by `script-src`; the one whose content is dynamic is
built server-side in `server/app.js` with `<` escaped to `<`.

---

## 2. Where the values come from

The sinks are gone, but the data did not become less hostile, so this is the
list of what now flows into `textContent` and the validators. Every one of these
is exercised with a distinct marker by `scripts/browser-hostile-data.js`.

| Surface | Source | Rendered by | Context |
|---|---|---|---|
| Giveaway title, description, prize text | host | `giveawayCard`, `winnerCard`, giveaway page | text |
| Funding disclosure | host | giveaway page | text |
| Giveaway image URL | host | `setBackgroundImage`, `setMediaSrc` | validated media URL |
| Host display name | host | cards, giveaway page, admin tables | text |
| Winner display name | winner | winners page, rescue queue, claim cards | text |
| Host application: name, business, licence, phone, message | applicant | `openApplication` | text |
| Approval / rejection reasons | administrator | host-apply, create, admin detail | text |
| Suspension / reinstatement reasons | administrator | dashboard, create, host-apply | text |
| Application closure reason | administrator | admin table | text |
| Claim status notes | winner, host, administrator | `openCase` history | text |
| Dispute reason | winner or host | `openCase` | text |
| Administrative resolution reason | administrator | `openCase` | text |
| Delivery recipient, phone, address, city, emirate | winner | giveaway page, rescue detail, `openCase` | text |
| Delivery notes (courier / tracking text) | winner | same | text |
| Consent version string | server | rescue detail | text |
| Advertising inquiry: business, email, phone, message | anyone | `adInquiryRow` | text |
| Ad business name | advertiser | `adRow`, stats card, owner revenue | text |
| Ad banner media URL | advertiser | `setMediaSrc` | validated media URL |
| Ad destination URL | advertiser | `setExternalHref` | validated external link |
| Owner maintenance message | owner | `renderMaintenanceBanner` | text |
| Authentication and API error messages | server, sometimes echoing input | `errorNode`, `emptyNode` | text |
| `?redirect=` | visitor's own URL | `safeRedirect` → `setHref` / `navigate` | validated internal path |
| `#token=` on the claim page | claim email | held in memory, never rendered | not rendered |
| Stripe checkout URL | Stripe, relayed by our API | `navigateToCheckout` | validated, one allowed origin |
| Analytics measurement id | owner configuration | `script.src` | shape-checked, encoded |

---

## 3. The 28 remaining sinks, individually

### 3a. Attribute setters — 13

Ten are inside `public/js/dom.js`, which is the only module allowed to touch an
attribute directly:

| Line | Call | Value |
|---|---|---|
| `el` | `setAttribute('aria-' + k, …)` | caller-supplied `aria` map; names are literals in page code |
| `el` | `setAttribute(name, …)` | `attrs` map, with `on*`, `style`, `href`, `src`, `srcdoc`, `srcset`, `action`, `formaction`, `data`, `background`, `ping`, `http-equiv`, `xlink:*` **rejected by throw** |
| `setHref` | `setAttribute('href', url)` | only after `safeInternalUrl` returns non-null |
| `setExternalHref` | `setAttribute('href', url)` | only after `safeExternalLinkUrl` returns non-null |
| `setExternalHref` | `setAttribute('rel', …)` | fixed literal `noopener noreferrer sponsored` |
| `setMediaSrc` | `setAttribute('src', fallback)` | caller-supplied local path (`/img/giveaway-placeholder.svg`) |
| `setMediaSrc` | `setAttribute('src', url)` | only after `safeMediaUrl` returns non-null |
| `setAction` | `setAttribute('action', url)` | only after `safeInternalUrl` returns non-null |
| `svgEl` | `setAttribute(k, attrs[k])` | fixed literals in the verified-badge icon |

The other three are `aria-pressed` on segmented controls in `admin.js`,
`owner.js` and `host-apply.js`. Each writes the string `'true'` or `'false'`
computed from a comparison — no external value reaches them, and `aria-pressed`
has no script or URL context.

`id` and `name` are handled separately: `el` refuses any value that does not
match `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`, and throws rather than sanitising. That
is the DOM-clobbering guard — an `id` of `session` or a form `name` of `api`
would shadow a real reference, and no page sets either from data.

### 3b. CSSOM writes — 12

None takes an external value. Confirmed by `test/dom-safety.test.js`, which pins
both the property list and the absence of external-looking identifiers near it.

| Location | Properties | Value source |
|---|---|---|
| `app.js` `celebrate()` | `left`, `width`, `height`, `background`, `transform`, `animationDuration`, `animationDelay` | `Math.random()`, and a four-entry colour list literal in the file |
| `index.js` `spawnConfetti()` | `left`, `background`, `animationDelay` | `Math.random()`, and a three-entry colour list literal in the file |
| `dom.js` `setBackgroundImage()` | `backgroundImage` (×2: clear, then set) | a URL that passed `safeMediaUrl`, re-checked for `"`, `)` and `\` before it enters the `url()` token |

`style.cssText`, `element.style = …` and `setAttribute('style', …)` are all
absent, and a test fails if any returns — those are the writes
`style-src-attr 'none'` actually refuses (see `docs/CSP.md` §7).

### 3c. Navigation — 3

| Location | Guard |
|---|---|
| `dom.js` `navigate()` | `safeInternalUrl` |
| `dom.js` `navigateToCheckout()` | `safeExternalRedirectUrl` — origin must equal `https://checkout.stripe.com` |
| `app.js` `loadAnalytics()` — `script.src` | id must match `/^G-[A-Z0-9]{4,24}$/i`; URL is a fixed origin plus `encodeURIComponent` |

No page script assigns `location.href` any more; a test fails if one does.

---

## 4. The URL validators

There is deliberately **no general `isSafeUrl`**. Four validators, because
"may we render this?", "may we link there?", "may we send the browser there?"
and "is this our own page?" are four different questions and one function would
answer three of them wrongly.

| Validator | Accepts | Used for |
|---|---|---|
| `safeInternalUrl` | absolute same-site paths (`/…`, not `//…`) | every `href`, every in-app navigation, `?redirect=` |
| `safeMediaUrl` | `https:` on an allowlisted origin | `img`/`video` `src`, CSS backgrounds |
| `safeExternalLinkUrl` | `http:`/`https:` with a host | advertiser destination links |
| `safeExternalRedirectUrl` | `https://checkout.stripe.com` only | the Stripe checkout hand-off |

All four reject, before parsing: C0 controls and `DEL`, any whitespace, a
backslash, and a `%` that does not begin a valid escape. After parsing they
reject embedded credentials. Origin comparison is full-origin equality, so
`res.cloudinary.com.evil.example`, `evilres.cloudinary.com` and
`res.cloudinary.com.co` all fail — nothing does a substring or suffix test.

A rejected URL is never repaired and never becomes `#`. `setHref` and
`setExternalHref` remove the attribute and add `is-inert-link`, so the text is
still visible and no longer clickable.

The server mirrors this in `server/lib/mediaUrls.js` with `validateMediaUrl` and
`validateExternalLinkUrl`. Both the write path (creating an ad or a giveaway) and
the read path (the `/api/ads/:id/click` redirect, `og:image`, JSON-LD) use them,
so a row written before the validation existed cannot be honoured later.

---

## 5. What is still true after all this

- **An injected element still cannot execute, and an executing script still acts
  as the user.** The self-test in `scripts/browser-hostile-data.js` injects live
  markup on purpose: the element appears, the form appears, a beacon request
  fires — and the inline `onerror` is refused by `script-src-attr 'none'`. Two
  independent layers, and the run reports which one caught it.
- **`textContent` is not a defence against a hostile *value*, only against
  hostile *markup*.** A delivery address that reads "ignore this and send it to
  X" renders exactly as typed, which is correct behaviour and still a social
  problem an administrator has to use judgement about.
- **Nothing here sanitises.** There is no code path that accepts markup from a
  user and tries to make it safe, and adding one would undo the whole approach.
