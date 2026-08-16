// A rotation chain is one logical session, and every revocation applies to all
// of it.
//
// The hole this closes was real and was demonstrated before it was fixed.
// Rotation replaces a session's token and leaves the predecessor authenticating
// for a grace window, so "the session" is a chain of rows rather than a row.
// Revoking only the row that happened to send the request meant a rotation
// committing between a logout resolving its session and revoking it left the
// successor alive:
//
//     logout step 1: authenticate(token) -> session A
//     another request: rotate A -> B
//     logout step 2: revoke A  ->  0 rows (A is already revoked-as-rotated)
//     B: still valid.
//
// Sessions now belong to a `session_families` row. Login creates one, rotation
// stays inside it, revocation ends it, and the absolute expiry lives on it so
// no amount of rotation can extend a sign-in. Two partial unique indexes make
// the shape a database guarantee rather than a convention.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const {
  api,
  pool,
  ensureInit,
  signIn,
  nextTestIp,
  TEST_ORIGIN,
  uniqueEmail,
} = require('../testHelpers');

const sessions = require('../server/lib/sessions');
const { tokenForFamily, CSRF_HEADER } = require('../server/lib/csrf');

const createdUserIds = [];
const PASSWORD = 'correcthorse123';

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

async function createAccount(tag, { admin = false } = {}) {
  const id = uuid();
  const email = uniqueEmail(`family-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, age_attestation_status, age_attestation_version)
     VALUES ($1, $2, $3, $4, TRUE, $5, 'confirmed', '2026-08-eligibility-18')`,
    [id, `Family ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin]
  );
  createdUserIds.push(id);
  return { id, email };
}

function tokenFrom(res) {
  return String(res.headers['set-cookie']).match(/naseeb_session=([^;]+)/)[1];
}

function login(email) {
  return api()
    .post('/api/auth/login')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ email, password: PASSWORD });
}

function asToken(token) {
  return api().get('/api/giveaways/mine/entered').set('Cookie', `naseeb_session=${token}`);
}

function logoutWith(token, csrf) {
  const req = api()
    .post('/api/auth/logout')
    .set('Origin', TEST_ORIGIN)
    .set('Cookie', `naseeb_session=${token}`);
  if (csrf) req.set(CSRF_HEADER, csrf);
  return req.send({});
}

// A signed-in browser whose token has been rotated once: a predecessor still
// inside its grace window, and the successor that replaced it.
async function familyWithRotation(tag) {
  const account = await createAccount(tag);
  const res = await login(account.email);
  const predecessorToken = tokenFrom(res);
  const csrf = res.body.csrf_token;

  const row = await pool.query(
    'SELECT id, family_id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [account.id]
  );
  const rotated = await sessions.rotateSession(row.rows[0].id);
  assert.ok(rotated, 'the fixture needs a successor');

  return {
    account,
    familyId: row.rows[0].family_id,
    predecessorToken,
    successorToken: rotated.token,
    csrf,
  };
}

function liveRows(userId) {
  return pool
    .query('SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ])
    .then((r) => r.rows[0].c);
}

function liveFamilies(userId) {
  return pool
    .query(
      'SELECT COUNT(*)::int AS c FROM session_families WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    )
    .then((r) => r.rows[0].c);
}

// ---------------------------------------------------------------------------
// The shape of a family
// ---------------------------------------------------------------------------

test('login creates exactly one family, and rotation stays inside it', async () => {
  const scene = await familyWithRotation('shape');

  const rows = await pool.query(
    'SELECT id, family_id, rotated_from_session_id FROM sessions WHERE user_id = $1 ORDER BY created_at',
    [scene.account.id]
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].family_id, scene.familyId);
  assert.equal(rows.rows[1].family_id, scene.familyId, 'the successor is in the same family');
  assert.equal(rows.rows[1].rotated_from_session_id, rows.rows[0].id);

  assert.equal(await liveFamilies(scene.account.id), 1);
  assert.equal(await liveRows(scene.account.id), 1, 'a family holds one live member');
});

test('the database refuses a second successor for one predecessor', async () => {
  const scene = await familyWithRotation('one-successor');
  const rows = await pool.query(
    'SELECT id, family_id FROM sessions WHERE user_id = $1 ORDER BY created_at',
    [scene.account.id]
  );
  const predecessorId = rows.rows[0].id;

  // A rival successor, inserted directly. The application would never write
  // this; the point is that it could not even if it tried.
  await assert.rejects(
    pool.query(
      `INSERT INTO sessions (id, family_id, user_id, token_hash, expires_at, rotated_from_session_id)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour', $5)`,
      [uuid(), scene.familyId, scene.account.id, 'rival-hash-1', predecessorId]
    ),
    (err) => err.code === '23505',
    'a chain must not be able to branch'
  );
});

test('the database refuses two live members in one family', async () => {
  const scene = await familyWithRotation('one-live');

  await assert.rejects(
    pool.query(
      `INSERT INTO sessions (id, family_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour')`,
      [uuid(), scene.familyId, scene.account.id, 'rival-hash-2']
    ),
    (err) => err.code === '23505',
    'exactly one member of a family may be live'
  );
});

test('a grace-period predecessor cannot produce a second successor', async () => {
  const scene = await familyWithRotation('no-second');
  const rows = await pool.query(
    'SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at',
    [scene.account.id]
  );

  const again = await sessions.rotateSession(rows.rows[0].id);
  assert.equal(again, null, 'a predecessor rotates once, ever');
  assert.equal(await liveRows(scene.account.id), 1);

  const total = await pool.query('SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1', [
    scene.account.id,
  ]);
  assert.equal(total.rows[0].c, 2);
});

test('the absolute expiry survives many rotations untouched', async () => {
  const account = await createAccount('expiry');
  const res = await login(account.email);
  const family = await pool.query(
    'SELECT id, absolute_expires_at FROM session_families WHERE user_id = $1',
    [account.id]
  );
  const original = new Date(family.rows[0].absolute_expires_at).getTime();

  let currentId = (
    await pool.query('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [
      account.id,
    ])
  ).rows[0].id;

  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    const rotated = await sessions.rotateSession(currentId);
    assert.ok(rotated, `rotation ${i} should succeed`);
    assert.equal(
      new Date(rotated.expiresAt).getTime(),
      original,
      'rotation must never move the end of a sign-in'
    );
    currentId = rotated.id;
  }

  const after = await pool.query(
    'SELECT absolute_expires_at FROM session_families WHERE user_id = $1',
    [account.id]
  );
  assert.equal(new Date(after.rows[0].absolute_expires_at).getTime(), original);

  const members = await pool.query('SELECT expires_at FROM sessions WHERE user_id = $1', [account.id]);
  assert.equal(members.rows.length, 6);
  members.rows.forEach((row) => {
    assert.equal(new Date(row.expires_at).getTime(), original, 'every member shares the expiry');
  });
});

// ---------------------------------------------------------------------------
// 1–3. Logout ends the family, whichever token asked
// ---------------------------------------------------------------------------

test('logout with the newest token revokes a predecessor still inside grace', async () => {
  const scene = await familyWithRotation('logout-newest');

  assert.equal((await asToken(scene.predecessorToken)).status, 200, 'grace holds before logout');

  const out = await logoutWith(scene.successorToken, scene.csrf);
  assert.equal(out.status, 200, JSON.stringify(out.body));

  assert.equal((await asToken(scene.successorToken)).status, 401, 'successor dies');
  assert.equal((await asToken(scene.predecessorToken)).status, 401, 'and so does the predecessor');
  assert.equal(await liveRows(scene.account.id), 0);
  assert.equal(await liveFamilies(scene.account.id), 0);
});

test('logout with the grace-period predecessor revokes the newest token', async () => {
  const scene = await familyWithRotation('logout-oldest');

  const out = await logoutWith(scene.predecessorToken, scene.csrf);
  assert.equal(out.status, 200, JSON.stringify(out.body));

  assert.equal((await asToken(scene.predecessorToken)).status, 401);
  assert.equal((await asToken(scene.successorToken)).status, 401, 'the successor must not survive');
  assert.equal(await liveRows(scene.account.id), 0);
});

test('a CSRF token from either revoked family member fails, and writes nothing', async () => {
  const scene = await familyWithRotation('csrf-dead');
  const familyToken = tokenForFamily(scene.familyId);

  await logoutWith(scene.successorToken, scene.csrf);

  for (const [label, token] of [
    ['predecessor', scene.predecessorToken],
    ['successor', scene.successorToken],
  ]) {
    const res = await api()
      .post('/api/giveaways')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', `naseeb_session=${token}`)
      .set(CSRF_HEADER, familyToken)
      .send({
        title: 'Should never exist',
        description: 'd',
        prize_description: 'p',
        funded_by: 'f',
        entry_deadline: new Date(Date.now() + 864e5).toISOString(),
      });
    assert.ok([401, 403].includes(res.status), `${label} must be refused, got ${res.status}`);
  }

  const written = await pool.query('SELECT COUNT(*)::int AS c FROM giveaways WHERE host_id = $1', [
    scene.account.id,
  ]);
  assert.equal(written.rows[0].c, 0, 'a refused request must write nothing');
});

// ---------------------------------------------------------------------------
// 4–8. Races
// ---------------------------------------------------------------------------

test('two concurrent rotation attempts produce one successor and no branch', async () => {
  const account = await createAccount('race-rotate');
  await login(account.email);
  const row = await pool.query(
    'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [account.id]
  );

  const results = await Promise.all(
    Array.from({ length: 8 }, () => sessions.rotateSession(row.rows[0].id))
  );
  const successors = results.filter(Boolean);
  assert.equal(successors.length, 1, `exactly one successor, got ${successors.length}`);

  assert.equal(await liveRows(account.id), 1);
  const total = await pool.query('SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1', [
    account.id,
  ]);
  assert.equal(total.rows[0].c, 2, 'one predecessor and one successor, nothing else');

  const branches = await pool.query(
    `SELECT rotated_from_session_id, COUNT(*)::int AS c FROM sessions
      WHERE user_id = $1 AND rotated_from_session_id IS NOT NULL
      GROUP BY rotated_from_session_id HAVING COUNT(*) > 1`,
    [account.id]
  );
  assert.equal(branches.rows.length, 0, 'no predecessor may have two successors');
});

test('rotation racing logout leaves zero valid family members', async () => {
  // The exact interleaving that was broken, stepped through as the logout route
  // runs it: resolve the session, let a rotation commit, then revoke.
  const account = await createAccount('race-logout');
  const res = await login(account.email);
  const token = tokenFrom(res);
  const row = await pool.query(
    'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [account.id]
  );

  const resolved = await sessions.authenticate(token);
  assert.equal(resolved.ok, true);

  const rotated = await sessions.rotateSession(row.rows[0].id);
  assert.ok(rotated, 'the rotation commits in the gap');

  // Logout's second step, against a session that has since been replaced.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await sessions.revokeFamily(client, resolved.session.familyId, sessions.REVOCATION.LOGOUT);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  assert.equal((await asToken(token)).status, 401, 'the token logout was given');
  assert.equal((await asToken(rotated.token)).status, 401, 'AND the successor it never saw');
  assert.equal(await liveRows(account.id), 0);
  assert.equal(await liveFamilies(account.id), 0);
});

test('rotation cannot revive a family that revocation reached first', async () => {
  const account = await createAccount('race-revive');
  await login(account.email);
  const row = await pool.query(
    'SELECT id, family_id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [account.id]
  );

  // Fired together: whichever takes the family lock first wins, and the loser
  // sees the winner's committed state.
  const client = await pool.connect();
  const revoke = (async () => {
    await client.query('BEGIN');
    await sessions.revokeFamily(client, row.rows[0].family_id, sessions.REVOCATION.LOGOUT);
    await client.query('COMMIT');
  })();
  const rotate = sessions.rotateSession(row.rows[0].id);

  const [, rotated] = await Promise.all([revoke, rotate]);
  client.release();

  if (rotated) {
    // The rotation won the lock; the revocation that followed must have taken
    // the successor with it.
    assert.equal((await asToken(rotated.token)).status, 401, 'a revoked family takes its successor');
  }
  assert.equal(await liveRows(account.id), 0, 'no live member may survive');
  assert.equal(await liveFamilies(account.id), 0);
});

test('rotation racing a password reset leaves zero valid sessions', async () => {
  const account = await createAccount('race-reset');
  const res = await login(account.email);
  const token = tokenFrom(res);
  const row = await pool.query(
    'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [account.id]
  );

  const resetToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    "UPDATE users SET reset_token = $1, reset_token_expires = NOW() + INTERVAL '1 hour' WHERE id = $2",
    [resetToken, account.id]
  );

  const [rotated, reset] = await Promise.all([
    sessions.rotateSession(row.rows[0].id),
    api()
      .post('/api/auth/reset-password')
      .set('Origin', TEST_ORIGIN)
      .set('X-Forwarded-For', nextTestIp())
      .send({ token: resetToken, password: 'a-completely-different-password' }),
  ]);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));

  assert.equal((await asToken(token)).status, 401);
  if (rotated) assert.equal((await asToken(rotated.token)).status, 401);
  assert.equal(await liveRows(account.id), 0);
  assert.equal(await liveFamilies(account.id), 0);
});

test('rotation racing an account suspension leaves zero valid sessions', async () => {
  const admin = await createAccount('race-suspend-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);
  const victim = await createAccount('race-suspend');
  const res = await login(victim.email);
  const token = tokenFrom(res);
  const row = await pool.query(
    'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [victim.id]
  );

  const [rotated, suspended] = await Promise.all([
    sessions.rotateSession(row.rows[0].id),
    adminSession
      .post(`/api/admin/users/${victim.id}/account-status`)
      .send({ status: 'suspended', reason: 'Fabricated, for a race test.' }),
  ]);
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

  assert.equal((await asToken(token)).status, 401);
  if (rotated) assert.equal((await asToken(rotated.token)).status, 401);
  assert.equal(await liveRows(victim.id), 0);
  assert.equal(await liveFamilies(victim.id), 0);
});

test('replaying any family token after revocation cannot create another session', async () => {
  const scene = await familyWithRotation('replay');
  await logoutWith(scene.successorToken, scene.csrf);

  const before = await pool.query('SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1', [
    scene.account.id,
  ]);

  // Replayed repeatedly, through the API and through the rotation path directly.
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await asToken(scene.predecessorToken)).status, 401);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await asToken(scene.successorToken)).status, 401);
  }
  const rows = await pool.query('SELECT id FROM sessions WHERE user_id = $1', [scene.account.id]);
  for (const row of rows.rows) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await sessions.rotateSession(row.id), null, 'a dead family cannot rotate');
  }

  const after = await pool.query('SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1', [
    scene.account.id,
  ]);
  assert.equal(after.rows[0].c, before.rows[0].c, 'no new row may appear');
  assert.equal(await liveRows(scene.account.id), 0);
});

// ---------------------------------------------------------------------------
// 9–10. Families are independent of each other
// ---------------------------------------------------------------------------

test('signing out one browser leaves another browser signed in', async () => {
  const account = await createAccount('two-browsers');
  const laptopRes = await login(account.email);
  const phoneRes = await login(account.email);
  const laptop = tokenFrom(laptopRes);
  const phone = tokenFrom(phoneRes);

  assert.equal(await liveFamilies(account.id), 2, 'two logins, two families');

  await logoutWith(laptop, laptopRes.body.csrf_token);

  assert.equal((await asToken(laptop)).status, 401, 'the browser that signed out');
  assert.equal((await asToken(phone)).status, 200, 'and only that one');
  assert.equal(await liveFamilies(account.id), 1);
});

test('logout-all, password reset, suspension and admin revoke each end every family', async () => {
  const admin = await createAccount('sweep-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);

  // Each case gets a fresh account with three families, one of which has
  // rotated — so a sweep that only reached live rows would be caught.
  async function threeFamilies(tag) {
    const account = await createAccount(tag);
    const tokens = [];
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await login(account.email);
      tokens.push({ token: tokenFrom(res), csrf: res.body.csrf_token });
    }
    const row = await pool.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1',
      [account.id]
    );
    const rotated = await sessions.rotateSession(row.rows[0].id);
    tokens.push({ token: rotated.token, csrf: null });
    assert.equal(await liveFamilies(account.id), 3);
    return { account, tokens };
  }

  // logout-all
  {
    const { account, tokens } = await threeFamilies('sweep-logout-all');
    const res = await api()
      .post('/api/auth/logout-all')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', `naseeb_session=${tokens[0].token}`)
      .set(CSRF_HEADER, tokens[0].csrf)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sessions_revoked, 3);
    for (const t of tokens) assert.equal((await asToken(t.token)).status, 401);
    assert.equal(await liveFamilies(account.id), 0);
  }

  // password reset
  {
    const { account, tokens } = await threeFamilies('sweep-reset');
    const resetToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "UPDATE users SET reset_token = $1, reset_token_expires = NOW() + INTERVAL '1 hour' WHERE id = $2",
      [resetToken, account.id]
    );
    const res = await api()
      .post('/api/auth/reset-password')
      .set('Origin', TEST_ORIGIN)
      .set('X-Forwarded-For', nextTestIp())
      .send({ token: resetToken, password: 'yet-another-password-1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions_revoked, 3);
    for (const t of tokens) assert.equal((await asToken(t.token)).status, 401);
    assert.equal(await liveFamilies(account.id), 0);
  }

  // account suspension
  {
    const { account, tokens } = await threeFamilies('sweep-suspend');
    const res = await adminSession
      .post(`/api/admin/users/${account.id}/account-status`)
      .send({ status: 'suspended', reason: 'Fabricated sweep test.' });
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions_revoked, 3);
    for (const t of tokens) assert.equal((await asToken(t.token)).status, 401);
    assert.equal(await liveFamilies(account.id), 0);
  }

  // administrative revoke-all
  {
    const { account, tokens } = await threeFamilies('sweep-admin-revoke');
    const res = await adminSession.post(`/api/admin/users/${account.id}/revoke-sessions`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions_revoked, 3);
    for (const t of tokens) assert.equal((await asToken(t.token)).status, 401);
    assert.equal(await liveFamilies(account.id), 0);
  }
});

// ---------------------------------------------------------------------------
// 12. Nothing sensitive is stored or logged
// ---------------------------------------------------------------------------

test('no raw session token and no CSRF value appears in any row or in the log', async () => {
  const account = await createAccount('no-secrets');

  const captured = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => captured.push(a.map(String).join(' '));
  console.error = (...a) => captured.push(a.map(String).join(' '));
  console.warn = (...a) => captured.push(a.map(String).join(' '));

  let tokens;
  try {
    const res = await login(account.email);
    const first = tokenFrom(res);
    const csrf = res.body.csrf_token;
    const row = await pool.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [account.id]
    );
    const rotated = await sessions.rotateSession(row.rows[0].id);
    await asToken(rotated.token);
    await logoutWith(rotated.token, csrf);
    tokens = [first, rotated.token, csrf];
  } finally {
    Object.assign(console, real);
  }

  const rows = await pool.query(
    `SELECT s.*, f.* FROM sessions s JOIN session_families f ON f.id = s.family_id
      WHERE s.user_id = $1`,
    [account.id]
  );
  const serialised = JSON.stringify(rows.rows);
  const logged = captured.join('\n');

  tokens.forEach((secret) => {
    assert.ok(!serialised.includes(secret), 'no column may hold a token or a CSRF value');
    assert.ok(!logged.includes(secret), 'and none may be logged');
  });

  // What IS stored is the hash, and it is the right one.
  const hashes = rows.rows.map((r) => r.token_hash);
  assert.ok(hashes.includes(crypto.createHash('sha256').update(tokens[0]).digest('hex')));

  // The revocation stays auditable without any of that.
  const family = await pool.query(
    'SELECT revoked_at, revocation_reason FROM session_families WHERE user_id = $1',
    [account.id]
  );
  assert.ok(family.rows[0].revoked_at, 'when');
  assert.equal(family.rows[0].revocation_reason, sessions.REVOCATION.LOGOUT, 'and why');

  const members = await pool.query(
    'SELECT revocation_reason FROM sessions WHERE user_id = $1 ORDER BY created_at',
    [account.id]
  );
  assert.deepEqual(
    members.rows.map((r) => r.revocation_reason),
    [sessions.REVOCATION.ROTATED, sessions.REVOCATION.LOGOUT],
    'the rotated row keeps its own reason, so the chain stays readable'
  );
});

// ---------------------------------------------------------------------------
// Production secret validation
// ---------------------------------------------------------------------------

test('production refuses a missing, short, placeholder or borrowed session secret', () => {
  const originals = {
    NODE_ENV: process.env.NODE_ENV,
    SESSION_SECRET: process.env.SESSION_SECRET,
    JWT_SECRET: process.env.JWT_SECRET,
  };
  const good = crypto.randomBytes(48).toString('base64url');

  try {
    process.env.NODE_ENV = 'production';

    delete process.env.SESSION_SECRET;
    assert.match(sessions.assertSessionSecret()[0], /SESSION_SECRET is not set/);

    process.env.SESSION_SECRET = 'short';
    assert.ok(sessions.assertSessionSecret().some((p) => /shorter than 32/.test(p)));

    for (const placeholder of [
      'change-this-to-a-long-random-string-really',
      'your-secret-goes-right-here-and-is-long-enough',
      'test-only-session-secret-not-valid-outside-the-suite',
    ]) {
      process.env.SESSION_SECRET = placeholder;
      assert.ok(
        sessions.assertSessionSecret().some((p) => /placeholder or example/.test(p)),
        `"${placeholder.slice(0, 20)}…" must be refused`
      );
    }

    process.env.SESSION_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.ok(sessions.assertSessionSecret().some((p) => /too few distinct characters/.test(p)));

    // Sharing a value with a less-protected variable is not a secret.
    process.env.SESSION_SECRET = good;
    process.env.JWT_SECRET = good;
    assert.ok(
      sessions.assertSessionSecret().some((p) => /must not be the same value as JWT_SECRET/.test(p))
    );

    delete process.env.JWT_SECRET;
    assert.deepEqual(sessions.assertSessionSecret(), [], 'a real random secret passes');
  } finally {
    Object.entries(originals).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('no session secret value ever appears in the messages produced about it', () => {
  const originals = { NODE_ENV: process.env.NODE_ENV, SESSION_SECRET: process.env.SESSION_SECRET };
  try {
    process.env.NODE_ENV = 'production';
    // Deliberately not English words: "short" would collide with the word
    // "shorter" in the message and report a leak that is not one.
    for (const value of ['Zq7xK', 'change-this-to-a-long-random-string-x', 'a'.repeat(64)]) {
      process.env.SESSION_SECRET = value;
      const problems = sessions.assertSessionSecret().join(' | ');
      assert.ok(problems.length > 0, `"${value.slice(0, 10)}…" should be refused`);
      assert.ok(!problems.includes(value), 'the value must never be echoed');
      assert.match(problems, /SESSION_SECRET/, 'only the variable name is named');
    }
  } finally {
    Object.entries(originals).forEach(([key, v]) => {
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    });
  }
});

test('without a secret no CSRF token can be minted at all', () => {
  const original = process.env.SESSION_SECRET;
  try {
    delete process.env.SESSION_SECRET;
    assert.equal(tokenForFamily('any-family-id'), null, 'fails closed rather than signing with a default');
  } finally {
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
  }
});

test('no default or fallback secret exists in the source', () => {
  const fs = require('fs');
  const path = require('path');
  const csrfSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'csrf.js'), 'utf8');
  const code = csrfSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  assert.ok(
    !/SESSION_SECRET\s*\|\|/.test(code),
    'SESSION_SECRET must have no fallback — a default is a secret every deployment shares'
  );
  assert.ok(!/JWT_SECRET/.test(code), 'and must not borrow another variable');
});

// ---------------------------------------------------------------------------
// The dependency that is gone
// ---------------------------------------------------------------------------

test('jsonwebtoken is not a dependency and nothing requires it', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.jsonwebtoken, undefined, 'removed from dependencies');
  assert.equal((pkg.devDependencies || {}).jsonwebtoken, undefined);

  const lock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
  assert.ok(!lock.includes('jsonwebtoken'), 'and from the lockfile');

  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }
  const offenders = walk(root).filter((file) => {
    const code = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    return /require\(['"]jsonwebtoken['"]\)/.test(code);
  });
  assert.deepEqual(offenders, [], 'nothing may require it');
});
