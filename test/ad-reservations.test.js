// Coverage for the banner-slot reservation model (audit finding #3).
//
// The slot was allocated by reading the last booked date in one statement and
// inserting in another, with no lock between them and unpaid rows invisible to
// the read. Two customers could be quoted, and could pay for, the same dates.
//
// Everything here runs against the isolated local PostgreSQL the suite always
// uses. Stripe is never contacted: globalThis.fetch is stubbed and every
// outbound request recorded, and the session objects are fabricated.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const Stripe = require('stripe');
const { api, pool, ensureInit } = require('../testHelpers');
const {
  AD_SLOT_LOCK_KEY,
  HOLD_MINUTES,
  STRIPE_EXPIRY_GRACE_MINUTES,
} = require('../server/lib/adSlots');
const {
  findOverlappingSlots,
  ensureSlotExclusionConstraint,
  SLOT_CONSTRAINT_NAME,
} = require('../server/db');

const WEBHOOK_SECRET = 'whsec_fabricated_secret_for_reservation_tests';
const stripe = new Stripe('sk_test_fabricated_key_for_tests_only');

const realFetch = globalThis.fetch;
const createdAdIds = [];
const usedEventIds = [];

let sessionCounter = 0;
let stripeRequests = [];

// Each call gets its own session id, so concurrent checkouts are distinguishable
// the way real Stripe sessions would be.
function stubStripe({ fail = false } = {}) {
  stripeRequests = [];
  globalThis.fetch = async (url, options) => {
    stripeRequests.push({ url: String(url), body: options && options.body });
    if (fail) {
      return new Response(
        JSON.stringify({ error: { message: 'Simulated Stripe outage.', type: 'api_error' } }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
    sessionCounter += 1;
    const id = `cs_test_reservation_${sessionCounter}_${Math.random().toString(36).slice(2, 8)}`;
    return new Response(
      JSON.stringify({ id, url: `https://checkout.stripe.com/pay/${id}`, object: 'checkout.session' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
}

before(async () => {
  await ensureInit();
  process.env.ADS_CHECKOUT_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fabricated_key_for_tests_only';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(() => {
  stubStripe();
});

after(async () => {
  globalThis.fetch = realFetch;
  await pool.query("DELETE FROM ads WHERE business_name LIKE 'Reservation Test%'");
  if (createdAdIds.length) {
    await pool.query('DELETE FROM ads WHERE id = ANY($1)', [createdAdIds]);
  }
  if (usedEventIds.length) {
    await pool.query('DELETE FROM stripe_events WHERE id = ANY($1)', [usedEventIds]);
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function bookWeeks(weeks = 2, name = 'Reservation Test Co') {
  return api()
    .post('/api/ads/checkout')
    .set('X-Forwarded-For', nextIp())
    .send({
      business_name: name,
      contact_email: 'advertiser@example.com',
      image_url: 'https://example.com/banner.jpg',
      target_url: 'https://example.com',
      weeks,
    });
}

async function bookingsFor(name = 'Reservation Test Co') {
  const res = await pool.query(
    `SELECT id, starts_at, ends_at, slot_status, payment_status, hold_expires_at,
            slot_released_at, slot_release_reason, stripe_session_id
       FROM ads WHERE business_name = $1 ORDER BY starts_at`,
    [name]
  );
  return res.rows;
}

async function readBooking(id) {
  const res = await pool.query(
    `SELECT paid, payment_status, slot_status, starts_at, ends_at, hold_expires_at,
            slot_released_at, slot_release_reason
       FROM ads WHERE id = $1`,
    [id]
  );
  return res.rows[0];
}

function overlaps(a, b) {
  return a.starts_at <= b.ends_at && b.starts_at <= a.ends_at;
}

// Dates far past anything the rest of the suite touches, so a fixture inserted
// here dominates MAX(ends_at) and the availability assertions stay deterministic.
let farCounter = 0;
function farWindow(days = 13) {
  farCounter += 1;
  const start = new Date(Date.UTC(2090, 0, 1));
  start.setUTCDate(start.getUTCDate() + farCounter * 60);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return { startsAt: start.toISOString().slice(0, 10), endsAt: end.toISOString().slice(0, 10) };
}

async function insertBooking({ startsAt, endsAt, slotStatus, holdExpiresAt = null, paymentStatus = 'pending' }) {
  const id = uuid();
  await pool.query(
    `INSERT INTO ads
       (id, business_name, image_url, target_url, media_type, contact_email,
        starts_at, ends_at, amount_aed, paid, active, slot_status, hold_expires_at, payment_status)
     VALUES ($1, 'Reservation Test Fixture', 'https://example.com/b.jpg', 'https://example.com',
             'image', 'advertiser@example.com', $2, $3, 1000, $4, FALSE, $5, $6, $7)`,
    [id, startsAt, endsAt, slotStatus === 'paid', slotStatus, holdExpiresAt, paymentStatus]
  );
  createdAdIds.push(id);
  return id;
}

// Holds the same advisory lock the allocation path uses, so no other test file
// can allocate a slot while an availability assertion is being made. Uses a
// dedicated connection because the lock is session-scoped here, not
// transaction-scoped.
async function withSlotLock(fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [AD_SLOT_LOCK_KEY]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [AD_SLOT_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

function dayAfter(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function paidEvent({ sessionId, adId, amountTotal = 100000 }) {
  const id = `evt_test_res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  usedEventIds.push(id);
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        client_reference_id: adId,
        amount_total: amountTotal,
        currency: 'aed',
        payment_status: 'paid',
        payment_intent: `pi_test_${Math.random().toString(36).slice(2, 10)}`,
        status: 'complete',
      },
    },
  };
}

function deliver(event) {
  const payload = JSON.stringify(event);
  return api()
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }))
    .send(payload);
}

// ---------------------------------------------------------------------------
// Concurrent allocation
// ---------------------------------------------------------------------------

test('simultaneous checkouts receive disjoint date ranges', async () => {
  const name = 'Reservation Test Concurrent';

  // Genuinely concurrent: all six are in flight before any of them commits.
  const results = await Promise.all([
    bookWeeks(1, name),
    bookWeeks(2, name),
    bookWeeks(1, name),
    bookWeeks(4, name),
    bookWeeks(2, name),
    bookWeeks(1, name),
  ]);

  assert.ok(results.every((r) => r.status === 200), 'every concurrent checkout should succeed');

  const rows = await bookingsFor(name);
  assert.equal(rows.length, 6);

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      assert.ok(
        !overlaps(rows[i], rows[j]),
        `bookings ${rows[i].starts_at}..${rows[i].ends_at} and ${rows[j].starts_at}..${rows[j].ends_at} must not overlap`
      );
    }
  }

  // Consecutive, not merely disjoint: each starts the day after the last ends.
  for (let i = 1; i < rows.length; i += 1) {
    assert.equal(rows[i].starts_at, dayAfter(rows[i - 1].ends_at));
  }

  assert.ok(rows.every((r) => r.slot_status === 'held'), 'all six hold their dates');
  await pool.query('DELETE FROM ads WHERE business_name = $1', [name]);
});

test('the database itself rejects a direct overlapping insert', async () => {
  // The advisory lock keeps the application well-behaved; this is the backstop
  // that holds when something bypasses it entirely.
  const { startsAt, endsAt } = farWindow();
  await insertBooking({ startsAt, endsAt, slotStatus: 'paid', paymentStatus: 'paid' });

  await assert.rejects(
    insertBooking({
      startsAt,
      endsAt,
      slotStatus: 'held',
      holdExpiresAt: new Date(Date.now() + 3600_000),
    }),
    (err) => err.code === '23P01',
    'an overlapping held booking must be refused by the exclusion constraint'
  );

  // A partial overlap is still an overlap.
  const partial = new Date(`${startsAt}T00:00:00Z`);
  partial.setUTCDate(partial.getUTCDate() + 3);
  await assert.rejects(
    insertBooking({
      startsAt: partial.toISOString().slice(0, 10),
      endsAt,
      slotStatus: 'paid',
      paymentStatus: 'paid',
    }),
    (err) => err.code === '23P01'
  );
});

test('a released booking does not block the dates it used to hold', async () => {
  const { startsAt, endsAt } = farWindow();
  await insertBooking({
    startsAt,
    endsAt,
    slotStatus: 'released',
    paymentStatus: 'expired',
  });

  // Same dates, now genuinely free.
  await assert.doesNotReject(
    insertBooking({ startsAt, endsAt, slotStatus: 'paid', paymentStatus: 'paid' })
  );
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test('a valid hold occupies the slot in availability, exactly as a paid booking does', async () => {
  await withSlotLock(async () => {
    const paidWindow = farWindow();
    await insertBooking({ ...paidWindow, slotStatus: 'paid', paymentStatus: 'paid' });

    const afterPaid = await api().get('/api/ads/availability');
    assert.equal(afterPaid.body.nextAvailableDate, dayAfter(paidWindow.endsAt));

    // A hold beyond it must push availability out further — an unpaid booking
    // in progress is not available to sell to someone else. This is the exact
    // case the old code got wrong: it counted paid rows only.
    const heldWindow = farWindow();
    await insertBooking({
      ...heldWindow,
      slotStatus: 'held',
      holdExpiresAt: new Date(Date.now() + 3600_000),
    });

    const afterHold = await api().get('/api/ads/availability');
    assert.equal(afterHold.body.nextAvailableDate, dayAfter(heldWindow.endsAt));
  });
});

test('an expired hold stops occupying the slot without being deleted', async () => {
  await withSlotLock(async () => {
    const paidWindow = farWindow();
    await insertBooking({ ...paidWindow, slotStatus: 'paid', paymentStatus: 'paid' });

    const expiredWindow = farWindow();
    const expiredId = await insertBooking({
      ...expiredWindow,
      slotStatus: 'held',
      holdExpiresAt: new Date(Date.now() - 60_000), // lapsed a minute ago
    });

    // Availability ignores it immediately, without waiting for a sweep.
    const availability = await api().get('/api/ads/availability');
    assert.equal(
      availability.body.nextAvailableDate,
      dayAfter(paidWindow.endsAt),
      'an expired hold must not keep the slot'
    );

    // And the record survives: an abandoned booking is still evidence of who
    // tried to buy what, and when.
    const stillThere = await readBooking(expiredId);
    assert.ok(stillThere, 'the row must not be deleted');
    assert.equal(stillThere.slot_status, 'held', 'not yet swept — only allocation sweeps');
  });
});

// Deliberately NOT wrapped in withSlotLock: this test drives the allocation
// route, which takes that same advisory lock. Holding it here would block the
// request forever. The assertions are about one specific row's state rather
// than global availability, so they don't need the isolation.
test('allocation sweeps expired holds and reuses their dates, keeping the audit trail', async () => {
  const expiredWindow = farWindow();
  const expiredId = await insertBooking({
    ...expiredWindow,
    slotStatus: 'held',
    holdExpiresAt: new Date(Date.now() - 60_000),
  });

  // Allocating is what triggers the sweep.
  const res = await bookWeeks(1, 'Reservation Test Sweep');
  assert.equal(res.status, 200);

  const swept = await readBooking(expiredId);
  assert.equal(swept.slot_status, 'released');
  assert.equal(swept.slot_release_reason, 'hold_expired');
  assert.ok(swept.slot_released_at, 'release must be timestamped for the audit trail');
  assert.equal(swept.payment_status, 'expired');

  await pool.query('DELETE FROM ads WHERE business_name = $1', ['Reservation Test Sweep']);
});

// ---------------------------------------------------------------------------
// Hold lifecycle around Stripe
// ---------------------------------------------------------------------------

test('the hold exists before Stripe is contacted', async () => {
  const name = 'Reservation Test Ordering';
  const res = await bookWeeks(1, name);
  assert.equal(res.status, 200);

  const [row] = await bookingsFor(name);
  assert.equal(row.slot_status, 'held');
  assert.ok(row.hold_expires_at, 'the hold must carry an expiry');
  assert.ok(row.stripe_session_id, 'and be linked to the session that was created for it');

  await pool.query('DELETE FROM ads WHERE business_name = $1', [name]);
});

test('the Stripe session expiry is aligned to — and lands before — the hold expiry', async () => {
  const name = 'Reservation Test Expiry';
  const res = await bookWeeks(1, name);
  assert.equal(res.status, 200);

  const [row] = await bookingsFor(name);
  const sessionCreate = stripeRequests.find((r) => r.url.includes('/checkout/sessions'));
  assert.ok(sessionCreate, 'a Checkout Session must have been created');

  const sent = new URLSearchParams(sessionCreate.body);
  const expiresAt = Number(sent.get('expires_at'));
  assert.ok(Number.isInteger(expiresAt), 'expires_at must be sent to Stripe');

  const holdExpiry = Math.floor(new Date(row.hold_expires_at).getTime() / 1000);
  assert.equal(
    expiresAt,
    holdExpiry - STRIPE_EXPIRY_GRACE_MINUTES * 60,
    'the session must expire exactly one grace period before the hold'
  );
  assert.ok(
    expiresAt < holdExpiry,
    'the hold must never lapse while the session is still payable'
  );

  // Stripe refuses an expires_at less than 30 minutes out.
  const minutesAhead = (expiresAt * 1000 - Date.now()) / 60000;
  assert.ok(minutesAhead > 30, `expires_at must be more than 30 minutes out, got ${minutesAhead}`);
  assert.ok(minutesAhead <= HOLD_MINUTES);

  await pool.query('DELETE FROM ads WHERE business_name = $1', [name]);
});

test('a failed Stripe session release the hold instead of blocking the slot', async () => {
  const name = 'Reservation Test StripeFail';
  stubStripe({ fail: true });

  const res = await bookWeeks(1, name);
  assert.equal(res.status, 500, 'the customer is told it failed');

  const [row] = await bookingsFor(name);
  assert.ok(row, 'the attempt is still on record, not deleted');
  assert.equal(row.slot_status, 'released', 'the dates go back on sale immediately');
  assert.equal(row.slot_release_reason, 'checkout_failed');
  assert.ok(row.slot_released_at);
  assert.equal(row.payment_status, 'failed');
  assert.equal(row.stripe_session_id, null);

  // The released dates are genuinely reusable.
  stubStripe();
  const next = await bookWeeks(1, 'Reservation Test StripeFailRetry');
  assert.equal(next.status, 200);
  const [retry] = await bookingsFor('Reservation Test StripeFailRetry');
  assert.equal(retry.starts_at, row.starts_at, 'the same dates are allocated again');

  await pool.query("DELETE FROM ads WHERE business_name LIKE 'Reservation Test StripeFail%'");
});

// ---------------------------------------------------------------------------
// Late payments
// ---------------------------------------------------------------------------

test('a payment made before expiry is honoured when its webhook arrives late', async () => {
  const name = 'Reservation Test LateWebhook';
  const res = await bookWeeks(1, name);
  assert.equal(res.status, 200);
  const [row] = await bookingsFor(name);

  // The customer paid while the session was live; the notification is slow, and
  // by the time it lands the hold has lapsed and been swept. Nobody else took
  // the dates in the meantime.
  await pool.query(
    `UPDATE ads SET hold_expires_at = NOW() - INTERVAL '10 minutes',
                    slot_status = 'released', slot_released_at = NOW(),
                    slot_release_reason = 'hold_expired', payment_status = 'expired'
      WHERE id = $1`,
    [row.id]
  );

  // Read the booked amount back rather than assuming a price: another test
  // file changes ad_price_per_week_aed while this one runs, so the only
  // reliable expectation is what this booking actually recorded.
  const booked = await pool.query('SELECT amount_aed FROM ads WHERE id = $1', [row.id]);
  const amountFils = Math.round(Number(booked.rows[0].amount_aed) * 100);

  const delivered = await deliver(
    paidEvent({ sessionId: row.stripe_session_id, adId: row.id, amountTotal: amountFils })
  );

  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.action, 'paid', 'a slow webhook must not cost the customer their booking');

  const after = await readBooking(row.id);
  assert.equal(after.paid, true);
  assert.equal(after.payment_status, 'paid');
  assert.equal(after.slot_status, 'paid', 'the booking reclaims the dates it paid for');
  assert.equal(after.starts_at, row.starts_at);

  await pool.query('DELETE FROM ads WHERE business_name = $1', [name]);
});

test('a late payment for reallocated dates goes to reconciliation, never to an overlap', async () => {
  const name = 'Reservation Test Superseded';
  const first = await bookWeeks(1, name);
  assert.equal(first.status, 200);
  const [original] = await bookingsFor(name);

  // The hold lapses and is released.
  await pool.query(
    `UPDATE ads SET hold_expires_at = NOW() - INTERVAL '10 minutes',
                    slot_status = 'released', slot_released_at = NOW(),
                    slot_release_reason = 'hold_expired', payment_status = 'expired'
      WHERE id = $1`,
    [original.id]
  );

  // Someone else buys those dates.
  const takeoverId = await insertBooking({
    startsAt: original.starts_at,
    endsAt: original.ends_at,
    slotStatus: 'paid',
    paymentStatus: 'paid',
  });

  // Only now does the original customer's payment land.
  const booked = await pool.query('SELECT amount_aed FROM ads WHERE id = $1', [original.id]);
  const delivered = await deliver(
    paidEvent({
      sessionId: original.stripe_session_id,
      adId: original.id,
      amountTotal: Math.round(Number(booked.rows[0].amount_aed) * 100),
    })
  );

  assert.equal(delivered.status, 200, 'acknowledged — retrying would not help');
  assert.equal(delivered.body.action, 'requires_reconciliation');

  const after = await readBooking(original.id);
  assert.equal(
    after.payment_status,
    'requires_reconciliation',
    'real money was taken and the slot cannot be delivered — this needs a human'
  );
  assert.equal(after.paid, false);
  assert.equal(after.slot_status, 'released', 'it must not claim dates someone else owns');

  // The buyer who got there first is untouched.
  const takeover = await readBooking(takeoverId);
  assert.equal(takeover.slot_status, 'paid');

  // And no overlap exists anywhere.
  assert.deepEqual(await findOverlappingSlots(pool), []);

  await pool.query('DELETE FROM ads WHERE business_name = $1', [name]);
});

// ---------------------------------------------------------------------------
// Concurrency between expiry and allocation
// ---------------------------------------------------------------------------

test('expiring and allocating at the same time cannot produce an overlap', async () => {
  const { expireStaleHolds } = require('../server/lib/adSlots');

  // A batch of holds, all lapsed, whose dates are about to be reclaimed while
  // sweeps run against them concurrently.
  const expiredIds = [];
  for (let i = 0; i < 3; i += 1) {
    const w = farWindow();
    expiredIds.push(
      await insertBooking({ ...w, slotStatus: 'held', holdExpiresAt: new Date(Date.now() - 60_000) })
    );
  }

  async function sweep() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [AD_SLOT_LOCK_KEY]);
      await expireStaleHolds(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  const name = 'Reservation Test Race';
  await Promise.all([
    sweep(),
    bookWeeks(1, name),
    sweep(),
    bookWeeks(2, name),
    sweep(),
    bookWeeks(1, name),
    sweep(),
  ]);

  assert.deepEqual(
    await findOverlappingSlots(pool),
    [],
    'no overlapping held-or-paid bookings may exist after concurrent sweeps and allocations'
  );

  // Sweeping is idempotent: running it again changes nothing.
  const before = await pool.query(
    "SELECT COUNT(*)::int AS c FROM ads WHERE slot_status = 'released' AND slot_release_reason = 'hold_expired'"
  );
  await sweep();
  const after = await pool.query(
    "SELECT COUNT(*)::int AS c FROM ads WHERE slot_status = 'released' AND slot_release_reason = 'hold_expired'"
  );
  assert.equal(after.rows[0].c, before.rows[0].c);

  await pool.query('DELETE FROM ads WHERE business_name = $1', [name]);
});

// ---------------------------------------------------------------------------
// Paid bookings still beat the manually toggled fallback ad
// ---------------------------------------------------------------------------

test('a paid booking takes priority over a manually activated fallback ad', async () => {
  const manualId = uuid();
  await pool.query(
    `INSERT INTO ads (id, business_name, image_url, target_url, media_type, active)
     VALUES ($1, 'Reservation Test Manual', 'https://example.com/m.jpg', 'https://example.com', 'image', TRUE)`,
    [manualId]
  );
  createdAdIds.push(manualId);

  const activeWithManualOnly = await api().get('/api/ads/active');
  assert.equal(activeWithManualOnly.body.id, manualId);

  // A booking covering today outranks it.
  const paidId = await insertBooking({
    startsAt: new Date().toISOString().slice(0, 10),
    endsAt: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    slotStatus: 'paid',
    paymentStatus: 'paid',
  });

  const activeWithPaid = await api().get('/api/ads/active');
  assert.equal(activeWithPaid.body.id, paidId, 'a paid booking must win');

  // Released again (refund, dispute), the manual ad takes back over rather than
  // the slot going dark.
  await pool.query(
    "UPDATE ads SET slot_status = 'released', paid = FALSE, payment_status = 'refunded' WHERE id = $1",
    [paidId]
  );
  const activeAfterRefund = await api().get('/api/ads/active');
  assert.equal(activeAfterRefund.body.id, manualId);

  await pool.query('DELETE FROM ads WHERE id = ANY($1)', [[manualId, paidId]]);
});

test('manual fallback ads never take part in slot allocation', async () => {
  // They have no dates at all; a NULL range would otherwise read as unbounded
  // and collide with everything.
  const manualId = uuid();
  await pool.query(
    `INSERT INTO ads (id, business_name, image_url, target_url, media_type, active)
     VALUES ($1, 'Reservation Test Manual2', 'https://example.com/m.jpg', 'https://example.com', 'image', TRUE)`,
    [manualId]
  );
  createdAdIds.push(manualId);

  const row = await pool.query('SELECT slot_status, starts_at FROM ads WHERE id = $1', [manualId]);
  assert.equal(row.rows[0].slot_status, 'released');
  assert.equal(row.rows[0].starts_at, null);

  // Booking still works with one present.
  const res = await bookWeeks(1, 'Reservation Test Manual3');
  assert.equal(res.status, 200);
  await pool.query('DELETE FROM ads WHERE business_name = $1', ['Reservation Test Manual3']);
});

// ---------------------------------------------------------------------------
// The migration, against data that already overlaps
// ---------------------------------------------------------------------------

test('the migration reports pre-existing overlaps and refuses to touch them', async () => {
  // Staged inside a transaction that drops the constraint and rolls back, so
  // the overlapping rows never become visible to anything else and the schema
  // is restored whatever happens. The DROP takes a brief exclusive lock on ads.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ads DROP CONSTRAINT ${SLOT_CONSTRAINT_NAME}`);

    const { startsAt, endsAt } = farWindow();
    const legacyA = uuid();
    const legacyB = uuid();
    for (const id of [legacyA, legacyB]) {
      await client.query(
        `INSERT INTO ads
           (id, business_name, image_url, target_url, media_type, starts_at, ends_at,
            amount_aed, paid, active, slot_status, payment_status)
         VALUES ($1, 'Reservation Test Legacy', 'https://example.com/b.jpg', 'https://example.com',
                 'image', $2, $3, 1000, TRUE, FALSE, 'paid', 'paid')`,
        [id, startsAt, endsAt]
      );
    }

    const detected = await findOverlappingSlots(client);
    assert.ok(detected.length >= 1, 'the overlap must be detected');
    assert.ok(
      detected.some(
        (row) =>
          (row.booking_a === legacyA && row.booking_b === legacyB) ||
          (row.booking_a === legacyB && row.booking_b === legacyA)
      ),
      'the specific conflicting pair must be reported'
    );

    const result = await ensureSlotExclusionConstraint(client);
    assert.equal(result.status, 'blocked', 'the constraint must not be added over bad data');

    // Nothing was deleted, moved or overwritten — these are commercial records.
    const survivors = await client.query(
      'SELECT id, starts_at, ends_at, slot_status FROM ads WHERE id = ANY($1) ORDER BY id',
      [[legacyA, legacyB].sort()]
    );
    assert.equal(survivors.rows.length, 2, 'both bookings must still exist');
    survivors.rows.forEach((row) => {
      assert.equal(row.starts_at, startsAt, 'dates must be untouched');
      assert.equal(row.ends_at, endsAt);
      assert.equal(row.slot_status, 'paid', 'no booking may be silently released');
    });

    const constraintNow = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = 'ads'::regclass`,
      [SLOT_CONSTRAINT_NAME]
    );
    assert.equal(constraintNow.rowCount, 0, 'blocked means not created');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  // The real schema is intact.
  const restored = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = 'ads'::regclass`,
    [SLOT_CONSTRAINT_NAME]
  );
  assert.equal(restored.rowCount, 1);
});

test('the migration is idempotent and creates the constraint on clean data', async () => {
  // Already present: a no-op, which is what every redeploy does.
  assert.deepEqual(await ensureSlotExclusionConstraint(pool), { status: 'present' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ads DROP CONSTRAINT ${SLOT_CONSTRAINT_NAME}`);

    const created = await ensureSlotExclusionConstraint(client);
    assert.equal(created.status, 'created');

    // And running it again in the same state does nothing.
    assert.deepEqual(await ensureSlotExclusionConstraint(client), { status: 'present' });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});
