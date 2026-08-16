// CSRF protection, and the two exclusions from it.
//
// The moment authentication moved from an Authorization header to a cookie it
// became ambient: the browser attaches it to any request to this origin,
// including one an unrelated site caused. The bearer header was immune to that
// by construction. A cookie is not, so the immunity has to be rebuilt.
//
// These tests care about one thing above all: a refused request must have
// changed nothing. It is not enough for the response to be a 403 if a row was
// written on the way to producing it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
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
const createdGiveawayIds = [];
const PASSWORD = 'correcthorse123';

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdGiveawayIds.length) {
    await pool.query(
      'DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query(
      'DELETE FROM claim_notifications WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query('DELETE FROM claim_rescue_queue WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('UPDATE giveaways SET winner_entry_id = NULL WHERE id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM host_status_events WHERE user_id = ANY($1) OR changed_by = ANY($1)', [
      createdUserIds,
    ]);
    await pool.query('DELETE FROM host_applications WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.query("DELETE FROM stripe_events WHERE id LIKE 'evt_csrf_%'");
  await pool.end();
});

async function createAccount(tag, { admin = false, hostStatus = 'approved' } = {}) {
  const id = uuid();
  const email = uniqueEmail(`csrf-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
    [id, `CSRF ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin, hostStatus]
  );
  createdUserIds.push(id);
  return { id, email };
}

function giveawayPayload(tag) {
  return {
    title: `CSRF test giveaway ${tag}`,
    description: 'A fabricated listing for the CSRF tests.',
    prize_description: 'A fabricated prize',
    funded_by: 'Fabricated marketing budget',
    entry_deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function countGiveaways(userId) {
  return pool
    .query('SELECT COUNT(*)::int AS c FROM giveaways WHERE host_id = $1', [userId])
    .then((r) => r.rows[0].c);
}

// ---------------------------------------------------------------------------
// The token itself
// ---------------------------------------------------------------------------

test('the CSRF token comes from an authenticated no-store endpoint and carries no session token', async () => {
  const account = await createAccount('bootstrap');
  const session = await signIn(account.email, PASSWORD);

  const res = await session.get('/api/auth/session');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store', 'who somebody is must never be cached');
  assert.ok(res.body.csrf_token, 'a token is issued');
  assert.ok(res.body.csrf_token.length >= 32, 'and it is high-entropy');

  // The session token is not in it, in any field.
  const row = await pool.query('SELECT token_hash, id, family_id FROM sessions WHERE user_id = $1', [account.id]);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(row.rows[0].token_hash));
  assert.equal(res.body.token, undefined);
  assert.equal(res.body.session_token, undefined);

  // It is derived from the session family, so it is not a second secret to
  // store — and a rotation inside the family does not invalidate it.
  assert.equal(res.body.csrf_token, tokenForFamily(row.rows[0].family_id));
});

test('an anonymous caller is told so plainly and gets no token', async () => {
  const res = await api().get('/api/auth/session');
  assert.equal(res.status, 200);
  assert.equal(res.body.authenticated, false);
  assert.equal(res.body.csrf_token, null);
  assert.equal(res.headers['cache-control'], 'no-store');
});

// ---------------------------------------------------------------------------
// 17–19. Enforcement
// ---------------------------------------------------------------------------

test('an authenticated mutation with no CSRF token is refused, and writes nothing', async () => {
  const account = await createAccount('no-token');
  const session = await signIn(account.email, PASSWORD);

  const before = await countGiveaways(account.id);
  const res = await session.agent
    .post('/api/giveaways')
    .set('Origin', TEST_ORIGIN)
    .send(giveawayPayload('no-token'));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CSRF_TOKEN_MISSING');
  assert.equal(await countGiveaways(account.id), before, 'nothing may be written by a refused request');
});

test('a wrong CSRF token is refused, and writes nothing', async () => {
  const account = await createAccount('wrong-token');
  const session = await signIn(account.email, PASSWORD);
  const before = await countGiveaways(account.id);

  for (const bogus of ['', 'not-a-token', 'A'.repeat(43), session.csrf.slice(0, -1) + 'X']) {
    const res = await session.agent
      .post('/api/giveaways')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, bogus)
      .send(giveawayPayload('wrong-token'));
    assert.equal(res.status, 403, `"${bogus.slice(0, 12)}…" must be refused`);
    assert.ok(['CSRF_TOKEN_MISSING', 'CSRF_TOKEN_INVALID'].includes(res.body.code));
  }
  assert.equal(await countGiveaways(account.id), before);
});

test('one session\'s CSRF token does not work on another session', async () => {
  const alice = await createAccount('alice');
  const bob = await createAccount('bob');
  const aliceSession = await signIn(alice.email, PASSWORD);
  const bobSession = await signIn(bob.email, PASSWORD);

  const before = await countGiveaways(bob.id);
  const res = await bobSession.agent
    .post('/api/giveaways')
    .set('Origin', TEST_ORIGIN)
    .set(CSRF_HEADER, aliceSession.csrf)
    .send(giveawayPayload('cross-session'));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CSRF_TOKEN_INVALID');
  assert.equal(await countGiveaways(bob.id), before);

  // And Alice's own second session gets its own token, so even the same person
  // cannot reuse one browser's token in another.
  const aliceSecond = await signIn(alice.email, PASSWORD);
  assert.notEqual(aliceSecond.csrf, aliceSession.csrf);
  const reused = await aliceSecond.agent
    .post('/api/giveaways')
    .set('Origin', TEST_ORIGIN)
    .set(CSRF_HEADER, aliceSession.csrf)
    .send(giveawayPayload('reused'));
  assert.equal(reused.status, 403);
});

test('the correct CSRF token succeeds', async () => {
  const account = await createAccount('correct');
  const session = await signIn(account.email, PASSWORD);

  const res = await session.post('/api/giveaways').send(giveawayPayload('correct'));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  createdGiveawayIds.push(res.body.id);
});

test('a CSRF token dies with its session', async () => {
  const account = await createAccount('revoked-token');
  const session = await signIn(account.email, PASSWORD);
  const csrf = session.csrf;

  await session.post('/api/auth/logout').send({});

  // The token is still syntactically fine; the session behind it is gone.
  const res = await session.agent
    .post('/api/giveaways')
    .set('Origin', TEST_ORIGIN)
    .set(CSRF_HEADER, csrf)
    .send(giveawayPayload('revoked-token'));
  assert.equal(res.status, 401, 'no session, so no request');
});

// ---------------------------------------------------------------------------
// 20. Origin and Referer
// ---------------------------------------------------------------------------

test('a disallowed Origin is refused before anything is written', async () => {
  const account = await createAccount('bad-origin');
  const session = await signIn(account.email, PASSWORD);
  const before = await countGiveaways(account.id);

  for (const origin of ['https://evil.example', 'http://localhost:3001', 'null']) {
    const res = await session.agent
      .post('/api/giveaways')
      .set('Origin', origin)
      .set(CSRF_HEADER, session.csrf)
      .send(giveawayPayload('bad-origin'));
    assert.equal(res.status, 403, `${origin} must be refused`);
    assert.equal(res.body.code, 'ORIGIN_NOT_ALLOWED');
  }
  assert.equal(await countGiveaways(account.id), before);
});

test('a disallowed Referer is refused when no Origin is sent', async () => {
  const account = await createAccount('bad-referer');
  const session = await signIn(account.email, PASSWORD);

  const res = await session.agent
    .post('/api/giveaways')
    .set('Referer', 'https://evil.example/attack.html')
    .set(CSRF_HEADER, session.csrf)
    .send(giveawayPayload('bad-referer'));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ORIGIN_NOT_ALLOWED');
});

test('the Origin check applies to unauthenticated writes too', async () => {
  // Login CSRF — forcing a victim into an attacker's account — needs no cookie,
  // so the token rule does not reach it. The Origin rule does.
  const res = await api()
    .post('/api/auth/login')
    .set('Origin', 'https://evil.example')
    .set('X-Forwarded-For', nextTestIp())
    .send({ email: 'someone@example.com', password: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ORIGIN_NOT_ALLOWED');
});

test('safe methods are never blocked by either rule', async () => {
  const account = await createAccount('safe-methods');
  const session = await signIn(account.email, PASSWORD);

  const res = await session.agent
    .get('/api/giveaways/mine/entered')
    .set('Origin', 'https://evil.example');
  assert.equal(res.status, 200, 'a GET carries no state change to protect');
});

// ---------------------------------------------------------------------------
// 22. The Stripe webhook exclusion
// ---------------------------------------------------------------------------

test('the Stripe webhook works without CSRF and still requires a valid signature', async () => {
  const secret = 'whsec_csrf_test_secret';
  const original = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = secret;

  try {
    const payload = JSON.stringify({
      id: `evt_csrf_${Date.now()}`,
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_csrf', metadata: {}, amount_total: 0, currency: 'aed' } },
    });

    // No CSRF token, no Origin, no cookie — and it is accepted, because its
    // authentication is the signature over the raw bytes.
    const signed = await api()
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set(
        'stripe-signature',
        Stripe.webhooks.generateTestHeaderString({ payload, secret })
      )
      .send(payload);
    assert.notEqual(signed.status, 403, `a signed webhook must not be refused: ${JSON.stringify(signed.body)}`);
    assert.ok(signed.status < 500, `unexpected ${signed.status}: ${JSON.stringify(signed.body)}`);

    // And the exclusion is only from CSRF. The signature is still mandatory.
    const unsigned = await api()
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);
    assert.equal(unsigned.status, 400, 'an unsigned webhook is still refused');

    const badSignature = await api()
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .send(payload);
    assert.equal(badSignature.status, 400);
  } finally {
    if (original === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = original;
  }
});

test('the webhook exclusion is by mount point, and nothing else is excluded', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
  const code = appSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const webhookMount = code.indexOf("app.use('/api/webhooks'");
  const csrfMount = code.indexOf("app.use('/api', csrfProtection)");
  assert.ok(webhookMount !== -1 && csrfMount !== -1);
  assert.ok(webhookMount < csrfMount, 'the raw-body webhook must be mounted before the CSRF gate');

  const csrfSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'csrf.js'), 'utf8');
  const csrfCode = csrfSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  // No route allowlist, no "skip if anonymous", no path exceptions. The only
  // rule is "a session cookie is present", which is exactly when there is
  // ambient authority to abuse.
  ['/api/auth', '/api/claims', 'SKIP_CSRF', 'exempt', 'allowlist', 'whitelist'].forEach((smell) => {
    assert.ok(!csrfCode.includes(smell), `no path-based CSRF exemption may exist (found "${smell}")`);
  });
});

// ---------------------------------------------------------------------------
// 23. The claim workflow is unaffected
// ---------------------------------------------------------------------------

test('the claim fragment workflow still works, with no session and no token in a URL', async () => {
  const claims = require('../server/lib/claims');
  const TEST_KEY = `v1:${require('crypto').randomBytes(32).toString('base64')}`;
  const originalKey = process.env.CLAIM_ENCRYPTION_KEY;
  process.env.CLAIM_ENCRYPTION_KEY = TEST_KEY;

  try {
    const host = await createAccount('claim-host');
    const winner = await createAccount('claim-winner', { hostStatus: 'not_requested' });

    const giveawayId = uuid();
    await pool.query(
      `INSERT INTO giveaways
         (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
       VALUES ($1, $2, 'Fabricated CSRF claim giveaway', 'd', 'p', 'Fabricated budget', $3, 'drawn')`,
      [giveawayId, host.id, new Date(Date.now() - 86400000).toISOString()]
    );
    createdGiveawayIds.push(giveawayId);
    const entryId = uuid();
    await pool.query(
      'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)',
      [entryId, giveawayId, winner.id]
    );
    await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);

    const client = await pool.connect();
    let claim;
    try {
      await client.query('BEGIN');
      claim = await claims.createClaimForDraw(client, {
        giveawayId,
        winnerUserId: winner.id,
        entryId,
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Exactly what the claim page does: a POST with the token in the body, from
    // a visitor who is not signed in. No session cookie, so no CSRF token is
    // required — and none could be obtained, because there is no session.
    const lookup = await api()
      .post('/api/claims/lookup')
      .set('Origin', TEST_ORIGIN)
      .set('Referer', `${TEST_ORIGIN}/claim.html`)
      .set('X-Forwarded-For', nextTestIp())
      .send({ token: claim.token });
    assert.equal(lookup.status, 200, JSON.stringify(lookup.body));

    const redeem = await api()
      .post('/api/claims/redeem')
      .set('Origin', TEST_ORIGIN)
      .set('Referer', `${TEST_ORIGIN}/claim.html`)
      .set('X-Forwarded-For', nextTestIp())
      .send({
        token: claim.token,
        consent: true,
        consent_version: claims.CONSENT_VERSION,
        delivery: {
          recipient_name: 'Fabricated Winner',
          phone: '+971 50 000 0000',
          address_line1: 'Villa 00, Fabricated Street',
          city: 'Nowhere City',
          emirate: 'Test Emirate',
        },
      });
    assert.equal(redeem.status, 200, JSON.stringify(redeem.body));

    // The old query-string form is still refused outright.
    const legacy = await api()
      .get(`/api/claims/lookup?token=${encodeURIComponent(claim.token)}`)
      .set('X-Forwarded-For', nextTestIp());
    assert.equal(legacy.status, 410);

    // Redeeming did not sign the winner in.
    assert.equal(String(redeem.headers['set-cookie'] || ''), '', 'a claim is not a login');
  } finally {
    if (originalKey === undefined) delete process.env.CLAIM_ENCRYPTION_KEY;
    else process.env.CLAIM_ENCRYPTION_KEY = originalKey;
  }
});

// ---------------------------------------------------------------------------
// 25. No bearer fallback
// ---------------------------------------------------------------------------

test('a bearer header authenticates nothing, with or without a CSRF token', async () => {
  const account = await createAccount('bearer');
  const session = await signIn(account.email, PASSWORD);
  const row = await pool.query('SELECT id, token_hash FROM sessions WHERE user_id = $1', [account.id]);

  // Even the real session id, presented as a bearer token, is worth nothing.
  const attempts = [
    api().get('/api/giveaways/mine/hosted').set('Authorization', `Bearer ${row.rows[0].id}`),
    api().get('/api/giveaways/mine/hosted').set('Authorization', `Bearer ${row.rows[0].token_hash}`),
    api()
      .post('/api/giveaways')
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${row.rows[0].id}`)
      .set(CSRF_HEADER, session.csrf)
      .send(giveawayPayload('bearer')),
  ];

  for (const attempt of attempts) {
    const res = await attempt;
    assert.equal(res.status, 401, 'there is no bearer path');
  }
  assert.equal(await countGiveaways(account.id), 0);
});

// ---------------------------------------------------------------------------
// The frontend sends it the right way
// ---------------------------------------------------------------------------

test('the frontend sends the CSRF token in a header, never a URL, and never stores it', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const code = appJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  assert.match(code, /X-CSRF-Token/, 'sent as a custom header');
  assert.match(code, /credentials:\s*'same-origin'/, 'the cookie goes only to this origin');

  assert.ok(!/csrf[^\n]*(localStorage|sessionStorage)/i.test(code), 'never stored');
  assert.ok(!/(localStorage|sessionStorage)[^\n]*csrf/i.test(code), 'never stored');
  assert.ok(!/[?&]csrf/i.test(code), 'never in a query string');
});
