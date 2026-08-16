// CSRF protection for cookie-authenticated requests.
//
// The moment authentication moved from an `Authorization` header to a cookie,
// it became ambient: the browser attaches it to any request to this origin,
// including one a completely unrelated site caused. A header-based token was
// immune to that by construction — an attacker's page cannot set a header on a
// cross-site request. A cookie is not, so the immunity has to be rebuilt
// deliberately rather than assumed.
//
// Two independent checks, both before any route handler runs, so nothing is
// written to the database by a request that is about to be refused:
//
//   1. Origin (or Referer) must be this site, for every unsafe request.
//   2. A CSRF token in a custom header must match the active session, for every
//      unsafe request that carries a session cookie.
//
// SameSite=Lax on the cookie is a third layer. It is not relied on alone: it is
// a browser behaviour, it has had bypasses, and "the browser will refuse to
// send the cookie" is not something a server can verify.

const crypto = require('crypto');
const { tokenFromRequest, hashToken } = require('./sessions');

const CSRF_HEADER = 'x-csrf-token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Never in a URL, so it cannot end up in an access log, a Referer header sent
// to a third party, a browser history entry or a shared link. Header only.
// Never in localStorage either — the frontend holds it in a module variable
// that dies with the page, so a stored copy cannot outlive the session.

function signingKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // server/index.js refuses to start without this in production. Reaching
    // here means a misconfigured non-production process, and the safe answer is
    // to make every token invalid rather than to sign with a guessable key.
    return null;
  }
  return secret;
}

// The token is an HMAC over the session id, not a random value stored beside
// it. That ties it cryptographically to one session with nothing extra
// persisted: a token issued for session A cannot validate against session B,
// and when a session is revoked or rotated its id stops resolving, so every
// token derived from it stops working at the same instant.
function tokenForSession(sessionId) {
  const key = signingKey();
  if (!key || !sessionId) return null;
  return crypto.createHmac('sha256', key).update(`csrf:${sessionId}`).digest('base64url');
}

function matches(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  // Length check first: timingSafeEqual throws on a mismatch, and a length
  // difference is not secret anyway.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

function configuredOrigin() {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  try {
    return new URL(appUrl).origin;
  } catch {
    return null;
  }
}

function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Checks Origin, falling back to Referer when a browser sent only that.
//
// A request carrying neither is not a cross-site browser request — every major
// browser sends Origin on cross-site POST, including form submissions — so it
// is allowed through to the token check rather than blocked. Non-browser
// callers (curl, the test suite, a future server-to-server client) live in that
// gap, and they have no cookie to abuse.
function originAllowed(req) {
  const expected = configuredOrigin();
  if (!expected) return { allowed: false, reason: 'APP_URL is not a valid origin' };

  const origin = req.headers.origin;
  if (origin) {
    // "null" is what a sandboxed iframe or a redirected cross-origin request
    // sends. It is not this site.
    if (origin === 'null') return { allowed: false, reason: 'opaque origin' };
    return originOf(origin) === expected
      ? { allowed: true }
      : { allowed: false, reason: 'origin mismatch' };
  }

  const referer = req.headers.referer;
  if (referer) {
    return originOf(referer) === expected
      ? { allowed: true }
      : { allowed: false, reason: 'referer mismatch' };
  }

  return { allowed: true, reason: 'no origin or referer supplied' };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Mounted once, in front of every API router.
//
// Deliberately NOT mounted in front of /api/webhooks. Stripe signs the exact
// bytes of its request body and has no way to know a CSRF token; its
// authentication is that signature, checked in server/routes/webhooks.js
// against the raw body. Adding a CSRF requirement there would break every
// webhook and add nothing — Stripe's POST is not a browser request and carries
// no cookie, so there is no ambient authority to abuse. That exclusion is by
// mount point, so it covers exactly that path and nothing else.
//
// Nothing else is excluded. In particular there is no blanket exemption for
// "anonymous" routes: the rule is that the token is required whenever a session
// cookie is present, which is precisely when a cross-site request would carry
// authority. A request with no cookie has nothing to steal.
function csrfProtection(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const origin = originAllowed(req);
  if (!origin.allowed) {
    return res.status(403).json({
      error: 'This request did not come from Naseeb.',
      code: 'ORIGIN_NOT_ALLOWED',
    });
  }

  const sessionToken = tokenFromRequest(req);
  if (!sessionToken) return next();

  // The expected value depends on which session this cookie names, so it is
  // resolved from the database rather than trusted from the request. requireAuth
  // has not run yet — that is the point, this must refuse before any handler
  // touches the database — so the session is looked up from the token hash here.
  //
  // Note the missing-header check happens *after* that lookup, not before.
  // Doing it first would mean a browser holding a stale or unknown cookie could
  // not sign in: the login POST would be refused for lacking a CSRF token it
  // has no way to obtain, and the only escape would be clearing cookies by
  // hand. A cookie that names no session carries no authority, so there is
  // nothing for CSRF to protect.
  req.csrfCheck = { sessionToken, provided: req.headers[CSRF_HEADER] };
  return verifyAgainstSession(req, res, next);
}

const { pool } = require('../db');

async function verifyAgainstSession(req, res, next) {
  try {
    const { sessionToken, provided } = req.csrfCheck;
    const result = await pool.query(
      `SELECT id, expires_at, revoked_at, replaced_by_session_id, revocation_reason,
              rotation_grace_until
         FROM sessions WHERE token_hash = $1`,
      [hashToken(sessionToken)]
    );
    const row = result.rows[0];
    if (!row) {
      // No session behind the cookie: there is no ambient authority to protect,
      // and requireAuth will refuse the request on its own merits.
      return next();
    }

    if (!provided) {
      return res.status(403).json({
        error: 'Your page is out of date. Reload and try again.',
        code: 'CSRF_TOKEN_MISSING',
      });
    }

    // A token minted for the session this cookie names. During a rotation grace
    // window the successor's token is the live one, so both are accepted —
    // otherwise a tab that rotated a moment ago would fail CSRF on its next
    // request while holding a perfectly good session.
    const candidates = [tokenForSession(row.id)];
    if (row.replaced_by_session_id) candidates.push(tokenForSession(row.replaced_by_session_id));

    const ok = candidates.some((expected) => matches(expected, provided));
    if (!ok) {
      return res.status(403).json({
        error: 'Your page is out of date. Reload and try again.',
        code: 'CSRF_TOKEN_INVALID',
      });
    }
    return next();
  } catch (err) {
    // Fails closed: an unverifiable CSRF token is a refused request, not an
    // accepted one.
    console.error('CSRF verification failed:', err.message);
    return res.status(503).json({
      error: 'We could not verify this request. Please try again shortly.',
      code: 'CSRF_CHECK_UNAVAILABLE',
    });
  }
}

module.exports = {
  CSRF_HEADER,
  UNSAFE_METHODS,
  csrfProtection,
  tokenForSession,
  originAllowed,
  configuredOrigin,
};
