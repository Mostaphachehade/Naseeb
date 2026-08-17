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
const giveawayOutbox = require('./giveawayOutbox');
const giveawayLifecycle = require('./giveawayLifecycle');

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
  giveaway_lifecycle: 811008,
  giveaway_outbox: 811009,
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
// The shared draw
// ---------------------------------------------------------------------------

// Selecting a winner, creating the claim and queueing the notices — the same
// operation the host-triggered route performs, called through the same code.
//
// Required lazily rather than at module load: `server/routes/giveaways.js`
// pulls in the claim scheduler, which pulls in this file, and a top-level
// require would close that loop.
async function runDrawForMaintenance(client, giveaway) {
  // eslint-disable-next-line global-require -- see above
  const { runDraw } = require('../routes/giveaways');
  return runDraw(client, giveaway, { actorUserId: null, actorRole: 'system' });
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


  // The giveaway lifecycle: close campaigns whose 30-day deadline has passed,
  // and draw every campaign that is closed and unblocked.
  //
  // This is the job that makes the deadline real. Before it, a campaign closed
  // when a host remembered to press "draw" — which means a host who lost
  // interest left entrants waiting indefinitely, and on a plan where the web
  // service sleeps, an in-process timer would not have fired anyway.
  //
  // Bounded, idempotent and single-worker like every other job. Idempotence
  // comes from the state model rather than from bookkeeping: closure is a latch,
  // and `drawIfReady` refuses anything already resolved. A retried run after a
  // crash finds the work done and reports zeros.
  giveaway_lifecycle: (options = {}) =>
    withJobLock('giveaway_lifecycle', async (client) => {
      const limit = batchLimit(options.limit);
      const counts = { closed: 0, drawn: 0, no_winner: 0, postponed: 0, skipped: 0 };

      // Two passes rather than one query: a campaign that closes in this run
      // must also be eligible to draw in it, and a campaign that was already
      // closed on a previous run — or is waiting on an integrity review that
      // has since resolved — must be picked up without waiting for its
      // deadline to come round again.
      const due = await client.query(
        `SELECT id FROM giveaways
          WHERE status = $1 AND closes_at IS NOT NULL AND closes_at <= NOW()
          ORDER BY closes_at
          LIMIT $2`,
        [giveawayLifecycle.STATUS.ACTIVE, limit]
      );

      for (const row of due.rows) {
        if (stopRequested()) break;
        // eslint-disable-next-line no-await-in-loop -- one transaction per campaign
        await client.query('BEGIN');
        try {
          // eslint-disable-next-line no-await-in-loop
          const giveaway = await giveawayLifecycle.lockGiveaway(client, row.id);
          // eslint-disable-next-line no-await-in-loop
          const closure = await giveawayLifecycle.closeEntries(client, giveaway, {
            reason: giveawayLifecycle.CLOSE_REASONS.DEADLINE_REACHED,
          });
          if (closure.closed) counts.closed += 1;
          else counts.skipped += 1;
          // eslint-disable-next-line no-await-in-loop
          await client.query('COMMIT');
        } catch (err) {
          // eslint-disable-next-line no-await-in-loop
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }

      // Every campaign whose entries are closed and which has not yet reached an
      // outcome. Includes ones postponed by an integrity review on an earlier
      // run: once the review resolves, the next pass draws them, which is what
      // "resolving the review resumes the draw" means operationally.
      const awaiting = await client.query(
        `SELECT id FROM giveaways
          WHERE status = ANY($1)
          ORDER BY entries_closed_at
          LIMIT $2`,
        [giveawayLifecycle.AWAITING_OUTCOME, limit]
      );

      for (const row of awaiting.rows) {
        if (stopRequested()) break;
        // eslint-disable-next-line no-await-in-loop
        await client.query('BEGIN');
        try {
          // eslint-disable-next-line no-await-in-loop
          const giveaway = await giveawayLifecycle.lockGiveaway(client, row.id);
          // eslint-disable-next-line no-await-in-loop
          const outcome = await runDrawForMaintenance(client, giveaway);
          if (outcome.drawn) counts.drawn += 1;
          else if (outcome.noWinner) counts.no_winner += 1;
          else if (outcome.postponed) counts.postponed += 1;
          else counts.skipped += 1;
          // eslint-disable-next-line no-await-in-loop
          await client.query('COMMIT');
        } catch (err) {
          // eslint-disable-next-line no-await-in-loop
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }

      return counts;
    }),

  // Entry receipts, winner notices and cancellation notices.
  giveaway_outbox: (options = {}) =>
    withJobLock('giveaway_outbox', async () => {
      const summary = await giveawayOutbox.processDue({ limit: batchLimit(options.limit) });
      return {
        claimed: summary.claimed,
        sent: summary.sent,
        retry: summary.retry,
        failed: summary.failed,
        cancelled: summary.cancelled,
      };
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
  // First, because it is the one job whose absence people notice: a campaign
  // whose deadline passed and which nobody has drawn.
  'giveaway_lifecycle',
  'email_changes',
  'ad_holds',
  'claims',
  'sessions',
  'risk_signals',
  'claim_outbox',
  'email_change_outbox',
  // After the lifecycle job, so a draw in this run has its winner notice
  // attempted in the same run rather than waiting for the next one. The
  // advisory locks are still the correctness boundary; this is a preference.
  'giveaway_outbox',
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
