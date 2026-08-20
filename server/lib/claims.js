// Claim persistence: authorization, state changes, and retention.
//
// Everything that decides who may do what reads the database on the request
// that is doing it. Nothing here trusts a role, an id or a status supplied by
// the browser.
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const {
  STATES,
  ROLES,
  TERMINAL,
  PUBLIC_STATUS,
  assertTransition,
  ClaimTransitionError,
} = require('./claimStateMachine');
const { issueToken, hashToken } = require('./claimTokens');
const { encryptDeliveryDetails, decryptDeliveryDetails } = require('./claimCrypto');
const { recordEvent } = require('./claimEvents');
const { canHost } = require('./hostAccess');
const { closeRescueForClaim } = require('./claimRescue');

// Bumped whenever the wording a winner agrees to changes, so a consent given
// under old wording is distinguishable from one given under new wording.
const CONSENT_VERSION = 'winner-delivery-2026-08';

const DEFAULT_RETENTION_DAYS = 30;

function deliveryRetentionDays() {
  const configured = Number(process.env.CLAIM_DELIVERY_RETENTION_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
}

// Resolved from the database every time. A user can hold more than one relation
// to a claim in principle (an admin who is also the host), and the most
// specific one wins for fulfilment actions — an admin acting on their own
// giveaway is acting as its host.
//
// Owning the giveaway is necessary for the host role but no longer sufficient:
// the account must also still hold host access. A host who is suspended or
// rejected stops being able to see the winner's delivery details or move the
// claim along from the moment the status changes, without anything being
// deleted. Their giveaways, claims and history are all still there.
//
// The consequence is deliberate and worth stating plainly: suspending a host
// with an open claim hands that claim to administrators. The winner can raise a
// dispute, and an administrator resolves it — see docs/HOST_ACCESS.md.
async function resolveRole(client, claim, userId) {
  if (!userId) return null;

  if (claim.winner_user_id === userId) return ROLES.WINNER;

  const giveaway = await client.query('SELECT host_id FROM giveaways WHERE id = $1', [
    claim.giveaway_id,
  ]);
  if (giveaway.rows[0] && giveaway.rows[0].host_id === userId) {
    if (await canHost(client, userId)) return ROLES.HOST;
    return null;
  }

  const user = await client.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  if (user.rows[0] && user.rows[0].is_admin) return ROLES.ADMIN;

  return null;
}

async function getClaimByGiveaway(client, giveawayId) {
  const result = await client.query('SELECT * FROM prize_claims WHERE giveaway_id = $1', [
    giveawayId,
  ]);
  return result.rows[0] || null;
}

async function getClaimById(client, claimId) {
  const result = await client.query('SELECT * FROM prize_claims WHERE id = $1', [claimId]);
  return result.rows[0] || null;
}

// The same read, with the row locked for the rest of the caller's transaction.
//
// `getClaimById` is a plain read, which is right for the many callers that only
// display a claim. It is wrong for a caller that then DECIDES something from
// what it read: two concurrent administrators reissuing the same claim both read
// the same state, both conclude the same thing, and the second one acts on a
// picture that stopped being true while it waited.
//
// The reissue route did exactly that. It read the claim without a lock,
// invalidated every token, requeued the notification and cleared
// `invitation_sent_at` — taking its first lock several statements in, by which
// time its decision was already made. Locking the claim first makes the two
// requests serial from the start, so the second reads the first one's result
// rather than racing it.
async function lockClaimById(client, claimId) {
  const result = await client.query('SELECT * FROM prize_claims WHERE id = $1 FOR UPDATE', [claimId]);
  return result.rows[0] || null;
}

// Created the moment a winner is drawn, along with the token that lets them
// claim without signing in.
async function createClaimForDraw(client, { giveawayId, winnerUserId, entryId }) {
  const id = uuid();
  const { token, tokenHash, expiresAt } = issueToken();

  await client.query(
    `INSERT INTO prize_claims
       (id, giveaway_id, winner_user_id, entry_id, status,
        token_hash, token_expires_at, token_issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [id, giveawayId, winnerUserId, entryId, STATES.AWAITING_CLAIM, tokenHash, expiresAt]
  );

  await recordEvent(client, {
    claimId: id,
    from: null,
    to: STATES.AWAITING_CLAIM,
    actorUserId: null,
    actorRole: ROLES.SYSTEM,
    note: 'winner drawn',
  });

  // The plaintext token is returned exactly once, for the email. It is not
  // stored and never returned again.
  return { id, token, expiresAt };
}

// Creates a claim for a giveaway that was drawn before this workflow existed,
// or whose claim was somehow never created.
//
// Never picks a winner: it reads the winner the draw already chose, from
// winner_entry_id. If a giveaway has no drawn winner there is nothing to claim
// and it refuses — the one thing this must never do is quietly decide who won.
//
// Idempotent and safe under concurrency: the UNIQUE constraint on giveaway_id
// means a second simultaneous attempt cannot create a duplicate, and the
// advisory-free ON CONFLICT path simply returns the existing claim.
async function backfillClaimForGiveaway(client, giveawayId) {
  const giveaway = await client.query(
    `SELECT g.id, g.status, g.winner_entry_id, e.user_id AS winner_user_id
       FROM giveaways g
       LEFT JOIN entries e ON e.id = g.winner_entry_id
      WHERE g.id = $1
      FOR UPDATE OF g`,
    [giveawayId]
  );
  const row = giveaway.rows[0];
  if (!row) {
    throw new ClaimTransitionError('This giveaway does not exist.', { status: 404, code: 'NOT_FOUND' });
  }
  if (row.status !== 'drawn' || !row.winner_entry_id || !row.winner_user_id) {
    throw new ClaimTransitionError(
      'This giveaway has no drawn winner, so there is nothing to claim. Draw a winner first — a claim never chooses one.',
      { status: 409, code: 'NO_WINNER' }
    );
  }

  const existing = await client.query('SELECT * FROM prize_claims WHERE giveaway_id = $1', [giveawayId]);
  if (existing.rowCount > 0) {
    return { created: false, claim: existing.rows[0] };
  }

  const created = await createClaimForDraw(client, {
    giveawayId,
    winnerUserId: row.winner_user_id,
    entryId: row.winner_entry_id,
  });
  const claim = await getClaimById(client, created.id);
  return { created: true, claim };
}

// Invalidates every previous token for a claim and issues nothing in its place.
//
// Used before queueing a fresh invitation: the outbox worker writes the new
// token as part of its send, so between these two steps no token is valid at
// all — which is the safe direction to be wrong in.
async function invalidateTokens(client, claimId) {
  await client.query(
    `UPDATE prize_claims
        SET token_hash = NULL, token_expires_at = NULL, token_used_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [claimId]
  );
}

// Column touched by each transition, so "when did this happen" is answerable
// per state rather than only from the event log.
const TIMESTAMP_COLUMN = {
  [STATES.CLAIMED]: 'claimed_at',
  [STATES.PREPARING_DELIVERY]: 'preparing_at',
  [STATES.SHIPPED_OR_ARRANGED]: 'shipped_at',
  [STATES.DELIVERED_PENDING_CONFIRMATION]: 'delivery_reported_at',
  [STATES.DELIVERED]: 'delivered_at',
  [STATES.DISPUTED]: 'disputed_at',
  [STATES.EXPIRED]: 'expired_at',
  [STATES.CANCELLED]: 'cancelled_at',
};

// The only way a claim changes state. Locks the row, re-reads the current
// status inside the transaction, and validates the move against that — so two
// simultaneous requests cannot both act on a status that only one of them saw.
async function transition(client, { claimId, to, role, actorUserId, note, extra = {} }) {
  const locked = await client.query('SELECT * FROM prize_claims WHERE id = $1 FOR UPDATE', [claimId]);
  const claim = locked.rows[0];
  if (!claim) {
    throw new ClaimTransitionError('This claim does not exist.', { status: 404, code: 'NOT_FOUND' });
  }

  assertTransition(claim.status, to, role);

  const sets = ['status = $2', 'updated_at = NOW()'];
  const values = [claimId, to];
  const stamp = TIMESTAMP_COLUMN[to];
  if (stamp) sets.push(`${stamp} = NOW()`);

  Object.entries(extra).forEach(([column, value]) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  });

  const updated = await client.query(
    `UPDATE prize_claims SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );

  await recordEvent(client, {
    claimId,
    from: claim.status,
    to,
    actorUserId,
    actorRole: role,
    note,
  });

  // A finished claim is nobody's outstanding work, including a rescuer's. Done
  // here rather than in the routes so it holds for every path that can finish a
  // claim — winner confirmation, admin resolution of a dispute, cancellation —
  // instead of only the ones somebody remembered to wire up.
  if (TERMINAL.has(to)) {
    await closeRescueForClaim(client, claimId, {
      reason: `Claim reached ${to}.`,
      closedBy: actorUserId,
    });
  }

  return { previous: claim, claim: updated.rows[0] };
}

// Redeeming a claim token and creating the claim record are one statement.
//
// The guard clauses are in the WHERE rather than in JavaScript on purpose: two
// simultaneous submissions of the same link both run this, and only the first
// matches a row with token_used_at still NULL. The second sees zero rows
// affected and is told the link has already been used — rather than both
// succeeding, or one overwriting the other's delivery details.
async function redeemToken(client, { token, deliveryDetails, consentVersion }) {
  const encrypted = encryptDeliveryDetails(deliveryDetails);

  const result = await client.query(
    `UPDATE prize_claims
        SET status = $2,
            token_used_at = NOW(),
            token_hash = NULL,
            claimed_at = NOW(),
            consent_version = $3,
            consented_at = NOW(),
            delivery_ciphertext = $4,
            delivery_iv = $5,
            delivery_tag = $6,
            delivery_key_version = $7,
            updated_at = NOW()
      WHERE token_hash = $1
        AND token_used_at IS NULL
        AND token_expires_at > NOW()
        AND status = $8
      RETURNING *`,
    [
      hashToken(token),
      STATES.CLAIMED,
      consentVersion,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      encrypted.keyVersion,
      STATES.AWAITING_CLAIM,
    ]
  );

  if (result.rowCount === 0) return null;

  const claim = result.rows[0];
  await recordEvent(client, {
    claimId: claim.id,
    from: STATES.AWAITING_CLAIM,
    to: STATES.CLAIMED,
    actorUserId: claim.winner_user_id,
    actorRole: ROLES.WINNER,
    note: `consent ${consentVersion}`,
  });
  return claim;
}

// Non-consuming: shows the winner what they are claiming before they fill the
// form in. Returns nothing sensitive and does not mark the token used.
async function lookupByToken(client, token) {
  const result = await client.query(
    `SELECT c.id, c.status, c.token_expires_at,
            g.title, g.prize_description, g.image_url, g.funded_by,
            hostuser.name AS host_name
       FROM prize_claims c
       JOIN giveaways g ON g.id = c.giveaway_id
       JOIN users hostuser ON hostuser.id = g.host_id
      WHERE c.token_hash = $1
        AND c.token_used_at IS NULL
        AND c.token_expires_at > NOW()
        AND c.status = $2`,
    [hashToken(token), STATES.AWAITING_CLAIM]
  );
  return result.rows[0] || null;
}

// What a host is allowed to see, and when.
//
// Before consent: nothing but the status. After consent: the minimum needed to
// physically deliver something. After retention erases it: the status again.
// The host never receives the winner's account email, and never receives
// anything at all through an API response that isn't this one.
function hostVisibleDelivery(claim) {
  if (claim.delivery_erased_at) {
    return { available: false, reason: 'erased' };
  }
  if (!claim.consented_at || !claim.delivery_ciphertext) {
    return { available: false, reason: 'awaiting_consent' };
  }
  const details = decryptDeliveryDetails({
    ciphertext: claim.delivery_ciphertext,
    iv: claim.delivery_iv,
    tag: claim.delivery_tag,
    keyVersion: claim.delivery_key_version,
  });
  return {
    available: true,
    consentVersion: claim.consent_version,
    consentedAt: claim.consented_at,
    details: {
      recipient_name: details.recipient_name,
      phone: details.phone,
      address_line1: details.address_line1,
      address_line2: details.address_line2 || null,
      city: details.city,
      emirate: details.emirate,
      notes: details.notes || null,
    },
  };
}

// Claims whose window ran out.
//
// Deliberately does NOT redraw and does NOT cancel. Someone won; whether they
// missed the email, changed address, or never opened it is a question a person
// has to answer, and an automatic redraw would quietly take a prize away from
// the person who actually won it.
//
// Idempotent: only matches claims still awaiting a claim with an expired token,
// so running it twice changes nothing the second time.
async function expireLapsedClaims(client) {
  const result = await client.query(
    `UPDATE prize_claims
        SET status = $1, expired_at = NOW(), token_hash = NULL, updated_at = NOW()
      WHERE status = $2
        AND token_expires_at IS NOT NULL
        AND token_expires_at <= NOW()
      RETURNING id`,
    [STATES.EXPIRED, STATES.AWAITING_CLAIM]
  );

  for (const row of result.rows) {
    await recordEvent(client, {
      claimId: row.id,
      from: STATES.AWAITING_CLAIM,
      to: STATES.EXPIRED,
      actorUserId: null,
      actorRole: ROLES.SYSTEM,
      note: 'claim window expired — needs admin review',
    });
  }
  return result.rowCount;
}

// Erases delivery details once they are no longer needed.
//
// The claim, its history and the fact of delivery all survive; the address and
// phone number do not. Idempotent and concurrency-safe: a single UPDATE that
// only matches rows still holding ciphertext, so a second run — or two runs at
// once — affects nothing.
//
// The period is provisional and configurable, and is one of the things UAE
// counsel needs to confirm.
async function eraseExpiredDeliveryDetails(client, { days = deliveryRetentionDays() } = {}) {
  const result = await client.query(
    `UPDATE prize_claims
        SET delivery_ciphertext = NULL,
            delivery_iv = NULL,
            delivery_tag = NULL,
            delivery_key_version = NULL,
            delivery_erased_at = NOW(),
            updated_at = NOW()
      WHERE delivery_ciphertext IS NOT NULL
        AND status = ANY($1)
        AND COALESCE(delivered_at, resolved_at, cancelled_at) IS NOT NULL
        AND COALESCE(delivered_at, resolved_at, cancelled_at) < NOW() - ($2 || ' days')::interval
      RETURNING id`,
    [[STATES.DELIVERED, STATES.CANCELLED], String(days)]
  );

  for (const row of result.rows) {
    await recordEvent(client, {
      claimId: row.id,
      from: null,
      to: 'delivery_details_erased',
      actorUserId: null,
      actorRole: ROLES.SYSTEM,
      note: `retention: ${days} days`,
    });
  }
  return result.rowCount;
}

function publicStatusFor(status) {
  return PUBLIC_STATUS[status] || null;
}

module.exports = {
  CONSENT_VERSION,
  backfillClaimForGiveaway,
  invalidateTokens,
  DEFAULT_RETENTION_DAYS,
  deliveryRetentionDays,
  resolveRole,
  getClaimByGiveaway,
  getClaimById,
  lockClaimById,
  createClaimForDraw,
  recordEvent,
  transition,
  redeemToken,
  lookupByToken,
  hostVisibleDelivery,
  expireLapsedClaims,
  eraseExpiredDeliveryDetails,
  publicStatusFor,
};
