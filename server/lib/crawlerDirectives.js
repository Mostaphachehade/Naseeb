// robots.txt and sitemap.xml, built from the deployment state instead of frozen
// on disk.
//
// ---------------------------------------------------------------------------
// Why these stopped being static files
// ---------------------------------------------------------------------------
//
// public/robots.txt was a committed file advertising a sitemap of eleven URLs,
// served identically before and after launch. Whether this site should be
// crawled is a property of the deployment, not of the repository, and a file
// cannot know which deployment it is in. Pre-launch it invited crawlers to a
// list of pages carrying draft policies and unreviewed legal text.
//
// public/sitemap.xml was worse in a quieter way: hand-maintained, so it drifted.
// It has to be written by the same list the pages are, or it becomes a
// confidently-wrong catalogue of a site that has changed underneath it.
//
// ---------------------------------------------------------------------------
// Why pre-launch ALLOWS crawling
// ---------------------------------------------------------------------------
//
// The obvious pre-launch robots.txt is `Disallow: /`, and it is the wrong one.
//
// Disallow means "do not fetch". It does not mean "do not index". A crawler that
// is refused the page can still index the URL from a link somewhere else, and
// list it with no title and no description — the "indexed, though blocked by
// robots.txt" state, which is both an entry in the index and one you cannot
// remove, because removing it needs the crawler to fetch the page and read the
// noindex it is forbidden to fetch.
//
// The header on every response says `noindex, nofollow, noarchive`. For that to
// work, it has to be READ. So crawling is allowed and indexing is refused, which
// is the combination that actually keeps a site out of an index. The sitemap
// line is dropped instead: there is no reason to hand out a list of URLs nobody
// may index, and its absence cannot be mistaken for permission.
//
// For the same reason nothing is Disallowed by path. The private surfaces —
// admin, owner, dashboard, account, the one-time link targets — carry
// `<meta name="robots" content="noindex, nofollow">` in their own markup, which
// survives public launch, when the deployment-state header stops being sent.
// Disallowing them instead would hide exactly the instruction that keeps them
// out.

// Kept in step with PUBLIC_PAGES in the page metadata: a page is in the sitemap
// if, and only if, it carries a canonical URL and hreflang alternates.
// test/seo.test.js compares the two and fails when they disagree, because a
// sitemap listing a noindex page asks a crawler to do two contradictory things.
const PUBLIC_PAGES = [
  'index.html',
  'winners.html',
  'about.html',
  'pricing.html',
  'partners.html',
  'host-apply.html',
  'advertise.html',
  'signup.html',
  'login.html',
  'terms.html',
  'privacy.html',
];

// giveaway.html is deliberately absent. Without ?id= it is an empty shell, and
// with one it is a different page per campaign — a list of those belongs in a
// generated per-campaign sitemap keyed on published campaigns, which is a
// post-launch piece of work recorded in docs/SEO.md. Listing the bare page would
// offer a crawler a URL that renders "not found".

function robotsTxt({ publicLaunch, origin }) {
  const lines = [
    '# Crawling is allowed and indexing is refused by the X-Robots-Tag header on',
    '# every response. Disallow would prevent the crawler reading that header,',
    '# which is how a URL ends up indexed with no content and no way to remove it.',
    'User-agent: *',
    'Allow: /',
    '',
  ];
  if (publicLaunch) {
    lines.push(`Sitemap: ${origin}/sitemap.xml`, '');
  } else {
    lines.push(
      '# No sitemap before public launch: nothing here may be indexed yet, so',
      '# there is nothing to offer.',
      ''
    );
  }
  return lines.join('\n');
}

// XML escaping for the one thing that reaches this: the origin. It comes from
// APP_URL, which is ours — but a URL with an ampersand in it would still produce
// a malformed document, and a sitemap that fails to parse is silently ignored
// rather than reported.
function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Each entry declares its own alternates, including itself. That is what the
// spec asks for and what makes the Arabic version addressable: ?lang=ar is a
// real URL that renders Arabic, so pointing a crawler at it is a true statement
// rather than a redirect to the same English page.
//
// No <lastmod>. These are static pages with no reliable per-page modification
// date, and a date invented at request time — "modified now, every time you
// ask" — is worse than none: it teaches a crawler to distrust the field.
function sitemapXml({ origin }) {
  const urls = PUBLIC_PAGES.map((page) => {
    const loc = `${origin}/${page}`;
    return [
      '  <url>',
      `    <loc>${xml(loc)}</loc>`,
      `    <xhtml:link rel="alternate" hreflang="en" href="${xml(loc)}" />`,
      `    <xhtml:link rel="alternate" hreflang="ar" href="${xml(`${loc}?lang=ar`)}" />`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(loc)}" />`,
      '  </url>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

module.exports = { PUBLIC_PAGES, robotsTxt, sitemapXml };
