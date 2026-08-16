// Where a prize photo or an ad banner may come from.
//
// Until now any string that parsed as an http(s) URL was accepted and rendered
// into an <img src>. That is two problems. The obvious one is that "http(s)
// only" is a weak filter — it stops `javascript:` and little else, and it does
// not stop a host pointing the platform's own pages at a tracker, a
// dead link, or an image that changes after moderation. The quieter one is that
// an unbounded set of image origins makes a real CSP impossible: `img-src`
// would have to be `*`, which is not a policy.
//
// So media URLs are now validated against an explicit origin allowlist, and the
// same allowlist is what `img-src` and `media-src` are built from. A URL that
// can be stored is a URL that can be displayed, and nothing else can.

// Cloudinary is the only upload path this application has: the create,
// advertise and owner pages all POST to an unsigned Cloudinary preset and store
// the secure_url it returns. Everything on the platform that was uploaded
// rather than pasted is already here.
const DEFAULT_ORIGINS = ['https://res.cloudinary.com'];

// Additional origins the owner has decided to trust, as a comma-separated list
// of full origins. Deliberately origins and not domains: "cloudinary.com" would
// admit anything anybody could get onto any subdomain of it.
function configuredOrigins() {
  return String(process.env.MEDIA_ORIGIN_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function normaliseOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The allowlist, as origins. Used by the validator below and by
// server/lib/securityHeaders.js to build img-src and media-src, so the two can
// never drift apart.
function mediaOrigins() {
  const all = [...DEFAULT_ORIGINS, ...configuredOrigins()]
    .map(normaliseOrigin)
    .filter(Boolean);
  return [...new Set(all)];
}

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\u009f]/;

const REJECTION = {
  EMPTY: 'A media URL is required.',
  MALFORMED: 'That does not look like a valid URL.',
  CONTROL_CHARACTERS: 'That URL contains characters that are not allowed.',
  PROTOCOL_RELATIVE: 'Media URLs must start with https://.',
  NOT_HTTPS: 'Media URLs must be served over https.',
  CREDENTIALS: 'Media URLs must not contain a username or password.',
  ORIGIN_NOT_ALLOWED: 'That image host is not on our allowed list.',
  TOO_LONG: 'That URL is too long.',
};

const MAX_URL_LENGTH = 2048;

// Returns { url } for something safe to store and render, or { error } saying
// why not. Never returns a "cleaned up" version of a rejected URL: a URL that
// had to be repaired to be safe is a URL somebody should look at, not one to
// quietly fix.
function validateMediaUrl(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { error: REJECTION.EMPTY };
  }

  const value = String(raw).trim();

  if (value.length > MAX_URL_LENGTH) return { error: REJECTION.TOO_LONG };

  // Checked before parsing, because the URL parser strips some of these and a
  // stripped control character is a filter bypass. A tab inside "java\tscript:"
  // is the classic one.
  if (CONTROL_CHARACTERS.test(value)) return { error: REJECTION.CONTROL_CHARACTERS };

  // "//evil.example/x.png" inherits whatever scheme the page is on. It parses
  // as a relative reference rather than a URL, so this has to be caught by
  // shape rather than by the parser.
  if (value.startsWith('//')) return { error: REJECTION.PROTOCOL_RELATIVE };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: REJECTION.MALFORMED };
  }

  // javascript:, data:, vbscript:, file:, and plain http: all land here. Only
  // https survives, so there is no per-scheme blocklist to keep up to date.
  if (url.protocol !== 'https:') return { error: REJECTION.NOT_HTTPS };

  // https://res.cloudinary.com@evil.example/x.png is a URL whose host is
  // evil.example, and which reads at a glance as if it were not.
  if (url.username || url.password) return { error: REJECTION.CREDENTIALS };

  // Origin comparison, so a suffix lookalike (res.cloudinary.com.evil.example)
  // and a prefix one (res.cloudinary.com.attacker.net) both fail — they are
  // different origins, and nothing here does a substring match.
  if (!mediaOrigins().includes(url.origin)) {
    return { error: REJECTION.ORIGIN_NOT_ALLOWED };
  }

  // href rather than the input: the parser has normalised escaping, so what is
  // stored is what a browser would actually request.
  return { url: url.href };
}

// Whether an already-stored URL is still safe to render.
//
// Rows written before this validation existed may hold anything. Rather than
// rewriting them — which would destroy the record of what a host actually
// submitted — the read path asks this, and a page that gets `false` shows its
// no-image state. The stored value is never turned into a link either: an
// unsafe URL a visitor can click is the same problem one step removed.
function isRenderableMediaUrl(value) {
  return Boolean(validateMediaUrl(value).url);
}

module.exports = {
  DEFAULT_ORIGINS,
  MAX_URL_LENGTH,
  REJECTION,
  mediaOrigins,
  validateMediaUrl,
  isRenderableMediaUrl,
};
