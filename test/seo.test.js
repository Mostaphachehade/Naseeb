// What this site tells a search engine, and what it must not tell one yet.
//
// ---------------------------------------------------------------------------
// Two lists that have to agree
// ---------------------------------------------------------------------------
//
// A page is offered to a crawler in two independent places: the canonical link
// and hreflang alternates in its own <head>, and its entry in the sitemap. They
// were maintained by hand, in different files, and nothing connected them. A
// sitemap listing a noindex page asks a crawler to do two contradictory things
// and gets the site treated as unreliable; a public page missing from the
// sitemap is simply invisible.
//
// So the sitemap is generated from one list and this file asserts the markup
// matches it, in both directions.
//
// ---------------------------------------------------------------------------
// And one thing that must not appear at all
// ---------------------------------------------------------------------------
//
// Structured data is the one place a claim can be made that nobody reviewing the
// rendered page will ever see. index.html carried an Organization node — name,
// url, description, areaServed "AE" — for an entity with no company, no trade
// licence and no VAT registration. It read as the site's own machine-readable
// statement that a UAE business exists. It is gone, and this file keeps it gone,
// along with the other types that assert facts we have not verified.
//
// Pure: reads files, opens no connection and starts no server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const { PUBLIC_PAGES, robotsTxt, sitemapXml } = require('../server/lib/crawlerDirectives');

const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).sort();
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

// giveaway.html is a public page whose canonical and alternates are written per
// campaign by the server, not by the file. It is deliberately absent from
// PUBLIC_PAGES — see server/lib/crawlerDirectives.js — so it is excluded here
// rather than counted as a mismatch.
const SERVER_RENDERED = new Set(['giveaway.html']);

const indexable = pages.filter((f) => read(f).includes('rel="canonical"'));

test('seo1. the sitemap and the pages agree on which pages are public', () => {
  const inMarkup = indexable.filter((f) => !SERVER_RENDERED.has(f)).sort();
  const inSitemap = [...PUBLIC_PAGES].sort();

  assert.deepEqual(
    inMarkup,
    inSitemap,
    'pages carrying a canonical URL and pages listed in the sitemap have diverged.'
    + ' Either the page should not be offered to a crawler, or the sitemap is missing it.'
  );
});

test('seo2. every page is either indexable or explicitly noindex, never neither', () => {
  const undecided = pages.filter((f) => {
    const html = read(f);
    return !html.includes('rel="canonical"') && !/<meta name="robots" content="noindex/.test(html);
  });

  assert.deepEqual(
    undecided,
    [],
    `${undecided.length} page(s) neither declare a canonical URL nor a page-level noindex, so what`
    + ' happens to them at public launch is undecided. The deployment-state header stops being sent'
    + ` then, and an undecided page becomes an indexed one.\n  ${undecided.join('\n  ')}`
  );
});

test('seo3. a page is never both indexable and noindex', () => {
  const contradictory = pages.filter((f) => {
    const html = read(f);
    return html.includes('rel="canonical"') && /<meta name="robots" content="noindex/.test(html);
  });
  assert.deepEqual(contradictory, [], `pages that both invite and refuse indexing: ${contradictory.join(', ')}`);
});

test('seo4. every indexable page offers both languages and points at itself', () => {
  for (const f of indexable) {
    if (SERVER_RENDERED.has(f)) continue;
    const html = read(f);
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html);
    assert.ok(canonical, `${f}: no canonical`);

    // Self-referential. A canonical pointing somewhere else says "index that
    // page instead of me", which for a distinct page is a request to be dropped.
    assert.ok(
      canonical[1].endsWith(`/${f}`),
      `${f}: canonical points at ${canonical[1]}, not at itself`
    );

    for (const lang of ['en', 'ar', 'x-default']) {
      assert.match(
        html,
        new RegExp(`<link rel="alternate" hreflang="${lang}" href="[^"]+"`),
        `${f}: no ${lang} alternate`
      );
    }

    // The Arabic alternate must be an address that actually renders Arabic.
    // Pointing it at the plain URL would be an assertion that the same page is
    // both versions, which is the failure hreflang exists to prevent.
    const ar = /<link rel="alternate" hreflang="ar" href="([^"]+)"/.exec(html);
    assert.ok(ar[1].includes('lang=ar'), `${f}: the Arabic alternate is not an Arabic URL`);
  }
});

test('seo5. titles and descriptions are unique across the site', () => {
  const titles = new Map();
  const descriptions = new Map();
  for (const f of pages) {
    const html = read(f);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(html)[1].replace(/\s+/g, ' ').trim();
    const desc = /<meta name="description"[^>]*content="([^"]*)"/.exec(html);
    assert.ok(desc, `${f}: no meta description`);

    // A duplicate title or description tells a search engine two pages are the
    // same page, and tells a person reading a list of open tabs nothing at all.
    if (titles.has(title)) assert.fail(`${f} and ${titles.get(title)} share the title "${title}"`);
    titles.set(title, f);

    const d = desc[1].replace(/\s+/g, ' ').trim();
    if (descriptions.has(d)) assert.fail(`${f} and ${descriptions.get(d)} share a meta description`);
    descriptions.set(d, f);
  }
});

test('seo6. structured data asserts nothing we have not verified', () => {
  // The prohibited types each assert a fact about a real-world entity: that a
  // company exists, that it has a place of business, that people have rated it.
  // None of those is true of Naseeb today, and the operator baseline in
  // docs/LAUNCH_READINESS.md §4 says nothing in the product may imply otherwise.
  const PROHIBITED = [
    ['Organization', 'asserts a legal entity that does not exist yet'],
    ['LocalBusiness', 'asserts a place of business'],
    ['Corporation', 'asserts a corporate form'],
    ['aggregateRating', 'asserts ratings nobody has given'],
    ['review', 'asserts reviews nobody has written'],
    ['address', 'asserts a registered address that is still to be confirmed'],
    ['taxID', 'asserts a VAT registration that does not exist'],
    ['vatID', 'asserts a VAT registration that does not exist'],
  ];

  const failures = [];
  for (const f of pages) {
    const html = read(f);
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      let parsed;
      try {
        parsed = JSON.parse(block[1]);
      } catch (err) {
        assert.fail(`${f}: structured data is not valid JSON — ${err.message}`);
      }
      const text = JSON.stringify(parsed);
      for (const [needle, why] of PROHIBITED) {
        if (text.includes(needle)) failures.push(`${f}: "${needle}" — ${why}`);
      }
    }
  }

  assert.deepEqual(failures, [], `structured data makes unverified claims:\n  ${failures.join('\n  ')}`);
});

test('seo7. robots.txt allows crawling in both states, and only offers a sitemap in one', () => {
  const before = robotsTxt({ publicLaunch: false, origin: 'https://example.test' });
  const after = robotsTxt({ publicLaunch: true, origin: 'https://example.test' });

  // Allow, not Disallow, before launch. Disallow stops the crawler fetching the
  // page, which stops it reading the noindex header — and a URL blocked from
  // being read can still be indexed from an external link, with no content and
  // no way to remove it.
  assert.match(before, /^Allow: \/$/m, 'pre-launch robots.txt does not allow crawling');
  assert.doesNotMatch(before, /^Disallow:/m, 'pre-launch robots.txt disallows, which would hide the noindex header');
  assert.doesNotMatch(before, /^Sitemap:/m, 'pre-launch robots.txt advertises a sitemap');

  assert.match(after, /^Allow: \/$/m);
  assert.match(after, /^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
});

test('seo8. the sitemap lists every public page once, with both languages', () => {
  const xml = sitemapXml({ origin: 'https://example.test' });

  for (const page of PUBLIC_PAGES) {
    const loc = `https://example.test/${page}`;
    assert.equal(
      (xml.match(new RegExp(`<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>`, 'g')) || []).length,
      1,
      `${page} does not appear exactly once in the sitemap`
    );
    assert.ok(xml.includes(`hreflang="ar" href="${loc}?lang=ar"`), `${page}: no Arabic alternate in the sitemap`);
  }

  assert.equal((xml.match(/<url>/g) || []).length, PUBLIC_PAGES.length, 'the sitemap has entries for pages nobody listed');

  // No lastmod. There is no reliable per-page modification date, and one
  // computed at request time says "modified now" on every fetch — which teaches
  // a crawler to ignore the field rather than to trust it.
  assert.doesNotMatch(xml, /<lastmod>/, 'the sitemap carries a lastmod it cannot substantiate');
});

test('seo9. the noindex header is still tied to the deployment state', () => {
  // The whole pre-launch posture rests on this one header. If it ever became
  // unconditional the site could never be indexed; if it became absent, a
  // pre-launch site with draft legal text would be.
  const headers = fs.readFileSync(path.join(ROOT, 'server/lib/securityHeaders.js'), 'utf8');
  assert.match(headers, /isPublicLaunch\(\)/, 'the robots header no longer consults the deployment state');
  assert.match(headers, /'X-Robots-Tag', 'noindex, nofollow, noarchive'/, 'the noindex header changed or is gone');
});
