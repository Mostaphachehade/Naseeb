// Coverage for the guard that keeps the test suite off the production
// database (audit finding #9). Before this, testHelpers.js loaded .env and
// inherited whatever DATABASE_URL was in it — on a developer machine, the live
// Neon connection string. `npm test` would then create, update and DELETE rows
// in production.
//
// These are pure unit tests: they exercise the guard's decision logic and open
// no connection of their own.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assertTestDatabase, configureTestEnv } = require('../testEnv');

function rejects(url, why) {
  assert.throws(
    () => assertTestDatabase(url),
    (err) => err.name === 'TestDatabaseGuardError',
    why
  );
}

test('accepts a local database named like a test database', () => {
  for (const url of [
    'postgresql://postgres@localhost:5432/naseeb_test',
    'postgresql://postgres@127.0.0.1:55432/naseeb_test',
    'postgresql://naseeb:naseeb@localhost:5432/test',
    'postgresql://postgres@localhost:5432/naseeb-test-2',
    'postgresql://postgres@localhost:5432/test_naseeb',
  ]) {
    assert.doesNotThrow(() => assertTestDatabase(url), `should accept ${url}`);
  }
});

test('refuses to run with no database configured', () => {
  rejects(undefined, 'undefined must be rejected');
  rejects('', 'empty string must be rejected');
});

test('refuses a database whose name is not test-like', () => {
  // The shape of a real hosted production URL, minus any real credentials.
  rejects('postgresql://owner:pw@localhost:5432/neondb');
  rejects('postgresql://owner:pw@localhost:5432/naseeb');
  rejects('postgresql://owner:pw@localhost:5432/production');
});

test('refuses a name that merely contains the letters "test"', () => {
  // "latest" and "greatest" end in test; matching them would defeat the guard.
  rejects('postgresql://owner:pw@localhost:5432/latest');
  rejects('postgresql://owner:pw@localhost:5432/greatest_db');
});

test('refuses a remote host even when the database is named test', () => {
  rejects('postgresql://owner:pw@ep-cool-name.eu-central-1.aws.neon.tech/naseeb_test');
  rejects('postgresql://owner:pw@db.example.supabase.co:5432/test');
});

test('allows a remote test database only with an explicit opt-in', () => {
  const url = 'postgresql://owner:pw@ep-cool-name.eu-central-1.aws.neon.tech/naseeb_test';
  rejects(url);

  process.env.ALLOW_REMOTE_TEST_DB = 'yes';
  try {
    assert.doesNotThrow(() => assertTestDatabase(url));
  } finally {
    delete process.env.ALLOW_REMOTE_TEST_DB;
  }
});

test('refuses a URL with no database name at all', () => {
  rejects('postgresql://postgres@localhost:5432/');
  rejects('postgresql://postgres@localhost:5432');
});

test('refuses something that is not a connection URL', () => {
  rejects('not-a-url');
  rejects('/var/lib/postgresql/data');
});

// The guard's whole job is to be noisy about a misconfigured target, and the
// obvious way to write that message is to print the URL — which would paste a
// live database password into CI logs and terminal scrollback.
test('never echoes credentials in its error message', () => {
  const secret = 'sup3rs3cr3t-password-value';
  try {
    assertTestDatabase(`postgresql://owner:${secret}@db.example.com:5432/production`);
    assert.fail('expected the guard to throw');
  } catch (err) {
    assert.equal(err.name, 'TestDatabaseGuardError');
    assert.ok(!err.message.includes(secret), 'error message must not contain the password');
    assert.ok(!err.message.includes('owner:'), 'error message must not contain the userinfo');
    assert.ok(err.message.includes('db.example.com'), 'host is safe to show, and is the useful part');
  }
});

test('configureTestEnv strips third-party credentials before any test runs', () => {
  process.env.RESEND_API_KEY = 're_not_a_real_key';
  process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
  process.env.RENDER_API_KEY = 'rnd_not_a_real_key';
  // A live-mode Stripe key must never survive into a test run — that is the
  // difference between a failing assertion and a real charge.
  process.env.STRIPE_SECRET_KEY = 'sk_live_not_a_real_key';

  configureTestEnv();

  assert.equal(process.env.RESEND_API_KEY, undefined);
  assert.equal(process.env.SENTRY_DSN, undefined);
  assert.equal(process.env.RENDER_API_KEY, undefined);
  assert.equal(process.env.STRIPE_SECRET_KEY, undefined);
  assert.equal(process.env.NODE_ENV, 'test');
});

test('configureTestEnv keeps an explicitly test-mode Stripe key', () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_for_this_assertion';
  configureTestEnv();
  assert.equal(process.env.STRIPE_SECRET_KEY, 'sk_test_placeholder_for_this_assertion');
  delete process.env.STRIPE_SECRET_KEY;
});

test('configureTestEnv never signs tokens with the real JWT_SECRET', () => {
  process.env.JWT_SECRET = 'a-secret-that-looks-like-the-production-one';
  configureTestEnv();
  assert.notEqual(process.env.JWT_SECRET, 'a-secret-that-looks-like-the-production-one');
  assert.match(process.env.JWT_SECRET, /test-only/);
});
