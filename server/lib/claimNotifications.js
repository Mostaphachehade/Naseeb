// Durable delivery of claim emails.
//
// The claim invitation is the one message the whole workflow depends on. A
// winner who never receives it cannot claim; the claim then expires into an
// admin queue for a reason nobody recorded. Sending it as an unawaited promise
// made a mail outage completely silent — the draw committed, the email
// vanished, and the only trace was a line in a log nobody was reading.
//
// So the intent to notify is written to the database in the same transaction as
// the draw, and stays there until it is delivered. Sending is a separate,
// retryable step against that record.
//
// The outbox never holds a token. Each attempt issues a fresh one and
// invalidates whatever came before it, which means a leaked outbox row is not a
// claim link, and an expired or undelivered link cannot be resurrected from it.
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { issueToken } = require('./claimTokens');
const { sendEmail } = require('./email');
const { claimInvitationHtml } = require('./emailTemplates');
const { recordEvent } = require('./claimEvents');
const { ROLES } = require('./claimStateMachine');

const KINDS = { INVITATION: 'claim_invitation' };
const MAX_ATTEMPTS = 8;

// Exponential, capped. Long enough that a provider outage isn't hammered,
// short enough that a winner isn't left waiting a day for a retry to fire.
function backoffMinutes(attempts) {
  return Math.min(2 ** attempts, 120);
}

// Errors are recorded as a category, never as the provider's message: bounce
// text routinely quotes the recipient address back at you, and this table is
// meant to hold no personal data at all.
function categorize(err) {
  const message = String((err && err.message) || '').toLowerCase();
  if (message.includes('timeout') || message.includes('etimedout')) return 'timeout';
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('network')) {
    return 'network';
  }
  if (message.includes('401') || message.includes('403') || message.includes('unauthor')) return 'auth';
  if (message.includes('429') || message.includes('rate')) return 'rate_limited';
  if (message.includes('5')) return 'provider_error';
  return 'unknown';
}

async function queueInvitation(client, claimId) {
  await client.query(
    `INSERT INTO claim_notifications (id, claim_id, kind, status, next_attempt_at)
     VALUES ($1, $2, $3, 'pending', NOW())`,
    [uuid(), claimId, KINDS.INVITATION]
  );
}

// Claims a batch of due notifications for this worker only.
//
// SKIP LOCKED is what makes two workers — or two instances, or a scheduled run
// overlapping a manual one — safe to run at the same time: each takes rows the
// other has not, rather than blocking or double-sending.
async function claimDueNotifications(client, limit) {
  const result = await client.query(
    `SELECT n.id, n.claim_id, n.kind, n.attempts,
            c.giveaway_id, c.winner_user_id, c.status AS claim_status,
            g.title, u.name AS winner_name, u.email AS winner_email
       FROM claim_notifications n
       JOIN prize_claims c ON c.id = n.claim_id
       JOIN giveaways g ON g.id = c.giveaway_id
       JOIN users u ON u.id = c.winner_user_id
      WHERE n.status = 'pending'
        AND n.next_attempt_at <= NOW()
      ORDER BY n.next_attempt_at ASC
      LIMIT $1
      FOR UPDATE OF n SKIP LOCKED`,
    [limit]
  );
  return result.rows;
}

// One delivery attempt for one outbox row, inside the caller's transaction.
//
// A fresh token is issued and written before the email is sent, so the link in
// the message that goes out is the only one that works: any previous token —
// from the original send or an earlier failed attempt — is invalidated by the
// same UPDATE. If the send then fails, the new token simply goes unused and the
// next attempt replaces it too.
async function attemptDelivery(client, row, { appUrl }) {
  const { token, tokenHash, expiresAt } = issueToken();

  await client.query(
    `UPDATE prize_claims
        SET token_hash = $2, token_expires_at = $3, token_issued_at = NOW(),
            token_used_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [row.claim_id, tokenHash, expiresAt]
  );

  try {
    await sendEmail({
      // Strict: this send has to report failure so the row stays queued.
      strict: true,
      to: row.winner_email,
      // Marked sensitive so the body — which carries the single-use link — is
      // never written to a log, even in development.
      sensitive: true,
      subject: `Claim your prize: ${row.title}`,
      html: claimInvitationHtml({
        winnerName: row.winner_name,
        giveawayTitle: row.title,
        // The token lives in the URL fragment. Fragments are not sent to the
        // server, so it cannot reach an access log, a proxy, or a Referer
        // header on the way in.
        claimUrl: `${appUrl}/claim.html#token=${token}`,
        expiresAt,
      }),
    });
  } catch (err) {
    const category = categorize(err);
    const attempts = row.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;

    await client.query(
      `UPDATE claim_notifications
          SET attempts = $2,
              status = $3,
              last_error_category = $4,
              last_attempt_at = NOW(),
              next_attempt_at = NOW() + ($5 || ' minutes')::interval,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, attempts, exhausted ? 'failed' : 'pending', category, String(backoffMinutes(attempts))]
    );

    return { delivered: false, category, attempts, exhausted };
  }

  await client.query(
    `UPDATE claim_notifications
        SET status = 'sent', attempts = attempts + 1, delivered_at = NOW(),
            last_attempt_at = NOW(), last_error_category = NULL, updated_at = NOW()
      WHERE id = $1`,
    [row.id]
  );
  await client.query('UPDATE prize_claims SET invitation_sent_at = NOW() WHERE id = $1', [
    row.claim_id,
  ]);

  return { delivered: true, attempts: row.attempts + 1 };
}

// Drains whatever is due. Safe to call from a scheduler, from an admin action,
// or from two of those at once.
async function processDueNotifications({ limit = 25, appUrl } = {}) {
  const resolvedUrl = appUrl || process.env.APP_URL || 'http://localhost:3000';
  const summary = { attempted: 0, delivered: 0, failed: 0, exhausted: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await claimDueNotifications(client, limit);

    for (const row of due) {
      summary.attempted += 1;
      const outcome = await attemptDelivery(client, row, { appUrl: resolvedUrl });
      if (outcome.delivered) {
        summary.delivered += 1;
        await recordEvent(client, {
          claimId: row.claim_id,
          from: null,
          to: 'invitation_sent',
          actorUserId: null,
          actorRole: ROLES.SYSTEM,
          note: outcome.attempts > 1 ? `delivered on attempt ${outcome.attempts}` : null,
        });
      } else {
        summary.failed += 1;
        if (outcome.exhausted) summary.exhausted += 1;
        await recordEvent(client, {
          claimId: row.claim_id,
          from: null,
          to: 'invitation_delivery_failed',
          actorUserId: null,
          actorRole: ROLES.SYSTEM,
          note: `attempt ${outcome.attempts}: ${outcome.category}`,
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (summary.exhausted > 0) {
    // Loud, because a winner is now waiting on a message that will never
    // arrive by itself and an administrator has to reissue it by hand.
    console.error(
      `${summary.exhausted} claim invitation(s) exhausted every delivery attempt and need manual reissue.`
    );
  }

  return summary;
}

// Puts a failed or already-sent invitation back in the queue. Used by the admin
// review screen when a winner says they never got the email.
async function requeueInvitation(client, claimId) {
  const existing = await client.query(
    `SELECT id FROM claim_notifications
      WHERE claim_id = $1 AND kind = $2
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [claimId, KINDS.INVITATION]
  );

  if (existing.rowCount === 0) {
    await queueInvitation(client, claimId);
    return { requeued: true, created: true };
  }

  await client.query(
    `UPDATE claim_notifications
        SET status = 'pending', next_attempt_at = NOW(), last_error_category = NULL, updated_at = NOW()
      WHERE id = $1`,
    [existing.rows[0].id]
  );
  return { requeued: true, created: false };
}

async function notificationStateFor(client, claimId) {
  const result = await client.query(
    `SELECT status, attempts, last_error_category, delivered_at, next_attempt_at
       FROM claim_notifications
      WHERE claim_id = $1 AND kind = $2
      ORDER BY created_at DESC LIMIT 1`,
    [claimId, KINDS.INVITATION]
  );
  return result.rows[0] || null;
}

module.exports = {
  KINDS,
  MAX_ATTEMPTS,
  backoffMinutes,
  categorize,
  queueInvitation,
  attemptDelivery,
  processDueNotifications,
  requeueInvitation,
  notificationStateFor,
};
