require('dotenv').config();
const Sentry = require('@sentry/node');

// Error reporting is configured in one place, with a scrubber in front of it —
// see server/lib/errorReporting.js for what it strips and why.
//
// This used to be `captureConsoleIntegration({ levels: ['error'] })`, which
// mirrored every console.error in the codebase to Sentry. It was convenient and
// it made the privacy of an off-platform transmission depend on nobody ever
// interpolating an address or a token into a log line. That integration is gone;
// what reaches Sentry now is a deliberate capture that has been through
// `beforeSend`. Must run before ./app is required.
const errorReporting = require('./lib/errorReporting');
errorReporting.init(Sentry);

const app = require('./app');
const {
  pool, init, BASELINE_SQL, ensureSlotExclusionConstraint,
  isSlotProtectionActive, SLOT_CONSTRAINT_NAME,
} = require('./db');
const { isAdsCheckoutEnabled, areClaimsEnabled } = require('./lib/featureFlags');
const claimScheduler = require('./lib/claimScheduler');
const emailChangeOutbox = require('./lib/emailChangeOutbox');
const migrations = require('./lib/migrations');
const config = require('./lib/config');
const { createShutdownCoordinator } = require('./lib/shutdown');

// A rejected promise nobody awaited terminates the process on modern Node.
// Most of this codebase awaits everything, but a background send or a
// scheduler tick that slips through should be logged and survived rather than
// taking the site down.
//
// Reported deliberately, because this is exactly the class of failure nobody
// sees otherwise. The reason goes through the scrubber like everything else.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
  errorReporting.reportError(
    reason instanceof Error ? reason : new Error(String(reason)),
    { source: 'unhandledRejection' }
  );
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
//
// One validator, in server/lib/config.js. This used to be five functions here,
// each with its own idea of what production meant and its own decision about
// whether to warn or refuse — and three variables that were checked nowhere.
//
// It refuses to continue in production and warns elsewhere, so a developer can
// still run the site without a Stripe account. Only variable NAMES are ever
// printed.
config.assertStartupConfiguration();

// The one check that needs the database, so it cannot live in the validator:
// selling the ad slot without the exclusion constraint means the only thing
// between two advertisers and the same dates is application code being right
// every time. With checkout off, nothing can book a slot, so nothing can
// double-book one — which is what makes it possible to deploy, read the overlap
// report and fix the data.
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

// The coordinator is built before anything starts, so a SIGTERM arriving during
// startup is handled by the same path as one arriving at 3am under load.
const shutdown = createShutdownCoordinator({
  pool,
  scheduler: claimScheduler,
  outbox: emailChangeOutbox,
  setReady: app.health.setReady,
}).install();

// Applies the schema and records what was applied.
//
// `migrate` runs the baseline (which is db.init()) under an advisory lock, and
// records it as ADOPTED rather than executed on a database that predates the
// ledger — see server/lib/migrations.js for why that distinction is not
// cosmetic.
async function start() {
  const summary = await migrations.migrate(pool, { init, baselineSql: BASELINE_SQL });

  // Every boot, not only when the baseline runs.
  //
  // This lived inside init(), which ran on every start. Once the migration
  // ledger arrived, init() stopped running on a database that already had the
  // schema — and this went with it, silently. It is a VERIFICATION step, not a
  // migration: it inspects existing bookings, reports any overlapping pair, and
  // adds the constraint when it can. Skipping it on an adopted database would
  // mean the overlap report only ever appeared on a fresh one, which is the
  // database that cannot have overlaps.
  await ensureSlotExclusionConstraint(pool);

  await assertSlotProtection();

  // Retention, claim expiry and both outboxes also run on their own from here.
  //
  // This is now a SAFETY NET rather than the schedule. The real schedule is
  // `scripts/maintenance.js`, run by the platform — because an in-process timer
  // stops when the process sleeps, and on a free plan the web service sleeps.
  // See docs/OPERATIONS.md.
  if (areClaimsEnabled() && shutdown.mayStartWork()) {
    claimScheduler.start();
  }

  const state = config.deploymentState();
  const server = app.listen(PORT, () => {
    console.log(
      `Naseeb running at http://localhost:${PORT} (schema ${summary.version}, deployment ${state}).`
    );
    const disclosure = config.stateDisclosure();
    if (disclosure) console.log(disclosure.disclosure);
  });

  // Handed to the coordinator only once it exists. Until this point a shutdown
  // has nothing to close, which is correct — there is no server yet.
  shutdown.attachServer(server);
  return server;
}

start().catch((err) => {
  // Message only. A migration or connection error can carry a connection string
  // in its stack, and this line goes to a platform log.
  console.error('Failed to start:', err.message);
  errorReporting.reportError(err, { source: 'startup' });
  process.exit(1);
});
