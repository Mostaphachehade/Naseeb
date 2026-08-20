// Suspending a host must not strand a winner, and host applications must not
// be deletable.
//
// The first cut of host access reported its recovery path as "the winner raises
// a dispute and an administrator resolves it". That required the winner to
// notice that a delivery had gone quiet, work out that something had gone wrong
// inside the platform, and then use the complaints mechanism to repair a
// decision that had nothing to do with them. It is not a recovery path.
//
// It also left a delete route on host applications, so the record of somebody
// asking to host could be made to have never happened.
//
// Fabricated accounts and fabricated addresses only, against the isolated test
// database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { api, pool, ensureInit, signIn, anon, seedGiveaway, closePool } = require('../testHelpers');

const { HOST_STATUS } = require('../server/lib/hostAccess');
const { STATES, ROLES, RESCUE_ELIGIBLE_STATES } = require('../server/lib/claimStateMachine');
const claims = require('../server/lib/claims');

const createdUserIds = [];
const createdGiveawayIds = [];

// A key that exists only for this file, generated here and never written down.
// Delivery details are encrypted at rest, so a test that exercises them needs
// one — and must not borrow whatever the environment happens to have.
const TEST_KEY = `v1:${require('crypto').randomBytes(32).toString('base64')}`;

before(async () => {
  await ensureInit();
  process.env.CLAIM_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.CLAIM_ENCRYPTION_KEYS_PREVIOUS;
  delete process.env.CLAIM_DEV_LOG_LINKS;
});

after(async () => {
  if (createdGiveawayIds.length) {
    await pool.query(
      'DELETE FROM claim_rescue_queue WHERE giveaway_id = ANY($1)',
      [createdGiveawayIds]
    );
    await pool.query(
      'DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query(
      'DELETE FROM claim_notifications WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query(
      `UPDATE giveaways
          SET winner_entry_id = NULL, drawn_at = NULL,
              status = CASE WHEN status = 'drawn' THEN 'closed_pending_draw' ELSE status END
        WHERE id = ANY($1)`,
      [createdGiveawayIds]
    );
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM host_status_events WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM host_applications WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await closePool();
});

const PASSWORD = 'correcthorse123';

let ipCounter = 0;
function uniqueIp() {
  ipCounter += 1;
  return `10.60.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
}

// Entirely invented. No real person lives here.
const FABRICATED_DELIVERY = {
  recipient_name: 'Fabricated Winner',
  phone: '+971 50 000 0000',
  address_line1: 'Villa 00, Fabricated Street',
  address_line2: 'Invented Block B',
  city: 'Nowhere City',
  emirate: 'Test Emirate',
  notes: 'Leave with the fabricated concierge.',
};

async function createUser(tag, { admin = false, hostStatus = HOST_STATUS.NOT_REQUESTED } = {}) {
  const id = uuid();
  const email = `test-rescue-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status, age_attestation_status, age_attestation_version)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, 'confirmed', '2026-08-eligibility-18')`,
    [id, `Rescue ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin, hostStatus]
  );
  createdUserIds.push(id);
  // A cookie jar, not a token: authentication is an HttpOnly cookie the page
  // cannot read, so a test cannot hold one either.
  const session = await signIn(email, PASSWORD, { ip: uniqueIp() });
  return { ...session, id, email };
}

// A drawn giveaway with a live claim, and the raw token the winner would have
// been emailed.
async function drawnGiveawayWithClaim(tag) {
  const host = await createUser(`${tag}-host`, { hostStatus: HOST_STATUS.APPROVED });
  const winner = await createUser(`${tag}-winner`);

  const giveawayId = await seedGiveaway({
    hostId: host.id,
    status: 'closed_pending_draw',
    title: 'Fabricated rescue giveaway',
    closesAt: new Date(Date.now() - 86400000),
  });
  createdGiveawayIds.push(giveawayId);

  const entryId = uuid();
  await pool.query('INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)', [
    entryId,
    giveawayId,
    winner.id,
  ]);
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

  return { host, winner, giveawayId, entryId, claim, token: claim.token };
}

function redeem(token) {
  return api()
    .post('/api/claims/redeem')
    .set('X-Forwarded-For', uniqueIp())
    .send({
      token,
      consent: true,
      consent_version: claims.CONSENT_VERSION,
      delivery: FABRICATED_DELIVERY,
    });
}

function suspend(adminSession, hostId, reason = 'Fabricated suspension for a test.') {
  return adminSession.post(`/api/admin/hosts/${hostId}/status`)
    .send({ status: 'suspended', reason });
}

function rescueStep(adminSession, claimId, to, reason = 'Taking over for an unavailable host.') {
  return adminSession.post(`/api/claims/${claimId}/rescue/transition`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ to, reason });
}

function openDetails(adminSession, claimId, reason = 'Need the address to arrange courier collection.') {
  return adminSession.post(`/api/claims/${claimId}/rescue/delivery-details`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ reason });
}

function rescueQueue(adminSession) {
  return adminSession.get('/api/claims/admin/rescue-queue');
}

// A claim that the winner has opened, so delivery details exist and the claim
// is sitting where a host would normally act.
async function claimedAndSuspended(tag) {
  const admin = await createUser(`${tag}-admin`, { admin: true });
  const scene = await drawnGiveawayWithClaim(tag);

  const redeemed = await redeem(scene.token);
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));

  const suspended = await suspend(admin, scene.host.id);
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

  return { ...scene, admin };
}

// ---------------------------------------------------------------------------
// 1–3. Suspension removes access and creates the queue, once
// ---------------------------------------------------------------------------

test('suspending a host removes their claim-management access immediately', async () => {
  const scene = await claimedAndSuspended('immediate');

  // The host's session is untouched — only the database changed.
  const view = await scene.host.get(`/api/claims/giveaway/${scene.giveawayId}`);
  assert.equal(view.status, 403, 'a suspended host may not read the winner\'s details');

  const move = await scene.host.post(`/api/claims/${scene.claim.id}/transition`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ to: STATES.PREPARING_DELIVERY });
  assert.equal(move.status, 403);

  const unchanged = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [scene.claim.id]);
  assert.equal(unchanged.rows[0].status, STATES.CLAIMED, 'a refused action changes nothing');
});

test('the affected claim appears exactly once in the rescue queue, with no winner asked to do anything', async () => {
  const scene = await claimedAndSuspended('queue-once');

  const queue = await rescueQueue(scene.admin);
  assert.equal(queue.status, 200);

  const mine = queue.body.filter((r) => r.claim_id === scene.claim.id);
  assert.equal(mine.length, 1, 'exactly one queue entry');
  assert.equal(mine[0].claim_status, STATES.CLAIMED);
  assert.equal(mine[0].action_available, true, 'the administrator can act on this one now');

  // And no dispute was needed to get here.
  const claim = await pool.query('SELECT status, disputed_at FROM prize_claims WHERE id = $1', [
    scene.claim.id,
  ]);
  assert.equal(claim.rows[0].disputed_at, null, 'the winner was never made to raise a dispute');
});

test('repeated and concurrent suspensions create no duplicate queue items', async () => {
  const scene = await claimedAndSuspended('no-dupes');

  // Same status again: setHostStatus short-circuits, so nothing at all happens.
  const again = await suspend(scene.admin, scene.host.id, 'Suspending an already suspended host.');
  assert.equal(again.status, 200);
  assert.equal(again.body.status_changed, false);

  // And a genuine reinstate/suspend cycle, run five times concurrently, still
  // leaves one open row.
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      scene.admin.post(`/api/admin/hosts/${scene.host.id}/status`)
        .send({ status: 'suspended', reason: `Concurrent suspension attempt ${i}.` })
    )
  );

  const rows = await pool.query(
    "SELECT COUNT(*)::int AS c FROM claim_rescue_queue WHERE claim_id = $1 AND status = 'open'",
    [scene.claim.id]
  );
  assert.equal(rows.rows[0].c, 1);

  const queue = await rescueQueue(scene.admin);
  assert.equal(queue.body.filter((r) => r.claim_id === scene.claim.id).length, 1);
});

test('the database itself refuses a second open queue row for one claim', async () => {
  const scene = await claimedAndSuspended('db-guard');

  await assert.rejects(
    pool.query(
      `INSERT INTO claim_rescue_queue (id, claim_id, giveaway_id, host_user_id)
       VALUES ($1, $2, $3, $4)`,
      [uuid(), scene.claim.id, scene.giveawayId, scene.host.id]
    ),
    (err) => err.code === '23505',
    'the uniqueness of an open rescue must not depend on application code alone'
  );
});

// ---------------------------------------------------------------------------
// 4–9. What a rescuer may and may not do
// ---------------------------------------------------------------------------

test('an administrator can take the host-side steps, each with a required reason', async () => {
  const scene = await claimedAndSuspended('steps');

  const noReason = await scene.admin.post(`/api/claims/${scene.claim.id}/rescue/transition`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ to: STATES.PREPARING_DELIVERY });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  const prep = await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY);
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  assert.equal(prep.body.status, STATES.PREPARING_DELIVERY);
  assert.equal(prep.body.acted_as, ROLES.ADMIN_RESCUE);

  const shipped = await rescueStep(scene.admin, scene.claim.id, STATES.SHIPPED_OR_ARRANGED);
  assert.equal(shipped.status, 200);

  const reported = await rescueStep(
    scene.admin,
    scene.claim.id,
    STATES.DELIVERED_PENDING_CONFIRMATION
  );
  assert.equal(reported.status, 200);
  assert.equal(reported.body.status, STATES.DELIVERED_PENDING_CONFIRMATION);
});

test('an administrator cannot claim on the winner\'s behalf', async () => {
  const admin = await createUser('no-claim-admin', { admin: true });
  const scene = await drawnGiveawayWithClaim('no-claim');

  // Suspended before the winner ever opened the link.
  const suspended = await suspend(admin, scene.host.id);
  assert.equal(suspended.status, 200);

  const attempt = await rescueStep(admin, scene.claim.id, STATES.CLAIMED);
  assert.equal(attempt.status, 409, JSON.stringify(attempt.body));
  assert.equal(attempt.body.code, 'NOT_RESCUE_ELIGIBLE');

  const still = await pool.query(
    'SELECT status, consented_at, delivery_ciphertext FROM prize_claims WHERE id = $1',
    [scene.claim.id]
  );
  assert.equal(still.rows[0].status, STATES.AWAITING_CLAIM);
  assert.equal(still.rows[0].consented_at, null, 'nobody may consent on a winner\'s behalf');
  assert.equal(still.rows[0].delivery_ciphertext, null);
});

test('an administrator cannot confirm delivery on the winner\'s behalf', async () => {
  const scene = await claimedAndSuspended('no-confirm');

  await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY);
  await rescueStep(scene.admin, scene.claim.id, STATES.SHIPPED_OR_ARRANGED);
  await rescueStep(scene.admin, scene.claim.id, STATES.DELIVERED_PENDING_CONFIRMATION);

  // Through the rescue route.
  const viaRescue = await rescueStep(scene.admin, scene.claim.id, STATES.DELIVERED);
  assert.equal(viaRescue.status, 409);
  assert.equal(viaRescue.body.code, 'NOT_RESCUE_ELIGIBLE');

  // And through the ordinary admin transition route, which is the same refusal
  // for a different reason: no role reaches delivered from here except winner.
  const viaAdmin = await scene.admin.post(`/api/claims/${scene.claim.id}/transition`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ to: STATES.DELIVERED, note: 'I am sure it arrived.' });
  assert.ok([403, 409].includes(viaAdmin.status), `expected a refusal, got ${viaAdmin.status}`);

  const row = await pool.query(
    'SELECT c.status, g.prize_delivered FROM prize_claims c JOIN giveaways g ON g.id = c.giveaway_id WHERE c.id = $1',
    [scene.claim.id]
  );
  assert.equal(row.rows[0].status, STATES.DELIVERED_PENDING_CONFIRMATION);
  assert.equal(row.rows[0].prize_delivered, false, 'the public delivery flag must not move without the winner');
});

test('the state machine grants a rescuer no route to delivered or claimed, from anywhere', () => {
  // Belt and braces on the table itself, so a future edit that hands a rescuer
  // one of those two moves fails here rather than in production.
  const { TRANSITIONS } = require('../server/lib/claimStateMachine');
  Object.entries(TRANSITIONS).forEach(([from, moves]) => {
    Object.entries(moves).forEach(([to, roles]) => {
      if (to === STATES.DELIVERED || to === STATES.CLAIMED) {
        assert.ok(
          !roles.includes(ROLES.ADMIN_RESCUE),
          `a rescuer must never reach ${to} (found on ${from} -> ${to})`
        );
      }
    });
  });
});

test('an administrator cannot rescue a claim whose host is still approved', async () => {
  const admin = await createUser('not-suspended-admin', { admin: true });
  const scene = await drawnGiveawayWithClaim('not-suspended');
  const redeemed = await redeem(scene.token);
  assert.equal(redeemed.status, 200);

  const attempt = await rescueStep(admin, scene.claim.id, STATES.PREPARING_DELIVERY);
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.code, 'HOST_NOT_SUSPENDED');

  const details = await openDetails(admin, scene.claim.id);
  assert.equal(details.status, 409);
  assert.equal(details.body.code, 'HOST_NOT_SUSPENDED');

  const queue = await rescueQueue(admin);
  assert.equal(queue.body.filter((r) => r.claim_id === scene.claim.id).length, 0);
});

test('reinstating the host closes the queue item and ends rescue authority at once', async () => {
  const scene = await claimedAndSuspended('reinstate');

  const reinstated = await scene.admin.post(`/api/admin/hosts/${scene.host.id}/status`)
    .send({ status: 'approved', reason: 'Explained themselves; access restored.' });
  assert.equal(reinstated.status, 200);

  const attempt = await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY);
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.code, 'HOST_NOT_SUSPENDED');

  const queue = await rescueQueue(scene.admin);
  assert.equal(queue.body.filter((r) => r.claim_id === scene.claim.id).length, 0);

  const closed = await pool.query(
    'SELECT status, closed_reason, closed_by FROM claim_rescue_queue WHERE claim_id = $1',
    [scene.claim.id]
  );
  assert.equal(closed.rows[0].status, 'closed');
  assert.match(closed.rows[0].closed_reason, /Host access restored/i);
  assert.equal(closed.rows[0].closed_by, scene.admin.id);

  // And the host has their own claim back.
  const view = await scene.host.get(`/api/claims/giveaway/${scene.giveawayId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.role, 'host');
});

test('a rescuer cannot make an out-of-order or invented move', async () => {
  const scene = await claimedAndSuspended('out-of-order');

  // Skipping a step.
  const skip = await rescueStep(scene.admin, scene.claim.id, STATES.SHIPPED_OR_ARRANGED);
  assert.equal(skip.status, 409);

  // A state that does not exist.
  const nonsense = await rescueStep(scene.admin, scene.claim.id, 'teleported');
  assert.equal(nonsense.status, 400);

  // A state a rescuer has no business in.
  const cancel = await rescueStep(scene.admin, scene.claim.id, STATES.CANCELLED);
  assert.equal(cancel.status, 403, JSON.stringify(cancel.body));

  const row = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [scene.claim.id]);
  assert.equal(row.rows[0].status, STATES.CLAIMED, 'nothing moved');
});

test('a non-admin cannot use the rescue routes at all', async () => {
  const scene = await claimedAndSuspended('non-admin');
  const outsider = await createUser('outsider', { hostStatus: HOST_STATUS.APPROVED });

  for (const [label, res] of [
    ['queue', await rescueQueue(outsider)],
    ['transition', await rescueStep(outsider, scene.claim.id, STATES.PREPARING_DELIVERY)],
    ['details', await openDetails(outsider, scene.claim.id)],
    ['queue as the suspended host', await rescueQueue(scene.host)],
    ['details as the suspended host', await openDetails(scene.host, scene.claim.id)],
  ]) {
    assert.equal(res.status, 403, `${label} must be refused`);
  }
});

test('the winner can still confirm delivery after an administrator-assisted shipment', async () => {
  const scene = await claimedAndSuspended('winner-confirms');

  await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY);
  await rescueStep(scene.admin, scene.claim.id, STATES.SHIPPED_OR_ARRANGED);
  await rescueStep(scene.admin, scene.claim.id, STATES.DELIVERED_PENDING_CONFIRMATION);

  const confirmed = await scene.winner.post(`/api/claims/${scene.claim.id}/transition`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ to: STATES.DELIVERED });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.status, STATES.DELIVERED);

  const giveaway = await pool.query(
    'SELECT prize_delivered FROM giveaways WHERE id = $1',
    [scene.giveawayId]
  );
  assert.equal(giveaway.rows[0].prize_delivered, true, 'the public flag follows the winner, as always');

  // A finished claim is nobody's outstanding work.
  const queueRow = await pool.query('SELECT status FROM claim_rescue_queue WHERE claim_id = $1', [
    scene.claim.id,
  ]);
  assert.equal(queueRow.rows[0].status, 'closed');
  const queue = await rescueQueue(scene.admin);
  assert.equal(queue.body.filter((r) => r.claim_id === scene.claim.id).length, 0);
});

// ---------------------------------------------------------------------------
// 10–13. Audit trail and delivery details
// ---------------------------------------------------------------------------

test('every rescue action writes a non-sensitive history entry naming the administrator', async () => {
  const scene = await claimedAndSuspended('audit');

  await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY, 'Courier booked for Tuesday.');
  await openDetails(scene.admin, scene.claim.id, 'Address needed for the courier booking.');

  const events = await pool.query(
    'SELECT from_status, to_status, actor_user_id, actor_role, note, created_at FROM prize_claim_events WHERE claim_id = $1 ORDER BY created_at ASC',
    [scene.claim.id]
  );

  const move = events.rows.find((e) => e.to_status === STATES.PREPARING_DELIVERY);
  assert.ok(move, 'the transition is in the history');
  assert.equal(move.from_status, STATES.CLAIMED, 'the previous state is recorded');
  assert.equal(move.actor_role, ROLES.ADMIN_RESCUE, 'and that it was a rescue, not the host');
  assert.equal(move.actor_user_id, scene.admin.id, 'and which administrator');
  assert.equal(move.note, 'Courier booked for Tuesday.');
  assert.ok(move.created_at, 'and when');

  const opened = events.rows.find((e) => /delivery_details_opened/.test(e.actor_role));
  assert.ok(opened, 'opening the details is itself in the history');
  assert.equal(opened.actor_user_id, scene.admin.id);
  assert.equal(opened.from_status, opened.to_status, 'looking is not moving');

  // Nothing about the address may have leaked into the trail.
  const serialised = JSON.stringify(events.rows);
  [FABRICATED_DELIVERY.phone, FABRICATED_DELIVERY.address_line1, FABRICATED_DELIVERY.city].forEach(
    (secret) => {
      assert.ok(!serialised.includes(secret), `claim history must not contain "${secret}"`);
    }
  );
});

test('the rescue queue carries no address, phone or ciphertext', async () => {
  const scene = await claimedAndSuspended('queue-privacy');

  const queue = await rescueQueue(scene.admin);
  assert.equal(queue.status, 200);
  assert.equal(queue.headers['cache-control'], 'no-store');

  const serialised = JSON.stringify(queue.body);
  Object.values(FABRICATED_DELIVERY).forEach((value) => {
    assert.ok(!serialised.includes(value), `the queue must not carry "${value}"`);
  });
  ['delivery_ciphertext', 'delivery_iv', 'delivery_tag', 'recipient_name', 'address_line1', 'phone'].forEach(
    (field) => {
      assert.ok(!serialised.includes(field), `the queue must not carry the ${field} field`);
    }
  );

  // It does say whether details exist, which is what an administrator needs in
  // order to decide whether to open them.
  const row = queue.body.find((r) => r.claim_id === scene.claim.id);
  assert.equal(row.delivery_available, true);
});

test('opening details is deliberate, audited, and marked no-store', async () => {
  const scene = await claimedAndSuspended('details-open');

  const noReason = await scene.admin.post(`/api/claims/${scene.claim.id}/rescue/delivery-details`)
    .set('X-Forwarded-For', uniqueIp())
    .send({});
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  const before = await pool.query(
    "SELECT COUNT(*)::int AS c FROM prize_claim_events WHERE claim_id = $1 AND actor_role LIKE '%delivery_details_opened'",
    [scene.claim.id]
  );

  const opened = await openDetails(scene.admin, scene.claim.id);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.headers['cache-control'], 'no-store');
  assert.equal(opened.body.delivery.available, true);
  assert.equal(opened.body.delivery.details.address_line1, FABRICATED_DELIVERY.address_line1);
  assert.ok(opened.body.delivery.consentedAt, 'the consent that permits this is reported with it');
  assert.equal(opened.body.delivery.consentVersion, claims.CONSENT_VERSION);

  const after = await pool.query(
    "SELECT COUNT(*)::int AS c FROM prize_claim_events WHERE claim_id = $1 AND actor_role LIKE '%delivery_details_opened'",
    [scene.claim.id]
  );
  assert.equal(after.rows[0].c, before.rows[0].c + 1, 'each opening is recorded, not just the first');
});

test('details that were never consented to, or have been erased, cannot be opened', async () => {
  // Never consented: the winner has not opened the claim at all.
  const admin = await createUser('unconsented-admin', { admin: true });
  const unclaimed = await drawnGiveawayWithClaim('unconsented');
  await suspend(admin, unclaimed.host.id);

  const notYet = await openDetails(admin, unclaimed.claim.id);
  // Refused before it even gets to the details: nothing is waiting on a host
  // while a winner has not claimed.
  assert.equal(notYet.status, 409);
  assert.equal(notYet.body.code, 'NOT_RESCUE_ELIGIBLE');

  // Erased: retention has already removed the address.
  const scene = await claimedAndSuspended('erased');
  await pool.query(
    `UPDATE prize_claims
        SET delivery_ciphertext = NULL, delivery_iv = NULL, delivery_tag = NULL,
            delivery_erased_at = NOW()
      WHERE id = $1`,
    [scene.claim.id]
  );

  const erased = await openDetails(scene.admin, scene.claim.id);
  assert.equal(erased.status, 409);
  assert.equal(erased.body.code, 'DELIVERY_ERASED');
  assert.equal(erased.headers['cache-control'], 'no-store');
  assert.ok(!JSON.stringify(erased.body).includes(FABRICATED_DELIVERY.address_line1));

  // And the fulfilment steps still work without them — an erased address does
  // not freeze a claim, it just means the courier details came from elsewhere.
  const step = await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY);
  assert.equal(step.status, 200);
});

test('no address or phone reaches the console, an email, a URL or any other response', async () => {
  const scene = await claimedAndSuspended('no-leak');

  // Everything the process writes out during a full rescue, captured. With no
  // RESEND_API_KEY configured (configureTestEnv strips it) the mailer logs
  // instead of sending, so this covers the outgoing emails too.
  const captured = [];
  const realLog = console.log;
  const realError = console.error;
  const realWarn = console.warn;
  console.log = (...args) => captured.push(args.map(String).join(' '));
  console.error = (...args) => captured.push(args.map(String).join(' '));
  console.warn = (...args) => captured.push(args.map(String).join(' '));

  let responses;
  try {
    const prep = await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY);
    const details = await openDetails(scene.admin, scene.claim.id);
    const shipped = await rescueStep(scene.admin, scene.claim.id, STATES.SHIPPED_OR_ARRANGED);
    const queue = await rescueQueue(scene.admin);
    const publicView = await api().get(`/api/giveaways/${scene.giveawayId}`);
    const adminReview = await scene.admin.get('/api/claims/admin/review');
    responses = { prep, details, shipped, queue, publicView, adminReview };
  } finally {
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
  }

  const SECRETS = [
    FABRICATED_DELIVERY.phone,
    FABRICATED_DELIVERY.address_line1,
    FABRICATED_DELIVERY.address_line2,
    FABRICATED_DELIVERY.city,
    FABRICATED_DELIVERY.notes,
  ];

  const logged = captured.join('\n');
  SECRETS.forEach((secret) => {
    assert.ok(!logged.includes(secret), `"${secret}" must never be written to the console or an email`);
  });

  // Every response except the one deliberate, audited, reasoned fetch.
  ['prep', 'shipped', 'queue', 'publicView', 'adminReview'].forEach((name) => {
    const body = JSON.stringify(responses[name].body);
    SECRETS.forEach((secret) => {
      assert.ok(!body.includes(secret), `${name} response must not carry "${secret}"`);
    });
  });

  // The one that may: and it is marked no-store so it stops at the browser.
  assert.equal(responses.details.status, 200);
  assert.equal(responses.details.headers['cache-control'], 'no-store');
  assert.ok(JSON.stringify(responses.details.body).includes(FABRICATED_DELIVERY.address_line1));
});

// ---------------------------------------------------------------------------
// 14. Forging
// ---------------------------------------------------------------------------

test('a suspended host cannot regain access by forging request fields or reusing an old session', async () => {
  const scene = await claimedAndSuspended('forgery');

  // The token was issued while approved and is still valid — the status behind
  // it is not.
  const forgeries = [
    { host_status: 'approved' },
    { role: 'host' },
    { acted_as: 'admin_rescue' },
    { is_admin: true },
    { userId: scene.admin.id },
  ];

  for (const extra of forgeries) {
    const res = await scene.host.post(`/api/claims/${scene.claim.id}/transition`)
      .set('X-Forwarded-For', uniqueIp())
      .send({ to: STATES.PREPARING_DELIVERY, ...extra });
    assert.equal(res.status, 403, `forging ${JSON.stringify(extra)} must change nothing`);
  }

  // Nor through the rescue route, which is admin-only regardless of body.
  const viaRescue = await scene.host.post(`/api/claims/${scene.claim.id}/rescue/transition`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ to: STATES.PREPARING_DELIVERY, reason: 'me again', is_admin: true });
  assert.equal(viaRescue.status, 403);

  const row = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [scene.claim.id]);
  assert.equal(row.rows[0].status, STATES.CLAIMED);
});

test('the queue row is work to do, never a permission', async () => {
  // A queue row left open after the host was reinstated by hand must not grant
  // anything: authority is re-derived from the host's status on the request.
  const scene = await claimedAndSuspended('stale-row');

  await pool.query("UPDATE users SET host_status = 'approved' WHERE id = $1", [scene.host.id]);
  const stillOpen = await pool.query(
    "SELECT COUNT(*)::int AS c FROM claim_rescue_queue WHERE claim_id = $1 AND status = 'open'",
    [scene.claim.id]
  );
  assert.equal(stillOpen.rows[0].c, 1, 'the row is deliberately left open for this test');

  const attempt = await rescueStep(scene.admin, scene.claim.id, STATES.PREPARING_DELIVERY);
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.code, 'HOST_NOT_SUSPENDED');
});

// ---------------------------------------------------------------------------
// 15–17. Host applications are never deleted
// ---------------------------------------------------------------------------

test('no host-application deletion route exists', async () => {
  const admin = await createUser('no-delete-admin', { admin: true });
  const applicant = await createUser('no-delete-applicant');

  const applied = await applicant.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send({ applicant_type: 'individual', full_name: 'Fabricated Applicant' });
  assert.equal(applied.status, 201);

  const deleted = await admin.delete(`/api/admin/host-applications/${applied.body.id}`);
  assert.equal(deleted.status, 404, 'there must be no route here at all');

  const still = await pool.query('SELECT COUNT(*)::int AS c FROM host_applications WHERE id = $1', [
    applied.body.id,
  ]);
  assert.equal(still.rows[0].c, 1);

  // And the source carries no DELETE handler for this resource, so one cannot
  // reappear without this failing.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/router\.delete\(\s*['"`]\/host-applications/.test(code),
    'no delete route may be defined for host applications'
  );
  assert.ok(
    !/DELETE FROM host_applications/i.test(code),
    'nothing in the admin routes may delete an application row'
  );
});

test('closing an application preserves the row, its history and its status events', async () => {
  const admin = await createUser('close-admin', { admin: true });
  const applicant = await createUser('close-applicant');

  const applied = await applicant.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send({ applicant_type: 'individual', full_name: 'Fabricated Applicant', message: 'Original text.' });
  assert.equal(applied.status, 201);
  const submittedAt = (
    await pool.query('SELECT created_at FROM host_applications WHERE id = $1', [applied.body.id])
  ).rows[0].created_at;

  const noReason = await admin.post(`/api/admin/host-applications/${applied.body.id}/close`)
    .send({});
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  const closed = await admin.post(`/api/admin/host-applications/${applied.body.id}/close`)
    .send({ reason: 'Duplicate of an earlier enquiry.' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'withdrawn');

  const row = await pool.query('SELECT * FROM host_applications WHERE id = $1', [applied.body.id]);
  assert.equal(row.rows.length, 1, 'the original application survives');
  assert.equal(row.rows[0].status, 'withdrawn');
  assert.equal(row.rows[0].user_id, applicant.id, 'still attached to the account that made it');
  assert.deepEqual(row.rows[0].created_at, submittedAt, 'submission time is untouched');
  assert.equal(row.rows[0].message, 'Original text.', 'what they wrote is untouched');
  assert.equal(row.rows[0].decided_by, admin.id);
  assert.ok(row.rows[0].decided_at);
  assert.equal(row.rows[0].decision_reason, 'Duplicate of an earlier enquiry.');

  const events = await pool.query(
    'SELECT from_status, to_status, reason, changed_by FROM host_status_events WHERE user_id = $1 ORDER BY created_at ASC',
    [applicant.id]
  );
  assert.deepEqual(
    events.rows.map((e) => `${e.from_status}->${e.to_status}`),
    ['not_requested->pending', 'pending->not_requested'],
    'both the asking and the closing are in the history'
  );
  assert.match(events.rows[1].reason, /Duplicate of an earlier enquiry/);
  assert.equal(events.rows[1].changed_by, admin.id);
});

test('a decided application is never rewritten, and a later application is a new record', async () => {
  const admin = await createUser('rewrite-admin', { admin: true });
  const applicant = await createUser('rewrite-applicant');

  const first = await applicant.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send({ applicant_type: 'individual', full_name: 'Fabricated Applicant' });
  assert.equal(first.status, 201);

  const rejected = await admin.post(`/api/admin/host-applications/${first.body.id}/decision`)
    .send({ decision: 'rejected', reason: 'First outcome, and it stays.' });
  assert.equal(rejected.status, 200);

  // Closing it afterwards would overwrite the recorded outcome.
  const overwrite = await admin.post(`/api/admin/host-applications/${first.body.id}/close`)
    .send({ reason: 'Trying to erase the refusal.' });
  assert.equal(overwrite.status, 409);
  assert.equal(overwrite.body.code, 'ALREADY_DECIDED');

  // Applying again creates a second row. The first outcome is still on file.
  const second = await applicant.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send({ applicant_type: 'individual', full_name: 'Fabricated Applicant', message: 'Trying again.' });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.id, first.body.id, 'a later application is a new record, not an edit');

  const rows = await pool.query(
    'SELECT id, status, decision_reason FROM host_applications WHERE user_id = $1 ORDER BY created_at ASC',
    [applicant.id]
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].status, 'rejected');
  assert.equal(rows.rows[0].decision_reason, 'First outcome, and it stays.');
  assert.equal(rows.rows[1].status, 'pending');
});

test('concurrent decisions on one application cannot produce conflicting outcomes', async () => {
  const adminA = await createUser('race-admin-a', { admin: true });
  const adminB = await createUser('race-admin-b', { admin: true });
  const applicant = await createUser('race-applicant');

  const applied = await applicant.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send({ applicant_type: 'individual', full_name: 'Fabricated Applicant' });
  assert.equal(applied.status, 201);

  const attempts = await Promise.all([
    adminA.post(`/api/admin/host-applications/${applied.body.id}/decision`)
      .send({ decision: 'approved', reason: 'A says yes.' }),
    adminB.post(`/api/admin/host-applications/${applied.body.id}/decision`)
      .send({ decision: 'rejected', reason: 'B says no.' }),
    adminB.post(`/api/admin/host-applications/${applied.body.id}/close`)
      .send({ reason: 'B closes it instead.' }),
  ]);

  const succeeded = attempts.filter((r) => r.status === 200);
  assert.equal(succeeded.length, 1, `exactly one outcome may stick, got ${attempts.map((r) => r.status)}`);
  attempts
    .filter((r) => r.status !== 200)
    .forEach((r) => assert.equal(r.status, 409, JSON.stringify(r.body)));

  const row = await pool.query(
    'SELECT status, decision_reason, decided_by FROM host_applications WHERE id = $1',
    [applied.body.id]
  );
  assert.ok(['approved', 'rejected', 'withdrawn'].includes(row.rows[0].status));
  assert.ok(row.rows[0].decision_reason, 'whichever won carries its reason');

  // And the account's status matches the one decision that stuck — not a mix.
  const user = await pool.query('SELECT host_status FROM users WHERE id = $1', [applicant.id]);
  const expected = { approved: 'approved', rejected: 'rejected', withdrawn: 'not_requested' };
  assert.equal(user.rows[0].host_status, expected[row.rows[0].status]);

  const events = await pool.query(
    "SELECT to_status FROM host_status_events WHERE user_id = $1 AND from_status = 'pending'",
    [applicant.id]
  );
  assert.equal(events.rows.length, 1, 'exactly one transition out of pending was recorded');
});

// ---------------------------------------------------------------------------
// Consistency between the queue and the gate
// ---------------------------------------------------------------------------

test('the states the queue offers action on are exactly the states the gate permits', () => {
  assert.deepEqual(
    [...RESCUE_ELIGIBLE_STATES].sort(),
    [STATES.CLAIMED, STATES.PREPARING_DELIVERY, STATES.SHIPPED_OR_ARRANGED].sort()
  );
});
