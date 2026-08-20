// Coverage for Stripe webhook fulfilment (audit finding #2).
//
// Everything here is offline. Signatures are produced with the official SDK's
// own test helper (stripe.webhooks.generateTestHeaderString) against a
// fabricated secret, and event bodies are hand-built objects — no Stripe
// account, no network call, no real key, no captured production payload. The
// database is the isolated local cluster the suite always uses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const Stripe = require('stripe');
const { api, pool, ensureInit, signIn, anon, closePool } = require('../testHelpers');

// Fabricated. Its only job is to be the same string on both sides of a
// signature check, and it never leaves this process.
const WEBHOOK_SECRET = 'whsec_fabricated_secret_for_offline_tests';
const OTHER_SECRET = 'whsec_a_different_fabricated_secret';

// Constructed with a placeholder key purely to reach the webhook helpers —
// signature generation is local crypto and makes no API call.
const stripe = new Stripe('sk_test_fabricated_key_for_tests_only');

const createdAdIds = [];
const usedEventIds = [];

before(async () => {
  await ensureInit();
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

after(async () => {
  if (createdAdIds.length) {
    await pool.query('DELETE FROM ads WHERE id = ANY($1)', [createdAdIds]);
  }
  if (usedEventIds.length) {
    await pool.query('DELETE FROM stripe_events WHERE id = ANY($1)', [usedEventIds]);
  }
  await closePool();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 8)}`;
}

// Every booking gets its own two-week window, far enough out that nothing else
// in the suite reaches it. Since Phase 1.3 the database refuses overlapping
// held-or-paid ranges outright, so fixtures that all booked "the next fortnight"
// (as these did) collide with each other the moment one is marked paid — which
// is the constraint doing its job, not a test problem to work around.
let windowOffset = 0;
function nextWindow() {
  windowOffset += 1;
  const start = 1000 + windowOffset * 20;
  return { start, end: start + 13 };
}

// A pending booking, inserted directly so tests don't depend on the checkout
// route (which is behind ADS_CHECKOUT_ENABLED and disabled by default).
// slot_status 'held' with a hold well into the future mirrors what the checkout
// route produces just before it sends a customer to Stripe.
async function createPendingBooking({ amountAed = 1000, sessionId = null, paymentIntent = null } = {}) {
  const id = uuid();
  const session = sessionId || unique('cs_test');
  const { start, end } = nextWindow();
  await pool.query(
    `INSERT INTO ads
       (id, business_name, image_url, target_url, media_type, contact_email,
        starts_at, ends_at, amount_aed, paid, active, stripe_session_id,
        payment_status, stripe_payment_intent, slot_status, hold_expires_at)
     VALUES ($1, 'Webhook Test Co', 'https://example.com/b.jpg', 'https://example.com',
             'image', 'advertiser@example.com',
             CURRENT_DATE + $5::int, CURRENT_DATE + $6::int,
             $2, FALSE, FALSE, $3, 'pending', $4, 'held', NOW() + INTERVAL '1 hour')`,
    [id, amountAed, session, paymentIntent, start, end]
  );
  createdAdIds.push(id);
  return { id, sessionId: session, amountAed };
}

async function readBooking(id) {
  const res = await pool.query(
    `SELECT paid, payment_status, paid_at, refunded_at, disputed_at, stripe_payment_intent
     FROM ads WHERE id = $1`,
    [id]
  );
  return res.rows[0];
}

function checkoutEvent({
  type = 'checkout.session.completed',
  eventId,
  sessionId,
  adId,
  amountTotal,
  currency = 'aed',
  paymentStatus = 'paid',
  paymentIntent = unique('pi_test'),
}) {
  const id = eventId || unique('evt_test');
  usedEventIds.push(id);
  return {
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        client_reference_id: adId,
        amount_total: amountTotal,
        currency,
        payment_status: paymentStatus,
        payment_intent: paymentIntent,
        status: 'complete',
      },
    },
  };
}

function chargeEvent({ type, eventId, paymentIntent }) {
  const id = eventId || unique('evt_test');
  usedEventIds.push(id);
  return {
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: unique('ch_test'),
        object: type === 'charge.dispute.created' ? 'dispute' : 'charge',
        payment_intent: paymentIntent,
      },
    },
  };
}

// Signs with the SDK's own helper, so these requests are verified by exactly
// the code path a real Stripe delivery goes through.
function deliver(event, { secret = WEBHOOK_SECRET, signature, omitSignature = false } = {}) {
  const payload = JSON.stringify(event);
  const req = api()
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json');

  if (!omitSignature) {
    req.set(
      'stripe-signature',
      signature || stripe.webhooks.generateTestHeaderString({ payload, secret })
    );
  }
  return req.send(payload);
}

async function ledgerCount(eventId) {
  const res = await pool.query('SELECT COUNT(*)::int AS c FROM stripe_events WHERE id = $1', [eventId]);
  return res.rows[0].c;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

test('a validly signed completed session marks the booking paid', async () => {
  const booking = await createPendingBooking();
  const paymentIntent = unique('pi_test');
  const event = checkoutEvent({
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100000, // AED 1,000 in fils
    paymentIntent,
  });

  const res = await deliver(event);

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'paid');

  const after = await readBooking(booking.id);
  assert.equal(after.paid, true);
  assert.equal(after.payment_status, 'paid');
  assert.ok(after.paid_at, 'paid_at must be stamped');
  assert.equal(after.stripe_payment_intent, paymentIntent);
});

test('an invalid signature is rejected before any database mutation', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100000,
  });

  // Correctly formed, but signed with a different secret — the forgery case.
  const res = await deliver(event, { secret: OTHER_SECRET });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid signature/i);

  const after = await readBooking(booking.id);
  assert.equal(after.paid, false);
  assert.equal(after.payment_status, 'pending');
  assert.equal(await ledgerCount(event.id), 0, 'a rejected event must not be recorded');
});

test('a missing signature header is rejected before any database mutation', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100000,
  });

  const res = await deliver(event, { omitSignature: true });

  assert.equal(res.status, 400);
  const after = await readBooking(booking.id);
  assert.equal(after.payment_status, 'pending');
  assert.equal(await ledgerCount(event.id), 0);
});

test('a garbage signature header is rejected', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 });

  const res = await deliver(event, { signature: 't=1,v1=deadbeef' });

  assert.equal(res.status, 400);
  assert.equal((await readBooking(booking.id)).payment_status, 'pending');
});

test('a body altered after signing is rejected', async () => {
  // The signature covers the exact bytes. This is the check that would silently
  // pass if the raw body were replaced by a re-serialised parsed object.
  const booking = await createPendingBooking();
  const event = checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: JSON.stringify(event),
    secret: WEBHOOK_SECRET,
  });

  const tampered = { ...event, data: { object: { ...event.data.object, amount_total: 1 } } };

  const res = await api()
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', signature)
    .send(JSON.stringify(tampered));

  assert.equal(res.status, 400);
  assert.equal((await readBooking(booking.id)).payment_status, 'pending');
});

test('the endpoint refuses to run when no webhook secret is configured', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 });

  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const res = await deliver(event);
    assert.equal(res.status, 503);
    assert.equal((await readBooking(booking.id)).payment_status, 'pending');
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('a replayed event is acknowledged without acting twice', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 });

  const first = await deliver(event);
  assert.equal(first.status, 200);
  assert.equal(first.body.action, 'paid');
  const afterFirst = await readBooking(booking.id);

  const second = await deliver(event);
  assert.equal(second.status, 200, 'a duplicate must still be acknowledged, or Stripe retries forever');
  assert.equal(second.body.action, 'duplicate');

  const afterSecond = await readBooking(booking.id);
  assert.equal(afterSecond.paid, true);
  assert.deepEqual(
    afterSecond.paid_at,
    afterFirst.paid_at,
    'the second delivery must not re-stamp paid_at'
  );
  assert.equal(await ledgerCount(event.id), 1, 'exactly one ledger row per event id');
});

test('concurrent duplicate deliveries settle to one fulfilment', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 });

  const results = await Promise.all([deliver(event), deliver(event), deliver(event)]);

  assert.ok(results.every((r) => r.status === 200), 'every delivery is acknowledged');
  const actions = results.map((r) => r.body.action).sort();
  assert.equal(actions.filter((a) => a === 'paid').length, 1, 'exactly one delivery fulfils');
  assert.equal(await ledgerCount(event.id), 1);
});

// ---------------------------------------------------------------------------
// Atomicity: the ledger and the business state commit together, or not at all
// ---------------------------------------------------------------------------

test('a failure mid-processing rolls back, and Stripe’s retry then succeeds', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 });

  // Forces the UPDATE inside the handler to fail, for this booking only, so the
  // rollback path is exercised for real rather than simulated at the seam.
  await pool.query(`
    CREATE OR REPLACE FUNCTION naseeb_test_fail_ad_update() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'simulated database failure'; END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(
    `CREATE TRIGGER naseeb_test_fail_update
     BEFORE UPDATE ON ads FOR EACH ROW
     WHEN (NEW.id = '${booking.id}')
     EXECUTE FUNCTION naseeb_test_fail_ad_update();`
  );

  let failed;
  try {
    failed = await deliver(event);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS naseeb_test_fail_update ON ads');
    await pool.query('DROP FUNCTION IF EXISTS naseeb_test_fail_ad_update()');
  }

  // 5xx so Stripe retries.
  assert.equal(failed.status, 500);

  // And nothing was left half-applied: no ledger row claiming the event was
  // handled, no state change on the booking.
  assert.equal(await ledgerCount(event.id), 0, 'the ledger claim must roll back with the work');
  const afterFailure = await readBooking(booking.id);
  assert.equal(afterFailure.paid, false);
  assert.equal(afterFailure.payment_status, 'pending');

  // The retry Stripe would send next.
  const retried = await deliver(event);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.action, 'paid');
  const afterRetry = await readBooking(booking.id);
  assert.equal(afterRetry.paid, true);
  assert.equal(afterRetry.payment_status, 'paid');
  assert.equal(await ledgerCount(event.id), 1);
});

// ---------------------------------------------------------------------------
// Reconciliation: an authenticated event still has to match the booking
// ---------------------------------------------------------------------------

test('an amount that does not match the booking is refused', async () => {
  const booking = await createPendingBooking({ amountAed: 1000 });
  const event = checkoutEvent({
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100, // AED 1.00 against a AED 1,000 booking
  });

  const res = await deliver(event);

  assert.equal(res.status, 200, 'authenticated but unusable: acknowledged, not retried');
  assert.equal(res.body.action, 'refused');
  const after = await readBooking(booking.id);
  assert.equal(after.paid, false);
  assert.equal(after.payment_status, 'pending');
});

test('a currency that is not AED is refused', async () => {
  const booking = await createPendingBooking({ amountAed: 1000 });
  const event = checkoutEvent({
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100000,
    currency: 'usd',
  });

  const res = await deliver(event);

  assert.equal(res.body.action, 'refused');
  assert.equal((await readBooking(booking.id)).paid, false);
});

test('a session id that does not match the booking is refused', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({
    sessionId: unique('cs_test_someone_elses'),
    adId: booking.id,
    amountTotal: 100000,
  });

  const res = await deliver(event);

  assert.equal(res.body.action, 'refused');
  assert.equal((await readBooking(booking.id)).payment_status, 'pending');
});

test('an unknown client_reference_id is ignored, not applied to another booking', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({
    sessionId: booking.sessionId,
    adId: uuid(), // a booking that does not exist
    amountTotal: 100000,
  });

  const res = await deliver(event);

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'ignored');
  assert.equal((await readBooking(booking.id)).payment_status, 'pending');
});

test('a missing client_reference_id is ignored', async () => {
  const event = checkoutEvent({ sessionId: unique('cs_test'), adId: null, amountTotal: 100000 });
  const res = await deliver(event);
  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'ignored');
});

test('an event arriving before the session id is stored is retried, not refused', async () => {
  // The checkout route inserts the booking and writes stripe_session_id a
  // moment later. A webhook that overtakes that write must not be permanently
  // refused as a mismatch.
  const id = uuid();
  const { start, end } = nextWindow();
  await pool.query(
    `INSERT INTO ads
       (id, business_name, image_url, target_url, media_type, contact_email,
        starts_at, ends_at, amount_aed, paid, active, stripe_session_id, payment_status,
        slot_status, hold_expires_at)
     VALUES ($1, 'Webhook Test Co', 'https://example.com/b.jpg', 'https://example.com',
             'image', 'advertiser@example.com',
             CURRENT_DATE + $2::int, CURRENT_DATE + $3::int,
             1000, FALSE, FALSE, NULL, 'pending', 'held', NOW() + INTERVAL '1 hour')`,
    [id, start, end]
  );
  createdAdIds.push(id);

  const sessionId = unique('cs_test');
  const event = checkoutEvent({ sessionId, adId: id, amountTotal: 100000 });

  const deferred = await deliver(event);
  assert.equal(deferred.status, 503, 'retryable, so Stripe tries again');
  assert.equal(await ledgerCount(event.id), 0, 'nothing recorded, so the retry is not a duplicate');

  // The checkout route catches up.
  await pool.query('UPDATE ads SET stripe_session_id = $1 WHERE id = $2', [sessionId, id]);

  const retried = await deliver(event);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.action, 'paid');
  assert.equal((await readBooking(id)).paid, true);
});

// ---------------------------------------------------------------------------
// Payment states
// ---------------------------------------------------------------------------

test('a completed session that is not yet paid does not mark the booking paid', async () => {
  const booking = await createPendingBooking();
  const event = checkoutEvent({
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100000,
    paymentStatus: 'unpaid',
  });

  const res = await deliver(event);

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'awaiting_payment');
  const after = await readBooking(booking.id);
  assert.equal(after.paid, false);
  assert.equal(after.payment_status, 'awaiting_payment');
  assert.equal(after.paid_at, null);
});

test('a delayed payment that later succeeds marks the booking paid', async () => {
  const booking = await createPendingBooking();

  const pending = checkoutEvent({
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100000,
    paymentStatus: 'unpaid',
  });
  await deliver(pending);
  assert.equal((await readBooking(booking.id)).payment_status, 'awaiting_payment');

  const succeeded = checkoutEvent({
    type: 'checkout.session.async_payment_succeeded',
    sessionId: booking.sessionId,
    adId: booking.id,
    amountTotal: 100000,
  });
  const res = await deliver(succeeded);

  assert.equal(res.body.action, 'paid');
  const after = await readBooking(booking.id);
  assert.equal(after.paid, true);
  assert.equal(after.payment_status, 'paid');
});

test('a delayed payment that fails marks the booking failed', async () => {
  const booking = await createPendingBooking();

  const res = await deliver(
    checkoutEvent({
      type: 'checkout.session.async_payment_failed',
      sessionId: booking.sessionId,
      adId: booking.id,
      amountTotal: 100000,
      paymentStatus: 'unpaid',
    })
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'failed');
  const after = await readBooking(booking.id);
  assert.equal(after.paid, false);
  assert.equal(after.payment_status, 'failed');
});

test('an expired session marks the booking expired', async () => {
  const booking = await createPendingBooking();

  const res = await deliver(
    checkoutEvent({
      type: 'checkout.session.expired',
      sessionId: booking.sessionId,
      adId: booking.id,
      amountTotal: 100000,
      paymentStatus: 'unpaid',
    })
  );

  assert.equal(res.body.action, 'expired');
  assert.equal((await readBooking(booking.id)).payment_status, 'expired');
});

test('a late expiry event cannot un-pay an already paid booking', async () => {
  const booking = await createPendingBooking();
  await deliver(
    checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 })
  );
  assert.equal((await readBooking(booking.id)).paid, true);

  const res = await deliver(
    checkoutEvent({
      type: 'checkout.session.expired',
      sessionId: booking.sessionId,
      adId: booking.id,
      amountTotal: 100000,
      paymentStatus: 'unpaid',
    })
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'ignored');
  const after = await readBooking(booking.id);
  assert.equal(after.paid, true, 'a paid booking must not be downgraded by a stale event');
  assert.equal(after.payment_status, 'paid');
});

test('a refund stops the banner and clears the paid flag', async () => {
  const booking = await createPendingBooking();
  const paymentIntent = unique('pi_test');
  await deliver(
    checkoutEvent({
      sessionId: booking.sessionId,
      adId: booking.id,
      amountTotal: 100000,
      paymentIntent,
    })
  );
  assert.equal((await readBooking(booking.id)).paid, true);

  const res = await deliver(chargeEvent({ type: 'charge.refunded', paymentIntent }));

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'refunded');
  const after = await readBooking(booking.id);
  assert.equal(after.paid, false, 'a refunded booking must stop running and stop counting as revenue');
  assert.equal(after.payment_status, 'refunded');
  assert.ok(after.refunded_at);
});

test('a dispute stops the banner and clears the paid flag', async () => {
  const booking = await createPendingBooking();
  const paymentIntent = unique('pi_test');
  await deliver(
    checkoutEvent({
      sessionId: booking.sessionId,
      adId: booking.id,
      amountTotal: 100000,
      paymentIntent,
    })
  );

  const res = await deliver(chargeEvent({ type: 'charge.dispute.created', paymentIntent }));

  assert.equal(res.body.action, 'disputed');
  const after = await readBooking(booking.id);
  assert.equal(after.paid, false);
  assert.equal(after.payment_status, 'disputed');
  assert.ok(after.disputed_at);
});

test('a refund for an unknown payment intent is ignored', async () => {
  const res = await deliver(chargeEvent({ type: 'charge.refunded', paymentIntent: unique('pi_test_unknown') }));
  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'ignored');
});

test('an event type this endpoint does not handle is acknowledged and ignored', async () => {
  const event = {
    id: unique('evt_test'),
    object: 'event',
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_test_irrelevant' } },
  };

  const res = await deliver(event);

  assert.equal(res.status, 200, 'unhandled types must not be retried forever');
  assert.equal(res.body.action, 'ignored');
  assert.equal(await ledgerCount(event.id), 0, 'nothing happened, so nothing to record');
});

// ---------------------------------------------------------------------------
// The confirmation endpoint is display-only
// ---------------------------------------------------------------------------

test('the confirmation endpoint cannot mark a booking paid', async () => {
  const booking = await createPendingBooking();

  // Hit it the way the success page does, repeatedly. Before this phase, this
  // request is what flipped the booking to paid.
  for (let i = 0; i < 3; i += 1) {
    const res = await api().get(
      `/api/ads/checkout/confirm?session_id=${encodeURIComponent(booking.sessionId)}`
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.paid, false);
    assert.equal(res.body.payment_status, 'pending');
  }

  const after = await readBooking(booking.id);
  assert.equal(after.paid, false, 'the confirmation endpoint must never change payment state');
  assert.equal(after.payment_status, 'pending');
  assert.equal(after.paid_at, null);
});

test('the confirmation endpoint reports a paid booking once the webhook has run', async () => {
  const booking = await createPendingBooking();
  await deliver(
    checkoutEvent({ sessionId: booking.sessionId, adId: booking.id, amountTotal: 100000 })
  );

  const res = await api().get(
    `/api/ads/checkout/confirm?session_id=${encodeURIComponent(booking.sessionId)}`
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.paid, true);
  assert.equal(res.body.payment_status, 'paid');
  assert.equal(res.body.business_name, 'Webhook Test Co');
});

test('the confirmation endpoint 404s for an unknown session', async () => {
  const res = await api().get('/api/ads/checkout/confirm?session_id=cs_test_never_existed');
  assert.equal(res.status, 404);
});
