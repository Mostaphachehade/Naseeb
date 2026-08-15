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
const { init } = require('./db');
const { isAdsCheckoutEnabled } = require('./lib/featureFlags');

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

assertPaymentConfiguration();

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Naseeb running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to the database:', err.message);
    process.exit(1);
  });
