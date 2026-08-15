const express = require('express');
const { pool } = require('../db');
const { constructWebhookEvent } = require('../lib/stripe');

const router = express.Router();

// Stripe webhook endpoint — the only thing that may mark an ad booking paid.
//
// Before this existed, fulfilment depended on the customer's browser coming
// back to the success page and calling /api/ads/checkout/confirm. A closed tab,
// a dropped connection, a blocked redirect or an impatient customer all left a
// real payment recorded as unpaid, and a banner that was bought but never ran.
// Webhooks are delivered server-to-server and retried until acknowledged, so
// fulfilment no longer depends on anything the customer does after paying.
//
// Shape of every request through here:
//
//   1. Verify the signature against the raw body. Anything that fails is
//      rejected before a single database statement runs.
//   2. Open a transaction and claim the event id in the ledger. A duplicate
//      delivery finds the id already present and stops there.
//   3. Apply the business change in the same transaction.
//   4. Commit. If anything failed, roll back — which also removes the ledger
//      claim, so Stripe's retry finds the event unprocessed and can succeed.
//
// Step 4 is why the ledger insert and the state change must share a
// transaction: recording an event as handled while the work it describes was
// rolled back would turn a retryable failure into a permanently lost payment.

// Which event types this endpoint acts on. Anything else is acknowledged and
// ignored — Stripe accounts often have more events enabled than an application
// cares about, and 2xx-with-no-action is the correct answer for those.
const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.dispute.created',
]);

// Stripe returns some nested objects either expanded or as a bare id string,
// depending on the request and API version.
function idOf(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

function fils(amountAed) {
  return Math.round(Number(amountAed) * 100);
}

// Everything below returns one of:
//   { action: '...' }            handled, commit
//   { action: 'ignored', ... }   nothing to do, commit (event still recorded)
//   { retry: true, ... }         transient, roll back and let Stripe retry
async function fulfilSession(client, event) {
  const session = event.data.object;
  const adId = session.client_reference_id;

  if (!adId) {
    return { action: 'ignored', reason: 'no client_reference_id' };
  }

  const adRes = await client.query(
    `SELECT id, amount_aed, stripe_session_id, payment_status
     FROM ads WHERE id = $1 FOR UPDATE`,
    [adId]
  );
  const ad = adRes.rows[0];

  // An event for a booking this deployment has never heard of — most often a
  // webhook endpoint shared between environments. Nothing to retry.
  if (!ad) {
    return { action: 'ignored', reason: 'no matching booking' };
  }

  // The session id is written a moment after the row is inserted, so a webhook
  // that overtakes that write would otherwise look like a session mismatch and
  // be refused permanently. Retry instead: the next delivery sees it stored.
  if (!ad.stripe_session_id) {
    return { retry: true, reason: 'booking has no session id yet' };
  }

  if (ad.stripe_session_id !== session.id) {
    return { action: 'refused', reason: 'session id does not match the booking' };
  }

  // A delayed payment method completes checkout while the money is still in
  // flight; the outcome arrives later as async_payment_succeeded/failed. This
  // is a legitimate state, not a failure — record it and wait.
  if (session.payment_status !== 'paid') {
    if (ad.payment_status === 'pending') {
      await client.query(
        "UPDATE ads SET payment_status = 'awaiting_payment' WHERE id = $1",
        [ad.id]
      );
    }
    return { action: 'awaiting_payment' };
  }

  if (String(session.currency || '').toLowerCase() !== 'aed') {
    return { action: 'refused', reason: 'currency does not match' };
  }

  if (session.amount_total !== fils(ad.amount_aed)) {
    return { action: 'refused', reason: 'amount does not match the booking' };
  }

  // Already fulfilled by an earlier event of a different type (completed and
  // async_payment_succeeded can both arrive for one session).
  if (ad.payment_status === 'paid') {
    return { action: 'already_paid' };
  }

  await client.query(
    `UPDATE ads
     SET paid = TRUE, payment_status = 'paid', paid_at = NOW(), stripe_payment_intent = $2
     WHERE id = $1`,
    [ad.id, idOf(session.payment_intent)]
  );

  return { action: 'paid' };
}

async function markSessionOutcome(client, event, { status, clearPaid }) {
  const session = event.data.object;
  const adId = session.client_reference_id;
  if (!adId) return { action: 'ignored', reason: 'no client_reference_id' };

  const adRes = await client.query(
    'SELECT id, stripe_session_id, payment_status FROM ads WHERE id = $1 FOR UPDATE',
    [adId]
  );
  const ad = adRes.rows[0];
  if (!ad) return { action: 'ignored', reason: 'no matching booking' };
  if (ad.stripe_session_id && ad.stripe_session_id !== session.id) {
    return { action: 'refused', reason: 'session id does not match the booking' };
  }

  // A session that already paid must not be downgraded by a late expiry event.
  if (ad.payment_status === 'paid' && !clearPaid) {
    return { action: 'ignored', reason: 'booking already paid' };
  }

  await client.query('UPDATE ads SET payment_status = $2, paid = FALSE WHERE id = $1', [
    ad.id,
    status,
  ]);
  return { action: status };
}

// Refunds and disputes arrive as charge events, which reference a payment
// intent rather than a checkout session — hence the lookup by intent, stored
// when the booking was fulfilled.
async function markChargeOutcome(client, event, { status, timestampColumn }) {
  const charge = event.data.object;
  const paymentIntent = idOf(charge.payment_intent);
  if (!paymentIntent) return { action: 'ignored', reason: 'no payment intent' };

  const adRes = await client.query(
    'SELECT id, payment_status FROM ads WHERE stripe_payment_intent = $1 FOR UPDATE',
    [paymentIntent]
  );
  const ad = adRes.rows[0];
  if (!ad) return { action: 'ignored', reason: 'no matching booking' };
  if (ad.payment_status === status) return { action: 'already_' + status };

  // paid goes FALSE in both cases: a refunded booking should stop running and
  // stop counting as revenue, and a disputed one has had its funds withdrawn
  // pending resolution. Reinstating after a won dispute is a deliberate admin
  // action, not an automatic one.
  await client.query(
    `UPDATE ads SET payment_status = $2, paid = FALSE, ${timestampColumn} = NOW() WHERE id = $1`,
    [ad.id, status]
  );
  return { action: status };
}

async function handleEvent(client, event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return fulfilSession(client, event);

    case 'checkout.session.async_payment_failed':
      return markSessionOutcome(client, event, { status: 'failed', clearPaid: false });

    case 'checkout.session.expired':
      return markSessionOutcome(client, event, { status: 'expired', clearPaid: false });

    case 'charge.refunded':
      return markChargeOutcome(client, event, { status: 'refunded', timestampColumn: 'refunded_at' });

    case 'charge.dispute.created':
      return markChargeOutcome(client, event, { status: 'disputed', timestampColumn: 'disputed_at' });

    default:
      return { action: 'ignored', reason: 'unhandled event type' };
  }
}

router.post('/stripe', async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Naming the variable is fine; its value is never read into a log line.
    console.error('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured.');
    return res.status(503).json({ error: 'Webhook not configured.' });
  }

  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    // Deliberately terse and fixed: an attacker probing this endpoint learns
    // nothing about why their forgery failed, and nothing derived from the
    // secret reaches the logs. 400 is also correct for Stripe — a signature
    // failure is permanent, so retrying it would be pointless.
    console.error('Stripe webhook signature verification failed.');
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  if (!HANDLED.has(event.type)) {
    // Acknowledged without being recorded: nothing happened, so there is no
    // state a replay could corrupt.
    return res.status(200).json({ received: true, action: 'ignored' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Claiming the id and doing the work share this transaction. A concurrent
    // duplicate delivery blocks here until the first commits, then finds the
    // row present and returns no rows.
    const claimed = await client.query(
      'INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
      [event.id, event.type]
    );

    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ received: true, action: 'duplicate' });
    }

    const outcome = await handleEvent(client, event);

    if (outcome.retry) {
      // Rolling back drops the ledger claim too, so the retry sees a fresh
      // event rather than one already marked handled.
      await client.query('ROLLBACK');
      console.error(`Stripe webhook ${event.type} deferred: ${outcome.reason}`);
      return res.status(503).json({ error: 'Not ready to process this event yet.' });
    }

    await client.query('COMMIT');

    if (outcome.action === 'refused') {
      // Authenticated, understood, and deliberately not acted on — the event
      // does not match the booking it claims to be for. Retrying cannot change
      // that, so this is acknowledged rather than failed, and logged loudly
      // enough to be investigated. Identifiers only, no customer details.
      console.error(
        `Stripe webhook ${event.type} refused for booking: ${outcome.reason} (event ${event.id})`
      );
    }

    return res.status(200).json({ received: true, action: outcome.action });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 5xx tells Stripe to retry. The rollback means there is nothing partially
    // applied for that retry to trip over.
    console.error(`Stripe webhook processing failed for event ${event.id}:`, err.message);
    return res.status(500).json({ error: 'Could not process this event.' });
  } finally {
    client.release();
  }
});

module.exports = router;
