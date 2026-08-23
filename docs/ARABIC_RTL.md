# Arabic and right-to-left

> **The Arabic on this site is machine-drafted and has not been reviewed by a
> native speaker.** Every dictionary file says so in its own header. It is
> committed so it can be reviewed, not because it is finished. Nothing in this
> document should be read as a claim that the Arabic is correct — only that it is
> present, complete, consistent, and tested for the failures that are testable
> without a reader.

---

## 1. What is covered

All 23 pages render in Arabic: markup, page scripts, metadata, and the messages
the server sends back when something is refused.

| Surface | How it is translated |
|---|---|
| Static page copy | `data-i18n` on the element; `applyI18n()` sets `textContent` |
| Multi-line headings | `data-i18n-lines`, which builds the `<br>` rather than parsing one out of a string |
| Attributes a person reads | `data-i18n-attr="placeholder:key; aria-label:key"`, restricted to `placeholder`, `aria-label`, `title`, `alt` |
| `<title>` | `data-i18n` on the element |
| `<meta name="description">` | `data-i18n-content` |
| Text built by page scripts | `t('key')` and `t('key', { vars })` |
| Server refusals | `public/js/i18n/errors.js`, looked up by `api()` |
| Values inside sentences | `isolate()` — see §4 |

### Dictionaries

`public/js/i18n.js` holds the shared vocabulary — navigation, footer, the
browse → view → enter → winner journey, and the `common.*` words that appear on
many pages. Everything else lives in a per-page file under `public/js/i18n/`,
registered with `register({ en, ar })`:

| File | Prefixes |
|---|---|
| `home.js` | `home.` |
| `public-pages.js` | `about.` |
| `pricing.js` | `pricing.` |
| `partners.js` | `partners.` |
| `host-advertise.js` | `advertise.`, `hostapply.` |
| `create.js` | `create.` |
| `member.js` | `account.`, `claim.`, `dashboard.` |
| `auth.js` | `404.`, `auth.`, `forgotpassword.`, `login.`, `resetpassword.`, `signup.`, `verify.`, `verifyemailchange.` |
| `admin.js` | `admin.`, `owner.` |
| `terms.js` | `terms.` |
| `privacy.js` | `privacy.` |
| `errors.js` | `errors.` |

---

## 2. What is **not** covered

Stated plainly, because a list of what works is not evidence of correctness.

- **No native review.** Modern Standard Arabic drafted by machine. Register,
  idiom, and whether the terminology reads naturally to a UAE audience are all
  unverified.
- **No legal review of the Arabic.** `terms.js` and `privacy.js` translate
  documents that are themselves unreviewed drafts with no effective date. They
  are a draft of a draft. See `docs/UAE_COUNSEL_REVIEW.md`.
- **The word for "giveaway" is an open question.** The dictionaries use
  **مسابقة** throughout, because it is the ordinary marketing term and because
  using one word consistently matters more than using the best word
  inconsistently. It also carries a sense of *contest*, which is precisely what
  this platform is not: entry is free and the winner is drawn at random. Whether
  **سحب** (draw) or a phrase like **سحب مجاني** would be both more accurate and
  more natural is a question for native review, and possibly for counsel.
- **Numerals.** Arabic-Indic digits (٠١٢٣) are used in translated prose;
  Latin digits appear wherever a value comes from the database or from
  `toLocaleDateString`. That is a deliberate split — a ticket number, a price and
  a version identifier are values, not prose — but it has not been checked
  against what a UAE reader expects.
- **No RTL screen-reader testing.** Announcement order in an RTL context, and
  how a screen reader handles the isolate characters in §4, are unverified.
  Listed as a public-launch blocker in `docs/ACCESSIBILITY.md`.
- **Server-side rendering is English.** The language is chosen in the browser, so
  the HTML served is always English until a script runs. Consequences for
  indexing are in `docs/SEO.md` §5.

---

## 3. Deliberately untranslated

Some entries are identical in both dictionaries on purpose. Each one is listed
explicitly in `INTENTIONALLY_UNTRANSLATED` in `test/i18n-parity.test.js` with its
reason, and `i18n2b` fails if an entry is later translated or removed — an
allowlist that outlives its entries is how an exception becomes a hole.

| Key | Why it stays in Latin script |
|---|---|
| `advertise.https`, `create.https`, `owner.https`, `admin.https` | A URL shape shown as a hint in a web-address field. "https" in Arabic script is a worse hint. |
| `advertise.httpsYourBusinessSite`, `admin.httpsTheAdvertiserS` | Example web addresses. Addresses are typed in Latin script; a translated example is not typeable. |
| `terms.202608172`, `privacy.202608151` | Machine-readable policy version identifiers. Translating one breaks the version it names. |
| `privacy.render`, `privacy.resend`, `privacy.stripe`, `privacy.cloudinary`, `privacy.googleAnalytics`, `privacy.sentry` | Provider trade names. Transliterating a company makes it harder to look up, not easier. |
| `admin.actionForAccount` | Two placeholders and a dash. There are no words in it — the action and the account name are each substituted at render time, and each is translated or isolated on its own. |

The browser sweep has a second, separate list for the same reason: words that
appear *inside* an otherwise Arabic sentence and are meant to. It lives in
`scripts/browser-arabic-rtl.js` and covers the brand, provider names, `AED`,
URL fragments, and the technical identifiers `bcrypt`, `IPv4`/`IPv6`, `Signals`
(from Google Signals) and the repository path `docs/HOST_ACCESS.md` quoted in
`owner.html`. Both lists are explicit alternations rather than loose patterns,
because anything general enough to cover them would also excuse a real
untranslated sentence.

**One element, not a key.** The age declaration on the account page is shown in
English deliberately and marked `data-lang-exempt="attestation-wording"`. It is
not a dictionary entry at all: `server/lib/eligibility.js` records *which version
of an exact sentence* a person agreed to, so rendering an Arabic sentence while
recording the English version would put a consent in the audit trail that nobody
read. The browser sweep excludes it by that marker rather than by adding
"confirm", "age" and "verification" to its ignore list, which would excuse those
words on every page instead of on this one element. What an Arabic declaration
would need — its own version identifier, a language recorded alongside it, and a
decision on which governs — is `docs/UAE_COUNSEL_REVIEW.md` B19.

**The brand itself.** `Naseeb` appears untranslated in the header link on every
page and is allowlisted in `i18n8` as `UNTRANSLATED_TEXT`. A transliteration
would be a second name for the same product.

---

## 4. Bidirectional isolation

`isolate(value)` wraps a value in U+2068 FIRST STRONG ISOLATE and U+2069 POP
DIRECTIONAL ISOLATE, after stripping any isolate, embedding or override
characters already inside it.

**Why wrapping.** An email address, a URL, a ticket reference or a price dropped
into an Arabic sentence is a run of left-to-right characters inside a
right-to-left paragraph. The Unicode bidi algorithm resolves the punctuation
around it by context, so `Contact ops@example.com.` renders with the full stop
leading: `.ops@example.com`. The address still reads correctly; the sentence does
not.

**Why stripping.** A value that carries its own U+202E RIGHT-TO-LEFT OVERRIDE, or
opens an isolate it never closes, reorders everything after it. A display name is
attacker-controlled. One hostile name in a list of winners could scramble every
line below it.

Applied to values, never to translated copy: the copy already has a direction,
the value is what does not.

Covered by `i18n7` (the function strips both the U+2066–U+2069 and U+202A–U+202E
ranges and wraps in FSI/PDI) and by the browser sweep, which runs a payload of
`RLO evil PDF ⁦spoof⁩ RLM` through the real helper rather than a
reimplementation of it.

---

## 5. Layout

Direction comes from `document.documentElement.dir`, set by `applyI18n()`.
Everything that depends on it uses CSS logical properties — `text-align: start`,
`margin-inline-start`, `border-inline-start` — which flip on their own. The one
remaining `[dir="rtl"]` override, on `.verified-badge`, was deleted when its
physical property became a logical one: an override that has become a no-op is
worse than no override, because it looks like the RTL case is handled somewhere.

---

## 6. The language switch, and the language URL

**The switch does not navigate.** `setLang()` validates against the two languages,
writes `localStorage`, and calls `location.reload()`. It never assigns
`location.href`, never reads a `redirect`, `next` or `returnTo` parameter, and
`i18n6` fails if any of that changes. A language switch that can be handed a URL
is an open redirect wearing a different hat.

**`?lang=ar` is an address, not a navigation.** Without it Arabic had no URL at
all: a page rendered in whichever language that browser last chose, so an Arabic
page could not be linked, shared, or offered to a crawler as an alternate. The
parameter is compared against a two-element list and used only as a dictionary
key; `i18n9` asserts it never reaches `location`, `innerHTML` or `window.open`,
and that the list holds exactly `['en', 'ar']`. A valid value is persisted, so a
shared Arabic link does not revert to English on the second page.

The switch still leaves the URL untouched. The two mechanisms are independent:
one makes a language addressable, the other changes a preference.

---

## 7. How this is tested

### Without a browser — `test/i18n-parity.test.js`

| | What it proves |
|---|---|
| `i18n1` | Every English key has an Arabic counterpart and vice versa |
| `i18n2` | No Arabic entry is left as its English source, except the documented allowlist |
| `i18n2b` | Every allowlisted key still exists and is still untranslated |
| `i18n3` | Every Arabic entry contains Arabic script |
| `i18n4` | The fallback text in the HTML matches the English dictionary |
| `i18n5` | `data-i18n-attr` can only write attributes a person reads |
| `i18n6` | The language switch cannot navigate |
| `i18n7` | Bidi isolation strips embedded control characters |
| `i18n8` | No page carries visible text that no dictionary can reach |
| `i18n9` | The language URL parameter is a dictionary key and nothing else |

`i18n8` is the one that matters. Every other test compares dictionary against
dictionary, and all of them passed while fifteen Arabic pages rendered English
paragraphs — because a sentence with no `data-i18n` is not a key, and a key is
the only thing they can see. 132 text nodes were in that state. Most were not
whole paragraphs but the *second half* of a sentence whose `<strong>` lead-in was
tagged and whose body was not, which is the shape that survives a careful reading
of the file.

`i18n8` walks the markup with an element stack. That detail is load-bearing: text
following a closing tag belongs to the element that contains it, and the first
version of the check attributed it to the preceding tag and therefore missed most
of the 132.

### Server refusals — `test/server-error-i18n.test.js`

Reads every error literal out of `server/` and fails when one has no entry in
`errors.js`. Writing it immediately found thirteen that a grep over the same
directory had missed, in double-quoted and backtick literals. `se2` checks the
opposite direction: an entry left behind after its message was reworded
translates nothing while making the file look complete.

### In a real browser — `scripts/browser-arabic-rtl.js`, CI job `arabic-rtl`

Every page × {English, Arabic} × {desktop 1280×900, mobile 390×844} — 92
combinations. Per combination it asserts `lang` and `dir` on the root element,
zero Latin runs in Arabic body text past the allowlist, no horizontal overflow,
and no console errors. Overflow findings name the offending element and how many
pixels it sticks out by, because "scrollWidth 397 > clientWidth 390" gives nobody
anywhere to start.

The suite also exercises `isolate()` against a hostile payload and asserts the
language switch leaves the URL — query and fragment included — exactly as it
found it, and refuses a value that is not a language.

It writes `.arabic-rtl/rtl-report.json`, uploaded as a CI artifact.

---

## 8. Before this is offered to Arabic-speaking users

- [ ] Native review of all twelve dictionary files. Register and idiom, not just
      accuracy.
- [ ] Decide the word for "giveaway" — see §2 — and apply it everywhere at once.
- [ ] UAE counsel review of the Arabic Terms and Privacy Policy, after the
      English ones are approved. Translating an unapproved document twice does
      not make it approved.
- [ ] Screen-reader testing in Arabic, with the isolate characters in place.
- [ ] Decide the numeral convention and apply it consistently to values as well
      as prose.
- [ ] Confirm the date formats produced by `ar-AE` are what a UAE reader expects.
