// The claim audit trail, in its own module so both the claim service and the
// notification outbox can append to it without requiring each other.
//
// Holds no delivery details by design: when retention erases an address, this
// history survives intact, which is the whole point of keeping them apart.
const { randomUUID } = require('node:crypto');

async function recordEvent(client, { claimId, from, to, actorUserId, actorRole, note }) {
  await client.query(
    `INSERT INTO prize_claim_events (id, claim_id, from_status, to_status, actor_user_id, actor_role, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      claimId,
      from,
      to,
      actorUserId || null,
      actorRole,
      // Bounded, and never anywhere an address could be pasted in.
      note ? String(note).slice(0, 500) : null,
    ]
  );
}

module.exports = { recordEvent };
