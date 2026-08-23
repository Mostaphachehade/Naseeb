// Durable entrant and winner notices.
//
// ---------------------------------------------------------------------------
// What this replaces
// ---------------------------------------------------------------------------
//
// Entry receipts and winner notices were `sendEmail({...})` called after the
// response had already been sent, unawaited, with no record that anything was
// owed. A mail outage lost them silently: the entrant never learned their ticket
// number, the winner never learned they had won, and nothing anywhere said so.
// The claim invitation was already durable; these two were not.
//
// Same design as the email-change outbox, deliberately — one shape of outbox in
// this codebase, not three:
//
//   * intent persisted in the SAME transaction as the thing it describes;
//   * a lease, so a crashed worker's row becomes claimable again after a bounded
//     time rather than being stuck behind a lock nobody holds;
//   * `FOR UPDATE SKIP LOCKED`, so concurrent workers claim disjoint work;
//   * capped exponential backoff and a FINITE attempt limit;
//   * a terminal `failed` state that stays visible to an administrator and feeds
//     the readiness notification check. Nothing retries forever;
//   * no database transaction held open across the provider call.
//
// What is never stored here: an email address, a rendered body, a link, a token,
// a session value, or a provider error message. Bounce text routinely quotes the
// recipient's address back at you, so only a category is kept. The recipient is
// derived from the referenced account at send time.
const { randomUUID } = require('node:crypto');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const {
  entryEmailHtml,
  winnerEmailHtml,
  giveawayCancelledHtml,
} = require('./emailTemplates');
const errorReporting = require('./errorReporting');

const KINDS = {
  ENTRY_RECEIPT: 'entry_receipt',
  WINNER_NOTICE: 'winner_notice',
  CANCELLATION_NOTICE: 'cancellation_notice',
};

const STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// Finite, and small. Six attempts across roughly two hours of backoff is long
// enough to ride out a provider incident and short enough that a genuinely
// undeliverable address stops being retried and starts being somebody's job.
const MAX_ATTEMPTS = 6;

// How long a worker's claim survives its own death.
const LEASE_SECONDS = 120;

function backoffMinutes(attempts) {
  // 1, 2, 4, 8, 16, capped at 30.
  return Math.min(30, 2 ** Math.max(0, attempts - 1));
}

// A category, never the provider's message.
function categorize(err) {
  const message = String((err && err.message) || '').toLowerCase();
  if (/timeout|etimedout|econnreset|socket|network|enotfound/.test(message)) return 'network';
  if (/rate|429|too many/.test(message)) return 'rate_limited';
  if (/invalid|reject|bounce|not a valid|unverified|domain/.test(message)) return 'rejected';
  if (/unauthor|forbidden|401|403|api key/.test(message)) return 'not_authorised';
  return 'provider_error';
}

async function recordEvent(client, notification, toStatus, extra = {}) {
  await client.query(
    `INSERT INTO giveaway_notification_events
       (id, notification_id, from_status, to_status, error_category, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      notification.id,
      notification.status || null,
      toStatus,
      extra.errorCategory || null,
      extra.actorRole || 'system',
    ]
  );
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

// Called inside the caller's transaction, so the notice and the thing it is
// about commit or roll back together. A draw that commits without its winner
// notice, or a notice for a draw that rolled back, are both failures this
// prevents by construction.
//
// Idempotent on `(giveaway, user, kind)`: enqueuing twice returns the existing
// row rather than sending two.
async function enqueue(client, { giveawayId, userId, kind }) {
  if (!Object.values(KINDS).includes(kind)) {
    throw new Error(`Unknown giveaway notification kind: ${kind}`);
  }
  const idempotencyKey = `${giveawayId}:${userId}:${kind}`;
  const inserted = await client.query(
    `INSERT INTO giveaway_notifications (id, giveaway_id, user_id, kind, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [randomUUID(), giveawayId, userId, kind, idempotencyKey]
  );
  if (inserted.rows[0]) {
    await recordEvent(client, { id: inserted.rows[0].id, status: null }, STATUS.PENDING);
    return { created: true, notification: inserted.rows[0] };
  }
  const existing = await client.query(
    'SELECT * FROM giveaway_notifications WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  return { created: false, notification: existing.rows[0] };
}

// Every accepted entrant on a campaign, for a cancellation notice. Disqualified
// entries are excluded: telling somebody a campaign they were removed from has
// been cancelled is a message that raises a question it does not answer.
async function enqueueForAllEntrants(client, { giveawayId, kind }) {
  const entrants = await client.query(
    `SELECT DISTINCT user_id FROM entries
      WHERE giveaway_id = $1 AND integrity_status <> 'disqualified'`,
    [giveawayId]
  );
  let created = 0;
  for (const row of entrants.rows) {
    // eslint-disable-next-line no-await-in-loop -- bounded by the entry target
    const result = await enqueue(client, { giveawayId, userId: row.user_id, kind });
    if (result.created) created += 1;
  }
  return { queued: entrants.rowCount, created };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

// `SKIP LOCKED` so two workers take disjoint rows instead of one queueing behind
// the other. The lease is what makes a crashed worker recoverable: its rows
// become claimable again once `lease_expires_at` passes, without anybody having
// to notice it died.
async function claimDue(client, { limit = 10, workerId }) {
  const result = await client.query(
    `UPDATE giveaway_notifications SET
        lease_owner = $2,
        lease_expires_at = NOW() + ($3 || ' seconds')::interval,
        updated_at = NOW()
      WHERE id IN (
        SELECT id FROM giveaway_notifications
         WHERE status = 'pending'
           AND next_attempt_at <= NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING *`,
    [limit, workerId, String(LEASE_SECONDS)]
  );
  return result.rows;
}

// The recipient and the content, derived from the referenced records at send
// time rather than stored. A row whose subject has gone is cancelled with a
// reason instead of being retried forever against nothing.
async function resolveTarget(client, row) {
  const result = await client.query(
    `SELECT u.email, u.name,
            g.id AS giveaway_id, g.title, g.prize_description, g.image_url,
            g.entry_deadline, g.closes_at, g.status, g.funded_by,
            g.cancellation_public_explanation,
            e.ticket_number
       FROM giveaway_notifications n
       JOIN users u ON u.id = n.user_id
       JOIN giveaways g ON g.id = n.giveaway_id
       LEFT JOIN entries e ON e.giveaway_id = n.giveaway_id AND e.user_id = n.user_id
      WHERE n.id = $1`,
    [row.id]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

// Three phases, and deliberately NO transaction across the middle one: holding a
// database transaction open across a provider call ties a connection to
// somebody else's latency and turns a slow provider into a connection-pool
// outage.
//
//   1. read what is needed, decide whether to send at all, release the client;
//   2. send;
//   3. take a fresh client and record the outcome.
async function attemptDelivery(row, { appUrl, send = sendEmail } = {}) {
  const prep = await pool.connect();
  let target = null;
  let cancelReason = null;

  try {
    target = await resolveTarget(prep, row);
    if (!target) {
      cancelReason = 'subject_no_longer_exists';
    } else if (row.kind === KINDS.CANCELLATION_NOTICE && target.status !== 'cancelled') {
      // The campaign was un-cancelled, or this row is stale. Either way, do not
      // tell somebody a live campaign was cancelled.
      cancelReason = 'campaign_not_cancelled';
    } else if (row.kind === KINDS.WINNER_NOTICE && target.status !== 'drawn') {
      cancelReason = 'draw_no_longer_stands';
    }
  } finally {
    prep.release();
  }

  if (cancelReason) {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE giveaway_notifications
            SET status = 'cancelled', cancelled_reason = $2, lease_owner = NULL,
                lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id, cancelReason]
      );
      await recordEvent(client, row, STATUS.CANCELLED);
    } finally {
      client.release();
    }
    return { outcome: 'cancelled', reason: cancelReason };
  }

  const giveawayUrl = `${appUrl || process.env.APP_URL || 'http://localhost:3000'}/giveaway.html?id=${target.giveaway_id}`;

  let error = null;
  try {
    if (row.kind === KINDS.ENTRY_RECEIPT) {
      await send({
        to: target.email,
        subject: `You're entered: ${target.title}`,
        html: entryEmailHtml({
          entrantName: target.name,
          giveawayTitle: target.title,
          prizeDescription: target.prize_description,
          imageUrl: target.image_url,
          ticketNumber: target.ticket_number,
          entryDeadline: target.entry_deadline,
          giveawayUrl,
        }),
      });
    } else if (row.kind === KINDS.WINNER_NOTICE) {
      await send({
        to: target.email,
        subject: `You won: ${target.title}`,
        html: winnerEmailHtml({
          winnerName: target.name,
          giveawayTitle: target.title,
          prizeDescription: target.prize_description,
          imageUrl: target.image_url,
          ticketNumber: target.ticket_number,
          fundedBy: target.funded_by,
          giveawayUrl,
        }),
      });
    } else {
      await send({
        to: target.email,
        subject: `Cancelled: ${target.title}`,
        html: giveawayCancelledHtml({
          entrantName: target.name,
          giveawayTitle: target.title,
          explanation: target.cancellation_public_explanation,
          giveawayUrl,
        }),
      });
    }
  } catch (err) {
    error = err;
  }

  const client = await pool.connect();
  try {
    if (!error) {
      await client.query(
        `UPDATE giveaway_notifications
            SET status = 'sent', sent_at = NOW(), attempts = attempts + 1,
                last_attempt_at = NOW(), lease_owner = NULL, lease_expires_at = NULL,
                last_error_category = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id]
      );
      await recordEvent(client, row, STATUS.SENT);
      return { outcome: 'sent' };
    }

    const category = categorize(error);
    const attempts = row.attempts + 1;

    if (attempts >= MAX_ATTEMPTS) {
      // Terminal. It stops here, stays visible to an administrator, and is
      // counted by the readiness notification check.
      await client.query(
        `UPDATE giveaway_notifications
            SET status = 'failed', failed_at = NOW(), attempts = $2,
                last_attempt_at = NOW(), last_error_category = $3,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id, attempts, category]
      );
      await recordEvent(client, row, STATUS.FAILED, { errorCategory: category });
      // Sanitised: a category and an id, never the recipient or the provider's
      // words. The reporter scrubs on top of this.
      errorReporting.reportError(new Error(`giveaway notification terminally failed: ${category}`), {
        source: 'giveaway_outbox',
        notification_id: row.id,
        kind: row.kind,
      });
      return { outcome: 'failed', category };
    }

    await client.query(
      `UPDATE giveaway_notifications
          SET attempts = $2, last_attempt_at = NOW(), last_error_category = $3,
              next_attempt_at = NOW() + ($4 || ' minutes')::interval,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [row.id, attempts, category, String(backoffMinutes(attempts))]
    );
    await recordEvent(client, row, STATUS.PENDING, { errorCategory: category });
    return { outcome: 'retry', category };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

const inFlight = new Set();

// Awaited by the tests and by shutdown, so a drain finishes rather than being
// cut off mid-attempt.
async function settle() {
  await Promise.allSettled([...inFlight]);
}

async function processDue({ limit = 10, appUrl, send, workerId } = {}) {
  const worker = workerId || `${process.pid}:${randomUUID()}`;
  const client = await pool.connect();
  let rows;
  try {
    rows = await claimDue(client, { limit, workerId: worker });
  } finally {
    client.release();
  }

  const summary = { claimed: rows.length, sent: 0, retry: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- bounded by `limit`
    const result = await attemptDelivery(row, { appUrl, send });
    if (result.outcome === 'sent') summary.sent += 1;
    else if (result.outcome === 'retry') summary.retry += 1;
    else if (result.outcome === 'failed') summary.failed += 1;
    else summary.cancelled += 1;
  }
  return summary;
}

// Fire-and-track, for the request path: the response does not wait on a provider,
// but the promise is tracked so nothing is lost at shutdown and the tests can
// await it.
function drainInBackground(options = {}) {
  const promise = processDue(options)
    .catch((err) => {
      console.error('Giveaway notification drain failed:', err.message);
    })
    .finally(() => inFlight.delete(promise));
  inFlight.add(promise);
  return promise;
}

// What an administrator sees. Counts, categories, kinds and ids — never a
// recipient, never a body.
async function adminView(client, { limit = 100 } = {}) {
  const result = await client.query(
    `SELECT id, giveaway_id, kind, status, attempts, last_error_category,
            created_at, sent_at, failed_at, cancelled_reason
       FROM giveaway_notifications
      WHERE status IN ('pending', 'failed')
      ORDER BY (status = 'failed') DESC, created_at
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  KINDS,
  STATUS,
  MAX_ATTEMPTS,
  LEASE_SECONDS,
  backoffMinutes,
  categorize,
  enqueue,
  enqueueForAllEntrants,
  claimDue,
  resolveTarget,
  attemptDelivery,
  processDue,
  drainInBackground,
  settle,
  adminView,
};
