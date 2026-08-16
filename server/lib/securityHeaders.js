// Content Security Policy and the rest of the security headers.
//
// CSP was switched off for the whole of this project's life, with this comment
// in server/app.js: "every page here uses inline <script>/<style> and loads
// images from arbitrary host-provided URLs, so a default-restrictive CSP would
// break the app rather than harden it". That was true, and it was a description
// of a problem rather than a reason. The inline scripts are now external files,
// the inline styles are classes, and host-provided media is validated against an
// origin allowlist — so the policy below is enforceable, and enforced.
//
// It is deliberately enforced rather than report-only. A report-only policy
// tells you what would have been blocked; it stops nothing. There is also no
// switch that disables it: an environment variable that turns CSP off is a
// switch somebody will eventually find flipped in production.

const ALWAYS_SELF = "'self'";

// ---------------------------------------------------------------------------
// External origins
// ---------------------------------------------------------------------------
//
// Every entry here is an origin the application genuinely loads from, listed
// individually. No wildcards, and no whole domain admitted because one asset
// under it might be used. Each is justified in docs/CSP.md.

// Google Fonts, imported at the top of public/css/style.css. Two origins, not
// one: the stylesheet comes from fonts.googleapis.com and the font files it
// references come from fonts.gstatic.com.
const FONT_STYLESHEET_ORIGIN = 'https://fonts.googleapis.com';
const FONT_FILE_ORIGIN = 'https://fonts.gstatic.com';

// Cloudinary. `api.cloudinary.com` is the unsigned upload endpoint the create,
// advertise and owner pages POST to; `res.cloudinary.com` is where the images
// and videos it returns are served from. They are separate origins doing
// separate jobs, so they are allowed in separate directives.
const CLOUDINARY_UPLOAD_ORIGIN = 'https://api.cloudinary.com';
const CLOUDINARY_ASSET_ORIGIN = 'https://res.cloudinary.com';

// Google Analytics, and only when GA_MEASUREMENT_ID is actually configured.
// An origin allowed "in case someone turns analytics on later" is an origin
// allowed for no reason on every deployment that never does.
const ANALYTICS_SCRIPT_ORIGIN = 'https://www.googletagmanager.com';
const ANALYTICS_CONNECT_ORIGINS = [
  'https://www.google-analytics.com',
  'https://analytics.google.com',
  'https://www.googletagmanager.com',
];
const ANALYTICS_IMG_ORIGINS = ['https://www.google-analytics.com', 'https://www.googletagmanager.com'];

// Paths that must never load third-party script, whatever the configuration.
//
// The claim page handles a single-use credential that arrives in a URL
// fragment; the admin and owner panels handle everything else. public/js/app.js
// already refuses to initialise analytics on them — this makes that a policy the
// browser enforces rather than a decision our own script makes about itself.
const NO_THIRD_PARTY_PATHS = [/^\/claim\.html/, /^\/admin\.html/, /^\/owner\.html/];

function analyticsEnabled(pathname) {
  if (!process.env.GA_MEASUREMENT_ID) return false;
  return !NO_THIRD_PARTY_PATHS.some((pattern) => pattern.test(pathname));
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

function buildDirectives(pathname) {
  const { mediaOrigins } = require('./mediaUrls');
  const allowedMedia = mediaOrigins();
  const withAnalytics = analyticsEnabled(pathname);

  const directives = {
    // Everything not named below falls back to this. Named directives are
    // still listed explicitly rather than inherited, so reading the header
    // tells you the whole answer.
    'default-src': [ALWAYS_SELF],

    // No 'unsafe-inline', no 'unsafe-eval', no data:, no blob:. Every script on
    // every page is a file under /js.
    'script-src': [ALWAYS_SELF, ...(withAnalytics ? [ANALYTICS_SCRIPT_ORIGIN] : [])],
    // script-src-attr is what would permit onclick="" and friends. 'none'
    // states plainly that there are none, and that a future one will not work.
    'script-src-attr': ["'none'"],

    'style-src': [ALWAYS_SELF, FONT_STYLESHEET_ORIGIN],
    // Same idea for style="" attributes: they are gone, and this keeps them
    // gone. Note this does NOT affect element.style assignments from
    // JavaScript, which CSP does not govern — see docs/CSP.md.
    'style-src-attr': ["'none'"],

    'font-src': [ALWAYS_SELF, FONT_FILE_ORIGIN],

    // Prize photos and ad banners. The allowlist is the same one the server
    // validates stored URLs against, so a URL that could be saved is a URL that
    // can be displayed, and nothing else can.
    'img-src': [ALWAYS_SELF, ...allowedMedia, ...(withAnalytics ? ANALYTICS_IMG_ORIGINS : [])],
    'media-src': [ALWAYS_SELF, ...allowedMedia],

    'connect-src': [
      ALWAYS_SELF,
      CLOUDINARY_UPLOAD_ORIGIN,
      ...(withAnalytics ? ANALYTICS_CONNECT_ORIGINS : []),
    ],

    // Nothing on this site is a plugin, an applet or an embedded document.
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'child-src': ["'none'"],
    'worker-src': ["'none'"],
    'manifest-src': [ALWAYS_SELF],

    // 'none' rather than 'self': there is no <base> tag anywhere, and an
    // injected one is a way to repoint every relative URL on the page.
    'base-uri': ["'none'"],

    // Clickjacking. frame-ancestors is the modern control; X-Frame-Options
    // below says the same thing for anything that predates it.
    'frame-ancestors': ["'none'"],

    // Where a form may submit. Stripe Checkout is reached by assigning
    // window.location, which is a navigation rather than a form submission, so
    // it needs nothing here.
    'form-action': [ALWAYS_SELF],
  };

  if (isProduction()) {
    // Only in production: locally the app is served over http, and upgrading
    // every request to https would break development outright.
    directives['upgrade-insecure-requests'] = [];
  }

  return directives;
}

function serialise(directives) {
  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

function policyFor(pathname) {
  return serialise(buildDirectives(pathname));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Mounted first, before any route and before the static handler, so the headers
// are on every response this process produces: pages, API JSON, API errors, the
// 404 page, the 500 handler, and the dynamically rendered giveaway page. A
// header that is only on the happy path is a header that is missing exactly
// when something has gone wrong.
function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', policyFor(req.path));

  // Sends the origin but not the path to other sites, and nothing at all when
  // downgrading to http. The claim page's token is in a fragment, which is
  // never in a Referer at all — this covers everything else.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Redundant with frame-ancestors for modern browsers, and harmless for the
  // rest. The two say the same thing, so they cannot contradict each other.
  res.setHeader('X-Frame-Options', 'DENY');

  // None of these features is used. Denying them means an injected script
  // cannot quietly start using one either.
  res.setHeader(
    'Permissions-Policy',
    [
      'accelerometer=()',
      'camera=()',
      'display-capture=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()',
      'interest-cohort=()',
    ].join(', ')
  );

  // same-origin-allow-popups rather than same-origin: Stripe Checkout is a
  // top-level redirect today, but a popup flow is the documented alternative
  // and same-origin would break it. Cross-origin isolation is not something
  // this app needs.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  // cross-origin, NOT same-origin: giveaway images are shared to WhatsApp and
  // social crawlers fetch them from other origins. same-origin would break
  // every link preview the platform depends on.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (isProduction()) {
    // Two years, subdomains included. Deliberately not sent outside production:
    // a browser that receives HSTS from http://localhost refuses to load
    // localhost over http afterwards, for every project on that machine.
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  return next();
}

module.exports = {
  securityHeaders,
  policyFor,
  buildDirectives,
  analyticsEnabled,
  NO_THIRD_PARTY_PATHS,
  FONT_STYLESHEET_ORIGIN,
  FONT_FILE_ORIGIN,
  CLOUDINARY_UPLOAD_ORIGIN,
  CLOUDINARY_ASSET_ORIGIN,
};
