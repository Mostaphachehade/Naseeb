const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { api, pool, ensureInit, signIn, anon, nextTestIp } = require('../testHelpers');
const claims = require('../server/lib/claims');
const { STATES } = require('../server/lib/claimStateMachine');

const createdUserIds = [];
const createdGiveawayIds = [];

before(async () => {
  await ensureInit();
  // Fabricated key, generated per run, never written anywhere.
  process.env.CLAIM_ENCRYPTION_KEY = `v1:${crypto.randomBytes(32).toString('base64')}`;
});

after(async () => {
  if (createdGiveawayIds.length) {
    await pool.query(
      'DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

async function createVerifiedUser(tag) {
  const id = uuid();
  const email = `test-delivery-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'correcthorse123';
  await pool.query(
    // Approved to host: these tests exercise delivery, not the host-access gate.
    `INSERT INTO users (id, name, email, password_hash, email_verified, host_status, age_attestation_status, age_attestation_version)
     VALUES ($1, $2, $3, $4, TRUE, 'approved', 'confirmed', '2026-08-eligibility-18')`,
    [id, `Delivery Test ${tag}`, email, bcrypt.hashSync(password, 4)]
  );
  createdUserIds.push(id);
  // A cookie jar, not a token: authentication is an HttpOnly cookie the page
  // cannot read, so a test cannot hold one either.
  const session = await signIn(email, password, { ip: nextTestIp() });
  return { ...session, id, email };
}

async function createDrawnGiveaway(hostId, winnerId) {
  const id = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Delivery test giveaway', 'desc', 'prize', 'test budget', $3, 'active')`,
    [id, hostId, new Date(Date.now() - 60 * 1000).toISOString()]
  );
  createdGiveawayIds.push(id);
  const entryId = uuid();
  await pool.query(
    `INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)`,
    [entryId, id, winnerId]
  );
  await pool.query(`UPDATE giveaways SET status = 'drawn', winner_entry_id = $1 WHERE id = $2`, [entryId, id]);
  return id;
}

// Creates the claim the draw route would have created, and returns its
// single-use token.
async function createClaimFor(giveawayId, winnerId) {
  const entry = await pool.query('SELECT id FROM entries WHERE giveaway_id = $1 LIMIT 1', [giveawayId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await claims.createClaimForDraw(client, {
      giveawayId,
      winnerUserId: winnerId,
      entryId: entry.rows[0].id,
    });
    await client.query('COMMIT');
    return claim;
  } finally {
    client.release();
  }
}

const FABRICATED_DELIVERY = {
  recipient_name: 'Fabricated Recipient',
  phone: '+971500000001',
  address_line1: 'Unit 7, Invented Tower',
  city: 'Fictionville',
  emirate: 'Testopolis',
};

// Walks a claim from awaiting_claim all the way to delivered, through the real
// endpoints — host moves it along, winner closes it.
async function completeDelivery(giveawayId, host, winner) {
  const claim = await createClaimFor(giveawayId, winner.id);
  const redeemed = await api().post('/api/claims/redeem').send({
    token: claim.token,
    consent: true,
    consent_version: claims.CONSENT_VERSION,
    delivery: FABRICATED_DELIVERY,
  });
  assert.equal(redeemed.status, 200);

  for (const [state, actor] of [
    [STATES.PREPARING_DELIVERY, host],
    [STATES.SHIPPED_OR_ARRANGED, host],
    [STATES.DELIVERED_PENDING_CONFIRMATION, host],
    [STATES.DELIVERED, winner],
  ]) {
    const res = await actor.post(`/api/claims/${claim.id}/transition`)
      .send({ to: state });
    assert.equal(res.status, 200, `moving to ${state} should succeed`);
  }
  return claim;
}

// The endpoint this file used to be about. It let a host declare, on their own,
// that a prize had been delivered — the winner had no say, and nobody could
// tell a delivered prize from one the host had simply clicked a button about.
// It now refuses and points at the claim workflow.
test('the host can no longer declare delivery on their own', async () => {
  const host = await createVerifiedUser('host');
  const winner = await createVerifiedUser('winner');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);
  await createClaimFor(giveawayId, winner.id);

  const res = await host.post(`/api/giveaways/${giveawayId}/confirm-delivery`)
    .send();

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'USE_CLAIM_WORKFLOW');

  const check = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [giveawayId]);
  assert.equal(check.rows[0].prize_delivered, false, 'nothing may be marked delivered by the host alone');
});

test('an unrelated user cannot touch delivery at all', async () => {
  const host = await createVerifiedUser('host2');
  const winner = await createVerifiedUser('winner2');
  const stranger = await createVerifiedUser('stranger2');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);

  const res = await stranger.post(`/api/giveaways/${giveawayId}/confirm-delivery`)
    .send();

  assert.equal(res.status, 403);
  const check = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [giveawayId]);
  assert.equal(check.rows[0].prize_delivered, false);
});

test('delivery cannot be touched before a winner is drawn', async () => {
  const host = await createVerifiedUser('host3');
  const id = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline)
     VALUES ($1, $2, 'Undrawn delivery test', 'desc', 'prize', 'test budget', $3)`,
    [id, host.id, new Date(Date.now() + 5 * 60 * 1000).toISOString()]
  );
  createdGiveawayIds.push(id);

  const res = await host.post(`/api/giveaways/${id}/confirm-delivery`)
    .send();

  // No claim exists because nobody has won, so there is nothing to fulfil.
  assert.equal(res.status, 409);
  assert.equal(res.body.claim_id, null);
});

test('prize_delivered is set only once the winner confirms receipt', async () => {
  const host = await createVerifiedUser('host4');
  const winner = await createVerifiedUser('winner4');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);
  const claim = await createClaimFor(giveawayId, winner.id);

  await api().post('/api/claims/redeem').send({
    token: claim.token,
    consent: true,
    consent_version: claims.CONSENT_VERSION,
    delivery: FABRICATED_DELIVERY,
  });

  // Right up to the last step, the host has not been able to set it.
  for (const state of [STATES.PREPARING_DELIVERY, STATES.SHIPPED_OR_ARRANGED, STATES.DELIVERED_PENDING_CONFIRMATION]) {
    await host.post(`/api/claims/${claim.id}/transition`)
      .send({ to: state });
    const midway = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [giveawayId]);
    assert.equal(midway.rows[0].prize_delivered, false, `still false at ${state}`);
  }

  const confirmed = await winner.post(`/api/claims/${claim.id}/transition`)
    .send({ to: STATES.DELIVERED });
  assert.equal(confirmed.status, 200);

  const after = await pool.query(
    'SELECT prize_delivered, prize_delivered_at FROM giveaways WHERE id = $1',
    [giveawayId]
  );
  assert.equal(after.rows[0].prize_delivered, true);
  assert.ok(after.rows[0].prize_delivered_at);
});

test('a winner-confirmed delivery appears on the public winners endpoint', async () => {
  const host = await createVerifiedUser('host5');
  const winner = await createVerifiedUser('winner5');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);
  await completeDelivery(giveawayId, host, winner);

  const res = await api().get('/api/giveaways/winners/all?pageSize=48');
  const found = res.body.items.find((i) => i.id === giveawayId);
  assert.ok(found, 'giveaway should appear in the public winners list');
  assert.equal(found.prize_delivered, true);

  // And the public record still carries nothing about where it went.
  const serialized = JSON.stringify(found);
  assert.ok(!serialized.includes(FABRICATED_DELIVERY.address_line1));
  assert.ok(!serialized.includes(FABRICATED_DELIVERY.phone));
});
