# Content Security Policy and XSS hardening

CSP is **enforced**, not report-only, and there is no configuration that turns it
off. This document is the whole policy: what it allows, why each external origin
is there, what is left in the DOM and why it is safe, and what is still open.

---

## 1. What it replaced

`server/app.js` carried this for the life of the project:

```js
// CSP is left off: every page here uses inline <script>/<style> and loads
// images from arbitrary host-provided URLs (prizes, ad banners), so a
// default-restrictive CSP would break the app rather than harden it.
app.use(helmet({ contentSecurityPolicy: false }));
```

Accurate, and not a reason. This phase removed the obstacles instead of the
ambition.

| | Before | After |
|---|---|---|
| Inline `<script>` blocks | 20 | **0** |
| Inline `<style>` blocks | 3 | **0** |
| `style=""` attributes (markup) | 317 | **0** |
| `setAttribute('style', …)` calls | 0 | 0 |
| `element.style` writes in JS | 82 | **12** (three effects with runtime values) |
| Inline event handlers (`onclick=`) | 0 | 0 |
| `javascript:` URLs | 0 | 0 |
| `eval` / `new Function` / string timers / `document.write` | 0 | 0 |
| Image origins accepted | any `http(s)` URL | an allowlist of 1 |
| CSP | none | enforced, no `unsafe-inline`, no `unsafe-eval` |

The 317 style attributes are the row that mattered — they are what the policy
actually refuses. They collapsed to **104 utility classes** (many were
duplicates), plus one `.is-hidden` class that replaced every
`element.style.display` toggle.

The `element.style` row is housekeeping, not enforcement: those writes were never
blocked, and the 13 that remain are the three places where the value is computed
at runtime (a validated background image, and the two confetti effects). §7
explains how that row came to be misunderstood, and `docs/DOM_SINKS.md` lists
every one of the twelve with its value source.

---

## 2. The measured policy

```
default-src 'self';
script-src 'self';
script-src-attr 'none';
style-src 'self' https://fonts.googleapis.com;
style-src-attr 'none';
font-src 'self' https://fonts.gstatic.com;
img-src 'self' https://res.cloudinary.com;
media-src 'self' https://res.cloudinary.com;
connect-src 'self' https://api.cloudinary.com;
object-src 'none';
frame-src 'none';
child-src 'none';
worker-src 'none';
manifest-src 'self';
base-uri 'none';
frame-ancestors 'none';
form-action 'self'
```

Production adds `upgrade-insecure-requests`. It is omitted locally, where the app
is served over http and upgrading every request would break development outright.

### Every external origin, and why

| Origin | Directive | Why |
|---|---|---|
| `https://fonts.googleapis.com` | `style-src` | The `@import` at the top of `public/css/style.css` fetches the Google Fonts stylesheet. |
| `https://fonts.gstatic.com` | `font-src` | That stylesheet references its font files from here. A separate origin doing a separate job, so a separate directive. |
| `https://res.cloudinary.com` | `img-src`, `media-src` | Where uploaded prize photos and ad banners are served from. Same allowlist the server validates stored URLs against — see §5. |
| `https://api.cloudinary.com` | `connect-src` | The unsigned upload endpoint the create, advertise and owner pages POST to. |
| `https://www.googletagmanager.com` | `script-src`, `connect-src`, `img-src` | Google Analytics — **only when `GA_MEASUREMENT_ID` is set**, and never on the claim, admin or owner pages. |
| `https://www.google-analytics.com`, `https://analytics.google.com` | `connect-src`, `img-src` | Where gtag.js sends its measurements. Same condition. |

No wildcards, no bare schemes, no whole domain admitted because one asset under
it might be used. An origin allowed "in case somebody turns analytics on later"
is an origin allowed for no reason on every deployment that never does — so the
analytics origins are absent unless the variable is configured, and a test
asserts both states.

### `base-uri 'none'`, not `'self'`

There is no `<base>` tag anywhere on the site, so nothing needs one. An injected
`<base href="https://evil.example/">` repoints every relative URL on the page,
including the script tags — `'none'` closes that outright.

### Sensitive pages take no third-party script at all

`/claim.html`, `/admin.html` and `/owner.html` get `script-src 'self'` whatever
the configuration. `public/js/app.js` already declined to initialise analytics on
them; this makes it a rule the browser enforces rather than a decision our own
script makes about itself. The claim page in particular handles a single-use
credential arriving in a URL fragment.

---

## 3. The other headers

| Header | Value | Note |
|---|---|---|
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Origin but not path to other sites; nothing at all on a downgrade. |
| `X-Content-Type-Options` | `nosniff` | |
| `X-Frame-Options` | `DENY` | Says the same as `frame-ancestors 'none'` for older browsers. The two agree, so they cannot contradict. |
| `Permissions-Policy` | 10 features denied | None is used, so an injected script cannot start using one. |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | `same-origin` would break a Stripe Checkout popup flow, which is the documented alternative to today's redirect. |
| `Cross-Origin-Resource-Policy` | `cross-origin` | **Deliberate.** `same-origin` would stop WhatsApp and social crawlers fetching giveaway images, breaking every link preview the platform depends on. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | **Production only.** A browser that receives HSTS from `http://localhost` refuses http on localhost afterwards, for every project on that machine. |

All of them are set by one middleware mounted **before every route**, so they are
on API JSON, API errors, the 404 page, the 500 handler and the dynamically
rendered giveaway page. helmet is still present for the headers this module does
not set, with its own versions of these switched off so there is exactly one
source per header.

---

## 4. DOM sinks

This section used to describe 72 surviving `innerHTML` sites and the escaping
tagged template that guarded them. The DOM-safety amendment removed all of them:
nothing in `public/js` builds markup at runtime any more, the escaper is gone,
and every URL goes through a validator chosen for the context it is going into.

The complete inventory, with the source of every value and the reason each of
the 28 remaining sinks is safe, is **`docs/DOM_SINKS.md`**. Reproduce its counts
with `node scripts/dom-sink-inventory.js`.

What matters for the policy specifically: `style-src-attr 'none'` refuses the
style *attribute*, and the one CSSOM write that takes a URL —
`setBackgroundImage` in `dom.js` — validates against the media allowlist and
re-checks for `"`, `)` and `\` before the value reaches a CSS `url()` token.

---

## 5. Media origin policy

`server/lib/mediaUrls.js` is the authority, and `img-src`/`media-src` are built
from the same list, so **a URL that can be stored is a URL that can be displayed,
and nothing else can.**

Accepted: `https` only, on an origin in the allowlist, with no embedded
credentials, no control characters, no protocol-relative form, and under 2048
characters. Rejected — with evidence in `test/csp.test.js`:

`javascript:` · `JaVaScRiPt:` · `java\tscript:` (control-character bypass) ·
`vbscript:` · `data:image/svg+xml,<svg onload=…>` · `data:text/html,…` ·
`//res.cloudinary.com/x.png` · `http://res.cloudinary.com/x.png` ·
`https://res.cloudinary.com@evil.example/x.png` · `https://user:pass@…` ·
`file:///etc/passwd` · a URL with an embedded newline · `not a url`

Lookalikes are rejected because the comparison is on `URL.origin`, so there is no
substring match to exploit: `res.cloudinary.com.evil.example`,
`res-cloudinary.com`, `rescloudinary.com`, `evil.example/res.cloudinary.com/…`
and a punycode homograph all fail.

**Rows written before this validation existed are not rewritten** — they are the
record of what a host actually submitted. The read path asks
`isRenderableMediaUrl` and hands the browser `null` instead, so the page shows
its no-image state. Such a URL is never turned into a clickable link either: that
is the same problem one step removed.

`MEDIA_ORIGIN_ALLOWLIST` (comma-separated full origins) adds to the default.
Origins, not domains: `cloudinary.com` would admit anything anybody could get
onto any subdomain of it.

---

## 6. Adding an asset without weakening the policy

1. **A script** → put it in `public/js/` or `public/js/pages/` and add a
   `<script src>`. Never an inline block; `test/csp.test.js` fails on one.
2. **A style** → add a named class to `public/css/style.css`. Not `style=""`, and
   not a new `u-…` utility: those exist to retire inline styles, not to become a
   framework.
3. **Showing or hiding something** → `classList.toggle('is-hidden', …)`. Not
   `element.style.display`; see §7.
4. **An image or video** → it must be served from an allowlisted origin. Upload
   it through Cloudinary like everything else, or add the origin to
   `MEDIA_ORIGIN_ALLOWLIST` *and* say here why it is trusted. The CSP follows
   automatically — the directive is built from the same list.
5. **A third-party script or API** → it needs a new origin in `script-src` or
   `connect-src` in `server/lib/securityHeaders.js`, a row in the table in §2,
   and a reason. If it only matters on some pages, gate it the way analytics is.

---

## 7. What `style-src-attr 'none'` actually blocks

The first browser run under this policy produced **105 "Refused to apply inline
style" violations**. I attributed them to `element.style` writes and migrated all
82 of them to classes. That attribution was wrong, and the mistake had a cost, so
here is the measurement rather than the assumption.

A page served under `style-src 'self'; style-src-attr 'none'`, doing one write of
each kind, then reading back the computed style:

| Write | Applied? | Violation |
|---|---|---|
| `el.style.backgroundImage = 'url("…")'` | yes | none |
| `el.style.display = 'none'` | yes | none |
| `el.style.cssText = 'color: red'` | yes | none |
| `el.setAttribute('style', 'color: blue')` | **no** | 1 |

Only the last one is refused. `style-src-attr` governs the style **content
attribute** — in parsed markup, and through `setAttribute` — and not property
assignments on `element.style`. The 105 violations came from the 317 `style=""`
attributes still in the markup when that run happened; converting those is what
fixed it.

Two consequences:

- **The class migration was not required by the policy.** It is kept anyway —
  a named class beats a style string at 82 call sites — but it is a housekeeping
  change, not a security control, and the document should not have claimed
  otherwise.
- **Two effects were degraded for no reason and have been restored.** The
  celebration confetti had been reduced from sixty randomly placed pieces to ten
  fixed columns, and the homepage promo specks from random positions to eight
  variants. Both are back to per-piece randomness through CSSOM writes. The
  promo specks were also *broken* by that change — the variant classes were
  written as `.spark.vN` while the elements carried `promo-speck`, so the specks
  rendered with no colour or position at all. The CSP run did not catch it,
  because a silently unstyled element violates nothing.

The rule to follow, stated exactly: **no `style` attribute in markup, and no
`setAttribute('style', …)`.** `element.style.property = value` is fine, and is
the right tool when the value is computed at runtime.

---

## 8. Verification

Headless Chromium against a real local server on the isolated test database,
with a fabricated XSS payload in every text field of a real giveaway and in the
host's display name. Signed-in pages are reached with a real session cookie
minted for a fabricated host and a fabricated administrator.

Each page reports three things: every `securitypolicyviolation` event the page
itself observed, every `error` and `unhandledrejection`, and whether the payload
came back as live markup. The browser's own stderr is grepped for refusals in
parallel, so a violation has to evade both to go unnoticed.

- **21 pages** — home, giveaway (payload-laden), winners, pricing, about,
  advertise (checkout disabled), partners, terms, privacy, login, signup, forgot
  password, reset password, verify, 404, dashboard, create as an approved host,
  host application, claim by fragment token, admin review, owner settings.
- **21/21 clean: 0 CSP violations, 0 JavaScript errors.**
- **0 pages where the payload rendered as live markup.**

Desktop (1280×900) and mobile (390×844) both render; all three stylesheets load
under the policy (214 + 121 + 30 rules) and the Google font resolves.

Two real bugs surfaced this way, neither of them CSP violations:

- A top-level `await` in the giveaway page's script, added during Phase 2.2A —
  a syntax error in an inline classic script too. Nothing had ever loaded that
  page in a browser to notice.
- The homepage promo specks rendering unstyled, described in §7. Worth stating
  plainly: **a clean CSP run is not a rendering check.** An element that silently
  loses its colour and position violates nothing, so it took reading computed
  styles in the browser to find, not counting violations.

---

## 9. Limitations

- **An injected script can still act as the user within their session.** CSP
  makes injection much harder to achieve; it does not make a successful one
  harmless. The session cookie is `HttpOnly` (Phase 2.2A), so what an injected
  script cannot do is steal a durable credential — but it can still read the
  in-memory CSRF token and make requests as the signed-in person.
- **`style-src` allows `https://fonts.googleapis.com`**, which serves CSS. A
  compromise of Google Fonts could deliver hostile CSS. Self-hosting the fonts
  would remove both font origins; it was not done in this phase.
- **`innerHTML` remains** at 72 sites. Escaped, tested and guarded, but the
  guarantee is "every interpolation is escaped" rather than "no HTML is built
  from strings".
- **The utility classes are machine-named** (`u-<hash>`). They preserve the
  design exactly and deduplicate, but they are not a design system, and reading
  `class="btn primary u-a4f3c0c1"` tells you nothing about what the second class
  does.
- **`style-src-attr 'none'` will block any future CSSOM style write**, including
  a legitimate one for something genuinely dynamic. Reach for a class or a CSS
  custom property defined in a stylesheet instead.
- **No CSP reporting endpoint.** Violations appear in browser consoles and
  nowhere else, so a violation in production is invisible unless somebody looks.
  A `report-to` endpoint is worth adding later — it does not weaken anything.
