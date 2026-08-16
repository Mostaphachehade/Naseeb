// Coverage for the ADS_CHECKOUT_ENABLED kill switch.
//
// Self-serve ad checkout can take a customer's money and then fail to deliver:
// fulfilment depends on the browser returning to the success page, and two
// simultaneous checkouts can be sold the same dates. Until those are fixed,
// the route must be inert unless someone has explicitly turned it on.
//
// The Stripe assertions here work by replacing globalThis.fetch — server/lib/
// stripe.js talks to the API through plain fetch(), so a stub records every
// outbound request the route would have made. No network call leaves this
// process in either direction, and no real Stripe key is present: testEnv.js
// strips anything that isn't sk_test_.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, pool, ensureInit, signIn, anon } = require('../testHelpers');

const realFetch = globalThis.fetch;
let fetchCalls = [];

// Returns a real Response rather than a hand-made lookalike: the Stripe SDK is
// configured with createFetchHttpClient() and reads status, headers and the
// body stream the way any fetch client would, so a duck-typed stub with only
// .ok and .json() is not enough for it.
function stubFetch(response) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function stripeCalls() {
  return fetchCalls.filter((call) => call.url.includes('api.stripe.com'));
}

const VALID_BOOKING = {
  business_name: 'Acme LLC',
  contact_email: 'advertiser@example.com',
  image_url: 'https://example.com/banner.jpg',
  target_url: 'https://example.com',
  weeks: 2,
};

// adCheckoutLimiter allows 10 requests per IP per 15 minutes, and this file
// makes more than that. Rather than disable a rate limiter that exists for good
// reason — leaving it untested in the process — each request arrives from its
// own address. The app sets `trust proxy` for Render, so X-Forwarded-For is
// what express-rate-limit keys on, exactly as it would for real visitors.
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

// Sends the current quote version, as the page does. Without it the server
// answers 409 (the price may have moved), which would mask what these tests are
// actually about — the kill switch.
async function postCheckout(body = VALID_BOOKING) {
  const quote = await api().get('/api/ads/availability');
  return api()
    .post('/api/ads/checkout')
    .set('X-Forwarded-For', nextIp())
    .send({ quote_version: quote.body.quoteVersion, ...body });
}

before(async () => {
  await ensureInit();
  // The Stripe SDK refuses to build a client without a key, where the previous
  // hand-rolled fetch client would happily send an unauthenticated request. The
  // value is a fabricated placeholder and never leaves this process — every
  // outbound call is intercepted by the fetch stub above. testEnv.js drops any
  // key that isn't sk_test_, so a live key can't be substituted here by accident.
  process.env.STRIPE_SECRET_KEY = 'sk_test_fabricated_key_for_tests_only';
});

beforeEach(() => {
  delete process.env.ADS_CHECKOUT_ENABLED;
  globalThis.fetch = realFetch;
  fetchCalls = [];
});

after(async () => {
  globalThis.fetch = realFetch;
  await pool.query("DELETE FROM ads WHERE business_name = 'Acme LLC'");
  await pool.end();
});

test('checkout is disabled when the environment variable is absent', async () => {
  // The default matters more than any other case here: a fresh environment, a
  // forgotten variable or a failed config load must all fail closed.
  assert.equal(process.env.ADS_CHECKOUT_ENABLED, undefined);

  const res = await postCheckout();

  assert.equal(res.status, 503);
  assert.equal(res.body.checkoutEnabled, false);
  assert.match(res.body.error, /temporarily unavailable/i);
});

test('a disabled checkout inserts no ad row', async () => {
  // Scoped to this file's own business name rather than a global COUNT(*) on
  // ads: other test files insert bookings in parallel, so a total row count
  // moves for reasons that have nothing to do with this request.
  const before = await pool.query(
    "SELECT COUNT(*)::int AS c FROM ads WHERE business_name = 'Acme LLC'"
  );

  const res = await postCheckout();
  assert.equal(res.status, 503);

  const after = await pool.query(
    "SELECT COUNT(*)::int AS c FROM ads WHERE business_name = 'Acme LLC'"
  );
  assert.equal(after.rows[0].c, before.rows[0].c, 'no pending ad row may be left behind');
});

test('a disabled checkout makes no Stripe request at all', async () => {
  stubFetch({ id: 'cs_test_should_never_be_created', url: 'https://checkout.stripe.com/never' });

  const res = await postCheckout();

  assert.equal(res.status, 503);
  assert.equal(stripeCalls().length, 0, 'no Checkout Session may be created while disabled');
});

test('every falsy-ish flag value keeps checkout disabled', async () => {
  for (const value of ['', 'false', 'FALSE', '0', 'no', 'off', 'disabled', 'ture', ' ']) {
    process.env.ADS_CHECKOUT_ENABLED = value;
    const res = await postCheckout();
    assert.equal(res.status, 503, `value ${JSON.stringify(value)} must not enable checkout`);
  }
});

test('the flag is read per request, not captured at startup', async () => {
  // Otherwise turning checkout on or off would need a redeploy, and the switch
  // would be useless as an incident control.
  process.env.ADS_CHECKOUT_ENABLED = 'true';
  stubFetch({ id: 'cs_test_flag_read_live', url: 'https://checkout.stripe.com/pay/cs_test_flag_read_live' });
  const enabled = await postCheckout();
  assert.equal(enabled.status, 200);

  process.env.ADS_CHECKOUT_ENABLED = 'false';
  const disabled = await postCheckout();
  assert.equal(disabled.status, 503);
});

test('availability reports the checkout state and leaks nothing else', async () => {
  const disabled = await api().get('/api/ads/availability');
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.checkoutEnabled, false);

  process.env.ADS_CHECKOUT_ENABLED = 'true';
  const enabled = await api().get('/api/ads/availability');
  assert.equal(enabled.body.checkoutEnabled, true);

  // The response is a fixed, boolean-and-numbers shape. Anything else appearing
  // here — a key name, an env value, a Stripe identifier — is a regression.
  assert.deepEqual(Object.keys(enabled.body).sort(), [
    'checkoutEnabled',
    'currency',
    'currencyMinorUnits',
    'durations',
    'maxWeeks',
    'nextAvailableDate',
    'pricePerWeekDisplay',
    'pricePerWeekFils',
    'quoteVersion',
  ]);
  assert.equal(typeof enabled.body.checkoutEnabled, 'boolean');

  const serialized = JSON.stringify(enabled.body);
  assert.ok(!serialized.includes('ADS_CHECKOUT_ENABLED'), 'must not echo the variable name');
  assert.ok(!/sk_(test|live)_/.test(serialized), 'must never contain a Stripe key');
});

test('when explicitly enabled, the existing checkout behaviour is unchanged', async () => {
  process.env.ADS_CHECKOUT_ENABLED = 'true';
  stubFetch({
    id: 'cs_test_enabled_path',
    url: 'https://checkout.stripe.com/pay/cs_test_enabled_path',
  });

  const res = await postCheckout();

  assert.equal(res.status, 200);
  assert.equal(res.body.checkoutUrl, 'https://checkout.stripe.com/pay/cs_test_enabled_path');

  // One Checkout Session created, with the booking's own amount and currency.
  const calls = stripeCalls();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/checkout\/sessions$/);
  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get('line_items[0][price_data][currency]'), 'aed');
  assert.equal(body.get('mode'), 'payment');

  // And the pending row exists, tied to that session — the behaviour the later
  // phases build webhook fulfilment and slot reservation on top of. Matched on
  // the session id rather than the business name, since other tests in this
  // file also complete a checkout as the same business.
  const row = await pool.query(
    'SELECT paid, stripe_session_id, amount_aed FROM ads WHERE stripe_session_id = $1',
    ['cs_test_enabled_path']
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].paid, false);
  assert.equal(row.rows[0].stripe_session_id, 'cs_test_enabled_path');

  // The amount charged must equal the amount booked. Asserted against each
  // other rather than against a hard-coded 1,000, because another test file
  // changes ad_price_per_week_aed while this one runs — and internal
  // consistency is the property that actually matters here anyway.
  assert.equal(
    Number(body.get('line_items[0][price_data][unit_amount]')),
    Math.round(Number(row.rows[0].amount_aed) * 100),
    'Stripe must be asked for exactly what the booking records'
  );
});

test('validation still rejects bad input when checkout is enabled', async () => {
  process.env.ADS_CHECKOUT_ENABLED = 'true';
  stubFetch({ id: 'cs_test_never', url: 'https://checkout.stripe.com/never' });

  const res = await postCheckout({ ...VALID_BOOKING, target_url: 'javascript:alert(1)' });

  assert.equal(res.status, 400);
  assert.equal(stripeCalls().length, 0, 'invalid input must not reach Stripe');
});
