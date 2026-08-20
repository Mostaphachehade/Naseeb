// Who is making this request.
//
// Authentication is a session cookie and nothing else. There was, until this
// commit, an `Authorization: Bearer <jwt>` path: the browser held a 30-day
// self-asserting token in localStorage, and the server verified a signature
// rather than looking anything up. There is no fallback to it here, and there
// must never be one — a bearer path that still worked would mean every
// protection added around the cookie (revocation, expiry, rotation, account
// status, CSRF) could be sidestepped by sending the old header instead.
//
// Every request resolves the session from the database. There is no cached
// answer and no claim taken from the request itself: not a user id, not a role,
// not an admin flag. A client that puts `is_admin: true` in a body or a header
// is sending a field nothing reads.

const {
  tokenFromRequest,
  authenticate,
  setSessionCookie,
  clearSessionCookie,
  FAILURE,
} = require('../lib/sessions');

const SIGNED_OUT = { error: 'Sign in to continue.' };
const SESSION_ENDED = { error: 'Your session has ended. Sign in again.' };

// Attaches the resolved identity to the request, and writes a rotated cookie
// back if the session renewed itself on this request.
function attach(req, res, result) {
  req.userId = result.user.id;
  req.userName = result.user.name;
  req.sessionId = result.session.id;
  req.authUser = result.user;
  if (result.renewed) {
    setSessionCookie(res, result.renewed.token, result.renewed.expiresAt);
  }
}

// Anything that is not a live session is a 401, with the cookie cleared so a
// browser stops presenting a token that will never work again. The one
// exception is a database failure, which is a 503: "we cannot tell" is not the
// same answer as "you are not signed in", and telling a signed-in user to sign
// in again because Postgres blipped would be both wrong and confusing.
function refuse(req, res, reason) {
  if (reason === FAILURE.ERROR) {
    return res.status(503).json({
      error: 'We could not verify your session just now. Please try again shortly.',
      code: 'SESSION_CHECK_UNAVAILABLE',
    });
  }
  clearSessionCookie(res);
  return res.status(401).json(reason === FAILURE.NO_TOKEN ? SIGNED_OUT : SESSION_ENDED);
}

async function requireAuth(req, res, next) {
  const result = await authenticate(tokenFromRequest(req));
  if (!result.ok) return refuse(req, res, result.reason);
  attach(req, res, result);
  return next();
}

// Attaches an identity when there is one, and carries on regardless. Used by
// the public giveaway page, which shows "you already entered" to a signed-in
// visitor and the same page to everyone else.
//
// A database failure is NOT swallowed here either: silently continuing as
// anonymous would render a signed-in person a signed-out page, which reads as
// "you were logged out" rather than "something is broken".
async function optionalAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return next();

  const result = await authenticate(token);
  if (result.ok) {
    attach(req, res, result);
    return next();
  }
  if (result.reason === FAILURE.ERROR) return refuse(req, res, result.reason);

  // A dead session on an optional route is simply an anonymous visitor — but
  // the stale cookie goes, so the browser stops sending it.
  clearSessionCookie(res);
  return next();
}

// There is still no role system beyond this one flag, and it is still read from
// the database on the request that needs it — never from the session, which
// could otherwise keep asserting an administrator long after the flag changed.
async function requireAdmin(req, res, next) {
  const result = await authenticate(tokenFromRequest(req));
  if (!result.ok) return refuse(req, res, result.reason);

  if (!result.user.is_admin) {
    attach(req, res, result);
    return res.status(403).json({ error: "You don't have access to this page." });
  }

  attach(req, res, result);
  return next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
