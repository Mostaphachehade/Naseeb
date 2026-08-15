// Coverage for the winner claim, delivery and dispute workflow (audit #5).
//
// Delivery used to be one boolean the host set by clicking a button: the host
// asserting, alone and unverifiably, that they had sent the thing they
// promised. The winner had no way to confirm it, contradict it, or pass on an
// address — while the privacy policy told entrants that hosts could contact
// them, which nothing in the system made possible.
//
// Every person in these tests is fabricated, every address is invented, and the
// database is the isolated local cluster.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { api, pool, ensureInit } = require('../testHelpers');

const claims = require('../server/lib/claims');
const { STATES, ROLES, assertTransition, ClaimTransitionError } = require('../server/lib/claimStateMachine');
const { hashToken, issueToken, TOKEN_BYTES } = require('../server/lib/claimTokens');
const claimCrypto = require('../server/lib/claimCrypto');

// Fabricated key material, generated here, never committed anywhere.
const TEST_KEY = `v1:${crypto.randomBytes(32).toString('base64')}`;
const ROTATED_KEY = `v2:${crypto.randomBytes(32).toString('base64')}`;

// Invented delivery details. Distinctive strings so leakage into a log, an
// email or an API response is detectable rather than assumed absent.
const FABRICATED_DELIVERY = {
  recipient_name: 'Fabricated Winner',
  phone: '+971500000000',
  address_line1: 'Villa 42, Nonexistent Street',
  address_line2: 'Imaginary District',
  city: 'Fictionville',
  emirate: 'Testopolis',
  notes: 'Ring the doorbell twice (invented note)',
};
const SECRET_STRINGS = [
  FABRICATED_DELIVERY.phone,
  FABRICATED_DELIVERY.address_line1,
  FABRICATED_DELIVERY.address_line2,
  FABRICATED_DELIVERY.city,
];

const createdUserIds = [];
const createdGiveawayIds = [];

let consoleOutput = [];
const realLog = console.log;
const realError = console.error;

before(async () => {
  await ensureInit();
  process.env.CLAIM_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.CLAIM_ENCRYPTION_KEYS_PREVIOUS;
  delete process.env.CLAIM_DEV_LOG_LINKS;
});

beforeEach(() => {
  consoleOutput = [];
});

after(async () => {
  console.log = realLog;
  console.error = realError;
  if (createdGiveawayIds.length) {
    await pool.query('DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))', [createdGiveawayIds]);
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${192 + ((ipCounter >> 16) & 31)}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

async function createUser(tag, { admin = false } = {}) {
  const id = uuid();
  const email = `test-claim-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'correcthorse123';
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin)
     VALUES ($1, $2, $3, $4, TRUE, $5)`,
    [id, `Fabricated ${tag}`, email, bcrypt.hashSync(password, 4), admin]
  );
  createdUserIds.push(id);

  const login = await api()
    .post('/api/auth/login')
    .set('X-Forwarded-For', nextIp())
    .send({ email, password });
  assert.equal(login.status, 200, `login for ${tag} should succeed`);
  return { id, email, token: login.body.token };
}

// A giveaway that has already been drawn, with a live claim — the state the
// draw route leaves behind.
async function createDrawnGiveaway() {
  const host = await createUser('host');
  const winner = await createUser('winner');

  const giveawayId = uuid();
  await pool.query(
    `INSERT INTO giveaways
       (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Fabricated Giveaway', 'A test giveaway', 'A fabricated prize',
             'Marketing budget (fabricated)', $3, 'drawn')`,
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

  return { host, winner, giveawayId, entryId, claim };
}

function redeem(token, overrides = {}) {
  return api()
    .post('/api/claims/redeem')
    .set('X-Forwarded-For', nextIp())
    .send({
      token,
      consent: true,
      consent_version: claims.CONSENT_VERSION,
      delivery: FABRICATED_DELIVERY,
      ...overrides,
    });
}

function transition(claimId, authToken, body) {
  return api()
    .post(`/api/claims/${claimId}/transition`)
    .set('Authorization', `Bearer ${authToken}`)
    .set('X-Forwarded-For', nextIp())
    .send(body);
}

function viewClaim(giveawayId, authToken) {
  return api()
    .get(`/api/claims/giveaway/${giveawayId}`)
    .set('Authorization', `Bearer ${authToken}`);
}

// Walks a claim to a given state using the real endpoints, so the tests that
// care about later states still exercise every gate on the way there.
async function advanceTo(ctx, target) {
  const order = [
    STATES.PREPARING_DELIVERY,
    STATES.SHIPPED_OR_ARRANGED,
    STATES.DELIVERED_PENDING_CONFIRMATION,
    STATES.DELIVERED,
  ];
  for (const state of order) {
    const actor = state === STATES.DELIVERED ? ctx.winner : ctx.host;
    const res = await transition(ctx.claim.id, actor.token, { to: state });
    assert.equal(res.status, 200, `advancing to ${state} should succeed`);
    if (state === target) return;
  }
}

function captureConsole() {
  console.log = (...args) => consoleOutput.push(args.join(' '));
  console.error = (...args) => consoleOutput.push(args.join(' '));
}
function releaseConsole() {
  console.log = realLog;
  console.error = realError;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test('claim tokens carry 256 bits of randomness and are stored only as a hash', async () => {
  assert.equal(TOKEN_BYTES, 32, '32 bytes = 256 bits');

  const ctx = await createDrawnGiveaway();
  const stored = await pool.query('SELECT token_hash FROM prize_claims WHERE id = $1', [ctx.claim.id]);

  assert.ok(ctx.claim.token, 'the plaintext token is returned once, for the email');
  assert.ok(ctx.claim.token.length >= 43, 'base64url of 32 bytes');
  assert.notEqual(stored.rows[0].token_hash, ctx.claim.token, 'the token itself must not be stored');
  assert.equal(stored.rows[0].token_hash, hashToken(ctx.claim.token));
  assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/, 'SHA-256 hex');

  // And nowhere else in the row either.
  const wholeRow = await pool.query('SELECT * FROM prize_claims WHERE id = $1', [ctx.claim.id]);
  const serialized = JSON.stringify(wholeRow.rows[0]);
  assert.ok(!serialized.includes(ctx.claim.token), 'no column may contain the plaintext token');

  // Two tokens are never the same.
  const other = issueToken();
  assert.notEqual(other.tokenHash, stored.rows[0].token_hash);
});

test('a claim link is single-use', async () => {
  const ctx = await createDrawnGiveaway();

  const first = await redeem(ctx.claim.token);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, STATES.CLAIMED);

  const second = await redeem(ctx.claim.token);
  assert.equal(second.status, 410, 'the same link must not work twice');
  assert.equal(second.body.code, 'TOKEN_UNUSABLE');

  // The hash is cleared on use, so the token cannot be redeemed even by a
  // direct database lookup.
  const stored = await pool.query('SELECT token_hash, token_used_at FROM prize_claims WHERE id = $1', [
    ctx.claim.id,
  ]);
  assert.equal(stored.rows[0].token_hash, null);
  assert.ok(stored.rows[0].token_used_at);
});

test('two simultaneous redemptions create exactly one claim', async () => {
  const ctx = await createDrawnGiveaway();

  const results = await Promise.all([
    redeem(ctx.claim.token),
    redeem(ctx.claim.token),
    redeem(ctx.claim.token),
  ]);

  const succeeded = results.filter((r) => r.status === 200);
  assert.equal(succeeded.length, 1, 'exactly one submission may win the race');
  results
    .filter((r) => r.status !== 200)
    .forEach((r) => assert.equal(r.status, 410));

  const events = await pool.query(
    "SELECT COUNT(*)::int AS c FROM prize_claim_events WHERE claim_id = $1 AND to_status = 'claimed'",
    [ctx.claim.id]
  );
  assert.equal(events.rows[0].c, 1, 'and only one claim event is recorded');
});

test('an expired token cannot be redeemed', async () => {
  const ctx = await createDrawnGiveaway();
  await pool.query("UPDATE prize_claims SET token_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
    ctx.claim.id,
  ]);

  const res = await redeem(ctx.claim.token);
  assert.equal(res.status, 410);

  const lookup = await api().get(`/api/claims/lookup?token=${encodeURIComponent(ctx.claim.token)}`);
  assert.equal(lookup.status, 404);
});

test('reissuing a claim link invalidates the previous one', async () => {
  const ctx = await createDrawnGiveaway();
  const admin = await createUser('reissue-admin', { admin: true });

  await pool.query("UPDATE prize_claims SET token_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
    ctx.claim.id,
  ]);
  await pool.query("UPDATE prize_claims SET status = 'expired', expired_at = NOW() WHERE id = $1", [
    ctx.claim.id,
  ]);

  const reissued = await api()
    .post(`/api/claims/${ctx.claim.id}/admin/reissue`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Forwarded-For', nextIp())
    .send({});
  assert.equal(reissued.status, 200);
  assert.equal(reissued.body.status, STATES.AWAITING_CLAIM);

  // The old token is gone for good.
  const old = await redeem(ctx.claim.token);
  assert.equal(old.status, 410, 'the replaced link must not work');

  const stored = await pool.query('SELECT token_hash FROM prize_claims WHERE id = $1', [ctx.claim.id]);
  assert.notEqual(stored.rows[0].token_hash, hashToken(ctx.claim.token));
});

test('a claim token grants nothing beyond that one claim', async () => {
  const ctx = await createDrawnGiveaway();
  const other = await createDrawnGiveaway();

  // It cannot be used as a session anywhere else.
  const asAuth = await api()
    .get(`/api/claims/giveaway/${ctx.giveawayId}`)
    .set('Authorization', `Bearer ${ctx.claim.token}`);
  assert.equal(asAuth.status, 401, 'a claim token is not a session token');

  // And it cannot reach another giveaway's claim.
  const lookup = await api().get(`/api/claims/lookup?token=${encodeURIComponent(ctx.claim.token)}`);
  assert.equal(lookup.status, 200);
  assert.notEqual(lookup.body.claim_id, other.claim.id);
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('only the winner, host and an admin can see a claim', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);

  const stranger = await createUser('stranger');
  const admin = await createUser('viewer-admin', { admin: true });

  assert.equal((await viewClaim(ctx.giveawayId, ctx.winner.token)).body.role, ROLES.WINNER);
  assert.equal((await viewClaim(ctx.giveawayId, ctx.host.token)).body.role, ROLES.HOST);
  assert.equal((await viewClaim(ctx.giveawayId, admin.token)).body.role, ROLES.ADMIN);

  const denied = await viewClaim(ctx.giveawayId, stranger.token);
  assert.equal(denied.status, 403, 'an unrelated user gets nothing');

  const anonymous = await api().get(`/api/claims/giveaway/${ctx.giveawayId}`);
  assert.equal(anonymous.status, 401);
});

test('a stranger cannot move a claim along, whatever they claim to be', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  const stranger = await createUser('meddler');

  const res = await transition(ctx.claim.id, stranger.token, { to: STATES.PREPARING_DELIVERY });
  assert.equal(res.status, 403);

  const after = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [ctx.claim.id]);
  assert.equal(after.rows[0].status, STATES.CLAIMED, 'nothing moved');
});

test('roles are read from the database, not taken from the request', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  const stranger = await createUser('role-forger');

  // Asserting a role in the body changes nothing.
  const res = await transition(ctx.claim.id, stranger.token, {
    to: STATES.PREPARING_DELIVERY,
    role: 'host',
    actor_role: 'admin',
    is_admin: true,
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

test('nothing is stored and no host sees anything without explicit consent', async () => {
  const ctx = await createDrawnGiveaway();

  const refused = await redeem(ctx.claim.token, { consent: false });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'CONSENT_REQUIRED');

  const stored = await pool.query(
    'SELECT delivery_ciphertext, consented_at, status FROM prize_claims WHERE id = $1',
    [ctx.claim.id]
  );
  assert.equal(stored.rows[0].delivery_ciphertext, null, 'no details stored without consent');
  assert.equal(stored.rows[0].consented_at, null);
  assert.equal(stored.rows[0].status, STATES.AWAITING_CLAIM);

  // And the host is told nothing.
  const hostView = await viewClaim(ctx.giveawayId, ctx.host.token);
  assert.equal(hostView.body.delivery.available, false);
  assert.equal(hostView.body.delivery.reason, 'awaiting_consent');
});

test('consent is recorded with its version and timestamp', async () => {
  const ctx = await createDrawnGiveaway();
  const before = new Date();
  await redeem(ctx.claim.token);

  const stored = await pool.query(
    'SELECT consent_version, consented_at FROM prize_claims WHERE id = $1',
    [ctx.claim.id]
  );
  assert.equal(stored.rows[0].consent_version, claims.CONSENT_VERSION);
  assert.ok(new Date(stored.rows[0].consented_at) >= new Date(before.getTime() - 1000));
});

test('consent given against outdated wording is rejected', async () => {
  const ctx = await createDrawnGiveaway();
  const res = await redeem(ctx.claim.token, { consent_version: 'winner-delivery-1999-01' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CONSENT_VERSION_CHANGED');
});

test('the host sees only fulfilment fields, and only after consent', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);

  const hostView = await viewClaim(ctx.giveawayId, ctx.host.token);
  assert.equal(hostView.body.delivery.available, true);
  assert.deepEqual(Object.keys(hostView.body.delivery.details).sort(), [
    'address_line1',
    'address_line2',
    'city',
    'emirate',
    'notes',
    'phone',
    'recipient_name',
  ]);
  assert.equal(hostView.body.delivery.details.city, FABRICATED_DELIVERY.city);

  // The winner's account email is not part of what a host receives.
  const serialized = JSON.stringify(hostView.body);
  assert.ok(!serialized.includes(ctx.winner.email), "the winner's account email is not disclosed");
});

test('extra fields a client invents are dropped rather than stored', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token, {
    delivery: {
      ...FABRICATED_DELIVERY,
      passport_number: 'FABRICATED-123',
      credit_card: '4111111111111111',
      date_of_birth: '1990-01-01',
    },
  });

  const hostView = await viewClaim(ctx.giveawayId, ctx.host.token);
  const serialized = JSON.stringify(hostView.body);
  assert.ok(!serialized.includes('FABRICATED-123'), 'identity documents must never be stored');
  assert.ok(!serialized.includes('4111111111111111'), 'payment details must never be stored');
  assert.ok(!serialized.includes('1990-01-01'));
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

test('delivery details are encrypted at rest with a per-record IV', async () => {
  const first = await createDrawnGiveaway();
  const second = await createDrawnGiveaway();
  await redeem(first.claim.token);
  await redeem(second.claim.token);

  const rows = await pool.query(
    `SELECT delivery_ciphertext, delivery_iv, delivery_tag, delivery_key_version
       FROM prize_claims WHERE id = ANY($1)`,
    [[first.claim.id, second.claim.id]]
  );

  rows.rows.forEach((row) => {
    assert.ok(row.delivery_ciphertext);
    assert.ok(row.delivery_iv);
    assert.ok(row.delivery_tag);
    assert.equal(row.delivery_key_version, 'v1');
    // The plaintext is nowhere in the stored record.
    const serialized = JSON.stringify(row);
    SECRET_STRINGS.forEach((secret) => {
      assert.ok(!serialized.includes(secret), `${secret} must not appear in the database row`);
    });
  });

  assert.notEqual(rows.rows[0].delivery_iv, rows.rows[1].delivery_iv, 'each record needs its own IV');
  assert.notEqual(
    rows.rows[0].delivery_ciphertext,
    rows.rows[1].delivery_ciphertext,
    'identical plaintext must not produce identical ciphertext'
  );
});

test('tampered ciphertext fails authentication instead of decrypting', async () => {
  const encrypted = claimCrypto.encryptDeliveryDetails(FABRICATED_DELIVERY);

  // Flip one byte of the ciphertext.
  const bytes = Buffer.from(encrypted.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  assert.throws(
    () => claimCrypto.decryptDeliveryDetails({ ...encrypted, ciphertext: bytes.toString('base64') }),
    /could not be decrypted or failed authentication/
  );

  // And a swapped authentication tag.
  const otherTag = claimCrypto.encryptDeliveryDetails(FABRICATED_DELIVERY).tag;
  assert.throws(
    () => claimCrypto.decryptDeliveryDetails({ ...encrypted, tag: otherTag }),
    /could not be decrypted or failed authentication/
  );

  // Intact, it round-trips.
  assert.deepEqual(claimCrypto.decryptDeliveryDetails(encrypted), FABRICATED_DELIVERY);
});

test('a rotated key still reads records written under the previous one', async () => {
  const underOldKey = claimCrypto.encryptDeliveryDetails(FABRICATED_DELIVERY);
  assert.equal(underOldKey.keyVersion, 'v1');

  // Rotation: the old key moves to the previous list, a new one becomes active.
  process.env.CLAIM_ENCRYPTION_KEY = ROTATED_KEY;
  process.env.CLAIM_ENCRYPTION_KEYS_PREVIOUS = TEST_KEY;
  try {
    const underNewKey = claimCrypto.encryptDeliveryDetails(FABRICATED_DELIVERY);
    assert.equal(underNewKey.keyVersion, 'v2', 'new records use the new key');

    assert.deepEqual(
      claimCrypto.decryptDeliveryDetails(underOldKey),
      FABRICATED_DELIVERY,
      'existing records stay readable'
    );
    assert.deepEqual(claimCrypto.decryptDeliveryDetails(underNewKey), FABRICATED_DELIVERY);

    // Without the old key in the list, the old record is unreadable — which is
    // what makes retiring a key meaningful.
    delete process.env.CLAIM_ENCRYPTION_KEYS_PREVIOUS;
    assert.throws(() => claimCrypto.decryptDeliveryDetails(underOldKey));
  } finally {
    process.env.CLAIM_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.CLAIM_ENCRYPTION_KEYS_PREVIOUS;
  }
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('the happy path runs winner → host → host → host → winner', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);

  const steps = [
    [STATES.PREPARING_DELIVERY, ctx.host],
    [STATES.SHIPPED_OR_ARRANGED, ctx.host],
    [STATES.DELIVERED_PENDING_CONFIRMATION, ctx.host],
    [STATES.DELIVERED, ctx.winner],
  ];
  for (const [state, actor] of steps) {
    const res = await transition(ctx.claim.id, actor.token, { to: state });
    assert.equal(res.status, 200, `${state} should be allowed`);
    assert.equal(res.body.status, state);
  }

  // The public trust signal only flips once the winner has said so.
  const giveaway = await pool.query(
    'SELECT prize_delivered, prize_delivered_at FROM giveaways WHERE id = $1',
    [ctx.giveawayId]
  );
  assert.equal(giveaway.rows[0].prize_delivered, true);
  assert.ok(giveaway.rows[0].prize_delivered_at);
});

test('the host alone cannot mark a prize delivered', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.DELIVERED_PENDING_CONFIRMATION);

  const hostAttempt = await transition(ctx.claim.id, ctx.host.token, { to: STATES.DELIVERED });
  assert.equal(hostAttempt.status, 403, 'saying "you received it" is not the host’s to say');

  const stillPending = await pool.query(
    `SELECT c.status, g.prize_delivered
       FROM prize_claims c JOIN giveaways g ON g.id = c.giveaway_id
      WHERE c.id = $1`,
    [ctx.claim.id]
  );
  assert.equal(stillPending.rows[0].status, STATES.DELIVERED_PENDING_CONFIRMATION);
  assert.equal(stillPending.rows[0].prize_delivered, false);

  // The winner can.
  const winnerConfirm = await transition(ctx.claim.id, ctx.winner.token, { to: STATES.DELIVERED });
  assert.equal(winnerConfirm.status, 200);
});

test('out-of-order transitions are rejected', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);

  // Skipping straight to shipped, or to delivered, from claimed.
  for (const target of [STATES.SHIPPED_OR_ARRANGED, STATES.DELIVERED_PENDING_CONFIRMATION]) {
    const res = await transition(ctx.claim.id, ctx.host.token, { to: target });
    assert.equal(res.status, 409, `claimed → ${target} must be refused`);
    assert.equal(res.body.code, 'INVALID_TRANSITION');
  }

  const backwards = await transition(ctx.claim.id, ctx.host.token, { to: STATES.AWAITING_CLAIM });
  assert.equal(backwards.status, 409);

  const nonsense = await transition(ctx.claim.id, ctx.host.token, { to: 'teleported' });
  assert.equal(nonsense.status, 400);
});

test('a delivered claim is final', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.DELIVERED);

  for (const [actor, target] of [
    [ctx.host, STATES.PREPARING_DELIVERY],
    [ctx.winner, STATES.DISPUTED],
  ]) {
    const res = await transition(ctx.claim.id, actor.token, { to: target, note: 'changed my mind' });
    assert.equal(res.status, 409, 'a terminal claim cannot be reopened');
  }
});

test('every declared transition is permitted for its roles and refused for others', () => {
  // Exercises the table directly, so a transition added without thinking about
  // who may make it shows up here rather than in production.
  const cases = [
    [STATES.AWAITING_CLAIM, STATES.CLAIMED, ROLES.WINNER, true],
    [STATES.AWAITING_CLAIM, STATES.CLAIMED, ROLES.HOST, false],
    [STATES.AWAITING_CLAIM, STATES.CLAIMED, ROLES.ADMIN, false],
    [STATES.AWAITING_CLAIM, STATES.EXPIRED, ROLES.SYSTEM, true],
    [STATES.AWAITING_CLAIM, STATES.DELIVERED, ROLES.ADMIN, false],
    [STATES.CLAIMED, STATES.PREPARING_DELIVERY, ROLES.HOST, true],
    [STATES.CLAIMED, STATES.PREPARING_DELIVERY, ROLES.WINNER, false],
    [STATES.CLAIMED, STATES.DISPUTED, ROLES.WINNER, true],
    [STATES.CLAIMED, STATES.DISPUTED, ROLES.HOST, true],
    [STATES.PREPARING_DELIVERY, STATES.SHIPPED_OR_ARRANGED, ROLES.HOST, true],
    [STATES.PREPARING_DELIVERY, STATES.DELIVERED, ROLES.HOST, false],
    [STATES.SHIPPED_OR_ARRANGED, STATES.DELIVERED_PENDING_CONFIRMATION, ROLES.HOST, true],
    [STATES.SHIPPED_OR_ARRANGED, STATES.DELIVERED, ROLES.HOST, false],
    [STATES.DELIVERED_PENDING_CONFIRMATION, STATES.DELIVERED, ROLES.WINNER, true],
    [STATES.DELIVERED_PENDING_CONFIRMATION, STATES.DELIVERED, ROLES.HOST, false],
    [STATES.DELIVERED_PENDING_CONFIRMATION, STATES.DELIVERED, ROLES.ADMIN, false],
    [STATES.DISPUTED, STATES.DELIVERED, ROLES.ADMIN, true],
    [STATES.DISPUTED, STATES.DELIVERED, ROLES.HOST, false],
    [STATES.DISPUTED, STATES.CANCELLED, ROLES.ADMIN, true],
    [STATES.EXPIRED, STATES.AWAITING_CLAIM, ROLES.ADMIN, true],
    [STATES.EXPIRED, STATES.AWAITING_CLAIM, ROLES.HOST, false],
    [STATES.DELIVERED, STATES.DISPUTED, ROLES.WINNER, false],
    [STATES.CANCELLED, STATES.CLAIMED, ROLES.ADMIN, false],
  ];

  cases.forEach(([from, to, role, allowed]) => {
    if (allowed) {
      assert.doesNotThrow(() => assertTransition(from, to, role), `${from} → ${to} as ${role}`);
    } else {
      assert.throws(
        () => assertTransition(from, to, role),
        (err) => err instanceof ClaimTransitionError,
        `${from} → ${to} as ${role} must be refused`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

test('either party can raise a dispute, and it needs a reason', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.SHIPPED_OR_ARRANGED);

  const noReason = await transition(ctx.claim.id, ctx.winner.token, { to: STATES.DISPUTED });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  const raised = await transition(ctx.claim.id, ctx.winner.token, {
    to: STATES.DISPUTED,
    note: 'Nothing arrived after two weeks (fabricated).',
  });
  assert.equal(raised.status, 200);
  assert.equal(raised.body.status, STATES.DISPUTED);

  const stored = await pool.query('SELECT disputed_by, disputed_at FROM prize_claims WHERE id = $1', [
    ctx.claim.id,
  ]);
  assert.equal(stored.rows[0].disputed_by, ctx.winner.id, 'who raised it is recorded');
  assert.ok(stored.rows[0].disputed_at);
});

test('only an admin resolves a dispute, and only with a recorded reason', async () => {
  const ctx = await createDrawnGiveaway();
  const admin = await createUser('resolver', { admin: true });
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.SHIPPED_OR_ARRANGED);
  await transition(ctx.claim.id, ctx.winner.token, { to: STATES.DISPUTED, note: 'Not received.' });

  // Neither party can resolve their own dispute.
  for (const actor of [ctx.host, ctx.winner]) {
    const res = await transition(ctx.claim.id, actor.token, {
      to: STATES.DELIVERED,
      note: 'sorted it out ourselves',
    });
    assert.equal(res.status, 403);
  }

  const noReason = await transition(ctx.claim.id, admin.token, { to: STATES.DELIVERED });
  assert.equal(noReason.status, 400, 'an unexplained resolution is unauditable');

  const resolved = await transition(ctx.claim.id, admin.token, {
    to: STATES.DELIVERED,
    note: 'Courier proof of delivery supplied by host; winner confirmed by phone (fabricated).',
  });
  assert.equal(resolved.status, 200);

  const stored = await pool.query(
    'SELECT resolved_by, resolved_at, status FROM prize_claims WHERE id = $1',
    [ctx.claim.id]
  );
  assert.equal(stored.rows[0].resolved_by, admin.id);
  assert.ok(stored.rows[0].resolved_at);
  assert.equal(stored.rows[0].status, STATES.DELIVERED);

  const history = await pool.query(
    "SELECT note, actor_role FROM prize_claim_events WHERE claim_id = $1 AND to_status = 'delivered' ORDER BY created_at DESC LIMIT 1",
    [ctx.claim.id]
  );
  assert.equal(history.rows[0].actor_role, ROLES.ADMIN);
  assert.match(history.rows[0].note, /Courier proof/);
});

test('an admin can send a disputed claim back to fulfilment', async () => {
  const ctx = await createDrawnGiveaway();
  const admin = await createUser('sendback-admin', { admin: true });
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.SHIPPED_OR_ARRANGED);
  await transition(ctx.claim.id, ctx.winner.token, { to: STATES.DISPUTED, note: 'Wrong item.' });

  const res = await transition(ctx.claim.id, admin.token, {
    to: STATES.PREPARING_DELIVERY,
    note: 'Host to resend the correct item (fabricated).',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, STATES.PREPARING_DELIVERY);
});

// ---------------------------------------------------------------------------
// Expiry and admin review
// ---------------------------------------------------------------------------

test('an expired claim goes to admin review, and never redraws or cancels', async () => {
  const ctx = await createDrawnGiveaway();
  const admin = await createUser('review-admin', { admin: true });

  const winnerBefore = await pool.query('SELECT winner_entry_id, status FROM giveaways WHERE id = $1', [
    ctx.giveawayId,
  ]);

  await pool.query("UPDATE prize_claims SET token_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
    ctx.claim.id,
  ]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expired = await claims.expireLapsedClaims(client);
    await client.query('COMMIT');
    assert.ok(expired >= 1);
  } finally {
    client.release();
  }

  const stored = await pool.query('SELECT status, winner_user_id FROM prize_claims WHERE id = $1', [
    ctx.claim.id,
  ]);
  assert.equal(stored.rows[0].status, STATES.EXPIRED);
  assert.equal(stored.rows[0].winner_user_id, ctx.winner.id, 'the same person still won');

  // The giveaway is untouched: no redraw, no cancellation.
  const winnerAfter = await pool.query('SELECT winner_entry_id, status FROM giveaways WHERE id = $1', [
    ctx.giveawayId,
  ]);
  assert.equal(winnerAfter.rows[0].winner_entry_id, winnerBefore.rows[0].winner_entry_id);
  assert.equal(winnerAfter.rows[0].status, winnerBefore.rows[0].status);

  // And it surfaces for a human.
  const queue = await api().get('/api/claims/admin/review').set('Authorization', `Bearer ${admin.token}`);
  assert.equal(queue.status, 200);
  assert.ok(queue.body.some((row) => row.id === ctx.claim.id), 'it must appear in the review queue');
});

test('expiring lapsed claims is idempotent', async () => {
  const ctx = await createDrawnGiveaway();
  await pool.query("UPDATE prize_claims SET token_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
    ctx.claim.id,
  ]);

  const runSweep = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const n = await claims.expireLapsedClaims(client);
      await client.query('COMMIT');
      return n;
    } finally {
      client.release();
    }
  };

  assert.ok((await runSweep()) >= 1);
  const second = await runSweep();
  const eventsAfter = await pool.query(
    "SELECT COUNT(*)::int AS c FROM prize_claim_events WHERE claim_id = $1 AND to_status = 'expired'",
    [ctx.claim.id]
  );
  assert.equal(eventsAfter.rows[0].c, 1, 'a second sweep must not re-expire the same claim');
  assert.equal(second, 0);
});

test('the admin review queue carries no delivery details', async () => {
  const ctx = await createDrawnGiveaway();
  const admin = await createUser('queue-admin', { admin: true });
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.SHIPPED_OR_ARRANGED);
  await transition(ctx.claim.id, ctx.winner.token, { to: STATES.DISPUTED, note: 'Not received.' });

  const queue = await api().get('/api/claims/admin/review').set('Authorization', `Bearer ${admin.token}`);
  const serialized = JSON.stringify(queue.body);
  SECRET_STRINGS.forEach((secret) => {
    assert.ok(!serialized.includes(secret), `${secret} must not appear in an admin list`);
  });

  const nonAdmin = await api()
    .get('/api/claims/admin/review')
    .set('Authorization', `Bearer ${ctx.host.token}`);
  assert.equal(nonAdmin.status, 403);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test('delivery details are erased after the retention period, keeping the audit trail', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.DELIVERED);

  // Delivered long enough ago to be past retention.
  await pool.query("UPDATE prize_claims SET delivered_at = NOW() - INTERVAL '400 days' WHERE id = $1", [
    ctx.claim.id,
  ]);

  const runCleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const n = await claims.eraseExpiredDeliveryDetails(client, { days: 30 });
      await client.query('COMMIT');
      return n;
    } finally {
      client.release();
    }
  };

  assert.equal(await runCleanup(), 1);

  const stored = await pool.query(
    `SELECT delivery_ciphertext, delivery_iv, delivery_tag, delivery_key_version,
            delivery_erased_at, status, delivered_at
       FROM prize_claims WHERE id = $1`,
    [ctx.claim.id]
  );
  assert.equal(stored.rows[0].delivery_ciphertext, null);
  assert.equal(stored.rows[0].delivery_iv, null);
  assert.equal(stored.rows[0].delivery_tag, null);
  assert.equal(stored.rows[0].delivery_key_version, null);
  assert.ok(stored.rows[0].delivery_erased_at);

  // The claim, its outcome and its history all survive.
  assert.equal(stored.rows[0].status, STATES.DELIVERED);
  assert.ok(stored.rows[0].delivered_at);
  const history = await pool.query(
    'SELECT COUNT(*)::int AS c FROM prize_claim_events WHERE claim_id = $1',
    [ctx.claim.id]
  );
  assert.ok(history.rows[0].c >= 5, 'the transition history is not erased with the address');

  // Repeated cleanup is a no-op.
  assert.equal(await runCleanup(), 0);

  // And the host can no longer see what was deleted.
  const hostView = await viewClaim(ctx.giveawayId, ctx.host.token);
  assert.equal(hostView.body.delivery.available, false);
  assert.equal(hostView.body.delivery.reason, 'erased');
  assert.equal(hostView.body.delivery_details_erased, true);
});

test('retention leaves a still-active claim alone', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.SHIPPED_OR_ARRANGED);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await claims.eraseExpiredDeliveryDetails(client, { days: 0 });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const stored = await pool.query('SELECT delivery_ciphertext FROM prize_claims WHERE id = $1', [
    ctx.claim.id,
  ]);
  assert.ok(stored.rows[0].delivery_ciphertext, 'an undelivered prize still needs its address');
});

// ---------------------------------------------------------------------------
// Leakage
// ---------------------------------------------------------------------------

test('no delivery detail or token reaches the logs', async () => {
  const ctx = await createDrawnGiveaway();

  captureConsole();
  try {
    await redeem(ctx.claim.token);
    await transition(ctx.claim.id, ctx.host.token, { to: STATES.PREPARING_DELIVERY });
  } finally {
    releaseConsole();
  }

  const logged = consoleOutput.join('\n');
  SECRET_STRINGS.forEach((secret) => {
    assert.ok(!logged.includes(secret), `${secret} must never be logged`);
  });
  assert.ok(!logged.includes(ctx.claim.token), 'a claim token must never be logged');
});

test('the claim invitation email is never written to the dev log', async () => {
  const { sendEmail } = require('../server/lib/email');
  captureConsole();
  try {
    await sendEmail({
      to: 'winner@example.com',
      subject: 'Claim your prize',
      html: '<a href="https://example.com/claim.html?token=SUPERSECRETTOKENVALUE">claim</a>',
      sensitive: true,
    });
  } finally {
    releaseConsole();
  }

  const logged = consoleOutput.join('\n');
  assert.ok(!logged.includes('SUPERSECRETTOKENVALUE'), 'a claim link must not reach the console');
  assert.match(logged, /body suppressed/);
});

test('public giveaway data shows a coarse status and nothing more', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.SHIPPED_OR_ARRANGED);

  const publicView = await api().get(`/api/giveaways/${ctx.giveawayId}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.claim_status, 'delivery_in_progress');

  const serialized = JSON.stringify(publicView.body);
  SECRET_STRINGS.forEach((secret) => {
    assert.ok(!serialized.includes(secret), `${secret} must not be public`);
  });
  assert.ok(!serialized.includes(ctx.claim.token));
  assert.ok(!serialized.includes(ctx.winner.email));
});

test('the retired host-only delivery endpoint can no longer mark anything delivered', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);
  await advanceTo(ctx, STATES.SHIPPED_OR_ARRANGED);

  const res = await api()
    .post(`/api/giveaways/${ctx.giveawayId}/confirm-delivery`)
    .set('Authorization', `Bearer ${ctx.host.token}`)
    .send({});

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'USE_CLAIM_WORKFLOW');

  const giveaway = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [
    ctx.giveawayId,
  ]);
  assert.equal(giveaway.rows[0].prize_delivered, false, 'the host cannot bypass the winner');
});

// ---------------------------------------------------------------------------
// Email failure
// ---------------------------------------------------------------------------

test('a failing email provider does not roll back a completed state change', async () => {
  const ctx = await createDrawnGiveaway();
  await redeem(ctx.claim.token);

  // Make every outbound email attempt fail the way a provider outage would.
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 're_fabricated_key_that_will_fail';
  globalThis.fetch = async () => {
    throw new Error('Simulated mail provider outage');
  };

  try {
    const res = await transition(ctx.claim.id, ctx.host.token, { to: STATES.PREPARING_DELIVERY });
    assert.equal(res.status, 200, 'the state change still succeeds');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }

  // Give the fire-and-forget send a tick to fail.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stored = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [ctx.claim.id]);
  assert.equal(
    stored.rows[0].status,
    STATES.PREPARING_DELIVERY,
    'a mail outage must not undo a change both parties have already been shown'
  );
});
