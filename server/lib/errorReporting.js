// Error reporting, and everything it is not allowed to carry.
//
// The previous arrangement was `captureConsoleIntegration({ levels: ['error'] })`:
// every `console.error` anywhere in the codebase became a Sentry event. It was
// convenient — no route file had to be touched — and it made the privacy of an
// off-platform transmission depend on nobody ever interpolating an email
// address, a delivery note or a token into a log line. That is a convention held
// up by code review, and a convention is not a control. One ordinary-looking
// `console.error(\`could not email ${user.email}\`)` would have sent it.
//
// So: the console integration is gone, `sendDefaultPii` is off, and everything
// that does reach Sentry passes through `scrub()` below first. The scrubber is
// deliberately built to fail closed — an unrecognised structure is dropped
// rather than forwarded, and a key that merely *looks* like a credential is
// redacted whether or not it is one.
//
// Two lines of defence, on purpose:
//
//   1. What is captured at all — explicit exceptions from `reportError()`, and
//      Express's own error handler. Not arbitrary log text.
//   2. What survives `beforeSend` — the recursive redaction here.
//
// Neither is trusted alone. See docs/DATA_INVENTORY.md §13.

const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------
// Key-based redaction
// ---------------------------------------------------------------------------

// Matched against the KEY, case-insensitively, anywhere in the name. A key is
// redacted on suspicion: `delivery_ciphertext`, `deliveryNote`, `x-csrf-token`
// and `RESEND_API_KEY` all match, and so does anything a future column names
// similarly. False positives here cost a debugging detail; false negatives cost
// a person's address.
const SENSITIVE_KEY = new RegExp(
  [
    // Credentials and secrets of every kind.
    'password', 'passwd', 'secret', 'token', 'csrf', 'authorization', 'auth',
    'cookie', 'session', 'credential', 'apikey', 'api_key', 'access_key',
    'private_key', 'signature', 'sig', 'hash', 'salt', 'nonce', 'jwt', 'bearer',
    // Encryption material and the encrypted payloads themselves.
    'cipher', 'ciphertext', 'encryption', '\\biv\\b', 'key_version', 'keyversion',
    // Third-party secrets.
    'stripe', 'resend', 'dsn', 'database_url', 'connection_string', 'conn_str',
    // Personal data this platform holds.
    'email', 'phone', 'mobile', 'address', 'addr', 'postcode', 'zip',
    'delivery', 'recipient', 'full_name', 'fullname', 'contact',
    'trade_license', 'tradelicense',
    // Internal reasoning about a person.
    'admin_notes', 'adminnotes', 'user_message', 'usermessage', 'reason',
    // Network data. Coarsened and keyed everywhere it is stored, and there is
    // no reason for either form to leave the platform.
    '\\bip\\b', 'ip_address', 'ipaddress', 'x-forwarded-for', 'forwarded',
    'remote_addr', 'network_hmac', 'network_hash', 'signal_hash', 'user-agent',
  ].join('|'),
  'i'
);

// ---------------------------------------------------------------------------
// Value-based redaction
// ---------------------------------------------------------------------------

// A value can carry personal data under an innocent key — a message, a stack
// frame, an error string. These run over every string that survives the key
// check.
//
// Order matters: the URL rule strips a whole query string before the narrower
// rules get a chance to leave the rest of a link intact.
const VALUE_RULES = [
  // Any URL with a query string or a fragment. Both are where this codebase's
  // single-use tokens live (?token=, #token=), so the whole tail goes rather
  // than trying to name every parameter that might be one.
  { pattern: /\b(https?:\/\/[^\s"'<>]*?)[?#][^\s"'<>]*/gi, replace: `$1?${REDACTED}` },
  // A bare token= / code= / key= pair, for a value that is not a full URL.
  {
    pattern: /\b(token|code|key|secret|password|csrf|auth|session|signature)=[^\s&"'<>]+/gi,
    replace: `$1=${REDACTED}`,
  },
  // Email addresses.
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: REDACTED },
  // Phone numbers, including the UAE forms this platform sees: +971 50 123 4567,
  // 0501234567, 971501234567. Seven or more digits with optional separators.
  { pattern: /(?<![\w.])\+?\d[\d\s().-]{6,}\d(?![\w.])/g, replace: REDACTED },
  // IPv4 addresses, in any form. No raw address is stored anywhere in this
  // system; one appearing in an error string is exactly the accident this
  // exists to catch.
  { pattern: /(?<![\w.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\w.])/g, replace: REDACTED },
  // IPv6, loosely: at least three colon-separated hex groups.
  { pattern: /(?<![\w:])(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}(?![\w:])/gi, replace: REDACTED },
  // Third-party key formats, by their published prefixes, in case one is ever
  // echoed back inside a provider's own error text.
  { pattern: /\b(sk|pk|rk|whsec|re)_[A-Za-z0-9_]{8,}/g, replace: REDACTED },
  // A Postgres connection string, with or without credentials.
  { pattern: /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, replace: REDACTED },
  // A long opaque run — a base64url token, a hex hash, a bearer value. 32+
  // characters of continuous token alphabet is not prose.
  { pattern: /(?<![\w-])[A-Za-z0-9_-]{32,}(?![\w-])/g, replace: REDACTED },
];

function scrubString(value) {
  let out = String(value);
  for (const rule of VALUE_RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

// ---------------------------------------------------------------------------
// Recursive scrub
// ---------------------------------------------------------------------------

const MAX_DEPTH = 8;
const MAX_ARRAY = 100;

// Walks anything. Redacts by key, then by value, and drops what it cannot
// reason about.
//
// `seen` guards a cycle: a Sentry event can hold a reference back to a request
// object, and an error thrown inside the scrubber would take the report path
// down with it.
function scrub(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === 'string') return scrubString(value);
  if (type === 'number' || type === 'boolean') return value;
  // A function, a symbol or a bigint in an event payload is not something this
  // understands well enough to forward.
  if (type !== 'object') return REDACTED;

  if (depth >= MAX_DEPTH) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return REDACTED;

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((item) => scrub(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) out.push(`[${value.length - MAX_ARRAY} more omitted]`);
    return out;
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(item, depth + 1, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// beforeSend
// ---------------------------------------------------------------------------

// Whole sections of a Sentry event are removed outright rather than scrubbed,
// because there is no version of them this platform needs off-site.
function scrubEvent(event) {
  if (!event || typeof event !== 'object') return null;

  const scrubbed = scrub(event);

  // Never a body, never headers, never cookies. `sendDefaultPii: false` already
  // asks the SDK not to attach most of these; this makes it true rather than
  // requested.
  if (scrubbed.request) {
    const request = scrubbed.request;
    delete request.cookies;
    delete request.headers;
    delete request.data;
    delete request.env;
    // The URL keeps its path, which is what makes an error locatable, and loses
    // its query string, which is where a token would be.
    if (typeof request.url === 'string') {
      request.url = request.url.split(/[?#]/)[0];
    }
    delete request.query_string;
  }

  // Who it happened to is not a question error reporting needs answered here.
  // The account reference is in the platform's own audit tables.
  delete scrubbed.user;
  delete scrubbed.server_name;

  return scrubbed;
}

// A breadcrumb is a log line by another name, and the console integration is
// gone precisely so that log lines do not travel. Dropped entirely rather than
// scrubbed: there is nothing in one this platform needs.
function scrubBreadcrumb() {
  return null;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let sentry = null;

// Called once, before ./app is required.
function init(Sentry, { dsn = process.env.SENTRY_DSN, environment } = {}) {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: environment || process.env.NODE_ENV || 'production',
    // No console capture. Errors reach Sentry because somebody decided this
    // particular exception should, not because it was logged.
    integrations: [],
    // Off explicitly. The default has changed between SDK majors, and this is
    // not a setting to inherit.
    sendDefaultPii: false,
    beforeSend: (event) => {
      try {
        return scrubEvent(event);
      } catch (err) {
        // A scrubber that throws must not fall through to sending the raw
        // event. Dropping it is the only safe failure.
        return null;
      }
    },
    beforeBreadcrumb: scrubBreadcrumb,
  });
  sentry = Sentry;
  return true;
}

// The deliberate capture path.
//
// `context` is scrubbed like everything else, so passing an id is safe and
// passing an address is harmless. Prefer stable identifiers: a route name, an
// operation, a record id.
function reportError(error, context = {}) {
  if (!sentry) return false;
  try {
    sentry.captureException(error, { extra: scrub(context) });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  REDACTED,
  SENSITIVE_KEY,
  VALUE_RULES,
  scrub,
  scrubString,
  scrubEvent,
  scrubBreadcrumb,
  init,
  reportError,
  // For tests, so a scrub can be exercised without a DSN.
  _setSentry: (value) => { sentry = value; },
};
