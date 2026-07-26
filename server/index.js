require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const Sentry = require('@sentry/node');
const { init, pool } = require('./db');

// Every route in this app already catches its own errors and logs them via
// console.error rather than calling next(err), so Sentry's automatic Express
// error handler alone wouldn't see any of them. captureConsoleIntegration
// mirrors every console.error call into Sentry too, without having to touch
// every route file's catch block individually.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  });
}

const authRoutes = require('./routes/auth');
const giveawayRoutes = require('./routes/giveaways');
const hostApplicationRoutes = require('./routes/hostApplications');
const adInquiryRoutes = require('./routes/adInquiries');
const adsRoutes = require('./routes/ads');
const adminRoutes = require('./routes/admin');
const configRoutes = require('./routes/config');

const app = express();

// Render terminates TLS and proxies every request — without this, req.ip
// collapses to the proxy's address for all traffic, and the rate limiters
// end up sharing one bucket across every visitor instead of per-IP.
app.set('trust proxy', 1);

// CSP is left off: every page here uses inline <script>/<style> and loads
// images from arbitrary host-provided URLs (prizes, ad banners), so a
// default-restrictive CSP would break the app rather than harden it. The
// other headers (HSTS, no-sniff, frame-deny, etc.) still apply.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: process.env.APP_URL || 'http://localhost:3000' }));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/giveaways', giveawayRoutes);
app.use('/api/host-applications', hostApplicationRoutes);
app.use('/api/ad-inquiries', adInquiryRoutes);
app.use('/api/ads', adsRoutes);
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
      'SELECT title, description, prize_description, image_url FROM giveaways WHERE id = $1',
      [id]
    );
    const giveaway = result.rows[0];
    if (!giveaway) return next();

    const title = `${giveaway.title} — Naseeb`;
    const description = (giveaway.prize_description || giveaway.description || '')
      .slice(0, 200)
      .trim();
    const url = `${APP_URL}/giveaway.html?id=${encodeURIComponent(id)}`;

    let html = giveawayPageTemplate
      .replace(
        '<title>Giveaway — Naseeb</title>',
        `<title>${escapeHtmlAttr(title)}</title>`
      )
      .replace(
        '<meta name="description" content="Enter this free giveaway on Naseeb — no purchase necessary, ever." />',
        `<meta name="description" content="${escapeHtmlAttr(description)}" />`
      );

    const ogTags = [
      `<meta property="og:title" content="${escapeHtmlAttr(title)}" />`,
      `<meta property="og:description" content="${escapeHtmlAttr(description)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:url" content="${escapeHtmlAttr(url)}" />`,
      giveaway.image_url ? `<meta property="og:image" content="${escapeHtmlAttr(giveaway.image_url)}" />` : '',
      `<meta name="twitter:card" content="${giveaway.image_url ? 'summary_large_image' : 'summary'}" />`,
    ].filter(Boolean).join('\n');

    html = html.replace('</head>', `${ogTags}\n</head>`);

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error(err);
    next();
  }
});

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Safety net for anything that slips past a route's own try/catch (e.g. a
// bug in middleware itself) — most real errors are already covered by
// captureConsoleIntegration above.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Naseeb running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to the database:', err.message);
    process.exit(1);
  });
