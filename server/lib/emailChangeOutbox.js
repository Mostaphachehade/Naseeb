// Durable delivery of the two email-change messages.
//
// Both are security-critical, in opposite directions.
//
//   verification         to the proposed NEW address. The only way a change can
//                        complete. If it never arrives, the change silently
//                        never happens and nobody is told why.
//
//   old_address_warning  to the EXISTING address, after the change completes.
//                        The only signal an account holder gets that somebody
//                        moved the address their password reset goes to. An
//                        attacker holding a stolen session wants exactly this
//                        message to go missing.
//
// Sending either as an unawaited promise made a mail outage completely silent.
// So the intent to notify is written in the same transaction as the thing that
// caused it, and delivery is a separate, retryable step against that record.
//
// ---------------------------------------------------------------------------
// The token lifecycle, which is the part worth reading twice
// ---------------------------------------------------------------------------
//
// A pending change is created with NO token. `token_hash` is NULL, and there is
// nothing in the database or the outbox that could be turned into a working
// link.
//
// A token comes into existence only inside `attemptDelivery`, in worker memory,
// immediately before the message goes out. Its SHA-256 is written to the change
// record in the same transaction that claims the row; the plaintext exists as a
// local variable for the length of one send and is never returned, logged,
// stored or included in a result.
//
// **Every retry mints a fresh token and overwrites the hash.** That is what
// makes the previous link stop working: there is exactly one live token per
// pending change at any moment, and it is the one in the most recent message.
//
// The safe failure direction, stated deliberately:
//
//   If the provider accepted a message but the response was lost, the outbox
//   still believes the send failed and will retry. That retry invalidates the
//   link in the message that may have arrived, and sends a new one. A person can
//   therefore receive two emails and find the first link dead.
//
//   That is the direction chosen. The alternative — leaving the uncertain link
//   live so both work — means an unknown number of valid tokens for an operation
//   that moves an account's recovery address, with no way to count or revoke
//   them. A confusing email is a support question; a second live token is a
//   security hole. We take the support question.
//
// The expiry never moves. `expires_at` is set once, when the change is created,
// and no code path here touches it — a retry issues a fresh token that dies at
// the original deadline, so an undeliverable change cannot be kept alive
// indefinitely by the retry loop itself.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { emailChangeConfirmHtml, emailChangeNoticeHtml } = require('./emailTemplates');
const errorReporting = require('./errorReporting');

const KINDS = {
  VERIFICATION: 'verification',
  OLD_ADDRESS_WARNING: 'old_address_warning',
};

const STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const MAX_ATTEMPTS = 6;

// How long a worker may hold a row before another one may take it. Long enough
// that a slow provider call finishes first; short enough that a crashed worker
// does not strand a security notice for an hour.
const LEASE_SECONDS = 120;

// Exponential and capped. A provider outage is not hammered; somebody waiting on
// a verification email is not left for a day.
function backoffMinutes(attempts) {
  return Math.min(2 ** attempts, 60);
}

// A category, never the provider's message. Bounce text routinely quotes the
// recipient address back at you, and nothing in this table may hold one.
function categorize(err) {
  const message = String((err && err.message) || '').toLowerCase();
  if (message.includes('timeout') || message.includes('etimedout')) return 'timeout';
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('network')) {
    return 'network';
  }
  if (message.includes('401') || message.includes('403') || message.includes('unauthor')) return 'auth';
  if (message.includes('429') || message.includes('rate')) return 'rate_limited';
  if (/\b5\d\d\b/.test(message)) return 'provider_error';
  if (/\b4\d\d\b/.test(message)) return 'rejected';
  return 'unknown';
}

// Masks an address for the warning message. Deliberately not reversible and
// deliberately not stored — computed at send time from the change record.
function maskEmail(value) {
  return String(value || '').replace(/^(.).*(@.*)$/, '$1***$2');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function recordEvent(client, notification, event, extra = {}) {
  await client.query(
    `INSERT INTO email_change_notification_events
       (id, notification_id, change_id, user_id, event, attempt, error_category, note,
        actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      uuid(),
      notification.id,
      notification.change_id,
      notification.user_id,
      event,
      extra.attempt === undefined ? null : extra.attempt,
      extra.errorCategory || null,
      extra.note || null,
      extra.actorUserId || null,
      extra.actorRole || 'system',
    ]
  );
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

// Called inside the caller's transaction — that is the whole point. Creating the
// pending change and its notification is one commit, so a crash between them is
// impossible and a provider failure cannot lose either.
//
// Idempotent by unique index: enqueuing the same (change, kind) twice leaves one
// row. A double submit produces one message, not two.
async function enqueue(client, { changeId, userId, kind }) {
  if (!Object.values(KINDS).includes(kind)) {
    throw new Error(`Unknown email-change notification kind: ${kind}`);
  }
  const id = uuid();
  const idempotencyKey = `${changeId}:${kind}`;

  const inserted = await client.query(
    `INSERT INTO email_change_notifications
       (id, change_id, user_id, kind, status, next_attempt_at, idempotency_key)
     VALUES ($1, $2, $3, $4, 'pending', NOW(), $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [id, changeId, userId, kind, idempotencyKey]
  );
  if (!inserted.rowCount) {
    const existing = await client.query(
      'SELECT id FROM email_change_notifications WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    return { id: existing.rows[0].id, created: false };
  }

  await recordEvent(client, { id, change_id: changeId, user_id: userId }, 'enqueued');
  return { id, created: true };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

// Takes up to `limit` due rows for this worker alone.
//
// `SKIP LOCKED` is what makes two workers — two instances, or a scheduled tick
// overlapping a manual drain — safe to run at once: each takes rows the other
// has not, rather than blocking behind it or double-sending.
//
// The lease is belt and braces on top of that. `FOR UPDATE SKIP LOCKED` protects
// only for the length of the claiming transaction, and the transaction commits
// before the network call so it is not held open across a slow request. The
// lease is what protects the row for the rest of the attempt, and it expires on
// its own so a worker that dies mid-send does not strand the row.
async function claimDue(client, { limit = 10, now = new Date(), workerId }) {
  const result = await client.query(
    `UPDATE email_change_notifications n
        SET lease_owner = $2,
            lease_expires_at = $3,
            attempts = n.attempts + 1,
            last_attempt_at = NOW(),
            updated_at = NOW()
      WHERE n.id IN (
        SELECT id FROM email_change_notifications
         WHERE status = 'pending'
           AND next_attempt_at <= $4
           AND (lease_expires_at IS NULL OR lease_expires_at <= $4)
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING n.*`,
    [limit, workerId, new Date(now.getTime() + LEASE_SECONDS * 1000), now]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

// Resolves the recipient by joining the change record, rather than reading an
// address the outbox duplicated. Also decides whether this notification still
// makes sense at all.
async function resolveTarget(client, row) {
  const result = await client.query(
    `SELECT id, user_id, new_email, previous_email, status, expires_at,
            (SELECT name FROM users WHERE id = email_change_requests.user_id) AS account_name
       FROM email_change_requests WHERE id = $1`,
    [row.change_id]
  );
  const change = result.rows[0];

  if (!change) return { ok: false, reason: 'change_record_gone' };

  if (row.kind === KINDS.VERIFICATION) {
    // A retry must never revive something that is over. Each of these is a
    // distinct way a change stops being live, and none of them may produce a
    // new link.
    if (change.status === 'completed') return { ok: false, reason: 'already_completed' };
    if (change.status === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (change.status === 'expired') return { ok: false, reason: 'expired' };
    if (change.status !== 'pending') return { ok: false, reason: `not_pending_${change.status}` };
    if (new Date(change.expires_at) <= new Date()) return { ok: false, reason: 'expired' };
    return { ok: true, change, recipient: change.new_email };
  }

  // The warning goes to the address that was moved away from, and only once the
  // change actually completed. A warning about a change that did not happen
  // would be a false alarm about an account compromise.
  if (change.status !== 'completed') return { ok: false, reason: `change_not_completed` };
  return { ok: true, change, recipient: change.previous_email };
}

// Mints a token and installs its hash, atomically, on a change that is still
// live. Returns null if the change moved underneath us between the claim and
// here — in which case nothing was written and no link exists.
//
// Note what this UPDATE does NOT touch: `expires_at`. A retry gets a fresh
// token with the ORIGINAL deadline, so the retry loop cannot extend the life of
// a change by even a second.
async function supersedeToken(client, changeId, { now = new Date() } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const updated = await client.query(
    `UPDATE email_change_requests
        SET token_hash = $2
      WHERE id = $1 AND status = 'pending' AND expires_at > $3
      RETURNING expires_at`,
    [changeId, tokenHash, now]
  );
  if (!updated.rowCount) return null;

  return { token, expiresAt: updated.rows[0].expires_at };
}

// The delivery for one row. Structured as three phases so no database
// transaction is open across the network call:
//
//   1. claim + (for a verification) mint and install the token   — committed
//   2. send                                                       — no transaction
//   3. record the outcome                                         — committed
//
// The token hash is durable before the message leaves, which is the ordering
// that matters: a link can never arrive that the database does not recognise.
async function attemptDelivery(row, { appUrl, send = sendEmail, now = new Date() } = {}) {
  const resolvedUrl = appUrl || process.env.APP_URL || 'http://localhost:3000';

  // --- phase 1 -------------------------------------------------------------
  //
  // Every exit from this block goes through the `finally`. An early `return`
  // inside a try that releases its client afterwards leaks one per call, and a
  // leaked client is invisible until the pool is exhausted or a shutdown hangs
  // waiting for it — so the cancellation paths set a variable and fall through
  // rather than returning from inside the try.
  let prepared = null;
  let cancelled = null;
  const prep = await pool.connect();
  try {
    await prep.query('BEGIN');
    const target = await resolveTarget(prep, row);

    if (!target.ok) {
      cancelled = target.reason;
    } else if (row.kind === KINDS.VERIFICATION) {
      const minted = await supersedeToken(prep, row.change_id, { now });
      if (!minted) {
        cancelled = 'change_no_longer_live';
      } else {
        await recordEvent(prep, row, 'token_superseded', { attempt: row.attempts });
        prepared = { ...target, token: minted.token, expiresAt: minted.expiresAt };
      }
    } else {
      prepared = target;
    }

    if (cancelled) {
      await prep.query(
        `UPDATE email_change_notifications
            SET status = 'cancelled', cancelled_reason = $2, lease_owner = NULL,
                lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id, cancelled]
      );
      await recordEvent(prep, row, 'cancelled', { note: cancelled, attempt: row.attempts });
    }

    await prep.query('COMMIT');
  } catch (err) {
    await prep.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    prep.release();
  }

  if (cancelled) return { outcome: 'cancelled', reason: cancelled };

  // --- phase 2: the network call, with nothing held open -------------------
  //
  // `token` is a local in this scope and in the template's arguments. It is
  // never returned, never put in the result object, never written to a row, and
  // never logged: `sensitive: true` keeps the body — which is the only place it
  // appears — out of the development log the same way a claim invitation is.
  let sendError = null;
  try {
    if (prepared.token) {
      await send({
        strict: true,
        sensitive: true,
        to: prepared.recipient,
        subject: 'Confirm your new email address',
        html: emailChangeConfirmHtml({
          name: prepared.change.account_name,
          confirmUrl: `${resolvedUrl}/verify-email-change.html#token=${encodeURIComponent(prepared.token)}`,
          expiresAt: prepared.expiresAt,
        }),
      });
    } else {
      await send({
        strict: true,
        to: prepared.recipient,
        subject: 'Your Naseeb email address was changed',
        html: emailChangeNoticeHtml({
          name: prepared.change.account_name,
          // Masked, and computed here rather than stored.
          newEmailMasked: maskEmail(prepared.change.new_email),
          appUrl: resolvedUrl,
          completed: true,
        }),
      });
    }
  } catch (err) {
    sendError = err;
  }

  // Dropped explicitly rather than left to fall out of scope, so a future edit
  // that returns `prepared` cannot carry a token out with it.
  const finished = { kind: row.kind, changeId: row.change_id };
  delete prepared.token;

  // --- phase 3 -------------------------------------------------------------
  const done = await pool.connect();
  try {
    await done.query('BEGIN');

    if (!sendError) {
      await done.query(
        `UPDATE email_change_notifications
            SET status = 'sent', sent_at = NOW(), last_error_category = NULL,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id]
      );
      await recordEvent(done, row, 'sent', { attempt: row.attempts });
      await done.query('COMMIT');
      return { ...finished, outcome: 'sent', attempts: row.attempts };
    }

    const category = categorize(sendError);
    const exhausted = row.attempts >= MAX_ATTEMPTS;

    await done.query(
      `UPDATE email_change_notifications
          SET status = $2,
              last_error_category = $3,
              next_attempt_at = NOW() + ($4 || ' minutes')::interval,
              failed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [row.id, exhausted ? STATUS.FAILED : STATUS.PENDING, category, String(backoffMinutes(row.attempts))]
    );
    await recordEvent(done, row, exhausted ? 'failed_terminal' : 'attempt_failed', {
      attempt: row.attempts,
      errorCategory: category,
    });
    await done.query('COMMIT');

    if (exhausted) {
      // Loud, and sanitised. The alert names the notification, the kind and the
      // error category — never the address, the body or the provider's message.
      console.error(
        `Email-change notification ${row.id} (${row.kind}) exhausted ${row.attempts} delivery attempts; last error category: ${category}. An administrator must retry it.`
      );
      errorReporting.reportError(
        new Error(`email-change notification exhausted: ${row.kind}`),
        {
          notification_id: row.id,
          kind: row.kind,
          attempts: row.attempts,
          error_category: category,
        }
      );
    }

    return { ...finished, outcome: exhausted ? 'failed' : 'retry', category, attempts: row.attempts };
  } catch (err) {
    await done.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    done.release();
  }
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

// In-flight drains, so a shutdown — or a test teardown — can wait for them.
//
// The routes kick a drain off without awaiting it: the record is already
// committed, the response should not wait on a mail provider, and the retry loop
// owns it from there. That is right for latency and wrong for lifecycle, because
// a process that exits (or a pool that closes) mid-drain leaves a row leased
// until the lease expires. `settle()` is the other half of that bargain.
const inFlight = new Set();

// Waits for every drain started so far. Not a lock and not a queue — a drain
// started after this call is not waited for, which is exactly what shutdown
// wants: stop accepting, then finish what is open.
async function settle() {
  await Promise.allSettled([...inFlight]);
}

// Fire-and-forget with the bookkeeping attached. Callers that do not want to
// wait use this rather than an unawaited `processDue`, so nothing is invisible
// to `settle()`.
function drainInBackground(options = {}) {
  const running = processDue(options).catch((err) => {
    console.error('Email-change outbox drain failed:', err.message);
  });
  inFlight.add(running);
  running.finally(() => inFlight.delete(running));
  return running;
}

// Safe to call from a scheduler, from an admin action, or from both at once.
async function processDue({ limit = 10, appUrl, send, now = new Date(), workerId } = {}) {
  const worker = workerId || `worker-${uuid()}`;
  const summary = { claimed: 0, sent: 0, retry: 0, failed: 0, cancelled: 0 };

  let due;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    due = await claimDue(client, { limit, now, workerId: worker });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  summary.claimed = due.length;

  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop -- ordered, and each is a send
    const result = await attemptDelivery(row, { appUrl, send, now });
    if (result.outcome === 'sent') summary.sent += 1;
    else if (result.outcome === 'retry') summary.retry += 1;
    else if (result.outcome === 'failed') summary.failed += 1;
    else if (result.outcome === 'cancelled') summary.cancelled += 1;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Manual retry
// ---------------------------------------------------------------------------

// Deliberate and audited: an administrator, a reason, and an event on the
// append-only trail. Puts a terminally failed notification back in the queue —
// it does not send anything itself, so a retry that fails again is just another
// attempt rather than a second code path.
async function manualRetry(client, { notificationId, actorUserId, reason }) {
  const admin = await client.query('SELECT is_admin, account_status FROM users WHERE id = $1', [
    actorUserId,
  ]);
  const actor = admin.rows[0];
  if (!actor || actor.account_status !== 'active' || !actor.is_admin) {
    const err = new Error('Administrators only.');
    err.status = 403;
    err.code = 'ADMIN_REQUIRED';
    throw err;
  }

  const note = String(reason || '').trim();
  if (note.length < 3) {
    const err = new Error('A reason is required — it is the record of why this was retried.');
    err.status = 400;
    err.code = 'REASON_REQUIRED';
    throw err;
  }

  const locked = await client.query(
    'SELECT * FROM email_change_notifications WHERE id = $1 FOR UPDATE',
    [notificationId]
  );
  const row = locked.rows[0];
  if (!row) {
    const err = new Error('That notification does not exist.');
    err.status = 404;
    err.code = 'NOTIFICATION_NOT_FOUND';
    throw err;
  }
  if (row.status === STATUS.SENT) {
    const err = new Error('That notification was already delivered.');
    err.status = 409;
    err.code = 'ALREADY_SENT';
    throw err;
  }
  if (row.status === STATUS.CANCELLED) {
    const err = new Error(`That notification was cancelled (${row.cancelled_reason}) and cannot be retried.`);
    err.status = 409;
    err.code = 'NOTIFICATION_CANCELLED';
    throw err;
  }

  await client.query(
    `UPDATE email_change_notifications
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
            failed_at = NULL, last_error_category = NULL,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [notificationId]
  );
  await recordEvent(client, row, 'manual_retry', {
    note,
    actorUserId,
    actorRole: 'admin',
  });

  return { requeued: true };
}

// What an administrator sees. No address, no body, no token, no provider text —
// there is nothing of that kind in the table to show.
async function adminView(client, { limit = 100 } = {}) {
  const result = await client.query(
    `SELECT n.id, n.kind, n.status, n.attempts, n.next_attempt_at, n.last_error_category,
            n.last_attempt_at, n.sent_at, n.failed_at, n.cancelled_reason, n.created_at,
            n.lease_owner IS NOT NULL AND n.lease_expires_at > NOW() AS in_flight,
            c.status AS change_status, c.expires_at AS change_expires_at
       FROM email_change_notifications n
       LEFT JOIN email_change_requests c ON c.id = n.change_id
      ORDER BY (n.status = 'failed') DESC, n.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    in_flight: row.in_flight,
    next_attempt_at: row.next_attempt_at,
    last_attempt_at: row.last_attempt_at,
    last_error_category: row.last_error_category,
    sent_at: row.sent_at,
    failed_at: row.failed_at,
    cancelled_reason: row.cancelled_reason,
    created_at: row.created_at,
    change_status: row.change_status,
    change_expires_at: row.change_expires_at,
    // Deliberately absent: recipient, subject, body, token, link, provider
    // response. An administrator who needs to know which account this is opens
    // the account, which is a separate and recorded act.
  }));
}

module.exports = {
  KINDS,
  STATUS,
  MAX_ATTEMPTS,
  LEASE_SECONDS,
  backoffMinutes,
  categorize,
  maskEmail,
  enqueue,
  claimDue,
  resolveTarget,
  supersedeToken,
  attemptDelivery,
  processDue,
  drainInBackground,
  settle,
  manualRetry,
  adminView,
  recordEvent,
};
