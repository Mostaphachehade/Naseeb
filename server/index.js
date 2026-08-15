require('dotenv').config();
const Sentry = require('@sentry/node');

// Every route in this app already catches its own errors and logs them via
// console.error rather than calling next(err), so Sentry's automatic Express
// error handler alone wouldn't see any of them. captureConsoleIntegration
// mirrors every console.error call into Sentry too, without having to touch
// every route file's catch block individually. Must run before ./app is
// required, since that's what wires up the routes that use console.error.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  });
}

const app = require('./app');
const { init, isSlotProtectionActive, SLOT_CONSTRAINT_NAME } = require('./db');
const { isAdsCheckoutEnabled, areClaimsEnabled } = require('./lib/featureFlags');
const { isConfigured: isClaimEncryptionConfigured } = require('./lib/claimCrypto');

// Taking card payments without a verified webhook is the failure this whole
// phase exists to prevent: checkout would work, customers would be charged, and
// nothing would ever mark their bookings paid. Refusing to boot is the only
// honest response — a warning would scroll past and the site would look fine
// while quietly losing every payment.
//
// Only variable *names* appear here. Their values are never logged.
function assertPaymentConfiguration() {
  if (!isAdsCheckoutEnabled()) return;

  const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter(
    (name) => !process.env[name]
  );
  if (missing.length === 0) return;

  console.error(
    `ADS_CHECKOUT_ENABLED is on, but ${missing.join(' and ')} ${
      missing.length > 1 ? 'are' : 'is'
    } not set. Refusing to start: customers could be charged for bookings that ` +
      'nothing would ever mark as paid. Set the missing variable(s), or set ' +
      'ADS_CHECKOUT_ENABLED=false to run without self-serve ad checkout.'
  );
  process.exit(1);
}

// Claims hold the most sensitive data on the platform — a winner's home
// address and phone number. Without a key there is nowhere safe to put them, so
// in production that is a refusal to start rather than a surprise 503 the first
// time somebody wins something. Elsewhere it is a warning: local development
// and CI can exercise everything except the encrypted path.
//
// Only variable names appear here, never key material.
function assertClaimConfiguration() {
  if (!areClaimsEnabled()) return;
  if (isClaimEncryptionConfigured()) return;

  const message =
    'Prize claims are enabled but CLAIM_ENCRYPTION_KEY is missing or invalid. Winner delivery ' +
    'details are encrypted with it, so claims cannot be completed without one. Generate a key ' +
    "with:  node -e \"console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))\"  " +
    'and set CLAIM_ENCRYPTION_KEY, or set CLAIMS_ENABLED=false to run without prize claims.';

  if (process.env.NODE_ENV === 'production') {
    console.error(`${message} Refusing to start.`);
    process.exit(1);
  }
  console.error(`WARNING: ${message}`);
}

assertPaymentConfiguration();
assertClaimConfiguration();

// Runs after init(), which is what creates the constraint when it can. If it
// still isn't there afterwards, the migration declined to add it — almost
// always because bookings already overlap, which it reports and refuses to
// resolve on its own.
//
// Selling the slot without this constraint means the only thing standing
// between two advertisers and the same dates is application code being right
// every time. That is exactly the assumption that produced the bug, so with
// checkout on it is not a warning, it is a refusal to start.
//
// With checkout off the site runs perfectly well unprotected: nothing can book
// a slot, so nothing can double-book one. That is what makes it possible to
// deploy, read the overlap report, and fix the data.
async function assertSlotProtection() {
  if (!isAdsCheckoutEnabled()) return;

  if (await isSlotProtectionActive()) return;

  console.error(
    `ADS_CHECKOUT_ENABLED is on, but the ${SLOT_CONSTRAINT_NAME} exclusion constraint is not ` +
      'active — it is missing, was blocked by existing overlapping bookings, or could not be ' +
      'verified. Refusing to start: without it, two advertisers can be sold the same dates. ' +
      'Resolve any overlapping bookings reported above and restart to apply the constraint, or ' +
      'set ADS_CHECKOUT_ENABLED=false to run without self-serve ad checkout.'
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

init()
  .then(async () => {
    await assertSlotProtection();
    app.listen(PORT, () => {
      console.log(`Naseeb running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
