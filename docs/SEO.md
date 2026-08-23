# Search engine readiness

> **This site is not indexable and must not become indexable before public
> launch.** Every response carries `X-Robots-Tag: noindex, nofollow, noarchive`
> while `DEPLOYMENT_STATE` is anything other than `public_launch`. The work
> described here is preparation. None of it takes effect until that variable is
> changed deliberately, and `launchBlockers()` refuses `public_launch` while
> either policy is still a draft.

---

## 1. The one thing that keeps the site out of the index

`server/lib/securityHeaders.js` sets, on **every** response — including the API,
the 404 page, and the dynamically rendered giveaway page:

```
X-Robots-Tag: noindex, nofollow, noarchive
```

It reads `isPublicLaunch()` rather than a variable of its own, so it cannot drift
from what the site tells its visitors. `seo9` fails if that link is broken or the
header changes.

A crawler that reaches the API or a 404 has still reached the platform, which is
why the header is not scoped to HTML.

---

## 2. Why `robots.txt` allows crawling before launch

The obvious pre-launch `robots.txt` is `Disallow: /`. It is the wrong one, and
the reasoning is worth writing down because it looks like a mistake.

`Disallow` means **do not fetch**. It does not mean **do not index**. A crawler
that is refused a page can still index the URL from a link somewhere else and
list it with no title and no description — the "indexed, though blocked by
robots.txt" state. That entry is both in the index and unremovable, because
removing it requires the crawler to fetch the page and read the `noindex` it is
forbidden to fetch.

So: crawling is allowed, indexing is refused by the header, and the crawler is
able to read the refusal. What is withheld pre-launch is the **sitemap** — there
is no reason to hand out a list of URLs nobody may index, and its absence cannot
be mistaken for permission. `/sitemap.xml` returns 404 rather than an empty
`<urlset>`, because an empty sitemap is a claim that the site has no pages, which
is a different and wronger statement.

Both are built by `server/lib/crawlerDirectives.js` and served before the static
handler. They were committed files; whether a site should be crawled is a
property of the deployment, and a file cannot know which deployment it is in.

**No path is disallowed.** The private surfaces — admin, owner, dashboard,
account, create, claim, and the one-time link targets — carry
`<meta name="robots" content="noindex, nofollow">` in their own markup. Two
reasons: a `Disallow` would hide exactly the instruction that keeps them out, and
a page-level directive outlives public launch, when the deployment-state header
stops being sent.

---

## 3. Which pages are offered

One list, in `server/lib/crawlerDirectives.js`:

`index`, `winners`, `about`, `pricing`, `partners`, `host-apply`, `advertise`,
`signup`, `login`, `terms`, `privacy`.

Every other page carries a page-level `noindex`. `seo1` asserts that the set of
pages carrying a canonical URL and the set listed in the sitemap are the same
set, in both directions — a sitemap listing a `noindex` page asks a crawler to do
two contradictory things, and a public page missing from the sitemap is simply
invisible. `seo2` asserts no page is *neither*, because an undecided page becomes
an indexed one the moment the deployment-state header stops being sent.

**`giveaway.html` is deliberately absent.** Without `?id=` it is an empty shell;
with one it is a different page per campaign. Its canonical, alternates, OG tags
and structured data are written per campaign by the server. A per-campaign
sitemap keyed on published campaigns is post-launch work — see §7.

---

## 4. Per-page metadata

Every page has a unique `<title>` and a unique `<meta name="description">`,
enforced by `seo5`. Both are translated: `data-i18n` on the title,
`data-i18n-content` on the description.

Indexable pages additionally carry:

```html
<link rel="canonical"  href="https://www.mynaseeb.ae/<page>" />
<link rel="alternate"  hreflang="en"        href=".../<page>" />
<link rel="alternate"  hreflang="ar"        href=".../<page>?lang=ar" />
<link rel="alternate"  hreflang="x-default" href=".../<page>" />
<meta property="og:type"            content="website" />
<meta property="og:site_name"       content="Naseeb" />
<meta property="og:url"             content=".../<page>" />
<meta property="og:locale"          content="en_AE" />
<meta property="og:locale:alternate" content="ar_AE" />
<meta property="og:title"           content="…" />
<meta property="og:description"     content="…" />
<meta name="twitter:card"           content="summary" />
<meta name="twitter:title"          content="…" />
<meta name="twitter:description"    content="…" />
```

`seo4` asserts each canonical is self-referential — one pointing elsewhere says
"index that page instead of me" — and that the Arabic alternate is an address
that actually renders Arabic. That is why `?lang=ar` exists at all: an hreflang
alternate pointing at a URL that serves English to everybody else is worse than
no alternate. See `docs/ARABIC_RTL.md` §6.

**`twitter:card` is `summary`, not `summary_large_image`.** There is no share
image yet; declaring the large card without one produces a broken preview. See
§7.

### The giveaway page

`server/app.js` rewrites the head per campaign for crawlers that do not run
JavaScript. It **removes** the static `og:*`, `twitter:card`, canonical and
hreflang tags before inserting its own. That is not tidiness: crawlers take the
first occurrence of a property, so appending would let the generic title win over
the campaign's real one, and would leave every campaign declaring itself a
duplicate of `/giveaway.html`.

The title and description substitutions match on the element rather than on the
exact sentence, and **throw** if they match nothing. They were literal string
replacements, and adding `data-i18n` to that `<title>` — a change in a different
file, for a different reason — turned both into silent no-ops. Every shared link
would have shown "Giveaway — Naseeb" instead of the prize, with nothing failing
and a 200 on the way out.

---

## 5. Structured data, and what it must not say

One node on the homepage:

```json
{ "@context": "https://schema.org", "@type": "WebSite",
  "name": "Naseeb", "url": "https://www.mynaseeb.ae", "inLanguage": ["en", "ar"] }
```

There was also an `Organization` node — name, url, description, `areaServed:
"AE"`. Every field of it was true of the *website* and none was true of an
*organisation*. Naseeb has no company, no trade licence and no VAT registration,
and is operated during development by one person. An Organization entity
asserting a UAE service area is a claim about a business that does not exist,
published in the format a search engine reads as the site's own statement about
itself — and unlike page copy, it is invisible to anyone reviewing the rendered
page. It is removed and stays removed until there is an organisation to describe.

`seo6` parses every `application/ld+json` block on every page and fails on
`Organization`, `LocalBusiness`, `Corporation`, `aggregateRating`, `review`,
`address`, `taxID` and `vatID`.

The giveaway page emits an `Event` node per campaign. Notes on it:

- **`endDate` quotes `closes_at`, not `entry_deadline`.** Both are derived from
  one scalar at approval, but `closes_at` is the column the worker acts on, and
  a promise to the outside world should cite the authority rather than the mirror
  of it. See `docs/LAUNCH_READINESS.md`.
- **No `organizer` node.** It said `Organization` for every host, and a host may
  be one person with no company at all. Asserting a legal form for a third party
  is not something the listing knows. The host is still named on the page, which
  is where the funding disclosure belongs.
- **`offers.price` is `"0"` in AED**, which is the single most useful true thing
  this markup can say about the platform.
- **`availability` is `OutOfStock`, not `SoldOut`,** once a campaign closes.
  Nothing was ever sold — entry is free and no payment path exists — and
  `SoldOut` is the one value that implies a transaction took place.
- The JSON is escaped for HTML context: a prize title containing `</script>`
  would otherwise close the tag early.
- `og:image` is used only when the campaign's image URL would pass
  `isRenderableMediaUrl()`. This markup is republished under our name by chat
  apps, so a hostile URL here is a hostile URL we published.

---

## 6. The limitation that matters most

**Language is chosen in the browser.** The HTML served is always English; the
Arabic appears after `applyI18n()` runs. The canonical and `og:url` are static in
the file.

Consequences:

- Arabic indexing depends on the crawler executing JavaScript. Google renders;
  most others do not.
- A crawler that renders will see the English canonical on the `?lang=ar` URL
  unless the page updates it, so `?lang=ar` may be read as a duplicate of the
  English page and dropped.
- Social crawlers never run JavaScript, so a shared Arabic link previews in
  English.

Server-side language negotiation — serving `lang`/`dir` and the right dictionary
from the request — is the fix, and it is post-launch work. It is recorded here
rather than worked around, because a half-measure that makes the markup *look*
bilingual to a reviewer without being bilingual to a crawler is worse than the
honest limitation.

---

## 7. Open before public launch

- [ ] **A share image.** 1200×630 PNG at a stable path, then `og:image`,
      `og:image:width`, `og:image:height` and `twitter:card:
      summary_large_image`. Until it exists the cards are text-only, which is
      correct — a declared image that 404s is a broken preview, not a missing one.
- [ ] **Per-campaign sitemap** generated from published campaigns, and a decision
      on whether closed campaigns stay listed.
- [ ] **Server-side language negotiation** — §6.
- [ ] **Verify the 404 status code**, not just the 404 page. A soft 404 that
      returns 200 gets indexed.
- [ ] **Confirm `APP_URL` matches the canonical host**, including `www`. A
      canonical pointing at a host that redirects wastes every crawl.
- [ ] **Re-check `robots.txt` and `/sitemap.xml` after the deployment state
      changes**, in that deployment, not in a test.
- [ ] **Decide whether `login.html` and `signup.html` should be indexed at all.**
      They are listed today because they were in the original hand-written
      sitemap, which is not a reason.

---

## 8. Tests

`test/seo.test.js`, in the plain `test` job — it reads files and starts no
server.

| | What it proves |
|---|---|
| `seo1` | The sitemap and the pages agree on which pages are public |
| `seo2` | Every page is either indexable or explicitly `noindex`, never neither |
| `seo3` | No page is both |
| `seo4` | Every indexable page has a self-referential canonical and all three alternates, and the Arabic one is an Arabic URL |
| `seo5` | Titles and descriptions are unique across the site |
| `seo6` | Structured data asserts nothing unverified |
| `seo7` | `robots.txt` allows crawling in both states and only offers a sitemap in one |
| `seo8` | The sitemap lists every public page once, with both languages, and no `lastmod` |
| `seo9` | The `noindex` header is still tied to the deployment state |
