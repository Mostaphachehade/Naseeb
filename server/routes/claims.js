const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { claimTokenLimiter, claimActionLimiter } = require('../middleware/rateLimit');
const { sendEmail } = require('../lib/email');
const {
  claimInvitationHtml,
  claimStatusHtml,
  hostClaimNotificationHtml,
} = require('../lib/emailTemplates');
const { STATES, ROLES, ClaimTransitionError } = require('../lib/claimStateMachine');
const claims = require('../lib/claims');
const rescue = require('../lib/claimRescue');
const claimEvents = require('../lib/claimEvents');
const { isConfigured: isEncryptionConfigured } = require('../lib/claimCrypto');
const { areClaimsEnabled } = require('../lib/featureFlags');
const notifications = require('../lib/claimNotifications');
const integrity = require('../lib/entryIntegrity');
const { runMaintenanceOnce } = require('../lib/claimScheduler');

const router = express.Router();
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// With claims switched off the whole workflow is inert rather than half
// present. Notably this does NOT fall back to the old host-only delivery
// confirmation — that path is gone, and a disabled claim workflow means
// delivery simply isn't recorded, not that a host can declare it alone again.
router.use((req, res, next) => {
  if (areClaimsEnabled()) return next();
  res.set('Cache-Control', 'no-store');
  return res.status(503).json({
    error: 'Prize claims are currently unavailable.',
    code: 'CLAIMS_DISABLED',
  });
});

// Delivery details are the minimum needed to physically hand something over.
// No identity documents, no date of birth, no payment details — none of it is
// needed to deliver a prize, and collecting it would mean holding it.
const DELIVERY_FIELDS = {
  recipient_name: { required: true, max: 120 },
  phone: { required: true, max: 32 },
  address_line1: { required: true, max: 200 },
  address_line2: { required: false, max: 200 },
  city: { required: true, max: 100 },
  emirate: { required: true, max: 100 },
  notes: { required: false, max: 500 },
};

function validateDeliveryDetails(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Delivery details are required.' };
  }
  const details = {};
  for (const [field, rule] of Object.entries(DELIVERY_FIELDS)) {
    const value = input[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      if (rule.required) {
        return { error: `${field.replace(/_/g, ' ')} is required.` };
      }
      continue;
    }
    const trimmed = String(value).trim();
    if (trimmed.length > rule.max) {
      return { error: `${field.replace(/_/g, ' ')} must be ${rule.max} characters or fewer.` };
    }
    details[field] = trimmed;
  }
  // Anything not on the list is dropped rather than stored: a client cannot
  // widen what this system holds about a winner by sending extra fields.
  return { details };
}

function claimError(res, err) {
  if (err instanceof ClaimTransitionError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('Claim operation failed:', err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// What every caller may see about a claim, regardless of who they are. Contains
// no delivery details and no token.
function baseClaimView(claim) {
  return {
    id: claim.id,
    giveaway_id: claim.giveaway_id,
    status: claim.status,
    public_status: claims.publicStatusFor(claim.status),
    claimed_at: claim.claimed_at,
    shipped_at: claim.shipped_at,
    delivery_reported_at: claim.delivery_reported_at,
    delivered_at: claim.delivered_at,
    disputed_at: claim.disputed_at,
    resolved_at: claim.resolved_at,
    expired_at: claim.expired_at,
    consent_version: claim.consent_version,
    consented_at: claim.consented_at,
    delivery_details_erased: Boolean(claim.delivery_erased_at),
  };
}

// ---------------------------------------------------------------------------
// Winner: redeeming a claim link
// ---------------------------------------------------------------------------

// Shows the winner what they are about to claim.
//
// A POST with the token in the body, not a GET with it in the query string.
// The token arrives at the browser in a URL fragment, which is never sent to a
// server — putting it back into a query string here would undo that, writing a
// live single-use credential into the access log of every proxy between the
// winner and this process.
//
// Deliberately does not consume the token: a link should survive being opened
// twice before the form is filled in. Returns nothing sensitive.
router.post('/lookup', claimTokenLimiter, async (req, res) => {
  try {
    const token = req.body && req.body.token;
    if (!token) return res.status(400).json({ error: 'Missing claim token.' });

    const claim = await claims.lookupByToken(pool, token);
    if (!claim) {
      // Same answer for wrong, expired and already-used, so this cannot be used
      // to work out which tokens exist.
      return res.status(404).json({ error: 'This claim link is invalid, expired, or already used.' });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      claim_id: claim.id,
      title: claim.title,
      prize_description: claim.prize_description,
      image_url: claim.image_url,
      funded_by: claim.funded_by,
      host_name: claim.host_name,
      expires_at: claim.token_expires_at,
      consent_version: claims.CONSENT_VERSION,
    });
  } catch (err) {
    return claimError(res, err);
  }
});

// The old GET form is refused outright rather than left as a quiet alternative.
// A token in a query string is a token in a log; answering 410 here means an
// old email, a bookmark or a copied link fails loudly instead of leaking.
router.get('/lookup', claimTokenLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(410).json({
    error: 'This claim link format is no longer supported. Please open the link from your email again.',
    code: 'USE_FRAGMENT_LINK',
  });
});

// The winner consents, supplies delivery details, and the claim opens.
//
// Consent is explicit and recorded: without it nothing is stored and the host
// is told nothing. The delivery details are encrypted before they reach the
// database.
router.post('/redeem', claimTokenLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { token, consent, consent_version, delivery } = req.body || {};

    if (!token) return res.status(400).json({ error: 'Missing claim token.' });

    if (consent !== true) {
      return res.status(400).json({
        error:
          'You need to agree to share your delivery details with the host before we can pass them on.',
        code: 'CONSENT_REQUIRED',
      });
    }
    if (consent_version !== claims.CONSENT_VERSION) {
      return res.status(409).json({
        error: 'The consent wording has been updated. Please reload the page and read it again.',
        code: 'CONSENT_VERSION_CHANGED',
        consent_version: claims.CONSENT_VERSION,
      });
    }

    if (!isEncryptionConfigured()) {
      // Without a key there is nowhere safe to put an address, so nothing is
      // stored at all. Names the variable, never a value.
      console.error('Claim redemption refused: CLAIM_ENCRYPTION_KEY is not configured.');
      return res.status(503).json({
        error: 'Prize claims are temporarily unavailable. Please try again shortly.',
      });
    }

    const { error, details } = validateDeliveryDetails(delivery);
    if (error) return res.status(400).json({ error });

    await client.query('BEGIN');
    const claim = await claims.redeemToken(client, {
      token,
      deliveryDetails: details,
      consentVersion: claims.CONSENT_VERSION,
    });

    if (!claim) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        error: 'This claim link is invalid, expired, or has already been used.',
        code: 'TOKEN_UNUSABLE',
      });
    }

    // If the host was suspended while this claim was still unopened, the winner
    // has just handed over an address to somebody who cannot act on it. Put it
    // in front of an administrator now rather than waiting for the winner to
    // notice the silence. Idempotent — the suspension already queued every
    // unfinished claim, so this normally finds the row already there.
    await rescue.ensureRescueForClaim(client, claim.id, {
      reason: 'Winner claimed while the host was suspended.',
    });

    const context = await client.query(
      `SELECT g.title, g.host_id, hostuser.email AS host_email, hostuser.name AS host_name,
              winner.name AS winner_name, winner.email AS winner_email
         FROM giveaways g
         JOIN users hostuser ON hostuser.id = g.host_id
         JOIN users winner ON winner.id = $2
        WHERE g.id = $1`,
      [claim.giveaway_id, claim.winner_user_id]
    );
    await client.query('COMMIT');

    res.set('Cache-Control', 'no-store');
    res.json({ ...baseClaimView(claim), message: 'Your claim is in. The host has been notified.' });

    // After the commit, and deliberately not awaited: a mail provider outage
    // must not roll back a claim the winner has already completed.
    const info = context.rows[0];
    if (info) {
      sendEmail({
        to: info.host_email,
        subject: `Your winner has claimed: ${info.title}`,
        // Carries no address and no phone number — the host signs in to see
        // those, so they are never sitting in an inbox or a mail provider's logs.
        html: hostClaimNotificationHtml({
          hostName: info.host_name,
          giveawayTitle: info.title,
          winnerName: info.winner_name,
          dashboardUrl: `${APP_URL}/dashboard.html`,
        }),
      });
      sendEmail({
        to: info.winner_email,
        subject: `Claim received: ${info.title}`,
        html: claimStatusHtml({
          recipientName: info.winner_name,
          giveawayTitle: info.title,
          status: STATES.CLAIMED,
          message: 'The host has been notified and will arrange delivery.',
          giveawayUrl: `${APP_URL}/giveaway.html?id=${claim.giveaway_id}`,
        }),
      });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Viewing a claim
// ---------------------------------------------------------------------------

// Role-aware. The role is worked out from the database on this request — the
// caller cannot assert it — and decides what comes back.
router.get('/giveaway/:giveawayId', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const claim = await claims.getClaimByGiveaway(client, req.params.giveawayId);
    if (!claim) return res.status(404).json({ error: 'No claim exists for this giveaway.' });

    const role = await claims.resolveRole(client, claim, req.userId);
    if (!role) return res.status(403).json({ error: "You don't have access to this claim." });

    const view = { ...baseClaimView(claim), role };

    if (role === ROLES.HOST) {
      // The host sees delivery details only after the winner consented, only
      // the fields needed to deliver, and only until retention erases them.
      view.delivery = claims.hostVisibleDelivery(claim);
    } else if (role === ROLES.WINNER) {
      view.delivery = claims.hostVisibleDelivery(claim);
    } else if (role === ROLES.ADMIN) {
      // An administrator gets the details only while actually intervening —
      // a dispute or an expired claim. Not as a matter of course.
      view.delivery =
        claim.status === STATES.DISPUTED || claim.status === STATES.EXPIRED
          ? claims.hostVisibleDelivery(claim)
          : { available: false, reason: 'not_required' };
    }

    const history = await client.query(
      `SELECT from_status, to_status, actor_role, note, created_at
         FROM prize_claim_events WHERE claim_id = $1 ORDER BY created_at ASC`,
      [claim.id]
    );
    view.history = history.rows;

    res.set('Cache-Control', 'no-store');
    res.json(view);
  } catch (err) {
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Moving a claim along
// ---------------------------------------------------------------------------

// One endpoint for every state change, because there is one state machine.
// Which moves are legal, and who may make them, live in
// server/lib/claimStateMachine.js rather than being spread across a route per
// verb where one of them can quietly disagree with the others.
router.post('/:id/transition', claimActionLimiter, requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { to, note } = req.body || {};

    await client.query('BEGIN');

    const existing = await claims.getClaimById(client, req.params.id);
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This claim does not exist.' });
    }

    const role = await claims.resolveRole(client, existing, req.userId);
    if (!role) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "You don't have access to this claim." });
    }

    // Fulfilment pauses while an integrity case is open on this giveaway.
    //
    // The winner is not replaced, the claim is not cancelled and nothing is
    // redrawn — the delivery simply does not advance until a human has decided.
    // Raising a dispute stays available on purpose: pausing the process must not
    // also mute the person waiting on it.
    if (to !== STATES.DISPUTED && (await integrity.hasBlockingCase(client, existing.giveaway_id))) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          'This giveaway is under integrity review. Delivery steps are paused until an administrator resolves it — the winner and this claim are unchanged.',
        code: 'INTEGRITY_REVIEW_OPEN',
      });
    }

    // A dispute and an admin resolution both have to say why. An unexplained
    // dispute is unresolvable, and an unexplained resolution is unauditable.
    const needsReason =
      to === STATES.DISPUTED || (role === ROLES.ADMIN && existing.status === STATES.DISPUTED);
    if (needsReason && (!note || !String(note).trim())) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A short reason is required.', code: 'REASON_REQUIRED' });
    }

    const extra = {};
    if (to === STATES.DISPUTED) extra.disputed_by = req.userId;
    if (role === ROLES.ADMIN && existing.status === STATES.DISPUTED) {
      extra.resolved_by = req.userId;
      extra.resolved_at = new Date();
    }

    const { claim } = await claims.transition(client, {
      claimId: req.params.id,
      to,
      role,
      actorUserId: req.userId,
      note,
      extra,
    });

    // The public delivery flag on the giveaway follows the claim rather than
    // leading it, so the trust signal on the giveaway page can only say
    // "delivered" once the winner has said so.
    if (to === STATES.DELIVERED) {
      await client.query(
        'UPDATE giveaways SET prize_delivered = TRUE, prize_delivered_at = NOW() WHERE id = $1',
        [claim.giveaway_id]
      );
    }

    const context = await client.query(
      `SELECT g.title, winner.name AS winner_name, winner.email AS winner_email,
              hostuser.name AS host_name, hostuser.email AS host_email
         FROM giveaways g
         JOIN users hostuser ON hostuser.id = g.host_id
         JOIN users winner ON winner.id = $2
        WHERE g.id = $1`,
      [claim.giveaway_id, claim.winner_user_id]
    );

    await client.query('COMMIT');

    res.set('Cache-Control', 'no-store');
    res.json(baseClaimView(claim));

    // Sent after the commit and never awaited — see the note in /redeem.
    const info = context.rows[0];
    if (info) {
      const audience = role === ROLES.WINNER ? info.host_email : info.winner_email;
      const audienceName = role === ROLES.WINNER ? info.host_name : info.winner_name;
      sendEmail({
        to: audience,
        subject: `Update on ${info.title}`,
        html: claimStatusHtml({
          recipientName: audienceName,
          giveawayTitle: info.title,
          status: claim.status,
          message: 'Sign in to see the details and what happens next.',
          giveawayUrl: `${APP_URL}/giveaway.html?id=${claim.giveaway_id}`,
        }),
      });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

// Everything a human needs to look at: disputes, and claims whose window ran
// out. Deliberately carries no delivery details — an admin list is the last
// place a page full of home addresses should appear.
router.get('/admin/review', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    // Cheap, idempotent, and keeps the queue honest without needing a cron.
    await client.query('BEGIN');
    await claims.expireLapsedClaims(client);
    await claims.eraseExpiredDeliveryDetails(client);
    await client.query('COMMIT');

    const result = await client.query(
      `SELECT c.id, c.giveaway_id, c.status, c.disputed_at, c.expired_at, c.created_at,
              g.title, winner.name AS winner_name, hostuser.name AS host_name
         FROM prize_claims c
         JOIN giveaways g ON g.id = c.giveaway_id
         JOIN users winner ON winner.id = c.winner_user_id
         JOIN users hostuser ON hostuser.id = g.host_id
        WHERE c.status = ANY($1)
        ORDER BY COALESCE(c.disputed_at, c.expired_at) ASC`,
      [[STATES.DISPUTED, STATES.EXPIRED]]
    );

    res.set('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// Reissues a claim link to the same winner.
//
// Never picks a different winner: the draw already happened, and redrawing
// would take a prize from the person who actually won it. Used after an expired
// claim has been reviewed, or when a winner says the email never arrived.
//
// The new token is issued by the outbox worker as part of sending, not here.
// Between invalidating the old one and the send succeeding, no token is valid
// at all — the safe direction to be wrong in.
router.post('/:id/admin/reissue', claimActionLimiter, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await claims.getClaimById(client, req.params.id);
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This claim does not exist.' });
    }

    // An expired claim goes back to awaiting_claim; one that is merely
    // undelivered stays where it is and just gets a fresh link.
    if (existing.status === STATES.EXPIRED) {
      await claims.transition(client, {
        claimId: req.params.id,
        to: STATES.AWAITING_CLAIM,
        role: ROLES.ADMIN,
        actorUserId: req.userId,
        note: req.body && req.body.note ? req.body.note : 'claim link reissued after review',
        extra: { expired_at: null },
      });
    }

    // Every previous token dies here, used or not.
    await claims.invalidateTokens(client, req.params.id);
    await notifications.requeueInvitation(client, req.params.id);
    await client.query(
      'UPDATE prize_claims SET invitation_sent_at = NULL, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');

    // Awaited: an admin clicking "resend" should be told whether it worked.
    const summary = await notifications.processDueNotifications({ appUrl: APP_URL });

    const refreshed = await claims.getClaimById(pool, req.params.id);
    const state = await notifications.notificationStateFor(pool, req.params.id);

    res.set('Cache-Control', 'no-store');
    res.json({
      ...baseClaimView(refreshed),
      invitation: state,
      delivery_attempted: summary.attempted,
      delivery_succeeded: summary.delivered,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// Creates a claim for a giveaway drawn before this workflow existed, or whose
// claim was never created. Reads the winner the draw already chose — it does
// not, and cannot, pick one.
router.post('/admin/backfill/:giveawayId', claimActionLimiter, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { created, claim } = await claims.backfillClaimForGiveaway(client, req.params.giveawayId);
    if (created) {
      await notifications.queueInvitation(client, claim.id);
      // A backfilled claim for a suspended host's giveaway needs a rescuer from
      // the moment it exists — no suspension event is going to come along later
      // and queue it.
      await rescue.ensureRescueForClaim(client, claim.id, {
        reason: 'Claim backfilled for a suspended host.',
      });
    }
    await client.query('COMMIT');

    let summary = null;
    if (created) {
      summary = await notifications.processDueNotifications({ appUrl: APP_URL });
    }

    res.set('Cache-Control', 'no-store');
    res.status(created ? 201 : 200).json({
      created,
      ...baseClaimView(claim),
      invitation: await notifications.notificationStateFor(pool, claim.id),
      delivery_succeeded: summary ? summary.delivered : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Rescuing a suspended host's claims
// ---------------------------------------------------------------------------

// The rescue queue: every unfinished claim whose host is suspended.
//
// Populated automatically inside the suspension transaction, so an
// administrator never has to notice the problem, and a winner is never expected
// to. Carries no delivery details, no ciphertext, no address and no phone —
// only whether details exist and could be opened. See the note on the review
// queue above: a list is the last place a page of home addresses belongs.
router.get('/admin/rescue-queue', requireAdmin, async (req, res) => {
  try {
    const rows = await rescue.listOpenRescues(pool);
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (err) {
    return claimError(res, err);
  }
});

// An administrator taking one host-side step on behalf of a suspended host.
//
// Separate from the ordinary transition endpoint on purpose. Rescue is a
// distinct authority with a distinct answer to "who is allowed", and folding it
// into the generic route would mean every administrator implicitly carried
// host powers over every claim. Here they carry them only when the host really
// is suspended and the claim really is waiting on a host — both re-read from
// the database inside this request, neither taken from the queue row.
router.post('/:id/rescue/transition', claimActionLimiter, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { to, reason } = req.body || {};

    // A rescue is somebody acting in another party's place. It is exactly the
    // kind of action that needs to say why, every time — not only when it goes
    // wrong.
    if (!reason || !String(reason).trim()) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({
        error: 'A short reason is required for a rescue action.',
        code: 'REASON_REQUIRED',
      });
    }

    await client.query('BEGIN');

    // Throws 403/409 with a code. Does not consult the queue: a queue row is
    // work to do, not a permission.
    const allowed = await rescue.assertRescueAllowed(client, {
      claimId: req.params.id,
      adminUserId: req.userId,
    });

    // The rescue path is a fulfilment step too, so an open integrity case pauses
    // it for the same reason it pauses the host's own steps. An administrator
    // acting for an absent host is still shipping a prize that is under review.
    const claimRow = await claims.getClaimById(client, req.params.id);
    if (claimRow && (await integrity.hasBlockingCase(client, claimRow.giveaway_id))) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          'This giveaway is under integrity review. Fulfilment is paused until an administrator resolves it.',
        code: 'INTEGRITY_REVIEW_OPEN',
      });
    }

    const { claim } = await claims.transition(client, {
      claimId: req.params.id,
      to,
      role: ROLES.ADMIN_RESCUE,
      actorUserId: req.userId,
      note: String(reason).trim(),
    });

    const context = await client.query(
      `SELECT g.title, winner.name AS winner_name, winner.email AS winner_email
         FROM giveaways g
         JOIN users winner ON winner.id = $2
        WHERE g.id = $1`,
      [claim.giveaway_id, claim.winner_user_id]
    );

    await client.query('COMMIT');

    res.set('Cache-Control', 'no-store');
    res.json({ ...baseClaimView(claim), acted_as: ROLES.ADMIN_RESCUE });

    // The winner is told what happened, by the same route as any other status
    // change and carrying no more than any other one does.
    const info = context.rows[0];
    if (info) {
      sendEmail({
        to: info.winner_email,
        subject: `Update on ${info.title}`,
        html: claimStatusHtml({
          recipientName: info.winner_name,
          giveawayTitle: info.title,
          status: claim.status,
          message: 'Sign in to see the details and what happens next.',
          giveawayUrl: `${APP_URL}/giveaway.html?id=${claim.giveaway_id}`,
        }),
      });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// Opening the winner's delivery details for one claim, deliberately.
//
// A POST with a reason in the body, not a GET: this is an action that leaves a
// record, not a page to browse. Nothing about it appears in the queue above, so
// an administrator who never needs an address never sees one.
//
// Refused unless the winner actually consented, and refused outright once
// retention has erased the details — an erased address stays erased, and a
// rescue is not a way to reach behind that.
router.post('/:id/rescue/delivery-details', claimActionLimiter, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        error: 'A short reason is required before delivery details can be opened.',
        code: 'REASON_REQUIRED',
      });
    }

    await client.query('BEGIN');
    await rescue.assertRescueAllowed(client, { claimId: req.params.id, adminUserId: req.userId });

    const claim = await claims.getClaimById(client, req.params.id);
    const delivery = claims.hostVisibleDelivery(claim);
    if (!delivery.available) {
      await client.query('ROLLBACK');
      res.set('Cache-Control', 'no-store');
      return res.status(409).json({
        error:
          delivery.reason === 'erased'
            ? 'These delivery details have been erased under the retention policy and cannot be recovered.'
            : 'The winner has not supplied delivery details for this claim yet.',
        code: delivery.reason === 'erased' ? 'DELIVERY_ERASED' : 'DELIVERY_UNAVAILABLE',
      });
    }

    // Audited in the claim's own history, alongside every state change. The
    // from and to statuses are the same because nothing moved — the record is
    // that somebody looked, not that something changed. The note carries the
    // administrator's reason and nothing about the address itself.
    await claimEvents.recordEvent(client, {
      claimId: req.params.id,
      from: claim.status,
      to: claim.status,
      actorUserId: req.userId,
      actorRole: `${ROLES.ADMIN_RESCUE}:delivery_details_opened`,
      note: String(reason).trim(),
    });

    await client.query('COMMIT');

    // no-store, because a proxy or a browser cache holding a winner's address
    // is the same leak as logging it.
    res.set('Cache-Control', 'no-store');
    res.json({
      claim_id: claim.id,
      status: claim.status,
      delivery,
      opened_for: 'suspended_host_rescue',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return claimError(res, err);
  } finally {
    client.release();
  }
});

// Drawn giveaways with no claim at all — the backlog an operator needs to work
// through after deploying this workflow.
router.get('/admin/missing-claims', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.id AS giveaway_id, g.title, g.entry_deadline, u.name AS winner_name
         FROM giveaways g
         JOIN entries e ON e.id = g.winner_entry_id
         JOIN users u ON u.id = e.user_id
         LEFT JOIN prize_claims c ON c.giveaway_id = g.id
        WHERE g.status = 'drawn' AND g.winner_entry_id IS NOT NULL AND c.id IS NULL
        ORDER BY g.entry_deadline DESC`
    );
    res.set('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err) {
    return claimError(res, err);
  }
});

// On-demand maintenance. The automatic path is a scheduler inside the process
// (server/lib/claimScheduler.js) with no route of its own, so retention does not
// depend on anybody visiting this.
router.post('/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const summary = await runMaintenanceOnce({});
    res.set('Cache-Control', 'no-store');
    res.json(summary);
  } catch (err) {
    return claimError(res, err);
  }
});

module.exports = router;
