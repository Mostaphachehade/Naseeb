// Coverage for advertising price parity (audit finding #4).
//
// The price existed in three places that could disagree: the owner setting the
// server charged from, a hard-coded AED 500 in advertise.html, and a second
// hard-coded total inside every dropdown option. Changing the price in the
// owner panel changed what Stripe charged and nothing else — so a customer
// could read one number on the page and be billed another.
//
// Offline throughout: Stripe is a stubbed globalThis.fetch that records every
// outbound request, the secrets are fabricated, and the database is the
// isolated local cluster.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const Stripe = require('stripe');
const { api, pool, ensureInit, signIn, anon, closePool } = require('../testHelpers');
const { aedToFils, formatFils, getAdPriceQuote, PRICE_SETTING_KEY } = require('../server/lib/adPricing');
const { setSetting, DEFAULTS } = require('../server/lib/settings');

const WEBHOOK_SECRET = 'whsec_fabricated_secret_for_pricing_tests';
const stripe = new Stripe('sk_test_fabricated_key_for_tests_only');

const realFetch = globalThis.fetch;
let stripeRequests = [];
const usedEventIds = [];

function stubStripe() {
  stripeRequests = [];
  globalThis.fetch = async (url, options) => {
    stripeRequests.push({ url: String(url), body: options && options.body });
    const id = `cs_test_pricing_${Math.random().toString(36).slice(2, 10)}`;
    return new Response(
      JSON.stringify({ id, url: `https://checkout.stripe.com/pay/${id}`, object: 'checkout.session' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
}

function sessionCreates() {
  return stripeRequests.filter((r) => r.url.includes('/checkout/sessions'));
}

function lastSessionParams() {
  const calls = sessionCreates();
  assert.ok(calls.length > 0, 'expected a Checkout Session to have been created');
  return new URLSearchParams(calls[calls.length - 1].body);
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
  await pool.query("DELETE FROM ads WHERE business_name LIKE 'Pricing Test%'").catch(() => {});
  if (usedEventIds.length) {
    await pool.query('DELETE FROM stripe_events WHERE id = ANY($1)', [usedEventIds]).catch(() => {});
  }
  // Leave the price as the suite found it.
  await setSetting(PRICE_SETTING_KEY, DEFAULTS[PRICE_SETTING_KEY]).catch(() => {});
  await closePool();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${128 + ((ipCounter >> 16) & 63)}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

async function availability() {
  const res = await api().get('/api/ads/availability');
  assert.equal(res.status, 200);
  return res;
}

function checkout(body) {
  return api().post('/api/ads/checkout').set('X-Forwarded-For', nextIp()).send(body);
}

function validBooking(overrides = {}) {
  return {
    business_name: 'Pricing Test Co',
    contact_email: 'advertiser@example.com',
    image_url: 'https://example.com/banner.jpg',
    target_url: 'https://example.com',
    weeks: 2,
    ...overrides,
  };
}

async function setPrice(value) {
  await setSetting(PRICE_SETTING_KEY, value);
}

async function bookingBySession(sessionId) {
  const res = await pool.query(
    `SELECT amount_fils, amount_aed, unit_price_fils, weeks, currency, quote_version
       FROM ads WHERE stripe_session_id = $1`,
    [sessionId]
  );
  return res.rows[0];
}

async function latestBooking(name = 'Pricing Test Co') {
  const res = await pool.query(
    `SELECT id, amount_fils, amount_aed, unit_price_fils, weeks, currency, quote_version,
            stripe_session_id
       FROM ads WHERE business_name = $1 ORDER BY created_at DESC LIMIT 1`,
    [name]
  );
  return res.rows[0];
}

function paidEvent({ sessionId, adId, amountTotal, currency = 'aed' }) {
  const id = `evt_test_pricing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
        currency,
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
// Minor-unit arithmetic
// ---------------------------------------------------------------------------

test('prices convert to fils exactly, without floating-point multiplication', () => {
  assert.equal(aedToFils('500'), 50000);
  assert.equal(aedToFils('0.01'), 1);
  assert.equal(aedToFils('1.5'), 150);
  assert.equal(aedToFils('1.05'), 105);

  // The cases a naive `Number(value) * 100` gets wrong: 49.99 * 100 is
  // 4998.999999999999 in IEEE 754, and 1.1 * 100 is 110.00000000000001.
  assert.equal(aedToFils('49.99'), 4999);
  assert.equal(aedToFils('1.1'), 110);
  assert.equal(aedToFils('8.29'), 829);
  assert.equal(aedToFils('1234.56'), 123456);

  // Surrounding whitespace is tolerated — the owner panel trims before storing,
  // so a padded value is the same price, not a different one.
  assert.equal(aedToFils(' 500 '), 50000);

  // Not a plain decimal amount, so not a price. '1e3' is the interesting one:
  // Number('1e3') is a perfectly good 1000, which is exactly how an
  // unintended price gets charged.
  for (const bad of ['1e3', '-5', '5.005', 'abc', '', '500,00', '0x10']) {
    assert.throws(() => aedToFils(bad), `"${bad}" must be rejected`);
  }
});

test('amounts are formatted identically everywhere they are shown', () => {
  assert.equal(formatFils(50000), 'AED 500');
  assert.equal(formatFils(100000), 'AED 1,000');
  assert.equal(formatFils(400000), 'AED 4,000');
  assert.equal(formatFils(4999), 'AED 49.99');
  assert.equal(formatFils(123456), 'AED 1,234.56');
  assert.equal(formatFils(5), 'AED 0.05');
});

// ---------------------------------------------------------------------------
// The API is the single source
// ---------------------------------------------------------------------------

test('availability returns the price in integer fils with currency and a quote version', async () => {
  await setPrice('500');
  const res = await availability();

  assert.equal(res.body.pricePerWeekFils, 50000);
  assert.equal(res.body.pricePerWeekDisplay, 'AED 500');
  assert.equal(res.body.currency, 'AED');
  assert.equal(res.body.currencyMinorUnits, 100);
  assert.match(res.body.quoteVersion, /^[0-9a-f]{16}$/);
  assert.equal(Number.isInteger(res.body.pricePerWeekFils), true);

  // Cached price is a stale price.
  assert.match(res.headers['cache-control'], /no-store/);
});

test('one, two, four and eight week totals are correct and server-calculated', async () => {
  await setPrice('500');
  const res = await availability();

  const byWeeks = Object.fromEntries(res.body.durations.map((d) => [d.weeks, d]));
  assert.deepEqual(Object.keys(byWeeks).map(Number).sort((a, b) => a - b), [1, 2, 4, 8]);

  assert.equal(byWeeks[1].totalFils, 50000);
  assert.equal(byWeeks[2].totalFils, 100000);
  assert.equal(byWeeks[4].totalFils, 200000);
  assert.equal(byWeeks[8].totalFils, 400000);

  assert.equal(byWeeks[1].totalDisplay, 'AED 500');
  assert.equal(byWeeks[2].totalDisplay, 'AED 1,000');
  assert.equal(byWeeks[4].totalDisplay, 'AED 2,000');
  assert.equal(byWeeks[8].totalDisplay, 'AED 4,000');

  assert.equal(byWeeks[8].label, '8 weeks — AED 4,000');
  assert.equal(byWeeks[1].label, '1 week — AED 500');
});

test('an owner price change propagates to the API, every total, and the quote version', async () => {
  await setPrice('500');
  const before = await availability();

  await setPrice('725.50');
  const after = await availability();

  assert.equal(after.body.pricePerWeekFils, 72550);
  assert.equal(after.body.pricePerWeekDisplay, 'AED 725.50');
  assert.notEqual(after.body.quoteVersion, before.body.quoteVersion, 'a new price must be a new quote');

  const byWeeks = Object.fromEntries(after.body.durations.map((d) => [d.weeks, d]));
  assert.equal(byWeeks[1].totalFils, 72550);
  assert.equal(byWeeks[2].totalFils, 145100);
  assert.equal(byWeeks[4].totalFils, 290200);
  assert.equal(byWeeks[8].totalFils, 580400);
  assert.equal(byWeeks[2].totalDisplay, 'AED 1,451');
  assert.equal(byWeeks[1].totalDisplay, 'AED 725.50');
});

test('the same price produces a stable quote version across calls', async () => {
  await setPrice('500');
  const a = await availability();
  const b = await availability();
  assert.equal(a.body.quoteVersion, b.body.quoteVersion);
});

// ---------------------------------------------------------------------------
// Displayed price equals charged price
// ---------------------------------------------------------------------------

test('Stripe is asked for exactly the amount the page displayed', async () => {
  await setPrice('500');
  const quote = (await availability()).body;
  const shown = quote.durations.find((d) => d.weeks === 4);

  const res = await checkout(validBooking({ weeks: 4, quote_version: quote.quoteVersion }));
  assert.equal(res.status, 200);

  const params = lastSessionParams();
  assert.equal(
    Number(params.get('line_items[0][price_data][unit_amount]')),
    shown.totalFils,
    'the charge must equal the displayed total'
  );
  assert.equal(params.get('line_items[0][price_data][currency]'), 'aed');
  assert.equal(res.body.amountFils, shown.totalFils);
  assert.equal(res.body.amountDisplay, shown.totalDisplay);
  assert.match(res.headers['cache-control'], /no-store/);
});

test('a changed price is charged at the new rate, still matching what was displayed', async () => {
  await setPrice('812.25');
  const quote = (await availability()).body;
  const shown = quote.durations.find((d) => d.weeks === 2);
  assert.equal(shown.totalFils, 162450);

  const res = await checkout(validBooking({ weeks: 2, quote_version: quote.quoteVersion }));
  assert.equal(res.status, 200);

  assert.equal(Number(lastSessionParams().get('line_items[0][price_data][unit_amount]')), 162450);
  const booking = await bookingBySession(res.body.checkoutUrl.split('/').pop());
  assert.equal(Number(booking.amount_fils), 162450);
});

test('the booking stores the unit price, duration, total, currency and quote version', async () => {
  await setPrice('500');
  const quote = (await availability()).body;

  const res = await checkout(validBooking({ weeks: 8, quote_version: quote.quoteVersion }));
  assert.equal(res.status, 200);

  const booking = await latestBooking();
  assert.equal(Number(booking.unit_price_fils), 50000);
  assert.equal(booking.weeks, 8);
  assert.equal(Number(booking.amount_fils), 400000);
  assert.equal(booking.currency, 'AED');
  assert.equal(booking.quote_version, quote.quoteVersion);
  // The legacy NUMERIC column stays consistent, derived in SQL from the fils.
  assert.equal(Number(booking.amount_aed), 4000);
});

// ---------------------------------------------------------------------------
// Stale quotes
// ---------------------------------------------------------------------------

test('a stale quote version is rejected with 409 and the fresh quote', async () => {
  await setPrice('500');
  const stale = (await availability()).body;

  // The owner changes the price while the customer is filling in the form.
  await setPrice('900');

  const res = await checkout(validBooking({ weeks: 2, quote_version: stale.quoteVersion }));

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PRICE_CHANGED');
  assert.match(res.body.error, /price changed/i);
  assert.equal(res.body.quote.pricePerWeekFils, 90000);
  assert.notEqual(res.body.quote.quoteVersion, stale.quoteVersion);
  assert.equal(res.body.quote.durations.find((d) => d.weeks === 2).totalDisplay, 'AED 1,800');
});

test('a stale quote creates no hold, no booking and no Stripe request', async () => {
  await setPrice('500');
  const stale = (await availability()).body;
  await setPrice('900');

  const before = await pool.query(
    "SELECT COUNT(*)::int AS c FROM ads WHERE business_name = 'Pricing Test Stale'"
  );

  const res = await checkout(
    validBooking({ business_name: 'Pricing Test Stale', weeks: 2, quote_version: stale.quoteVersion })
  );
  assert.equal(res.status, 409);

  const after = await pool.query(
    "SELECT COUNT(*)::int AS c FROM ads WHERE business_name = 'Pricing Test Stale'"
  );
  assert.equal(after.rows[0].c, before.rows[0].c, 'no booking row may be created');

  const held = await pool.query(
    "SELECT COUNT(*)::int AS c FROM ads WHERE business_name = 'Pricing Test Stale' AND slot_status = 'held'"
  );
  assert.equal(held.rows[0].c, 0, 'no slot may be held');
  assert.equal(sessionCreates().length, 0, 'Stripe must not be contacted');
});

test('a missing quote version is rejected the same way as a stale one', async () => {
  await setPrice('500');
  const res = await checkout(validBooking({ weeks: 2 })); // no quote_version at all
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PRICE_CHANGED');
  assert.equal(sessionCreates().length, 0);
});

test('confirming the refreshed quote completes the booking at the new price', async () => {
  await setPrice('500');
  const stale = (await availability()).body;
  await setPrice('600');

  const rejected = await checkout(
    validBooking({ business_name: 'Pricing Test Confirm', weeks: 2, quote_version: stale.quoteVersion })
  );
  assert.equal(rejected.status, 409);

  // The customer sees the new total and submits again — exactly what the page
  // does after showing the "confirm new price" notice.
  const fresh = rejected.body.quote;
  const accepted = await checkout(
    validBooking({ business_name: 'Pricing Test Confirm', weeks: 2, quote_version: fresh.quoteVersion })
  );

  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.amountFils, 120000);
  assert.equal(Number(lastSessionParams().get('line_items[0][price_data][unit_amount]')), 120000);
});

// ---------------------------------------------------------------------------
// The browser is never trusted about money
// ---------------------------------------------------------------------------

test('a tampered price or total in the request body is ignored', async () => {
  await setPrice('500');
  const quote = (await availability()).body;

  const res = await checkout(
    validBooking({
      business_name: 'Pricing Test Tamper',
      weeks: 2,
      quote_version: quote.quoteVersion,
      // Every shape an attacker might try.
      amount_fils: 1,
      amount_aed: 0.01,
      amountFils: 1,
      total: 1,
      totalFils: 1,
      price: 0,
      pricePerWeekFils: 1,
      unit_price_fils: 1,
      currency: 'usd',
    })
  );

  assert.equal(res.status, 200);
  const params = lastSessionParams();
  assert.equal(
    Number(params.get('line_items[0][price_data][unit_amount]')),
    100000,
    'Stripe must be charged the server price, not the submitted one'
  );
  assert.equal(params.get('line_items[0][price_data][currency]'), 'aed', 'currency comes from the server');

  const booking = await latestBooking('Pricing Test Tamper');
  assert.equal(Number(booking.amount_fils), 100000);
  assert.equal(Number(booking.unit_price_fils), 50000);
  assert.equal(booking.currency, 'AED');
});

// ---------------------------------------------------------------------------
// Existing bookings are immutable
// ---------------------------------------------------------------------------

test('a later price change does not alter an existing booking', async () => {
  await setPrice('500');
  const quote = (await availability()).body;

  const res = await checkout(
    validBooking({ business_name: 'Pricing Test Immutable', weeks: 2, quote_version: quote.quoteVersion })
  );
  assert.equal(res.status, 200);
  const before = await latestBooking('Pricing Test Immutable');
  assert.equal(Number(before.amount_fils), 100000);

  // The owner doubles the price afterwards.
  await setPrice('1000');

  const after = await latestBooking('Pricing Test Immutable');
  assert.equal(Number(after.amount_fils), 100000, 'the agreed amount must not move');
  assert.equal(Number(after.unit_price_fils), 50000);
  assert.equal(Number(after.amount_aed), 1000);
  assert.equal(after.quote_version, before.quote_version);
});

test('the webhook reconciles against the stored amount, not the current price', async () => {
  await setPrice('500');
  const quote = (await availability()).body;

  const res = await checkout(
    validBooking({ business_name: 'Pricing Test Webhook', weeks: 2, quote_version: quote.quoteVersion })
  );
  assert.equal(res.status, 200);
  const booking = await latestBooking('Pricing Test Webhook');
  assert.equal(Number(booking.amount_fils), 100000);

  // The price changes between checkout and the webhook arriving. The customer
  // agreed to 1,000 and Stripe collected 1,000; reconciling against the new
  // rate would reject a perfectly good payment.
  await setPrice('1500');

  const delivered = await deliver(
    paidEvent({
      sessionId: booking.stripe_session_id,
      adId: booking.id,
      amountTotal: 100000,
    })
  );

  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.action, 'paid', 'the payment the customer actually made must be honoured');

  // And an amount matching the *new* price is still refused for this booking.
  const wrong = await deliver(
    paidEvent({
      sessionId: booking.stripe_session_id,
      adId: booking.id,
      amountTotal: 300000,
    })
  );
  // Refused rather than ignored as a duplicate: reconciliation runs before the
  // already-paid short-circuit, so an event claiming a different amount for a
  // booking is rejected on its merits whatever state that booking is in.
  assert.equal(wrong.body.action, 'refused');
});

test('the webhook refuses an amount matching a newly raised price on an unpaid booking', async () => {
  await setPrice('500');
  const quote = (await availability()).body;
  const res = await checkout(
    validBooking({ business_name: 'Pricing Test WebhookRefuse', weeks: 1, quote_version: quote.quoteVersion })
  );
  assert.equal(res.status, 200);
  const booking = await latestBooking('Pricing Test WebhookRefuse');

  await setPrice('2000');

  const delivered = await deliver(
    paidEvent({
      sessionId: booking.stripe_session_id,
      adId: booking.id,
      amountTotal: 200000, // what the new price would be
    })
  );

  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.action, 'refused');
  const after = await pool.query('SELECT paid, payment_status FROM ads WHERE id = $1', [booking.id]);
  assert.equal(after.rows[0].paid, false);
});

test('a currency that does not match the booking is refused', async () => {
  await setPrice('500');
  const quote = (await availability()).body;
  const res = await checkout(
    validBooking({ business_name: 'Pricing Test Currency', weeks: 1, quote_version: quote.quoteVersion })
  );
  assert.equal(res.status, 200);
  const booking = await latestBooking('Pricing Test Currency');

  const delivered = await deliver(
    paidEvent({
      sessionId: booking.stripe_session_id,
      adId: booking.id,
      amountTotal: Number(booking.amount_fils),
      currency: 'usd',
    })
  );
  assert.equal(delivered.body.action, 'refused');
});

// ---------------------------------------------------------------------------
// Owner panel validation
// ---------------------------------------------------------------------------

test('the owner panel rejects prices that cannot be charged exactly', async () => {
  const adminEmail = `test-pricing-admin-${Date.now()}@example.com`;
  const adminId = randomUUID();
  const bcrypt = require('bcryptjs');
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, is_admin, email_verified, age_attestation_status, age_attestation_version)
     VALUES ($1, 'Pricing Admin', $2, $3, TRUE, TRUE, 'confirmed', '2026-08-eligibility-18')`,
    [adminId, adminEmail, bcrypt.hashSync('correcthorse123', 4)]
  );

  try {
    const adminSession = await signIn(adminEmail, 'correcthorse123', { ip: nextIp() });

    for (const bad of ['1e3', '5.005', '-100', '0', 'free', '']) {
      const res = await adminSession
        .patch('/api/admin/settings')
        .send({ ad_price_per_week_aed: bad });
      assert.equal(res.status, 400, `"${bad}" must be rejected as a price`);
    }

    const ok = await adminSession.patch('/api/admin/settings')
      .send({ ad_price_per_week_aed: '650.25' });
    assert.equal(ok.status, 200);
    assert.equal((await getAdPriceQuote(pool)).pricePerWeekFils, 65025);
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  }
});

// ---------------------------------------------------------------------------
// No price constant survives on the customer page
// ---------------------------------------------------------------------------

test('the advertise page contains no hard-coded price or client-side money arithmetic', () => {
  // The page's behaviour now lives in an external file (Phase 2.2B moved every
  // inline script out so CSP could forbid them). Both are read, so this still
  // covers everything it did before.
  const markup = fs.readFileSync(path.join(__dirname, '..', 'public', 'advertise.html'), 'utf8');
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pages', 'advertise.js'),
    'utf8'
  );
  const page = markup + script;

  assert.ok(!/WEEK_PRICE/.test(page), 'the hard-coded weekly price constant must be gone');
  assert.ok(!/AED\s*[\d,]/.test(page), 'no literal AED amount may remain on the page');

  // The dropdown options and totals must be built from the server response, not
  // written into the markup.
  assert.ok(!/<option[^>]*>[^<]*\d/.test(page), 'no option may carry a hard-coded amount');

  // And the page must not do arithmetic on money: the old bug was
  // `Number(weeks) * WEEK_PRICE_AED`.
  assert.ok(!/\*\s*WEEK_PRICE/.test(page));
  assert.ok(!/amount_aed/.test(page), 'the page must render the server-formatted amount');

  // It must send the quote version so the server can detect a stale price.
  assert.ok(/quote_version/.test(page), 'checkout must submit the quote version');
  assert.ok(/PRICE_CHANGED/.test(page), 'the page must handle the stale-price response');
});
