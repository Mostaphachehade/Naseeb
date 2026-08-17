// Every time-based cleanup this platform needs, as jobs something outside the
// web process can run.
//
// ---------------------------------------------------------------------------
// What the audit found
// ---------------------------------------------------------------------------
//
// Six maintenance functions existed. How they ran:
//
//   expireLapsedClaims          in-process timer
//   eraseExpiredDeliveryDetails in-process timer      ← retention
//   claim notification outbox   in-process timer
//   email-change outbox         in-process timer
//   expireStaleHolds            ONLY when a request happened to hit /api/ads
//   purgeExpiredSignals         ONLY when an admin clicked a button
//   deleteExpiredSessions       NOTHING CALLED IT
//   expireStaleEmailChanges     NOTHING CALLED IT
//
// Two had no caller at all. Two ran only if somebody visited the right page —
// which means a quiet week is a week with no retention, and on a free plan
// where the web service sleeps, an in-process timer is a timer that stops. A
// retention policy that depends on traffic is not a retention policy.
//
// So every job below is runnable from a command line, on a schedule owned by
// the platform rather than by whether anyone is browsing.
//
// ---------------------------------------------------------------------------
// What every job guarantees
// ---------------------------------------------------------------------------
//
//   * **One worker.** A Postgres advisory lock per job. A second run finds the
//     lock held and reports `skipped`, which is a success — not a wait, not a
//     duplicate.
//   * **Bounded.** Each pass touches at most `limit` rows. A job that tries to
//     delete a million rows in one statement is a job that holds locks for
//     minutes and times out having achieved nothing.
//   * **Idempotent.** Re-running changes nothing that was already done.
//   * **Structured, sanitised output.** Counts and durations. No address, no
//     token, no subject, no row content, no connection string.
//   * **"Nothing to do" is not failure.** `{ processed: 0 }` and exit 0.
//   * **SIGTERM stops cleanly** between batches, not mid-transaction.
const { pool } = require('../db');
const sessions = require('./sessions');
const riskSignals = require('./riskSignals');
const claims = require('./claims');
const adSlots = require('./adSlots');
const rights = require('./accountRights');
const claimNotifications = require('./claimNotifications');
const emailChangeOutbox = require('./emailChangeOutbox');

// One key per job. Distinct from the migration lock (918273645), the claim
// scheduler lock (738201947383) and the ad-slot allocation lock.
const LOCK_KEYS = {
  sessions: 811001,
  risk_signals: 811002,
  claims: 811003,
  claim_outbox: 811004,
  email_change_outbox: 811005,
  email_changes: 811006,
  ad_holds: 811007,
};

const DEFAULT_LIMIT = 500;

function batchLimit(override) {
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const configured = Number(process.env.MAINTENANCE_BATCH_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_LIMIT;
}

// ---------------------------------------------------------------------------
// Stop signal
// ---------------------------------------------------------------------------

// A job checks this between batches. Set by the CLI on SIGTERM, so a container
// being replaced finishes the batch it is in and stops rather than being killed
// mid-transaction.
let stopping = false;
function requestStop() {
  stopping = true;
}
function stopRequested() {
  return stopping;
}
function resetStop() {
  stopping = false;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

// Wraps a job body in the lock, the timing and the result shape, so no job has
// to remember any of it.
//
// `pg_try_advisory_lock` rather than the blocking form: a second worker should
// report that another is already doing this and exit, not queue up behind it
// and run the same work a minute later.
async function withJobLock(name, fn) {
  const key = LOCK_KEYS[name];
  if (!key) throw new Error(`Unknown maintenance job: ${name}`);

  const client = await pool.connect();
  const started = Date.now();
  let acquired = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [key]);
    acquired = lock.rows[0].acquired;
    if (!acquired) {
      return { job: name, status: 'skipped', reason: 'another worker holds the lock', ms: Date.now() - started };
    }
    const counts = await fn(client);
    return { job: name, status: 'ok', ...counts, ms: Date.now() - started };
  } finally {
    if (acquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    }
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The jobs
// ---------------------------------------------------------------------------

const JOBS = {
  // Expired session rows and families. Nothing called this before; expired
  // sessions were already refused by authenticate(), so this is hygiene rather
  // than a control — but it is hygiene that was never running.
  sessions: (options = {}) =>
    withJobLock('sessions', async (client) => {
      const removed = await sessions.deleteExpiredSessions(client, {
        olderThanDays: options.olderThanDays,
      });
      return { removed: Number(removed) || 0 };
    }),

  // Risk signals past their retention window. The HMAC key is salted with the
  // window, so an unpurged signal is already unmatchable — but it is still a
  // pseudonymous record of somebody's network, and it was only ever deleted
  // when an administrator happened to press a button.
  risk_signals: () =>
    withJobLock('risk_signals', async (client) => {
      const purged = await riskSignals.purgeExpiredSignals(client);
      return { purged: Number(purged) || 0 };
    }),

  // Claim windows that lapsed, and delivery addresses past their retention.
  // The erasure half is the one that matters: it is the only thing that removes
  // a winner's home address from this system.
  claims: () =>
    withJobLock('claims', async (client) => {
      await client.query('BEGIN');
      try {
        const expired = await claims.expireLapsedClaims(client);
        const erased = await claims.eraseExpiredDeliveryDetails(client);
        await client.query('COMMIT');
        return { expired: Number(expired) || 0, erased: Number(erased) || 0 };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }),

  // Undelivered claim invitations. A winner who never got the email cannot
  // claim, and the claim then expires into an admin queue for a reason nobody
  // recorded.
  claim_outbox: (options = {}) =>
    withJobLock('claim_outbox', async () => {
      const summary = await claimNotifications.processDueNotifications({
        limit: batchLimit(options.limit),
      });
      return {
        attempted: summary.attempted,
        delivered: summary.delivered,
        failed: summary.failed,
        exhausted: summary.exhausted,
      };
    }),

  // Email-change verifications and old-address warnings.
  email_change_outbox: (options = {}) =>
    withJobLock('email_change_outbox', async () => {
      const summary = await emailChangeOutbox.processDue({ limit: batchLimit(options.limit) });
      return {
        claimed: summary.claimed,
        sent: summary.sent,
        retry: summary.retry,
        failed: summary.failed,
        cancelled: summary.cancelled,
      };
    }),

  // Pending email changes whose window closed. Marks them expired with a
  // reason rather than leaving a row that looks live forever. Nothing called
  // this before.
  email_changes: () =>
    withJobLock('email_changes', async (client) => {
      await client.query('BEGIN');
      try {
        const expired = await rights.expireStaleEmailChanges(client);
        await client.query('COMMIT');
        return { expired: Number(expired) || 0 };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }),

  // Advertising slot holds that were never paid for. Previously released only
  // when a request happened to hit the ads route, which means a held slot could
  // block a real booking for as long as nobody visited the page.
  ad_holds: () =>
    withJobLock('ad_holds', async (client) => {
      await client.query('BEGIN');
      try {
        const released = await adSlots.expireStaleHolds(client);
        await client.query('COMMIT');
        return { released: Number(released) || 0 };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }),
};

const JOB_NAMES = Object.keys(JOBS);

// Runs several jobs in sequence. Order matters in one place and is documented
// where it does: `email_changes` expires stale pending changes, and the outbox
// then cancels the notifications attached to them — running the outbox first
// would simply do that work on the next pass, so the ordering is a preference,
// not a correctness requirement. The advisory locks are the correctness
// boundary; nothing here depends on two jobs not overlapping.
const ALL_ORDER = [
  'email_changes',
  'ad_holds',
  'claims',
  'sessions',
  'risk_signals',
  'claim_outbox',
  'email_change_outbox',
];

async function runJobs(names, options = {}) {
  const results = [];
  for (const name of names) {
    if (stopRequested()) {
      results.push({ job: name, status: 'skipped', reason: 'shutdown requested' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential
    results.push(await JOBS[name](options));
  }
  return results;
}

// The structured line a scheduler captures. One JSON object per run, with
// counts only — a log aggregator can alert on `status` and on non-zero
// `failed`/`exhausted` without anything sensitive ever being in it.
function summarise(results, { startedAt }) {
  const failed = results.filter((r) => r.status === 'error');
  return {
    event: 'maintenance',
    started_at: startedAt,
    ok: failed.length === 0,
    jobs: results,
    // "Nothing to do" is explicitly not an error, and is reported as such so a
    // dashboard does not read a quiet night as a broken job.
    idle: results.every(
      (r) =>
        r.status === 'skipped' ||
        Object.entries(r).every(
          ([key, value]) => ['job', 'status', 'ms', 'reason'].includes(key) || value === 0
        )
    ),
  };
}

module.exports = {
  LOCK_KEYS,
  DEFAULT_LIMIT,
  JOBS,
  JOB_NAMES,
  ALL_ORDER,
  batchLimit,
  withJobLock,
  runJobs,
  summarise,
  requestStop,
  stopRequested,
  resetStop,
};
