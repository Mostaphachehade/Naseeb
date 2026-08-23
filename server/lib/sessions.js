// Browser sessions: opaque tokens in an HttpOnly cookie, hashes in Postgres.
//
// What this replaces: a 30-day JWT written to localStorage and sent back as an
// `Authorization: Bearer` header. Three things were wrong with that at once.
// Any script on the page could read it — one XSS anywhere on the site handed an
// attacker a month of somebody's account. It could not be revoked: signing out
// deleted the browser's copy and nothing else, so a copied token kept working
// for its full 30 days, and a password reset did not end a single existing
// session. And the token asserted its own claims, so the server had no record
// that a session existed at all, let alone the ability to end one.
//
// Now: a random 256-bit token, stored only as a SHA-256 hash, delivered only in
// an HttpOnly cookie the page's JavaScript cannot read, with a row in Postgres
// that can be expired, revoked or rotated at any moment.
//
// The raw token exists in exactly three places: the bytes returned by
// crypto.randomBytes, the Set-Cookie header, and the browser's cookie jar. It is
// never written to the database, a log line, a URL, an email, an API body, or
// any JavaScript-readable storage.

const crypto = require('crypto');
const { pool } = require('../db');

const SESSION_COOKIE = 'naseeb_session';

// 32 random bytes. Not derived from anything about the user, so a token reveals
// nothing and two users' tokens cannot collide in any useful way.
const TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

// Twelve hours, down from thirty days.
//
// The judgement: the sensitive things an account can do here are publishing a
// giveaway, drawing a winner, reading a winner's home address, and — for an
// administrator — everything. Thirty days of ambient authority sitting in a
// browser is indefensible for any of those, and it was chosen originally
// because it was the JWT library's convenient default rather than because
// anyone decided a month was the right answer.
//
// Twelve hours means a stolen session dies the same day, and a returning
// visitor signs in about once a day. It is configurable because the right
// number depends on support burden the owner can see and I cannot — but it is
// bounded, so a value cannot be set that quietly restores the old behaviour.
const DEFAULT_TTL_HOURS = 12;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 168; // seven days, the most this will ever issue

// How long one token value stays in use before the next request swaps it for a
// fresh one. Rotation does not extend the session — the expiry is fixed at
// creation — it just shortens the window in which any single captured token is
// worth anything.
const DEFAULT_ROTATE_AFTER_MINUTES = 240;
const MIN_ROTATE_AFTER_MINUTES = 5;

// After a rotation the replaced token keeps working for a moment.
//
// Without this, two browser tabs that both fire a request the instant a
// rotation is due would race: one rotates, the other presents the token that
// was valid when it started and gets signed out through no fault of anyone's.
// A minute is long enough to cover every request already in flight and short
// enough that a captured old token is not a durable credential.
const ROTATION_GRACE_MS = 60 * 1000;

// Writing last_used_at on literally every request would mean a write per page
// view for a column nothing reads more precisely than "roughly when".
const LAST_USED_THROTTLE_SECONDS = 60;

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function ttlHours() {
  return bounded(process.env.SESSION_TTL_HOURS, DEFAULT_TTL_HOURS, MIN_TTL_HOURS, MAX_TTL_HOURS);
}

function ttlMs() {
  return ttlHours() * 60 * 60 * 1000;
}

function rotateAfterMs() {
  return (
    bounded(
      process.env.SESSION_ROTATE_AFTER_MINUTES,
      DEFAULT_ROTATE_AFTER_MINUTES,
      MIN_ROTATE_AFTER_MINUTES,
      MAX_TTL_HOURS * 60
    ) *
    60 *
    1000
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function issueToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// SHA-256 rather than bcrypt deliberately. A session token is 256 bits of
// uniform randomness, so there is no dictionary to attack and nothing for a
// slow hash to buy; what matters is that a database dump does not contain
// anything usable as a credential, which a fast one-way hash gives just as well
// and without a per-request bcrypt cost.
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

// Express has res.cookie/res.clearCookie built in, but req.cookies needs a
// parser. This is that parser, kept here rather than as a dependency because it
// is nine lines and reads one header.
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  header.split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const name = part.slice(0, eq).trim();
    if (!name) return;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape is a malformed cookie, not a session.
    }
  });
  return out;
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// Secure is on in production, always. Outside production it follows
// COOKIE_SECURE, which exists so a developer on plain http://localhost can sign
// in — a Secure cookie is simply not sent over http, so without this the whole
// app is unusable locally. Production cannot opt out: see assertCookieSecurity.
function cookieSecure() {
  if (isProduction()) return true;
  return String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
}

// Lax, not Strict, and the difference matters here.
//
// Strict would mean that following the link in a verification email, a claim
// invitation, or any link shared to WhatsApp lands the visitor on a page that
// believes they are signed out — the cookie is withheld on the very first
// cross-site navigation. Lax withholds it on cross-site POST, which is the
// case CSRF cares about, and sends it on top-level GET navigation, which is the
// case those emails depend on. The CSRF token in server/lib/csrf.js is what
// actually defends state-changing requests; SameSite is a second layer, not the
// only one.
const SAME_SITE = 'lax';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: SAME_SITE,
    secure: cookieSecure(),
    path: '/',
    maxAge: maxAgeMs,
  };
}

function setSessionCookie(res, token, expiresAt) {
  // Expiry on the cookie is derived from the row's expiry, so the browser stops
  // sending a token at the same moment the server stops honouring it rather
  // than some approximation of it.
  const maxAge = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  res.cookie(SESSION_COOKIE, token, cookieOptions(maxAge));
}

// Cleared with the same attributes it was set with — a mismatched Path or
// SameSite leaves the original cookie in place and the browser keeps sending it.
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: SAME_SITE,
    secure: cookieSecure(),
    path: '/',
  });
  // Belt and braces: an explicitly expired empty value, so a browser that is
  // fussy about clearCookie's exact form still drops it.
  res.cookie(SESSION_COOKIE, '', { ...cookieOptions(0), expires: new Date(0) });
}

function tokenFromRequest(req) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw || typeof raw !== 'string') return null;
  // A token is base64url of 32 bytes: 43 characters. Anything else is not one,
  // and rejecting it here keeps malformed input away from a database query.
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(raw)) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

const REVOCATION = {
  LOGOUT: 'logout',
  ROTATED: 'rotated',
  PASSWORD_RESET: 'password_reset',
  ACCOUNT_SUSPENDED: 'account_suspended',
  ADMIN_REVOKED: 'admin_revoked',
  // The address the account is reached at changed. Every existing sign-in ends,
  // including the one that made the change: the whole risk being defended
  // against is a stolen session quietly moving the recovery address.
  EMAIL_CHANGED: 'email_changed',
};

// Deliberately stores no IP address and no user-agent string.
//
// Neither is used by anything here — there is no "sign out my other devices"
// screen listing them and no anomaly detection reading them — so storing them
// would be collecting identifiable data to display to nobody. If a device list
// is ever built, that is the moment to decide what minimal, hashed metadata it
// needs, not before.
async function createSession(client, { userId }) {
  const token = issueToken();
  const familyId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs());

  // The family carries the absolute expiry. Nothing ever moves it, so no amount
  // of rotation can extend the life of one sign-in — and that is a property of
  // where the value lives, not of every caller remembering to copy it.
  await client.query(
    `INSERT INTO session_families (id, user_id, absolute_expires_at) VALUES ($1, $2, $3)`,
    [familyId, userId, expiresAt]
  );
  await client.query(
    `INSERT INTO sessions (id, family_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, familyId, userId, hashToken(token), expiresAt]
  );

  return { id, familyId, token, userId, expiresAt };
}

// ---------------------------------------------------------------------------
// Authenticating
// ---------------------------------------------------------------------------

const FAILURE = {
  NO_TOKEN: 'no_token',
  UNKNOWN: 'unknown',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  ACCOUNT_UNAVAILABLE: 'account_unavailable',
  ERROR: 'error',
};

// Resolves a raw cookie value to a session and its account, or explains why not.
//
// Every rejection reason returns the same shape so a caller cannot accidentally
// treat "database is down" as "signed out" — the middleware distinguishes them,
// and an error fails closed rather than falling through to anonymous access.
//
// Returns { ok, session, user, renewed } where `renewed` is a fresh
// { token, expiresAt } the caller must write back as a cookie.
async function authenticate(rawToken, { client = pool } = {}) {
  if (!rawToken) return { ok: false, reason: FAILURE.NO_TOKEN };

  let row;
  try {
    const result = await client.query(
      `SELECT s.id, s.family_id, s.user_id, s.created_at, s.revoked_at, s.revocation_reason,
              s.rotation_grace_until, s.last_used_at,
              f.absolute_expires_at, f.revoked_at AS family_revoked_at,
              u.id AS account_id, u.name, u.email, u.is_admin, u.email_verified, u.account_status
         FROM sessions s
         JOIN session_families f ON f.id = s.family_id
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hashToken(rawToken)]
    );
    row = result.rows[0];
  } catch (err) {
    // Fails closed. An unreadable session is not a valid one, and it is also
    // not an anonymous request — the caller must not carry on as if nobody was
    // signed in when it does not actually know.
    console.error('Session lookup failed:', err.message);
    return { ok: false, reason: FAILURE.ERROR };
  }

  if (!row) return { ok: false, reason: FAILURE.UNKNOWN };

  const now = Date.now();

  // The family's expiry is the authority, not the row's copy of it. A row can
  // only ever have been written with the family's value, and reading the family
  // means no rotation — however many — can push the end of a sign-in outwards.
  if (new Date(row.absolute_expires_at).getTime() <= now) {
    return { ok: false, reason: FAILURE.EXPIRED };
  }

  // One check for the whole logical session. Whether this particular row is the
  // current token or a predecessor inside its grace window, a revoked family is
  // revoked — which is what makes logout, password reset, suspension and
  // administrative revocation apply to every token that login ever produced.
  if (row.family_revoked_at) return { ok: false, reason: FAILURE.REVOKED };

  // The account behind the session, checked every time. A deleted account has
  // no row; a suspended or deactivated one is not allowed to hold a session.
  // Note this is users.account_status, NOT users.host_status: losing permission
  // to host is an authorization change and must not sign anybody out of the
  // account they enter giveaways with.
  if (!row.account_id) return { ok: false, reason: FAILURE.ACCOUNT_UNAVAILABLE };
  if (row.account_status && row.account_status !== 'active') {
    return { ok: false, reason: FAILURE.ACCOUNT_UNAVAILABLE };
  }

  if (row.revoked_at) {
    // One exception, and only one: a token replaced by a rotation stays usable
    // for the grace window, so requests already in flight when the swap
    // happened do not fail. Anything else revoked is simply revoked.
    const withinGrace =
      row.revocation_reason === REVOCATION.ROTATED &&
      row.rotation_grace_until &&
      new Date(row.rotation_grace_until).getTime() > now;

    if (!withinGrace) return { ok: false, reason: FAILURE.REVOKED };

    // Authenticated as the family's current live member rather than by
    // following one link in the chain, so this holds however many rotations
    // have happened since. The partial unique index on (family_id) WHERE
    // revoked_at IS NULL guarantees there is at most one.
    const live = await client.query(
      `SELECT id FROM sessions WHERE family_id = $1 AND revoked_at IS NULL`,
      [row.family_id]
    );
    if (!live.rows[0]) return { ok: false, reason: FAILURE.REVOKED };

    return {
      ok: true,
      session: {
        id: live.rows[0].id,
        familyId: row.family_id,
        userId: row.user_id,
        expiresAt: row.absolute_expires_at,
      },
      user: userView(row),
      // No new token: the browser that performed the rotation already has it.
      // This request is simply a straggler holding the previous one.
      renewed: null,
    };
  }

  const session = {
    id: row.id,
    familyId: row.family_id,
    userId: row.user_id,
    expiresAt: row.absolute_expires_at,
  };

  if (now - new Date(row.created_at).getTime() >= rotateAfterMs()) {
    const renewed = await rotateSession(row.id);
    if (renewed) {
      return {
        ok: true,
        session: {
          id: renewed.id,
          familyId: row.family_id,
          userId: row.user_id,
          expiresAt: renewed.expiresAt,
        },
        user: userView(row),
        renewed: { token: renewed.token, expiresAt: renewed.expiresAt },
      };
    }
    // Rotation declined, which means one of two very different things: the
    // family was revoked while this request was in flight, or another request
    // rotated first and this one is now holding a predecessor. Both have to be
    // re-resolved from the database rather than guessed at — the first is a
    // 401, and the second is the ordinary grace case that exists precisely so
    // ten tabs firing at once do not sign anybody out.
    const recheck = await client.query(
      `SELECT s.revoked_at, s.revocation_reason, s.rotation_grace_until,
              (SELECT live.id FROM sessions live
                WHERE live.family_id = s.family_id AND live.revoked_at IS NULL) AS live_id
         FROM sessions s WHERE s.id = $1`,
      [row.id]
    );
    const state = recheck.rows[0];
    if (!state) return { ok: false, reason: FAILURE.REVOKED };

    if (state.revoked_at) {
      const stillInGrace =
        state.revocation_reason === REVOCATION.ROTATED &&
        state.rotation_grace_until &&
        new Date(state.rotation_grace_until).getTime() > Date.now() &&
        state.live_id;
      if (!stillInGrace) return { ok: false, reason: FAILURE.REVOKED };

      return {
        ok: true,
        session: {
          id: state.live_id,
          familyId: row.family_id,
          userId: row.user_id,
          expiresAt: row.absolute_expires_at,
        },
        user: userView(row),
        // The request that won the rotation already has the new token.
        renewed: null,
      };
    }
  }

  await touch(client, row.id, row.last_used_at);
  return { ok: true, session, user: userView(row), renewed: null };
}

function userView(row) {
  return {
    id: row.account_id,
    name: row.name,
    email: row.email,
    is_admin: row.is_admin,
    email_verified: row.email_verified,
    account_status: row.account_status,
  };
}

async function touch(client, sessionId, lastUsedAt) {
  const stale =
    !lastUsedAt || Date.now() - new Date(lastUsedAt).getTime() > LAST_USED_THROTTLE_SECONDS * 1000;
  if (!stale) return;
  try {
    await client.query('UPDATE sessions SET last_used_at = NOW() WHERE id = $1', [sessionId]);
  } catch (err) {
    // Bookkeeping. A failure here must not fail an otherwise valid request.
    console.error('Could not update session last_used_at:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Rotating
// ---------------------------------------------------------------------------

// Swaps a session's token for a new one, atomically and at most once.
//
// The row is locked for the whole operation and the successor is recorded on
// it, so two concurrent requests that both decide a rotation is due do not
// produce two successors: the second sees replaced_by_session_id already set
// and returns null rather than minting a second valid token.
//
// The expiry does NOT move. Rotation shortens the life of a token value; it is
// not a way to keep a session alive indefinitely by using it.
async function rotateSession(sessionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The family row is locked FIRST, and every revocation path locks the same
    // row before revoking. That single ordering is what closes the race this
    // amendment exists for: a rotation and a logout can no longer interleave so
    // that the logout revokes a row the rotation has already replaced, leaving
    // the successor alive. Whichever takes the lock first wins, and the loser
    // sees the winner's committed state.
    const family = await client.query(
      `SELECT id, revoked_at, absolute_expires_at
         FROM session_families WHERE id = (SELECT family_id FROM sessions WHERE id = $1)
        FOR UPDATE`,
      [sessionId]
    );
    const fam = family.rows[0];
    if (!fam || fam.revoked_at || new Date(fam.absolute_expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return null;
    }

    const locked = await client.query(
      `SELECT id, family_id, user_id, revoked_at, replaced_by_session_id
         FROM sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const current = locked.rows[0];
    if (!current || current.revoked_at || current.replaced_by_session_id) {
      await client.query('ROLLBACK');
      return null;
    }

    const token = issueToken();
    const newId = crypto.randomUUID();

    // Three statements, in this order, and the order is load-bearing.
    //
    // The predecessor is revoked FIRST because the partial unique index on
    // (family_id) WHERE revoked_at IS NULL allows a family at most one live
    // row: inserting the successor while the predecessor was still live would
    // be rejected by the database. That is the point — the invariant does not
    // depend on this function being written correctly.
    //
    // The back-pointer is set LAST because it references a row that does not
    // exist until the insert. (Deferring the foreign key would also work; a
    // third statement is plainer than a deferred constraint.)
    await client.query(
      `UPDATE sessions
          SET revoked_at = NOW(), revocation_reason = $2,
              rotation_grace_until = NOW() + ($3 || ' milliseconds')::interval
        WHERE id = $1`,
      [current.id, REVOCATION.ROTATED, String(ROTATION_GRACE_MS)]
    );

    // The successor inherits the family's absolute expiry rather than getting a
    // fresh one, so a busy user cannot roll a twelve-hour session forward for
    // ever.
    await client.query(
      `INSERT INTO sessions (id, family_id, user_id, token_hash, expires_at, rotated_from_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId, current.family_id, current.user_id, hashToken(token), fam.absolute_expires_at, current.id]
    );

    await client.query('UPDATE sessions SET replaced_by_session_id = $2 WHERE id = $1', [
      current.id,
      newId,
    ]);

    await client.query('COMMIT');
    return { id: newId, familyId: current.family_id, token, expiresAt: fam.absolute_expires_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A unique-violation here means another connection rotated the same family
    // first. That is the constraint doing its job, not a fault.
    if (err.code !== '23505') {
      console.error('Session rotation failed:', err.message);
    }
    return null;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Revoking
// ---------------------------------------------------------------------------

// Ends one logical session — every token that login has produced or is about to.
//
// Locks the family row first, in the same order rotateSession takes it, so a
// rotation cannot slip a fresh successor past a revocation that is already
// under way. Rows that were revoked by a rotation keep their own
// `revocation_reason` so the chain stays readable; what they lose is their
// grace window, and the family-level record says who ended the session and why.
async function revokeFamily(client, familyId, reason) {
  const family = await client.query(
    `SELECT id, revoked_at FROM session_families WHERE id = $1 FOR UPDATE`,
    [familyId]
  );
  if (!family.rows[0]) return false;

  const alreadyRevoked = Boolean(family.rows[0].revoked_at);
  if (!alreadyRevoked) {
    await client.query(
      `UPDATE session_families SET revoked_at = NOW(), revocation_reason = $2 WHERE id = $1`,
      [familyId, reason]
    );
  }

  await client.query(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, NOW()),
            revocation_reason = CASE WHEN revoked_at IS NULL THEN $2 ELSE revocation_reason END,
            rotation_grace_until = NULL
      WHERE family_id = $1`,
    [familyId, reason]
  );

  return !alreadyRevoked;
}

// Resolves whichever token was presented to its family, then ends the family.
// Works identically whether the caller holds the current token or a predecessor
// still inside its grace window.
async function revokeFamilyForSession(client, sessionId, reason) {
  const found = await client.query('SELECT family_id FROM sessions WHERE id = $1', [sessionId]);
  if (!found.rows[0]) return false;
  return revokeFamily(client, found.rows[0].family_id, reason);
}

// Every live family for one account, gone at once. The single call behind
// signing out everywhere, a password reset, an account suspension and an
// administrator pulling the plug — one implementation, so none of them can
// quietly do less than the others.
//
// Returns the number of logical sessions ended, not the number of rows touched:
// a family that had rotated five times is one session a person would recognise.
async function revokeAllForUser(client, userId, reason) {
  const families = await client.query(
    `SELECT id FROM session_families WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE`,
    [userId]
  );
  let ended = 0;
  for (const row of families.rows) {
    // eslint-disable-next-line no-await-in-loop -- ordered, and these are few
    if (await revokeFamily(client, row.id, reason)) ended += 1;
  }
  return ended;
}

// Housekeeping only. Expired rows are already refused by authenticate(); this
// keeps the table from growing without bound.
async function deleteExpiredSessions(client = pool, { olderThanDays = 30, limit = null } = {}) {
  // Families, not rows: a family cascades to its members, so a rotation chain
  // is removed whole rather than leaving orphaned predecessors behind.
  //
  // Bounded when a limit is given, which is how the scheduled job calls it: a
  // single DELETE across a year of accumulated families holds locks for as long
  // as it takes and times out having achieved nothing. The caller re-runs until
  // a pass returns less than the limit.
  //
  // Scheduled by scripts/maintenance.js — see docs/OPERATIONS.md. It used to
  // have no caller at all.
  const result = await client.query(
    `DELETE FROM session_families
      WHERE id IN (
        SELECT id FROM session_families
         WHERE absolute_expires_at < NOW() - ($1 || ' days')::interval
         LIMIT $2
      )
      RETURNING id`,
    [String(olderThanDays), limit && limit > 0 ? Math.floor(limit) : 100000]
  );
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

// Production must not run with a session cookie that a network observer can
// read. Called from server/index.js, which exits rather than starting.
function assertCookieSecurity() {
  const problems = [];
  if (!isProduction()) return problems;

  if (String(process.env.COOKIE_SECURE || '').toLowerCase() === 'false') {
    problems.push('COOKIE_SECURE=false is not allowed in production.');
  }
  const appUrl = process.env.APP_URL || '';
  if (!appUrl.startsWith('https://')) {
    problems.push(
      'APP_URL must be an https:// origin in production — a Secure cookie is never sent over http.'
    );
  }
  return problems;
}

// SESSION_SECRET signs every CSRF token. A guessable one means an attacker can
// mint a valid token for a session id they can guess or observe, which is the
// whole defence gone — so this refuses a value that is absent, short, a
// placeholder, or too repetitive to be random.
//
// There is deliberately NO default and no fallback to any other variable. A
// secret with a built-in value is a secret every deployment shares, and one
// that quietly falls back to JWT_SECRET or APP_URL would be a public value
// signing a private thing. When it is missing, csrf.js issues no token at all
// and every state-changing request is refused — failing closed rather than
// failing open on a guessable key.
//
// Only the variable NAME appears in anything this returns. The value is never
// echoed, logged, hashed into a message, or length-reported beyond "shorter
// than 32 characters".
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRETS = [
  /^change[-_ ]?(this|me)/i,
  /^your[-_ ]?secret/i,
  /^(secret|password|changeme|placeholder|example|sample|todo)$/i,
  /test[-_ ]?only/i,
  /not[-_ ]?valid[-_ ]?outside/i,
  /^[a-z0-9]{0,8}$/i,
];

function assertSessionSecret() {
  const problems = [];
  const secret = process.env.SESSION_SECRET || '';

  if (!secret) {
    problems.push('SESSION_SECRET is not set — CSRF tokens cannot be signed.');
    return problems;
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters.`);
  }
  if (PLACEHOLDER_SECRETS.some((pattern) => pattern.test(secret))) {
    problems.push('SESSION_SECRET looks like a placeholder or example value.');
  }
  // A long string of one repeated character passes a length check and is not a
  // secret. Not an entropy estimate — just a floor no real random value fails.
  if (new Set(secret).size < 8) {
    problems.push('SESSION_SECRET has too few distinct characters to be random.');
  }
  // A secret that is also some other, less-protected variable is not a secret.
  ['JWT_SECRET', 'APP_URL', 'DATABASE_URL', 'STRIPE_SECRET_KEY', 'CLAIM_ENCRYPTION_KEY'].forEach(
    (name) => {
      if (process.env[name] && process.env[name] === secret) {
        problems.push(`SESSION_SECRET must not be the same value as ${name}.`);
      }
    }
  );
  return problems;
}

module.exports = {
  SESSION_COOKIE,
  REVOCATION,
  FAILURE,
  ttlHours,
  ttlMs,
  rotateAfterMs,
  ROTATION_GRACE_MS,
  hashToken,
  parseCookies,
  tokenFromRequest,
  cookieSecure,
  cookieOptions,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  authenticate,
  rotateSession,
  revokeFamily,
  revokeFamilyForSession,
  revokeAllForUser,
  deleteExpiredSessions,
  assertCookieSecurity,
  assertSessionSecret,
  MIN_SECRET_LENGTH,
  isProduction,
};
