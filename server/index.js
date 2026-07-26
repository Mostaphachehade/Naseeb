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
