const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const Sentry = require('@sentry/node');
const { pool } = require('./db');

const authRoutes = require('./routes/auth');
const giveawayRoutes = require('./routes/giveaways');
const hostApplicationRoutes = require('./routes/hostApplications');
const adInquiryRoutes = require('./routes/adInquiries');
const adsRoutes = require('./routes/ads');
const adminRoutes = require('./routes/admin');
const configRoutes = require('./routes/config');
const webhookRoutes = require('./routes/webhooks');
const claimRoutes = require('./routes/claims');
const accountRoutes = require('./routes/account');
const { csrfProtection } = require('./lib/csrf');
const { securityHeaders } = require('./lib/securityHeaders');
const healthRoutes = require('./routes/health');
const { isRenderableMediaUrl } = require('./lib/mediaUrls');
const { resolveTrustProxy } = require('./lib/proxyTrust');
const { robotsTxt, sitemapXml } = require('./lib/crawlerDirectives');

const app = express();

// How many proxies sit in front of this process, and therefore how much of
// X-Forwarded-For may be believed.
//
// This used to be a hard-coded 1, which is correct on Render and wrong
// everywhere else: run the same code with no proxy in front and a client can
// write its own X-Forwarded-For, mint a fresh rate-limit identity per request,
// and walk through every limiter on the site. The number is now configuration
// with a fail-closed default of 0, validated at startup. See
// server/lib/proxyTrust.js for the arithmetic and docs/ENTRY_INTEGRITY.md §7.
const trustProxy = resolveTrustProxy();
app.set('trust proxy', trustProxy.value);

// Every security header, on every response this process produces — including
// API errors, the 404 page and the dynamically rendered giveaway page. Mounted
// first for exactly that reason: a header only present on the happy path is
// missing precisely when something has gone wrong.
//
// CSP used to be off, with a comment explaining that inline scripts and
// arbitrary image origins made it unenforceable. Both of those are now fixed —
// scripts are files, styles are classes, media origins are an allowlist — so
// the policy is on, enforced, and has no switch to turn it off. See
// server/lib/securityHeaders.js and docs/CSP.md.
app.use(securityHeaders);

// helmet still supplies the headers securityHeaders does not set. Its own CSP
// and the headers we set above are disabled here so there is exactly one source
// for each header and no chance of two contradicting each other.
app.use(
  helmet({
    contentSecurityPolicy: false,
    referrerPolicy: false,
    frameguard: false,
    strictTransportSecurity: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })
);
app.use(compression());
app.use(cors({ origin: process.env.APP_URL || 'http://localhost:3000' }));

// Health probes, mounted early and outside /api on purpose.
//
// Early, because a readiness check that queues behind body parsing, CORS
// negotiation and CSRF is a check that reports "slow" as "unhealthy". Outside
// /api, because they are not part of the API surface: no CSRF, no session, no
// rate limit, and nothing they do can mutate anything. They still get the full
// security-header stack above, which is why this sits after `securityHeaders`
// rather than at the very top.
app.use(healthRoutes.router);

// Mounted BEFORE express.json(), and the ordering is load-bearing rather than
// stylistic. Stripe signs the exact bytes it sent; express.json() would consume
// the stream and hand the route a parsed object, and re-serialising that object
// does not reproduce those bytes — so every signature check would fail. Scoped
// to this one path so the rest of the API still gets normal JSON parsing.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json());

// Runs in front of every remaining API router, and deliberately AFTER the
// webhook mount above so Stripe's raw-body path never reaches it. Checks
// Origin/Referer on every unsafe request, and requires a session-bound CSRF
// token on every unsafe request that carries a session cookie — both before any
// handler runs, so a refused request has written nothing.
app.use('/api', csrfProtection);

app.use('/api/auth', authRoutes);
app.use('/api/giveaways', giveawayRoutes);
app.use('/api/host-applications', hostApplicationRoutes);
app.use('/api/ad-inquiries', adInquiryRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/claims', claimRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRoutes);

function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const giveawayPageTemplate = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'giveaway.html'),
  'utf8'
);

// Social crawlers (WhatsApp, Facebook, Twitter/X) don't run the client-side
// JS that fills in the page, so without this every shared giveaway link
// shows the same generic title/description instead of the actual prize.
// This only rewrites <head> tags — the client-side script below still
// fetches and renders the same data for real visitors.
app.get('/giveaway.html', async (req, res, next) => {
  const id = req.query.id;
  if (!id) return next();

  try {
    const result = await pool.query(
      `SELECT giveaways.title, giveaways.description, giveaways.prize_description,
              giveaways.image_url, giveaways.status, giveaways.closes_at,
              giveaways.created_at, users.name AS host_name
       FROM giveaways
       JOIN users ON users.id = giveaways.host_id
       WHERE giveaways.id = $1`,
      [id]
    );
    const giveaway = result.rows[0];
    if (!giveaway) return next();

    // Only a URL that would be accepted today goes into og:image or the
    // structured data — this markup is consumed by crawlers and chat apps, so a
    // hostile URL here is a hostile URL republished under our name.
    const shareableImage = isRenderableMediaUrl(giveaway.image_url) ? giveaway.image_url : null;

    const title = `${giveaway.title} — Naseeb`;
    const description = (giveaway.prize_description || giveaway.description || '')
      .slice(0, 200)
      .trim();
    const url = `${APP_URL}/giveaway.html?id=${encodeURIComponent(id)}`;

    // Matched by shape, not by the exact sentence that happened to be in the
    // markup when this was written.
    //
    // These were two literal string replacements against the generic title and
    // description. Adding data-i18n to that <title> and data-i18n-content to
    // that <meta> — a translation change, in another file, with no connection to
    // this one — turned both into no-ops, and every shared link would have shown
    // "Giveaway — Naseeb" instead of the prize. Nothing failed; the page still
    // rendered, still returned 200, and the substitution simply stopped
    // happening.
    //
    // Regex on the element, and an assertion that each one matched, so the same
    // edit produces a startup-visible error instead of a silently generic share
    // card. The i18n attributes are dropped from the rewritten tags on purpose:
    // this response is for crawlers, and applyI18n() would otherwise overwrite
    // the campaign's own title with the dictionary's generic one the moment a
    // real visitor's browser ran the script.
    const substitutions = [
      [/<title[^>]*>[\s\S]*?<\/title>/, `<title>${escapeHtmlAttr(title)}</title>`],
      [/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtmlAttr(description)}" />`],
    ];
    let html = giveawayPageTemplate;
    for (const [pattern, replacement] of substitutions) {
      if (!pattern.test(html)) {
        throw new Error(`giveaway.html no longer contains ${pattern} — share metadata would be generic`);
      }
      html = html.replace(pattern, replacement);
    }

    const ogTags = [
      `<meta property="og:title" content="${escapeHtmlAttr(title)}" />`,
      `<meta property="og:description" content="${escapeHtmlAttr(description)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:url" content="${escapeHtmlAttr(url)}" />`,
      shareableImage ? `<meta property="og:image" content="${escapeHtmlAttr(shareableImage)}" />` : '',
      `<meta name="twitter:card" content="${shareableImage ? 'summary_large_image' : 'summary'}" />`,
    ].filter(Boolean).join('\n');

    // Mapped to Event rather than Product: schema.org has no dedicated
    // "giveaway" type, and Event's start/end dates plus a zero-price Offer
    // capture the two things that actually matter here — when entries close,
    // and that entering is genuinely free — better than any alternative type.
    const eventJsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: giveaway.title,
      description,
      startDate: new Date(giveaway.created_at).toISOString(),
      // closes_at, not entry_deadline. Both are derived from one scalar at
      // approval, but closes_at is the column the worker acts on, and this
      // markup is a promise to the outside world about when entries end. It
      // should quote the authority rather than the mirror of it.
      endDate: new Date(giveaway.closes_at).toISOString(),
      eventStatus: `https://schema.org/Event${giveaway.status === 'drawn' ? 'Completed' : 'Scheduled'}`,
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      location: { '@type': 'VirtualLocation', url },
      // No organizer node. It said `Organization` for every host, and a host
      // may be one person with no company at all — asserting a legal form for
      // a third party, in the format a search engine reads as our own claim
      // about them, is not something the listing knows. The host is still named
      // on the page, which is where the funding disclosure belongs.
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'AED',
        // OutOfStock rather than SoldOut for a closed giveaway. Nothing was
        // ever sold — entry is free and no payment path exists — and SoldOut is
        // the one value here that implies a transaction took place.
        availability:
          giveaway.status === 'active'
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
        url,
      },
      ...(shareableImage ? { image: shareableImage } : {}),
    };

    // JSON.stringify has no notion of HTML context — a title containing
    // "</script>" would otherwise close this tag early and let arbitrary
    // markup from a host-controlled field run on the page.
    const eventJsonLdSafe = JSON.stringify(eventJsonLd).replace(/</g, '\\u003c');

    // The static head already carries a generic og:* set and a canonical
    // pointing at the id-less page. Both have to GO, not merely be followed:
    // crawlers take the first occurrence of a property, so appending would let
    // the generic "Giveaway — Naseeb" title win over this campaign's real one,
    // and would leave every campaign declaring itself a duplicate of
    // /giveaway.html. Removed first, then replaced with the specific ones.
    html = html
      .replace(/^[ \t]*<meta property="og:(?:title|description|type|url|image)"[^>]*>\r?\n/gm, '')
      .replace(/^[ \t]*<meta name="twitter:card"[^>]*>\r?\n/gm, '')
      .replace(/^[ \t]*<link rel="canonical"[^>]*>\r?\n/gm, '')
      .replace(/^[ \t]*<link rel="alternate" hreflang="[^"]*"[^>]*>\r?\n/gm, '');

    const languageTags = [
      `<link rel="canonical" href="${escapeHtmlAttr(url)}" />`,
      `<link rel="alternate" hreflang="en" href="${escapeHtmlAttr(url)}" />`,
      `<link rel="alternate" hreflang="ar" href="${escapeHtmlAttr(`${url}&lang=ar`)}" />`,
      `<link rel="alternate" hreflang="x-default" href="${escapeHtmlAttr(url)}" />`,
    ].join('\n');

    html = html.replace(
      '</head>',
      `${languageTags}\n${ogTags}\n<script type="application/ld+json">${eventJsonLdSafe}</script>\n</head>`
    );

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error(err);
    next();
  }
});

// Crawler directives, before the static handler so they are answered from the
// deployment state rather than from a file that cannot know which deployment it
// is in. See server/lib/crawlerDirectives.js for why pre-launch allows crawling
// instead of disallowing it.
app.get('/robots.txt', (req, res) => {
  // eslint-disable-next-line global-require
  const publicLaunch = require('./lib/config').isPublicLaunch();
  res.type('text/plain').send(robotsTxt({ publicLaunch, origin: APP_URL }));
});

app.get('/sitemap.xml', (req, res) => {
  // eslint-disable-next-line global-require
  if (!require('./lib/config').isPublicLaunch()) {
    // Nothing here may be indexed yet, and a sitemap is an invitation to index.
    // 404 rather than an empty urlset: an empty sitemap is a claim that the site
    // has no pages, which is a different and wronger statement.
    return res.status(404).type('text/plain').send('Not found.\n');
  }
  return res.type('application/xml').send(sitemapXml({ origin: APP_URL }));
});

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Safety net for anything that slips past a route's own try/catch — a bug in
// middleware itself, say. Everything it captures still goes through the
// `beforeSend` scrubber configured in server/lib/errorReporting.js; this handler
// decides *whether* an event is created, never what is in it.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

module.exports = app;
// Exposed so the shutdown coordinator can flip readiness false before anything
// is torn down, and so tests can drive it.
module.exports.health = healthRoutes;
