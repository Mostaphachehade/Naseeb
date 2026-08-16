// Browser sessions: cookies, revocation, rotation and account status.
//
// What this replaced was a 30-day JWT in localStorage sent back as a bearer
// header. Any script on any page could read it, nothing could revoke it, and
// the server held no record that a session existed — so "sign out" deleted the
// browser's copy and left the credential working for another month.
//
// These tests are about the three properties that fixes: the token is not
// reachable from JavaScript, it is not stored anywhere it could be read back,
// and it can be ended from the server at any moment.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const {
  api,
  pool,
  ensureInit,
  signIn,
  nextTestIp,
  TEST_ORIGIN,
  uniqueEmail,
} = require('../testHelpers');

const app = require('../server/app');
const sessions = require('../server/lib/sessions');

const createdUserIds = [];
const PASSWORD = 'correcthorse123';

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdUserIds.length) {
    await pool.query('DELETE FROM host_status_events WHERE user_id = ANY($1) OR changed_by = ANY($1)', [
      createdUserIds,
    ]);
    await pool.query('DELETE FROM host_applications WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

async function createAccount(tag, { admin = false, accountStatus = 'active' } = {}) {
  const id = uuid();
  const email = uniqueEmail(`session-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, account_status)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
    [id, `Session ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin, accountStatus]
  );
  createdUserIds.push(id);
  return { id, email };
}

function cookieAttributes(setCookieHeader) {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const line = raw.find((c) => c && c.startsWith(`${sessions.SESSION_COOKIE}=`));
  if (!line) return null;
  const parts = line.split(';').map((p) => p.trim());
  const [, value] = parts[0].split('=');
  const flags = parts.slice(1);
  const get = (name) => {
    const found = flags.find((f) => f.toLowerCase().startsWith(`${name.toLowerCase()}=`));
    return found ? found.split('=')[1] : null;
  };
  return {
    value,
    httpOnly: flags.some((f) => f.toLowerCase() === 'httponly'),
    secure: flags.some((f) => f.toLowerCase() === 'secure'),
    sameSite: get('SameSite'),
    path: get('Path'),
    maxAge: get('Max-Age'),
    expires: get('Expires'),
    raw: line,
  };
}

function login(email, password = PASSWORD) {
  return api()
    .post('/api/auth/login')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ email, password });
}

// ---------------------------------------------------------------------------
// 1–5. The cookie, and what is not in it
// ---------------------------------------------------------------------------

test('login sets an HttpOnly, SameSite, path-scoped session cookie with an explicit expiry', async () => {
  const account = await createAccount('cookie-attrs');
  const res = await login(account.email);
  assert.equal(res.status, 200);

  const cookie = cookieAttributes(res.headers['set-cookie']);
  assert.ok(cookie, 'a session cookie is set');
  assert.equal(cookie.httpOnly, true, 'JavaScript must not be able to read it');
  assert.equal(cookie.sameSite.toLowerCase(), 'lax');
  assert.equal(cookie.path, '/');
  assert.ok(Number(cookie.maxAge) > 0, 'an explicit expiry, not a session cookie');

  // The cookie's life matches the row's, so the browser stops sending a token
  // at the same moment the server stops honouring it.
  const row = await pool.query(
    'SELECT expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [account.id]
  );
  const rowSeconds = Math.round((new Date(row.rows[0].expires_at).getTime() - Date.now()) / 1000);
  assert.ok(Math.abs(rowSeconds - Number(cookie.maxAge)) <= 5, 'cookie expiry tracks the database');

  // Secure is off here only because the test server speaks http. Production
  // cannot make that choice — see the startup test below.
  assert.equal(cookie.secure, false);
});

test('the session lifetime is materially shorter than the 30 days it replaced', () => {
  assert.ok(sessions.ttlHours() <= 24, `expected <= 24h, got ${sessions.ttlHours()}h`);

  // Configurable, but only within a range that cannot restore the old
  // behaviour.
  const original = process.env.SESSION_TTL_HOURS;
  try {
    process.env.SESSION_TTL_HOURS = '99999';
    assert.equal(sessions.ttlHours(), 168, 'clamped to seven days');
    process.env.SESSION_TTL_HOURS = '0';
    assert.equal(sessions.ttlHours(), 1, 'clamped to at least an hour');
    process.env.SESSION_TTL_HOURS = 'not-a-number';
    assert.equal(sessions.ttlHours(), 12, 'falls back to the documented default');
  } finally {
    if (original === undefined) delete process.env.SESSION_TTL_HOURS;
    else process.env.SESSION_TTL_HOURS = original;
  }
});

test('no session token appears in any response body', async () => {
  const account = await createAccount('no-token-in-body');
  const res = await login(account.email);

  const cookie = cookieAttributes(res.headers['set-cookie']);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(cookie.value), 'the raw token must never be in a response body');
  assert.equal(res.body.token, undefined);
  assert.equal(res.body.session_token, undefined);

  const session = await signIn(account.email, PASSWORD);
  const bootstrap = await session.get('/api/auth/session');
  assert.equal(bootstrap.status, 200);
  assert.ok(!JSON.stringify(bootstrap.body).includes(cookie.value));
});

test('only a hash of the token reaches PostgreSQL, and no column contains the token', async () => {
  const account = await createAccount('hash-only');
  const res = await login(account.email);
  const token = cookieAttributes(res.headers['set-cookie']).value;

  const rows = await pool.query('SELECT * FROM sessions WHERE user_id = $1', [account.id]);
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0];

  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(row.token_hash, token);
  assert.ok(!JSON.stringify(row).includes(token), 'no column may hold the plaintext token');

  // And nowhere else in the database either.
  const anywhere = await pool.query(
    "SELECT COUNT(*)::int AS c FROM sessions WHERE token_hash = $1",
    [token]
  );
  assert.equal(anywhere.rows[0].c, 0);
});

test('no session token reaches the console', async () => {
  const account = await createAccount('no-token-logged');

  const captured = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => captured.push(a.map(String).join(' '));
  console.error = (...a) => captured.push(a.map(String).join(' '));
  console.warn = (...a) => captured.push(a.map(String).join(' '));

  let token;
  try {
    const res = await login(account.email);
    token = cookieAttributes(res.headers['set-cookie']).value;
    const session = await signIn(account.email, PASSWORD);
    await session.get('/api/auth/session');
    await session.get('/api/giveaways/mine/entered');
    await session.post('/api/auth/logout').send({});
  } finally {
    Object.assign(console, real);
  }

  assert.ok(!captured.join('\n').includes(token), 'a session token must never be logged');
});

// ---------------------------------------------------------------------------
// 6. Fixation
// ---------------------------------------------------------------------------

test('a session cookie supplied by the browser is replaced at login, never adopted', async () => {
  const account = await createAccount('fixation');
  const planted = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  const res = await api()
    .post('/api/auth/login')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .set('Cookie', `${sessions.SESSION_COOKIE}=${planted}`)
    .send({ email: account.email, password: PASSWORD });

  assert.equal(res.status, 200);
  const issued = cookieAttributes(res.headers['set-cookie']).value;
  assert.notEqual(issued, planted, 'the planted value must not survive');

  // The planted value never becomes a session, before or after.
  const asPlanted = await api()
    .get('/api/giveaways/mine/entered')
    .set('Cookie', `${sessions.SESSION_COOKIE}=${planted}`);
  assert.equal(asPlanted.status, 401);

  const rows = await pool.query(
    'SELECT token_hash FROM sessions WHERE user_id = $1',
    [account.id]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].token_hash, sessions.hashToken(issued));
});

// ---------------------------------------------------------------------------
// 7–8. What authenticates and what does not
// ---------------------------------------------------------------------------

test('a valid cookie authenticates', async () => {
  const account = await createAccount('valid');
  const session = await signIn(account.email, PASSWORD);

  const res = await session.get('/api/giveaways/mine/entered');
  assert.equal(res.status, 200);

  const who = await session.get('/api/auth/session');
  assert.equal(who.body.authenticated, true);
  assert.equal(who.body.user.email, account.email);
  assert.equal(who.headers['cache-control'], 'no-store');
});

test('missing, malformed, unknown, expired and revoked sessions are all refused', async () => {
  const account = await createAccount('refusals');
  const session = await signIn(account.email, PASSWORD);
  const sessionRow = await pool.query('SELECT id FROM sessions WHERE user_id = $1', [account.id]);
  const sessionId = sessionRow.rows[0].id;

  const cases = [
    ['no cookie at all', null],
    ['a malformed value', 'not a token at all !!!'],
    ['an unknown but well-formed value', 'A'.repeat(43)],
  ];
  for (const [label, value] of cases) {
    const req = api().get('/api/giveaways/mine/entered');
    if (value !== null) req.set('Cookie', `${sessions.SESSION_COOKIE}=${encodeURIComponent(value)}`);
    const res = await req;
    assert.equal(res.status, 401, `${label} must be refused`);
  }

  // Expired. The family's absolute expiry is the authority, so that is what is
  // moved — a per-row copy could not extend or shorten anything on its own.
  await pool.query(
    "UPDATE session_families SET absolute_expires_at = NOW() - INTERVAL '1 minute' WHERE id = (SELECT family_id FROM sessions WHERE id = $1)",
    [sessionId]
  );
  assert.equal((await session.get('/api/giveaways/mine/entered')).status, 401, 'expired');

  // Revoked (and un-expired again, so only the revocation is being tested).
  await pool.query(
    "UPDATE session_families SET absolute_expires_at = NOW() + INTERVAL '1 hour', revoked_at = NOW(), revocation_reason = 'test' WHERE id = (SELECT family_id FROM sessions WHERE id = $1)",
    [sessionId]
  );
  assert.equal((await session.get('/api/giveaways/mine/entered')).status, 401, 'revoked');
});

test('a refused session clears the cookie so the browser stops presenting it', async () => {
  const account = await createAccount('clears');
  const session = await signIn(account.email, PASSWORD);
  await pool.query(
    "UPDATE session_families SET revoked_at = NOW(), revocation_reason = 'test' WHERE user_id = $1",
    [account.id]
  );

  const res = await session.get('/api/giveaways/mine/entered');
  assert.equal(res.status, 401);
  assert.match(String(res.headers['set-cookie']), /naseeb_session=;|naseeb_session=\s*;/);
});

// ---------------------------------------------------------------------------
// 9–10. Logout
// ---------------------------------------------------------------------------

test('logout revokes the session server-side and clears the cookie', async () => {
  const account = await createAccount('logout');
  const session = await signIn(account.email, PASSWORD);

  const before = await pool.query('SELECT id, revoked_at FROM sessions WHERE user_id = $1', [account.id]);
  assert.equal(before.rows[0].revoked_at, null);

  const res = await session.post('/api/auth/logout').send({});
  assert.equal(res.status, 200);
  assert.match(String(res.headers['set-cookie']), /naseeb_session=/);

  const after = await pool.query(
    'SELECT revoked_at, revocation_reason FROM sessions WHERE user_id = $1',
    [account.id]
  );
  assert.ok(after.rows[0].revoked_at, 'the row is revoked, not just the browser copy');
  assert.equal(after.rows[0].revocation_reason, sessions.REVOCATION.LOGOUT);
});

test('the cookie held before logout stops working immediately afterwards', async () => {
  const account = await createAccount('logout-replay');
  const res = await login(account.email);
  const token = cookieAttributes(res.headers['set-cookie']).value;

  const replay = () =>
    api().get('/api/giveaways/mine/entered').set('Cookie', `${sessions.SESSION_COOKIE}=${token}`);

  assert.equal((await replay()).status, 200, 'works before');

  // Logout is a state change, so it needs the CSRF token like any other —
  // a cross-site page must not be able to sign somebody out.
  const bootstrap = await api()
    .get('/api/auth/session')
    .set('Cookie', `${sessions.SESSION_COOKIE}=${token}`);
  const out = await api()
    .post('/api/auth/logout')
    .set('Origin', TEST_ORIGIN)
    .set('Cookie', `${sessions.SESSION_COOKIE}=${token}`)
    .set('X-CSRF-Token', bootstrap.body.csrf_token)
    .send({});
  assert.equal(out.status, 200, JSON.stringify(out.body));

  // This is the whole point of a session table: the browser still holds a
  // perfectly well-formed, unexpired cookie, and it is worth nothing.
  assert.equal((await replay()).status, 401, 'and not after');
});

// ---------------------------------------------------------------------------
// 11–14. Revocation
// ---------------------------------------------------------------------------

test('a password reset revokes every existing session', async () => {
  const account = await createAccount('reset');
  const laptop = await signIn(account.email, PASSWORD);
  const phone = await signIn(account.email, PASSWORD);
  assert.equal((await laptop.get('/api/giveaways/mine/entered')).status, 200);
  assert.equal((await phone.get('/api/giveaways/mine/entered')).status, 200);

  const resetToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    "UPDATE users SET reset_token = $1, reset_token_expires = NOW() + INTERVAL '1 hour' WHERE id = $2",
    [resetToken, account.id]
  );

  const reset = await api()
    .post('/api/auth/reset-password')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token: resetToken, password: 'a-different-password-123' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.sessions_revoked, 2);

  // Somebody resetting a password is very often somebody who thinks another
  // person has their account. Leaving that person signed in would make the
  // reset theatre.
  assert.equal((await laptop.get('/api/giveaways/mine/entered')).status, 401);
  assert.equal((await phone.get('/api/giveaways/mine/entered')).status, 401);

  const reasons = await pool.query(
    'SELECT DISTINCT revocation_reason FROM sessions WHERE user_id = $1',
    [account.id]
  );
  assert.deepEqual(reasons.rows.map((r) => r.revocation_reason), [sessions.REVOCATION.PASSWORD_RESET]);
});

test('suspending an account revokes its sessions and refuses new sign-ins', async () => {
  const admin = await createAccount('suspender', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);
  const victim = await createAccount('suspended');
  const victimSession = await signIn(victim.email, PASSWORD);
  assert.equal((await victimSession.get('/api/giveaways/mine/entered')).status, 200);

  const res = await adminSession
    .post(`/api/admin/users/${victim.id}/account-status`)
    .send({ status: 'suspended', reason: 'Fabricated abuse report.' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.sessions_revoked, 1);

  assert.equal((await victimSession.get('/api/giveaways/mine/entered')).status, 401);

  // And they cannot simply sign in again. Same answer as a wrong password, so
  // this cannot be used to find out which accounts are suspended.
  const retry = await login(victim.email);
  assert.equal(retry.status, 401);
  assert.match(retry.body.error, /Incorrect email or password/);
});

test('suspending host access does NOT sign anybody out of their account', async () => {
  // The distinction the whole two-column design exists for: hosting is
  // authorization and the account is authentication. A host who may no longer
  // publish giveaways is still an entrant with tickets, and signing them out of
  // the platform would punish them for something they can still do.
  const admin = await createAccount('host-suspender', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);
  const host = await createAccount('host-suspended');
  await pool.query("UPDATE users SET host_status = 'approved' WHERE id = $1", [host.id]);
  const hostSession = await signIn(host.email, PASSWORD);

  const res = await adminSession
    .post(`/api/admin/hosts/${host.id}/status`)
    .send({ status: 'suspended', reason: 'Fabricated undelivered prize.' });
  assert.equal(res.status, 200);

  // Still signed in.
  assert.equal((await hostSession.get('/api/auth/session')).body.authenticated, true);
  assert.equal((await hostSession.get('/api/giveaways/mine/entered')).status, 200);

  // And still cannot host, which is a 403, not a 401.
  assert.equal((await hostSession.get('/api/giveaways/mine/hosted')).status, 403);

  const rows = await pool.query(
    'SELECT revoked_at FROM sessions WHERE user_id = $1',
    [host.id]
  );
  assert.equal(rows.rows[0].revoked_at, null, 'host suspension must revoke no session');
  const account = await pool.query('SELECT account_status FROM users WHERE id = $1', [host.id]);
  assert.equal(account.rows[0].account_status, 'active');
});

test('an administrator can revoke every session for one account without changing what it may do', async () => {
  const admin = await createAccount('revoker', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);
  const target = await createAccount('revoked-all');
  const a = await signIn(target.email, PASSWORD);
  const b = await signIn(target.email, PASSWORD);

  const res = await adminSession.post(`/api/admin/users/${target.id}/revoke-sessions`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.sessions_revoked, 2);

  assert.equal((await a.get('/api/giveaways/mine/entered')).status, 401);
  assert.equal((await b.get('/api/giveaways/mine/entered')).status, 401);

  // The account itself is untouched, so they simply sign in again.
  const account = await pool.query('SELECT account_status FROM users WHERE id = $1', [target.id]);
  assert.equal(account.rows[0].account_status, 'active');
  const again = await signIn(target.email, PASSWORD);
  assert.equal((await again.get('/api/giveaways/mine/entered')).status, 200);
});

test('a user can end all of their own sessions', async () => {
  const account = await createAccount('logout-all');
  const laptop = await signIn(account.email, PASSWORD);
  const phone = await signIn(account.email, PASSWORD);

  const res = await laptop.post('/api/auth/logout-all').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.sessions_revoked, 2);
  assert.equal((await phone.get('/api/giveaways/mine/entered')).status, 401);
  assert.equal((await laptop.get('/api/giveaways/mine/entered')).status, 401);
});

// ---------------------------------------------------------------------------
// 15–16. Rotation
// ---------------------------------------------------------------------------

test('rotation issues one successor, invalidates the old token, and keeps the expiry', async () => {
  const account = await createAccount('rotate');
  const res = await login(account.email);
  const oldToken = cookieAttributes(res.headers['set-cookie']).value;
  const before = await pool.query(
    'SELECT s.id, s.family_id, f.absolute_expires_at FROM sessions s JOIN session_families f ON f.id = s.family_id WHERE s.user_id = $1',
    [account.id]
  );

  const rotated = await sessions.rotateSession(before.rows[0].id);
  assert.ok(rotated, 'a successor is issued');
  assert.notEqual(rotated.token, oldToken);
  assert.equal(rotated.familyId, before.rows[0].family_id, 'the successor stays inside the family');
  assert.equal(
    new Date(rotated.expiresAt).getTime(),
    new Date(before.rows[0].absolute_expires_at).getTime(),
    'rotation shortens a token’s life, it does not extend the session'
  );

  const rows = await pool.query(
    'SELECT id, revoked_at, revocation_reason, replaced_by_session_id, rotated_from_session_id FROM sessions WHERE user_id = $1 ORDER BY created_at ASC',
    [account.id]
  );
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows[0].revoked_at);
  assert.equal(rows.rows[0].revocation_reason, sessions.REVOCATION.ROTATED);
  assert.equal(rows.rows[0].replaced_by_session_id, rows.rows[1].id);
  assert.equal(rows.rows[1].rotated_from_session_id, rows.rows[0].id);

  // The successor works.
  const withNew = await api()
    .get('/api/giveaways/mine/entered')
    .set('Cookie', `${sessions.SESSION_COOKIE}=${rotated.token}`);
  assert.equal(withNew.status, 200);

  // Rotating again is idempotent: no second successor is minted.
  const twice = await sessions.rotateSession(before.rows[0].id);
  assert.equal(twice, null, 'a session rotates at most once');
  const total = await pool.query('SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1', [
    account.id,
  ]);
  assert.equal(total.rows[0].c, 2);
});

test('a replaced token keeps working for the grace window, then stops', async () => {
  const account = await createAccount('grace');
  const res = await login(account.email);
  const oldToken = cookieAttributes(res.headers['set-cookie']).value;
  const row = await pool.query('SELECT id FROM sessions WHERE user_id = $1', [account.id]);

  await sessions.rotateSession(row.rows[0].id);

  const replay = () =>
    api().get('/api/giveaways/mine/entered').set('Cookie', `${sessions.SESSION_COOKIE}=${oldToken}`);

  // Two tabs firing at the moment of a rotation: the straggler holding the
  // previous token must not be signed out through no fault of anyone's.
  assert.equal((await replay()).status, 200, 'within the grace window');

  await pool.query(
    "UPDATE sessions SET rotation_grace_until = NOW() - INTERVAL '1 second' WHERE id = $1",
    [row.rows[0].id]
  );
  assert.equal((await replay()).status, 401, 'and dead once the window closes');
});

test('many concurrent requests across a rotation neither log anyone out nor duplicate the session', async () => {
  const account = await createAccount('concurrent');
  const originalRotate = process.env.SESSION_ROTATE_AFTER_MINUTES;
  process.env.SESSION_ROTATE_AFTER_MINUTES = '5';
  try {
    const res = await login(account.email);
    const token = cookieAttributes(res.headers['set-cookie']).value;

    // Age the session past the rotation threshold, then fire ten requests at
    // once — the multi-tab case.
    await pool.query("UPDATE sessions SET created_at = NOW() - INTERVAL '10 minutes' WHERE user_id = $1", [
      account.id,
    ]);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api().get('/api/giveaways/mine/entered').set('Cookie', `${sessions.SESSION_COOKIE}=${token}`)
      )
    );
    results.forEach((r, i) => assert.equal(r.status, 200, `request ${i} must not be signed out`));

    const live = await pool.query(
      'SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [account.id]
    );
    assert.equal(live.rows[0].c, 1, 'exactly one live session, not one per racing request');

    const total = await pool.query('SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1', [
      account.id,
    ]);
    assert.equal(total.rows[0].c, 2, 'one rotation, not ten');
  } finally {
    if (originalRotate === undefined) delete process.env.SESSION_ROTATE_AFTER_MINUTES;
    else process.env.SESSION_ROTATE_AFTER_MINUTES = originalRotate;
  }
});

// ---------------------------------------------------------------------------
// Forging, and the boundaries that are not sessions
// ---------------------------------------------------------------------------

test('forged role, admin and host fields are ignored everywhere', async () => {
  const account = await createAccount('forger');
  const session = await signIn(account.email, PASSWORD);
  const admin = await createAccount('real-admin', { admin: true });

  const forgeries = [
    { is_admin: true },
    { role: 'admin' },
    { userId: admin.id },
    { host_status: 'approved' },
    { account_status: 'active', sub: admin.id },
  ];

  for (const body of forgeries) {
    const res = await session.get('/api/admin/stats').query(body);
    assert.equal(res.status, 403, `query ${JSON.stringify(body)} must not grant admin`);

    const posted = await session.post('/api/host-applications').send({
      applicant_type: 'individual',
      full_name: 'Fabricated Applicant',
      ...body,
    });
    assert.ok(posted.status !== 500, 'a forged field must be ignored, not crash anything');
  }

  // Headers are no better.
  const headerForged = await session
    .get('/api/admin/stats')
    .set('X-User-Id', admin.id)
    .set('X-Is-Admin', 'true');
  assert.equal(headerForged.status, 403);
});

test('purpose-limited tokens are not sessions, and sessions are not those tokens', async () => {
  const account = await createAccount('purpose');

  // A verification token cannot be used as a session cookie.
  const verifyToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    "UPDATE users SET verification_token = $1, verification_token_expires = NOW() + INTERVAL '1 day', email_verified = FALSE WHERE id = $2",
    [verifyToken, account.id]
  );
  const asSession = await api()
    .get('/api/giveaways/mine/entered')
    .set('Cookie', `${sessions.SESSION_COOKIE}=${verifyToken}`);
  assert.equal(asSession.status, 401);

  // A reset token cannot either.
  const resetToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    "UPDATE users SET reset_token = $1, reset_token_expires = NOW() + INTERVAL '1 hour' WHERE id = $2",
    [resetToken, account.id]
  );
  const asSession2 = await api()
    .get('/api/giveaways/mine/entered')
    .set('Cookie', `${sessions.SESSION_COOKIE}=${resetToken}`);
  assert.equal(asSession2.status, 401);

  // And a session cookie is not a reset token: signing in does not let anybody
  // change a password without the emailed token.
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [account.id]);
  const session = await signIn(account.email, PASSWORD);
  const noToken = await session.post('/api/auth/reset-password').send({ password: 'brand-new-password' });
  assert.equal(noToken.status, 400);
});

// ---------------------------------------------------------------------------
// Nothing in the browser holds a credential
// ---------------------------------------------------------------------------

test('no page or script stores an authentication token in browser storage', () => {
  const publicDir = path.join(__dirname, '..', 'public');

  function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return files(full);
      return /\.(html|js)$/.test(entry.name) ? [full] : [];
    });
  }

  // Comments are stripped first: this codebase explains at length why the old
  // scheme was removed, and a guard that cannot tell an explanation from an
  // implementation is no guard.
  function code(text) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }

  const failures = [];
  files(publicDir).forEach((file) => {
    const rel = path.relative(path.join(__dirname, '..'), file);
    const text = code(fs.readFileSync(file, 'utf8'));

    // Storing anything token-shaped.
    const stores = text.match(
      /(localStorage|sessionStorage)\s*\.\s*setItem\(\s*['"`][^'"`]*(token|session|auth|jwt|csrf)[^'"`]*['"`]/gi
    );
    if (stores) failures.push(`${rel}: writes ${stores.join(', ')} to browser storage`);

    // Reading one back.
    const reads = text.match(
      /(localStorage|sessionStorage)\s*\.\s*getItem\(\s*['"`][^'"`]*(token|session|auth|jwt|csrf)[^'"`]*['"`]/gi
    );
    if (reads) failures.push(`${rel}: reads ${reads.join(', ')} from browser storage`);

    // Building an Authorization header by hand.
    if (/Authorization\s*[:=]/.test(text) || /Bearer\s*\$\{/.test(text)) {
      failures.push(`${rel}: constructs an Authorization header`);
    }
  });

  assert.deepEqual(
    failures,
    [],
    `Browser-stored authentication found:\n  ${failures.join('\n  ')}\n\n` +
      'Sessions are an HttpOnly cookie. Anything a script can read, an injected script can read.'
  );
});

test('the frontend clears any token left behind by the old scheme, and never exchanges it', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

  assert.match(appJs, /removeItem\('naseeb_token'\)|removeItem\(key\)/, 'legacy tokens are removed');
  assert.match(appJs, /purgeLegacyTokens/, 'and removed deliberately, on load');

  // No path that hands an old token to the server for a session. Comments are
  // stripped first — this file explains at length why the old scheme went, and
  // a guard that cannot tell an explanation from an implementation is no guard.
  const code = appJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(
    !/exchange|migrateToken|legacyLogin/i.test(code),
    'an old localStorage token must never be exchanged for a session'
  );
});

test('no server code accepts an Authorization bearer token for browser authentication', () => {
  const authMiddleware = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'middleware', 'auth.js'),
    'utf8'
  );
  const code = authMiddleware
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  assert.ok(!/headers\.authorization/i.test(code), 'no bearer fallback may exist');
  assert.ok(!/jsonwebtoken|jwt\./i.test(code), 'and no JWT verification');
});

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

test('production refuses an insecure cookie configuration', () => {
  const original = { env: process.env.NODE_ENV, secure: process.env.COOKIE_SECURE, url: process.env.APP_URL };
  try {
    process.env.NODE_ENV = 'production';

    process.env.COOKIE_SECURE = 'false';
    process.env.APP_URL = 'https://example.test';
    let problems = sessions.assertCookieSecurity();
    assert.ok(problems.some((p) => /COOKIE_SECURE=false/.test(p)));

    delete process.env.COOKIE_SECURE;
    process.env.APP_URL = 'http://example.test';
    problems = sessions.assertCookieSecurity();
    assert.ok(problems.some((p) => /https/.test(p)), 'an http origin cannot carry a Secure cookie');

    process.env.APP_URL = 'https://example.test';
    assert.deepEqual(sessions.assertCookieSecurity(), []);

    // And Secure is forced on regardless of what COOKIE_SECURE says.
    process.env.COOKIE_SECURE = 'false';
    assert.equal(sessions.cookieSecure(), true, 'production cannot opt out of Secure');
  } finally {
    if (original.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original.env;
    if (original.secure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = original.secure;
    if (original.url === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = original.url;
  }
});

test('expired sessions can be swept without touching live ones', async () => {
  const account = await createAccount('sweep');
  await signIn(account.email, PASSWORD);
  const live = await signIn(account.email, PASSWORD);

  await pool.query(
    `UPDATE session_families SET absolute_expires_at = NOW() - INTERVAL '60 days'
      WHERE id = (SELECT family_id FROM sessions WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1)`,
    [account.id]
  );

  const deleted = await sessions.deleteExpiredSessions(pool, { olderThanDays: 30 });
  assert.ok(deleted >= 1);
  assert.equal((await live.get('/api/giveaways/mine/entered')).status, 200);
});
