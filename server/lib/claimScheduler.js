// Scheduled maintenance for prize claims.
//
// Three things have to happen on their own, without anyone visiting a page:
// lapsed claim windows must expire into the admin queue, delivery details must
// be erased once retention is up, and undelivered claim invitations must be
// retried. Doing any of that opportunistically — when an admin happens to open
// a screen — means a site with no admin activity never erases anything, which
// is not a retention policy, it is a hope.
//
// This runs in-process on an interval rather than as an HTTP endpoint, which
// makes it unreachable from outside: there is no route to call, so there is
// nothing to authenticate or rate-limit. The admin endpoint still exists for
// running it on demand, but the automatic path does not depend on it.
//
// Every instance runs the same timer. A Postgres advisory lock means only one
// of them does the work in any given tick, so this is safe on a platform that
// may run more than one instance, and safe against a scheduled run overlapping
// a manual one.
const { pool } = require('../db');
const { expireLapsedClaims, eraseExpiredDeliveryDetails } = require('./claims');
const { processDueNotifications } = require('./claimNotifications');
const emailChangeOutbox = require('./emailChangeOutbox');

// Distinct from the ad-slot lock; the two must never contend.
const CLAIM_MAINTENANCE_LOCK_KEY = 738201947383;

const DEFAULT_INTERVAL_MINUTES = 15;

// Repeated failure is the interesting signal: one failed tick is a blip, five
// in a row means retention has silently stopped running.
const FAILURE_ALERT_THRESHOLD = 3;

let timer = null;
let consecutiveFailures = 0;

function intervalMinutes() {
  const configured = Number(process.env.CLAIM_MAINTENANCE_INTERVAL_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MINUTES;
}

// One pass. Exported so tests and the admin endpoint drive exactly the same
// code the timer does, rather than a parallel implementation that can drift.
async function runMaintenanceOnce({ skipNotifications = false } = {}) {
  const client = await pool.connect();
  let acquired = false;
  const summary = { skipped: false, expired: 0, erased: 0, notifications: null, emailChanges: null };

  try {
    // Non-blocking: if another instance is already doing this tick, that is a
    // success, not something to queue up behind.
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
      CLAIM_MAINTENANCE_LOCK_KEY,
    ]);
    acquired = lock.rows[0].acquired;
    if (!acquired) {
      summary.skipped = true;
      return summary;
    }

    await client.query('BEGIN');
    summary.expired = await expireLapsedClaims(client);
    summary.erased = await eraseExpiredDeliveryDetails(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (acquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [CLAIM_MAINTENANCE_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }

  // Deliberately outside the lock-held transaction above: sending email is slow
  // and must not hold a database transaction open while a provider times out.
  // processDueNotifications takes its rows with SKIP LOCKED, so it is safe to
  // run concurrently with itself.
  if (!skipNotifications) {
    summary.notifications = await processDueNotifications({});
    // The email-change outbox, on the same terms and for the same reason. Its
    // rows are claimed with SKIP LOCKED and a lease, so this is safe to run
    // alongside another instance's tick or an administrator's manual drain.
    summary.emailChanges = await emailChangeOutbox.processDue({});
  }

  return summary;
}

async function tick() {
  try {
    const summary = await runMaintenanceOnce({});
    consecutiveFailures = 0;
    if (!summary.skipped && (summary.expired > 0 || summary.erased > 0)) {
      console.log(
        `Claim maintenance: expired ${summary.expired}, erased delivery details for ${summary.erased}.`
      );
    }
  } catch (err) {
    consecutiveFailures += 1;
    // console.error is mirrored into Sentry by captureConsoleIntegration, so
    // this is the alert. Identifiers and counts only.
    console.error(
      `Claim maintenance failed (${consecutiveFailures} consecutive): ${err.message}`
    );
    if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      console.error(
        `ALERT: claim maintenance has failed ${consecutiveFailures} times in a row. Delivery-detail ` +
          'retention and claim expiry are not running. This needs attention.'
      );
    }
  }
}

function start() {
  if (timer) return timer;
  const minutes = intervalMinutes();

  // unref() so the timer never keeps the process alive on its own — a shutdown
  // should not wait up to fifteen minutes for a tick that has nothing to do.
  timer = setInterval(tick, minutes * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  // A first pass shortly after boot, so a restart also catches up on anything
  // that fell due while the process was down.
  const initial = setTimeout(tick, 30 * 1000);
  if (typeof initial.unref === 'function') initial.unref();

  console.log(`Claim maintenance scheduled every ${minutes} minutes.`);
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  CLAIM_MAINTENANCE_LOCK_KEY,
  DEFAULT_INTERVAL_MINUTES,
  FAILURE_ALERT_THRESHOLD,
  intervalMinutes,
  runMaintenanceOnce,
  start,
  stop,
};
