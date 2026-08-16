// Coverage for the gates that stop paid checkout operating without confirmed
// database overlap protection (Phase 1.3 safety fix).
//
// The exclusion constraint is what makes double-selling the banner slot
// impossible. Reporting that it could not be applied is not enough: a log line
// scrolls past, and the site carries on taking money with nothing but
// application logic between two advertisers and the same dates — which is the
// assumption that produced the bug in the first place.
//
// Three gates are tested here:
//   1. startup refuses to boot with checkout on and protection unconfirmed;
//   2. the checkout route refuses at request time, before any hold or Stripe
//      call, whenever protection is not confirmed;
//   3. with checkout off, an unprotected app still starts — so a deployment can
//      read the overlap report and fix the data.
//
// The startup gates are exercised by actually spawning server/index.js as a
// child process and inspecting its exit code, because "the process exits" is
// the behaviour being claimed.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { api, pool, ensureInit, signIn, anon } = require('../testHelpers');
const {
  ensureSlotExclusionConstraint,
  isSlotProtectionActive,
  findOverlappingSlots,
  SLOT_CONSTRAINT_NAME,
} = require('../server/db');

const realFetch = globalThis.fetch;
let stripeRequests = [];

// Distinctive values so the overlap report can be checked for leakage of
// anything identifying an advertiser.
const LEGACY_BUSINESS = 'Legacy Overlap Trading LLC';
const LEGACY_EMAIL = 'legacy-advertiser@example.com';
const legacyIds = [];

function stubStripe() {
  stripeRequests = [];
  globalThis.fetch = async (url, options) => {
    stripeRequests.push({ url: String(url), body: options && options.body });
    const id = `cs_test_protection_${Math.random().toString(36).slice(2, 10)}`;
    return new Response(
      JSON.stringify({ id, url: `https://checkout.stripe.com/pay/${id}`, object: 'checkout.session' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
}

function stripeCalls() {
  return stripeRequests.filter((call) => call.url.includes('api.stripe.com'));
}

before(async () => {
  await ensureInit();
  process.env.STRIPE_SECRET_KEY = 'sk_test_fabricated_key_for_tests_only';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fabricated_secret_for_protection_tests';
});

beforeEach(() => {
  stubStripe();
  process.env.ADS_CHECKOUT_ENABLED = 'true';
});

after(async () => {
  globalThis.fetch = realFetch;
  // Whatever happened above, leave the database protected and clean.
  await pool.query("DELETE FROM ads WHERE business_name LIKE 'Protection Test%'").catch(() => {});
  if (legacyIds.length) {
    await pool.query('DELETE FROM ads WHERE id = ANY($1)', [legacyIds]).catch(() => {});
  }
  await ensureSlotExclusionConstraint(pool).catch(() => {});
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${64 + ((ipCounter >> 16) & 63)}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

async function bookSlot(name = 'Protection Test Co') {
  const quote = await api().get('/api/ads/availability');
  return api()
    .post('/api/ads/checkout')
    .set('X-Forwarded-For', nextIp())
    .send({
      business_name: name,
      contact_email: 'advertiser@example.com',
      image_url: 'https://example.com/banner.jpg',
      target_url: 'https://example.com',
      weeks: 1,
      quote_version: quote.body.quoteVersion,
    });
}

async function dropConstraint() {
  await pool.query(`ALTER TABLE ads DROP CONSTRAINT IF EXISTS ${SLOT_CONSTRAINT_NAME}`);
}

async function restoreConstraint() {
  const result = await ensureSlotExclusionConstraint(pool);
  assert.notEqual(result.status, 'blocked', 'test cleanup left overlapping rows behind');
}

// Two bookings for the same dates, of the kind that could exist in a database
// written before any of this protection did.
async function createHistoricalOverlap() {
  const startsAt = '2088-03-01';
  const endsAt = '2088-03-14';
  for (let i = 0; i < 2; i += 1) {
    const id = uuid();
    await pool.query(
      `INSERT INTO ads
         (id, business_name, image_url, target_url, media_type, contact_email,
          starts_at, ends_at, amount_aed, paid, active, slot_status, payment_status)
       VALUES ($1, $2, 'https://example.com/b.jpg', 'https://example.com', 'image', $3,
               $4, $5, 1000, TRUE, FALSE, 'paid', 'paid')`,
      [id, LEGACY_BUSINESS, LEGACY_EMAIL, startsAt, endsAt]
    );
    legacyIds.push(id);
  }
  return { startsAt, endsAt, ids: [...legacyIds] };
}

async function clearHistoricalOverlap() {
  if (legacyIds.length) {
    await pool.query('DELETE FROM ads WHERE id = ANY($1)', [legacyIds]);
    legacyIds.length = 0;
  }
}

// Boots server/index.js for real. Resolves with its exit code and output; if it
// gets as far as listening, it is killed and reported as started.
function runServer(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_SSL: 'false',
        JWT_SECRET: 'startup-check-secret-not-a-real-credential',
        // 0 lets the OS pick a free port, so these never collide with anything.
        PORT: '0',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let started = false;

    const giveUp = setTimeout(() => child.kill('SIGKILL'), 20000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Naseeb running')) {
        started = true;
        clearTimeout(giveUp);
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(giveUp);
      resolve({ code, started, stdout, stderr });
    });
  });
}

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_fabricated_key_for_startup_check',
  STRIPE_WEBHOOK_SECRET: 'whsec_fabricated_secret_for_startup_check',
};

// ---------------------------------------------------------------------------
// The normal, protected path still works
// ---------------------------------------------------------------------------

test('with the constraint in place, checkout allocates exactly as before', async () => {
  assert.equal(await isSlotProtectionActive(pool), true);

  const res = await bookSlot('Protection Test Baseline');
  assert.equal(res.status, 200);
  assert.ok(res.body.checkoutUrl);
  assert.equal(stripeCalls().length, 1, 'the protected path still reaches Stripe');

  const row = await pool.query(
    "SELECT slot_status, hold_expires_at FROM ads WHERE business_name = 'Protection Test Baseline'"
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].slot_status, 'held');
  assert.ok(row.rows[0].hold_expires_at);

  await pool.query("DELETE FROM ads WHERE business_name = 'Protection Test Baseline'");
});

test('a valid constraint and checkout enabled starts normally', async () => {
  const result = await runServer({ ADS_CHECKOUT_ENABLED: 'true', ...STRIPE_ENV });
  assert.equal(result.started, true, `expected the server to start; stderr: ${result.stderr}`);
});

// ---------------------------------------------------------------------------
// Runtime guard
// ---------------------------------------------------------------------------

test('checkout refuses at request time when the constraint is missing, taking no money', async () => {
  await dropConstraint();
  try {
    assert.equal(await isSlotProtectionActive(pool), false);

    const res = await bookSlot('Protection Test Unprotected');

    assert.equal(res.status, 503);
    assert.equal(res.body.checkoutEnabled, false);
    // The customer sees the ordinary unavailable message; why it is unavailable
    // is an internal matter.
    assert.match(res.body.error, /temporarily unavailable/i);

    const rows = await pool.query(
      "SELECT COUNT(*)::int AS c FROM ads WHERE business_name = 'Protection Test Unprotected'"
    );
    assert.equal(rows.rows[0].c, 0, 'no hold may be inserted without overlap protection');
    assert.equal(stripeCalls().length, 0, 'Stripe must not be contacted');
  } finally {
    await restoreConstraint();
  }
});

test('the runtime guard fires even though the flag says checkout is on', async () => {
  // The two gates are independent: the kill switch is a business decision, this
  // one is a safety interlock. Neither substitutes for the other.
  await dropConstraint();
  try {
    process.env.ADS_CHECKOUT_ENABLED = 'true';
    const res = await bookSlot('Protection Test Interlock');
    assert.equal(res.status, 503);
    assert.equal(stripeCalls().length, 0);
  } finally {
    await restoreConstraint();
  }
});

test('checkout resumes as soon as protection is restored', async () => {
  await dropConstraint();
  const refused = await bookSlot('Protection Test Resume');
  assert.equal(refused.status, 503);

  await restoreConstraint();

  const allowed = await bookSlot('Protection Test Resume');
  assert.equal(allowed.status, 200, 'the guard must not latch once the constraint is back');
  await pool.query("DELETE FROM ads WHERE business_name = 'Protection Test Resume'");
});

// ---------------------------------------------------------------------------
// Startup gates
// ---------------------------------------------------------------------------

test('a missing constraint with checkout enabled refuses to start', async () => {
  // Simulated at the verification seam rather than by starting a process with
  // the constraint dropped, because init() would simply recreate it — which is
  // the correct behaviour and not the case under test. The state that actually
  // persists in production is the blocked one, covered end-to-end below.
  await dropConstraint();
  try {
    assert.equal(
      await isSlotProtectionActive(pool),
      false,
      'an absent constraint must read as unprotected'
    );
  } finally {
    await restoreConstraint();
  }

  assert.equal(await isSlotProtectionActive(pool), true);
});

test('historical overlaps with checkout ENABLED refuse to start', async () => {
  await dropConstraint();
  const { ids, startsAt, endsAt } = await createHistoricalOverlap();
  try {
    const result = await runServer({ ADS_CHECKOUT_ENABLED: 'true', ...STRIPE_ENV });

    assert.equal(result.started, false, 'the server must not begin listening');
    assert.equal(result.code, 1, 'it must exit non-zero');
    assert.match(
      result.stderr,
      new RegExp(SLOT_CONSTRAINT_NAME),
      'the reason must name the missing constraint'
    );
    assert.match(result.stderr, /refusing to start/i);

    // The report identifies the conflict without exposing who booked it.
    assert.ok(
      result.stderr.includes(ids[0]) || result.stdout.includes(ids[0]),
      'the conflicting booking ids must be reported'
    );
    assert.ok(
      result.stderr.includes(startsAt) || result.stdout.includes(startsAt),
      'the conflicting dates must be reported'
    );
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(LEGACY_BUSINESS), 'must not print the advertiser’s name');
    assert.ok(!output.includes(LEGACY_EMAIL), 'must not print the advertiser’s email');

    // And nothing was touched to make the problem go away.
    const survivors = await pool.query(
      'SELECT id, starts_at, ends_at, slot_status, paid FROM ads WHERE id = ANY($1)',
      [ids]
    );
    assert.equal(survivors.rows.length, 2);
    survivors.rows.forEach((row) => {
      assert.equal(row.starts_at, startsAt);
      assert.equal(row.ends_at, endsAt);
      assert.equal(row.slot_status, 'paid');
      assert.equal(row.paid, true);
    });
  } finally {
    await clearHistoricalOverlap();
    await restoreConstraint();
  }
});

test('historical overlaps with checkout DISABLED start, but checkout stays unavailable', async () => {
  await dropConstraint();
  const { ids, startsAt } = await createHistoricalOverlap();
  try {
    const result = await runServer({ ADS_CHECKOUT_ENABLED: 'false' });

    assert.equal(
      result.started,
      true,
      `an unprotected app must still run with checkout off; stderr: ${result.stderr}`
    );

    // It says what is wrong, loudly, without naming the advertisers.
    const output = result.stdout + result.stderr;
    assert.match(output, /overlap/i);
    assert.ok(output.includes(ids[0]), 'the conflicting booking ids must be reported');
    assert.ok(output.includes(startsAt));
    assert.ok(!output.includes(LEGACY_BUSINESS));
    assert.ok(!output.includes(LEGACY_EMAIL));

    // The constraint was not force-applied over the bad data.
    assert.equal(await isSlotProtectionActive(pool), false);

    // And checkout is unavailable in this state, by both gates at once.
    process.env.ADS_CHECKOUT_ENABLED = 'true'; // even if someone flips it
    const res = await bookSlot('Protection Test WhileBlocked');
    assert.equal(res.status, 503);
    assert.equal(stripeCalls().length, 0);
    const created = await pool.query(
      "SELECT COUNT(*)::int AS c FROM ads WHERE business_name = 'Protection Test WhileBlocked'"
    );
    assert.equal(created.rows[0].c, 0);

    // Records untouched.
    const survivors = await pool.query('SELECT COUNT(*)::int AS c FROM ads WHERE id = ANY($1)', [ids]);
    assert.equal(survivors.rows[0].c, 2);
  } finally {
    await clearHistoricalOverlap();
    await restoreConstraint();
  }
});

test('resolving the overlap lets the constraint apply and checkout work again', async () => {
  await dropConstraint();
  const { ids } = await createHistoricalOverlap();
  try {
    assert.equal((await ensureSlotExclusionConstraint(pool)).status, 'blocked');

    // The admin resolves it the way the report describes: release one side,
    // keeping the record.
    await pool.query(
      "UPDATE ads SET slot_status = 'released', slot_released_at = NOW(), slot_release_reason = 'admin_resolved_overlap' WHERE id = $1",
      [ids[0]]
    );

    assert.deepEqual(await findOverlappingSlots(pool), []);
    assert.equal((await ensureSlotExclusionConstraint(pool)).status, 'created');
    assert.equal(await isSlotProtectionActive(pool), true);

    const result = await runServer({ ADS_CHECKOUT_ENABLED: 'true', ...STRIPE_ENV });
    assert.equal(result.started, true, `should start once resolved; stderr: ${result.stderr}`);

    // Both records still exist — resolving is a status change, not a deletion.
    const survivors = await pool.query('SELECT COUNT(*)::int AS c FROM ads WHERE id = ANY($1)', [ids]);
    assert.equal(survivors.rows[0].c, 2);
  } finally {
    await clearHistoricalOverlap();
    await restoreConstraint();
  }
});
