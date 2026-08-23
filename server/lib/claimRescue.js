// Rescuing a prize claim whose host was suspended mid-delivery.
//
// The problem this exists for: suspending a host is a decision the platform
// makes about the host, and the winner had nothing to do with it. The first cut
// of host access left the winner to notice the delivery had stalled and open a
// dispute — using the complaints mechanism to repair an internal decision, and
// only if they worked out that something was wrong. That is not a recovery
// path; it is a hope.
//
// So: the moment a host is suspended, every unfinished claim of theirs is put
// in front of a human automatically, and an administrator may take over exactly
// the moves the absent host would have made — prepare, ship, report delivered.
// Not one move more. In particular a rescuer cannot claim on the winner's
// behalf and cannot confirm receipt on the winner's behalf, because those two
// are statements only the winner is in a position to make. Winner confirmation
// remains the only route to `delivered` outside a dispute.
//
// A queue row is work to do, not a permission. Whether a rescue action is
// allowed is re-derived from the database on every single request: the host
// must be suspended *now*, and the claim must be in an eligible state *now*.

const { randomUUID } = require('node:crypto');
const { pool } = require('../db');
const {
  STATES,
  ROLES,
  ACTIVE_STATES,
  RESCUE_ELIGIBLE_STATES,
  ClaimTransitionError,
} = require('./claimStateMachine');

const HOST_SUSPENDED = 'suspended';

const ACTIVE_STATE_LIST = [...ACTIVE_STATES];
const RESCUE_STATE_LIST = [...RESCUE_ELIGIBLE_STATES];

// Opens a queue item for every unfinished claim belonging to this host.
//
// Idempotent by construction: the insert selects the claims that need a row and
// collides with the partial unique index for any that already have one. Calling
// it twice, or from two connections at once, produces the same single row.
// Returns how many were newly opened, which the suspending administrator is
// shown so nobody suspends a host without being told what they just took on.
async function openRescuesForHost(client, { hostUserId, reason, openedBy }) {
  const result = await client.query(
    `INSERT INTO claim_rescue_queue (id, claim_id, giveaway_id, host_user_id, opened_reason, opened_by)
     SELECT md5(random()::text || clock_timestamp()::text || c.id), c.id, c.giveaway_id, g.host_id, $2, $3
       FROM prize_claims c
       JOIN giveaways g ON g.id = c.giveaway_id
       JOIN users h ON h.id = g.host_id
      WHERE g.host_id = $1
        AND c.status = ANY($4)
        AND h.host_status = $5
        -- An administrator is exempt from the host gate, so their own
        -- host_status never makes them unavailable and there is nothing to
        -- rescue from them.
        AND h.is_admin = FALSE
     ON CONFLICT (claim_id) WHERE status = 'open' DO NOTHING
     RETURNING id`,
    [
      hostUserId,
      reason ? String(reason).slice(0, 500) : null,
      openedBy || null,
      ACTIVE_STATE_LIST,
      HOST_SUSPENDED,
    ]
  );
  return result.rowCount;
}

// The same thing for one claim, used where a claim becomes active *after* a
// suspension — a winner opening a link that was already in flight, or an
// administrator backfilling a claim for a suspended host's old giveaway.
async function ensureRescueForClaim(client, claimId, { reason, openedBy } = {}) {
  const result = await client.query(
    `INSERT INTO claim_rescue_queue (id, claim_id, giveaway_id, host_user_id, opened_reason, opened_by)
     SELECT $2, c.id, c.giveaway_id, g.host_id, $3, $4
       FROM prize_claims c
       JOIN giveaways g ON g.id = c.giveaway_id
       JOIN users h ON h.id = g.host_id
      WHERE c.id = $1
        AND c.status = ANY($5)
        AND h.host_status = $6
        AND h.is_admin = FALSE
     ON CONFLICT (claim_id) WHERE status = 'open' DO NOTHING
     RETURNING id`,
    [
      claimId,
      randomUUID(),
      reason ? String(reason).slice(0, 500) : null,
      openedBy || null,
      ACTIVE_STATE_LIST,
      HOST_SUSPENDED,
    ]
  );
  return result.rowCount > 0;
}

// Closes every open item for a host. Called when their access is restored:
// the host is back, so the work is theirs again.
async function closeRescuesForHost(client, { hostUserId, reason, closedBy }) {
  const result = await client.query(
    `UPDATE claim_rescue_queue
        SET status = 'closed', closed_at = NOW(), closed_reason = $2, closed_by = $3
      WHERE host_user_id = $1 AND status = 'open'
      RETURNING id`,
    [hostUserId, reason ? String(reason).slice(0, 500) : null, closedBy || null]
  );
  return result.rowCount;
}

// Closes the item for one claim, called when that claim reaches a state where
// there is nothing left for anyone to rescue.
async function closeRescueForClaim(client, claimId, { reason, closedBy } = {}) {
  const result = await client.query(
    `UPDATE claim_rescue_queue
        SET status = 'closed', closed_at = NOW(), closed_reason = $2, closed_by = $3
      WHERE claim_id = $1 AND status = 'open'
      RETURNING id`,
    [claimId, reason ? String(reason).slice(0, 500) : null, closedBy || null]
  );
  return result.rowCount > 0;
}

// The queue an administrator sees.
//
// Carries no delivery details, no encrypted payload, no address and no phone
// number — not even a redacted one. A list is a screen that gets left open and
// screenshotted; the winner's address has no business being on it. Opening the
// details for one claim is a separate, deliberate, audited request.
async function listOpenRescues(client = pool) {
  const result = await client.query(
    `SELECT q.id, q.claim_id, q.giveaway_id, q.opened_at, q.opened_reason,
            c.status AS claim_status,
            c.claimed_at, c.shipped_at, c.delivery_reported_at,
            (c.delivery_ciphertext IS NOT NULL AND c.delivery_erased_at IS NULL
             AND c.consented_at IS NOT NULL) AS delivery_available,
            g.title,
            hostuser.name AS host_name, hostuser.host_status,
            winner.name AS winner_name,
            opener.name AS opened_by_name
       FROM claim_rescue_queue q
       JOIN prize_claims c ON c.id = q.claim_id
       JOIN giveaways g ON g.id = q.giveaway_id
       JOIN users hostuser ON hostuser.id = q.host_user_id
       JOIN users winner ON winner.id = c.winner_user_id
       LEFT JOIN users opener ON opener.id = q.opened_by
      WHERE q.status = 'open'
      ORDER BY q.opened_at ASC`
  );

  return result.rows.map((row) => ({
    ...row,
    // Whether a rescuer can actually do something right now, rather than
    // leaving an administrator to work it out from the state name.
    action_available: RESCUE_ELIGIBLE_STATES.has(row.claim_status) && row.host_status === HOST_SUSPENDED,
  }));
}

// The authorization decision, made fresh from the database every time.
//
// Deliberately not derived from the queue row: a queue item that was opened
// yesterday says nothing about whether the host is suspended now. Three
// independent facts have to hold, and each is read here rather than trusted
// from a caller, a session or a request body.
async function assertRescueAllowed(client, { claimId, adminUserId }) {
  const result = await client.query(
    `SELECT c.id, c.status AS claim_status, g.host_id,
            hostuser.host_status, hostuser.is_admin AS host_is_admin,
            actor.is_admin AS actor_is_admin
       FROM prize_claims c
       JOIN giveaways g ON g.id = c.giveaway_id
       JOIN users hostuser ON hostuser.id = g.host_id
       LEFT JOIN users actor ON actor.id = $2
      WHERE c.id = $1`,
    [claimId, adminUserId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new ClaimTransitionError('This claim does not exist.', { status: 404, code: 'NOT_FOUND' });
  }

  // 1. The actor is an administrator, per the database on this request.
  if (!row.actor_is_admin) {
    throw new ClaimTransitionError("You don't have access to this claim.", {
      status: 403,
      code: 'NOT_ADMIN',
    });
  }

  // 2. The host is unavailable *now*. A reinstated host does their own work,
  //    and an administrator does not get to take over a claim from a host who
  //    is perfectly able to handle it.
  if (row.host_status !== HOST_SUSPENDED || row.host_is_admin) {
    throw new ClaimTransitionError(
      'This claim\'s host is not suspended, so there is nothing to take over. Ask the host to act, or use a dispute.',
      { status: 409, code: 'HOST_NOT_SUSPENDED' }
    );
  }

  // 3. The claim is somewhere a host would have been the one to act.
  if (!RESCUE_ELIGIBLE_STATES.has(row.claim_status)) {
    throw new ClaimTransitionError(
      `Nothing is waiting on the host while this claim is ${row.claim_status.replace(/_/g, ' ')}.`,
      { status: 409, code: 'NOT_RESCUE_ELIGIBLE' }
    );
  }

  return { claimStatus: row.claim_status, hostId: row.host_id };
}

module.exports = {
  ROLE: ROLES.ADMIN_RESCUE,
  STATES,
  RESCUE_STATE_LIST,
  openRescuesForHost,
  ensureRescueForClaim,
  closeRescuesForHost,
  closeRescueForClaim,
  listOpenRescues,
  assertRescueAllowed,
};
