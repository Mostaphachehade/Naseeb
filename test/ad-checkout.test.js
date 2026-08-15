// Validation-only coverage — like the email tests elsewhere in this suite,
// this deliberately never calls the real Stripe API from CI (no
// STRIPE_SECRET_KEY is configured there, matching how RESEND_API_KEY isn't
// either). The full Stripe Checkout round trip (session creation, a real
// test-card payment, and the paid-status confirmation) was verified
// manually in-browser against Stripe's actual test mode.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, pool, ensureInit } = require('../testHelpers');

before(async () => {
  await ensureInit();
  // These assert the enabled path's input validation, so the kill switch has to
  // be on for them to reach it — with ADS_CHECKOUT_ENABLED absent (the default
  // since Phase 1.1) every request short-circuits to 503 before validation
  // runs. The disabled path has its own coverage in ads-checkout-flag.test.js.
  process.env.ADS_CHECKOUT_ENABLED = 'true';
});

after(async () => {
  await pool.end();
});

test('availability returns a next-available date and the current price', async () => {
  const res = await api().get('/api/ads/availability');
  assert.equal(res.status, 200);
  assert.match(res.body.nextAvailableDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof res.body.pricePerWeekAed, 'number');
  assert.equal(typeof res.body.maxWeeks, 'number');
});

test('checkout rejects a missing business name', async () => {
  const res = await api().post('/api/ads/checkout').send({
    contact_email: 'test@example.com',
    image_url: 'https://example.com/banner.jpg',
    target_url: 'https://example.com',
    weeks: 1,
  });
  assert.equal(res.status, 400);
});

test('checkout rejects an invalid email', async () => {
  const res = await api().post('/api/ads/checkout').send({
    business_name: 'Acme LLC',
    contact_email: 'not-an-email',
    image_url: 'https://example.com/banner.jpg',
    target_url: 'https://example.com',
    weeks: 1,
  });
  assert.equal(res.status, 400);
});

test('checkout rejects a missing banner image', async () => {
  const res = await api().post('/api/ads/checkout').send({
    business_name: 'Acme LLC',
    contact_email: 'test@example.com',
    target_url: 'https://example.com',
    weeks: 1,
  });
  assert.equal(res.status, 400);
});

test('checkout rejects a non-http(s) destination link', async () => {
  const res = await api().post('/api/ads/checkout').send({
    business_name: 'Acme LLC',
    contact_email: 'test@example.com',
    image_url: 'https://example.com/banner.jpg',
    target_url: 'javascript:alert(1)',
    weeks: 1,
  });
  assert.equal(res.status, 400);
});

test('checkout rejects an out-of-range week count', async () => {
  const res = await api().post('/api/ads/checkout').send({
    business_name: 'Acme LLC',
    contact_email: 'test@example.com',
    image_url: 'https://example.com/banner.jpg',
    target_url: 'https://example.com',
    weeks: 99,
  });
  assert.equal(res.status, 400);
});

test('checkout/confirm requires a session_id', async () => {
  const res = await api().get('/api/ads/checkout/confirm');
  assert.equal(res.status, 400);
});

test('a bad-input checkout attempt never leaves a pending ad row behind', async () => {
  // Keyed on a marker unique to this run rather than a global COUNT(*): test
  // files run in parallel against one database, so a total row count also
  // moves when another file inserts, which made this assertion flaky. Checking
  // that this specific booking is absent is both stabler and a stronger claim.
  const marker = `Bad Input Co ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const res = await api()
    .post('/api/ads/checkout')
    .send({ business_name: marker, contact_email: 'not-an-email', weeks: 1 });
  assert.equal(res.status, 400);

  const rows = await pool.query('SELECT COUNT(*)::int AS c FROM ads WHERE business_name = $1', [marker]);
  assert.equal(rows.rows[0].c, 0);
});
