// Test environment setup and safety guard.
//
// Every test entry point must call configureTestEnv() *before* anything
// requires server/db.js, because that module builds its connection Pool at
// require time from process.env.DATABASE_URL. Two things happen here, in order:
//
//   1. .env is deliberately NOT loaded. It holds the live Neon connection
//      string, and `npm test` inheriting it is exactly how a test run ends up
//      reading, writing, or truncating production data. Test configuration
//      comes from .env.test (gitignored, local-only) or from real environment
//      variables, which is how CI supplies it.
//
//   2. The resolved database is checked before a single connection is opened.
//      A database name that doesn't look like a test database, or a remote
//      host without an explicit opt-in, aborts the run with instructions
//      rather than connecting and finding out afterwards.
//
// Credentials are never echoed: every message describes a target as
// host:port/database, with the userinfo half of the URL dropped entirely.

const fs = require('fs');
const path = require('path');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

// Matches naseeb_test, test_naseeb, naseeb-test-3, plain "test" — but not
// "latest", "greatest", or a production database that merely contains those
// letters somewhere in the middle of a word.
const TEST_DB_NAME = /(^|[-_])test([-_0-9]|$)/i;

const REMOTE_OPT_IN = 'ALLOW_REMOTE_TEST_DB';

function describeTarget(parsed) {
  const port = parsed.port || '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return `${parsed.hostname}:${port}/${database}`;
}

function fail(lines) {
  const err = new Error(['', 'Refusing to run tests.', '', ...lines, ''].join('\n'));
  err.name = 'TestDatabaseGuardError';
  throw err;
}

// Exported so scripts can validate a target without mutating process.env.
function assertTestDatabase(rawUrl) {
  if (!rawUrl) {
    fail([
      'No test database is configured.',
      '',
      'Set TEST_DATABASE_URL (preferred) or DATABASE_URL to an isolated',
      'database whose name contains "test". Start a throwaway local one with:',
      '',
      '    npm run test:db:start',
      '',
      'Tests never read .env — see testEnv.js for why.',
    ]);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail(['TEST_DATABASE_URL is not a valid connection URL.']);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const target = describeTarget(parsed);

  if (!database) {
    fail([`No database name in the connection URL (${target}).`]);
  }

  if (!TEST_DB_NAME.test(database)) {
    fail([
      `The configured database "${database}" is not named like a test database.`,
      `Target: ${target}`,
      '',
      'This guard exists because the production Neon database was previously',
      'reachable from `npm test`. Point the suite at a database whose name',
      'contains "test" (e.g. naseeb_test) and run again.',
    ]);
  }

  if (!LOCAL_HOSTS.has(parsed.hostname) && process.env[REMOTE_OPT_IN] !== 'yes') {
    fail([
      `The configured database is on a remote host (${target}).`,
      '',
      'Tests default to local-only so a stray environment variable cannot send',
      'them at hosted infrastructure. If this really is a disposable remote',
      `test database, re-run with ${REMOTE_OPT_IN}=yes.`,
    ]);
  }

  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database,
    isLocal: LOCAL_HOSTS.has(parsed.hostname),
    describe: target,
  };
}

function configureTestEnv() {
  const envTestPath = path.join(__dirname, '.env.test');
  if (fs.existsSync(envTestPath)) {
    require('dotenv').config({ path: envTestPath });
  }

  process.env.NODE_ENV = 'test';

  const target = assertTestDatabase(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

  // Everything downstream (server/db.js, the reset script) reads DATABASE_URL,
  // so collapse the two variables here once the guard has approved the target.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

  if (process.env.DATABASE_SSL === undefined && target.isLocal) {
    process.env.DATABASE_SSL = 'false';
  }

  // Fixed, obviously-fake secrets. Tests assert on auth behaviour, not on
  // secret strength, and hard-coding them means the suite can never fall back
  // to a real one and mint credentials that would be valid in production.
  //
  // SESSION_SECRET signs CSRF tokens. Note this value would be REFUSED by
  // assertSessionSecret in production — it matches the "test-only" placeholder
  // pattern on purpose, so a suite value can never be mistaken for a real one.
  process.env.SESSION_SECRET =
    'test-only-session-secret-not-valid-outside-the-test-suite-0123456789';
  // JWT_SECRET is gone along with the jsonwebtoken dependency. Deleted rather
  // than set, so anything that starts reading it again fails loudly.
  delete process.env.JWT_SECRET;
  process.env.APP_URL = process.env.APP_URL || 'http://localhost:3000';

  // The suite IS the proxy.
  //
  // Requests arrive over a loopback socket, and each one carries an
  // X-Forwarded-For the test wrote — which is precisely what one trusted hop
  // means: the rightmost entry was added by something we control. Setting this
  // explicitly rather than inheriting a default keeps the assumption visible,
  // and keeps the limiters doing real per-identity work instead of sharing one
  // bucket across the whole suite. See server/lib/proxyTrust.js.
  process.env.TRUSTED_PROXY_HOPS = process.env.TRUSTED_PROXY_HOPS || '1';

  // Keys the network hashes in the integrity tables. Ephemeral and per-run, so
  // nothing links across runs and no default can be shipped. Would be REFUSED
  // in production by riskSignals.assertSignalSecret — it matches the test-only
  // placeholder pattern deliberately.
  process.env.INTEGRITY_SIGNAL_SECRET =
    'test-only-integrity-signal-secret-not-valid-outside-the-test-suite-0123456789';
  // Tests speak plain http to an in-process server; a Secure cookie would never
  // be sent back. Production cannot make this choice — see
  // sessions.assertCookieSecurity, which refuses to start on it.
  process.env.COOKIE_SECURE = process.env.COOKIE_SECURE || 'false';

  // Third-party credentials are stripped rather than trusted. Without these,
  // the app's own fallbacks take over: emails log to the console, Sentry stays
  // uninitialised. A live (sk_live_) Stripe key is dropped outright; only an
  // explicitly test-mode key survives, so no test run can move real money.
  delete process.env.RESEND_API_KEY;
  delete process.env.SENTRY_DSN;
  delete process.env.RENDER_API_KEY;
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    delete process.env.STRIPE_SECRET_KEY;
  }

  return target;
}

module.exports = { configureTestEnv, assertTestDatabase };
