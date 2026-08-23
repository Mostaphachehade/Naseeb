// The giveaway lifecycle: publication, closing, drawing, and the one kind of
// cancellation that is allowed to exist.
//
// ---------------------------------------------------------------------------
// What this replaces
// ---------------------------------------------------------------------------
//
// A campaign used to run like this: an approved host picked any future deadline
// they liked, published instantly, and then — if they remembered — pressed a
// button to draw. If they never pressed it, nothing drew. There was no entry
// target, no automatic closure, no state between "active" and "drawn", and the
// only thing standing between an unreviewed prize and the front page was the
// host's own judgement.
//
// Now: every published campaign closes at whichever comes first, the 100th
// accepted entry or the one-calendar-month deadline, and it draws without
// anybody pressing anything.
//
// ---------------------------------------------------------------------------
// "Eligible" means two different things, and conflating them is a bug
// ---------------------------------------------------------------------------
//
// This is the most important thing in the file. The schema already had three
// hand-written variants of "eligible" and they did not agree, on purpose:
//
//   * An entry **under review** still counts as an entry. Somebody submitted it,
//     it may well be reinstated, and hiding it from the public tally would mean
//     the number on the page moved every time an administrator opened a case.
//   * An entry **under review** must not win. A winner drawn out of a pool
//     somebody is currently arguing about is a winner nobody can defend.
//
// So there are two predicates, named so they cannot be mistaken for each other,
// and each has exactly ONE definition that every caller shares:
//
//   ACCEPTED_SQL  — `integrity_status <> 'disqualified'`
//                   Counts toward the 100 target, and toward every public and
//                   dashboard tally. This is the threshold predicate.
//
//   DRAWABLE_SQL  — `integrity_status = 'eligible'`
//                   The draw pool, and nothing else.
//
// The threshold uses ACCEPTED because closure must not depend on a review
// outcome. If the 100th entry were counted as DRAWABLE, then putting one entry
// under review would drop the count to 99 and REOPEN a closed campaign — which
// would accept an entry after closure and effectively extend the deadline. Both
// are forbidden.
//
// Which is also why closure is **latched**: `entries_closed_at` is a fact
// written once, not a count recomputed on every read.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const integrity = require('./entryIntegrity');
const prizeStandard = require('./prizeStandard');

// ---------------------------------------------------------------------------
// The state model
// ---------------------------------------------------------------------------
//
// `active` and `drawn` keep their historical names — they are read in eleven
// places and asserted by every existing test, and renaming them would be churn
// with a real chance of missing a reader.
const STATUS = {
  // Submitted by a host. Not public, not enterable, not published.
  PENDING_APPROVAL: 'pending_approval',
  // Reviewed and refused. Terminal. Never publishes.
  REJECTED: 'rejected',
  // Published and accepting entries. Historically `active`.
  ACTIVE: 'active',
  // Entries closed, draw not yet run.
  CLOSED_PENDING_DRAW: 'closed_pending_draw',
  // Entries closed, draw postponed because an integrity question is open.
  PENDING_INTEGRITY_REVIEW: 'pending_integrity_review',
  // Exactly one winner. Terminal.
  DRAWN: 'drawn',
  // Closed with no eligible entry, and a recorded reason. Terminal.
  CLOSED_NO_WINNER: 'closed_no_winner',
  // Exceptional cancellation. Terminal.
  CANCELLED: 'cancelled',
};

const ALL_STATUSES = Object.values(STATUS);

// States in which the campaign is finished and nothing further happens to it.
const TERMINAL = new Set([STATUS.REJECTED, STATUS.DRAWN, STATUS.CLOSED_NO_WINNER, STATUS.CANCELLED]);

// States in which entries are closed but an outcome has not been reached.
const AWAITING_OUTCOME = [STATUS.CLOSED_PENDING_DRAW, STATUS.PENDING_INTEGRITY_REVIEW];

// The rules, as numbers in one place.
const ENTRY_TARGET = 100;
// One calendar month, not thirty days.
//
// The approved rule is "closes after one calendar month". The code enforced
// thirty days, and the public copy promised "exactly 30 days" — so the product
// and the rule disagreed in every month except June, September, November and
// April, and nobody could tell because the wording had been written to match
// the code rather than the rule.
//
// PostgreSQL's `INTERVAL '1 month'` does calendar arithmetic: 31 January plus
// one month is 28 February, and 31 March plus one month is 30 April. That is
// what "one calendar month" means to a person reading it, which is the only
// definition that matters on a page a member reads.
const ENTRY_WINDOW = "INTERVAL '1 month'";
// Kept for the lifecycle event metadata, which recorded a day count.
const ENTRY_WINDOW_LABEL = '1 month';

// Why entries closed. An allowlist: "the deadline" and "the target" are
// different facts and the record should be able to tell them apart later.
const CLOSE_REASONS = {
  TARGET_REACHED: 'entry_target_reached',
  DEADLINE_REACHED: 'closing_deadline_reached',
  CANCELLED: 'cancelled',
  // Written only by the migration, for campaigns drawn before any of this
  // existed. Never written by this module.
  BACKFILLED: 'backfilled_pre_lifecycle',
};

// Why a campaign closed with nobody winning.
const NO_WINNER_REASONS = {
  NO_ENTRIES: 'no_entries_received',
  NO_ELIGIBLE_ENTRIES: 'no_eligible_entries_after_review',
};

// Exceptional cancellation grounds. `sponsor_withdrawal` is deliberately absent,
// and its absence is enforced by a CHECK constraint as well as by this list — a
// sponsor changing their mind after publication is not a ground for stopping a
// campaign people have already entered.
const CANCELLATION_GROUNDS = {
  FULFILMENT_IMPOSSIBLE: 'fulfilment_impossible',
  UNLAWFUL: 'unlawful',
  FRAUDULENT: 'fraudulent',
  UNSAFE: 'unsafe',
  PROHIBITED_BY_AUTHORITY: 'prohibited_by_authority',
};

const CANCELLATION_GROUND_IDS = Object.values(CANCELLATION_GROUNDS);

// A sponsor asking to withdraw. Named so the refusal can be specific rather
// than a generic "unknown ground", because this is the one somebody will
// actually try.
const SPONSOR_WITHDRAWAL = 'sponsor_withdrawal';

// The entrant-facing explanation for each ground. Fixed sentences chosen by
// code — an administrator's own account of why a campaign was stopped can name
// a sponsor, an allegation or a legal instruction, and none of that belongs on
// a stranger's screen. None of these accuses anybody.
const CANCELLATION_COPY = {
  [CANCELLATION_GROUNDS.FULFILMENT_IMPOSSIBLE]:
    'This giveaway has been cancelled because the prize can no longer be provided. Your entry has not been deleted and the full record of this campaign has been kept. We are sorry — this is not the outcome we wanted either.',
  [CANCELLATION_GROUNDS.UNLAWFUL]:
    'This giveaway has been cancelled because continuing it would not be lawful. Your entry has not been deleted and the full record of this campaign has been kept.',
  [CANCELLATION_GROUNDS.FRAUDULENT]:
    'This giveaway has been cancelled following a review. Nothing here is a statement about you or your entry. Your entry has not been deleted and the full record of this campaign has been kept.',
  [CANCELLATION_GROUNDS.UNSAFE]:
    'This giveaway has been cancelled on safety grounds. Your entry has not been deleted and the full record of this campaign has been kept.',
  [CANCELLATION_GROUNDS.PROHIBITED_BY_AUTHORITY]:
    'This giveaway has been cancelled because we have been required to stop it. Your entry has not been deleted and the full record of this campaign has been kept.',
};

// ---------------------------------------------------------------------------
// The two predicates
// ---------------------------------------------------------------------------

// Counts toward the target, and toward every public tally. Identical to
// `integrity.COUNTED_SQL` by construction rather than by coincidence: it IS
// that constant, re-exported under the name this module's callers need, so a
// change to one cannot leave the other behind.
const ACCEPTED_SQL = integrity.COUNTED_SQL;

// The draw pool, and nothing else.
const DRAWABLE_SQL = `integrity_status = '${integrity.STATUS.ELIGIBLE}'`;

class LifecycleError extends Error {
  constructor(message, { status = 400, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Both counts in one query, so the threshold decision and the draw decision are
// never made from two reads taken at different moments.
async function countEntries(client, giveawayId) {
  const result = await client.query(
    `SELECT COUNT(*) FILTER (WHERE ${ACCEPTED_SQL})::int AS accepted,
            COUNT(*) FILTER (WHERE ${DRAWABLE_SQL})::int AS drawable,
            COUNT(*) FILTER (WHERE integrity_status = 'under_review')::int AS under_review,
            COUNT(*)::int AS total
       FROM entries WHERE giveaway_id = $1`,
    [giveawayId]
  );
  return result.rows[0];
}

// The closing deadline for a campaign published now. One calendar month,
// computed in the database so the deadline and the clock that will enforce it
// are the same clock.
function closesAtSql() {
  return `NOW() + ${ENTRY_WINDOW}`;
}

// ---------------------------------------------------------------------------
// Append-only history
// ---------------------------------------------------------------------------

async function recordEvent(
  client,
  { giveawayId, eventType, fromStatus, toStatus, reasonCode, adminNotes, actorUserId, actorRole, metadata }
) {
  await client.query(
    `INSERT INTO giveaway_lifecycle_events
       (id, giveaway_id, event_type, from_status, to_status, reason_code, admin_notes,
        actor_user_id, actor_role, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      uuid(),
      giveawayId,
      eventType,
      fromStatus || null,
      toStatus || null,
      reasonCode || null,
      adminNotes || null,
      actorUserId || null,
      actorRole,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

// The campaign row, locked. Every state change in this file starts here, and
// the lock order — giveaway first, then entries — is the same order
// `entryIntegrity.lockEntryForDecision` uses, so a draw and an integrity
// decision can race without deadlocking.
async function lockGiveaway(client, giveawayId) {
  const result = await client.query('SELECT * FROM giveaways WHERE id = $1 FOR UPDATE', [giveawayId]);
  const row = result.rows[0];
  if (!row) {
    throw new LifecycleError('This giveaway does not exist.', {
      status: 404,
      code: 'GIVEAWAY_NOT_FOUND',
    });
  }
  return row;
}

async function bumpVersion(client, giveawayId) {
  const result = await client.query(
    'UPDATE giveaways SET lifecycle_version = lifecycle_version + 1 WHERE id = $1 RETURNING lifecycle_version',
    [giveawayId]
  );
  return result.rows[0].lifecycle_version;
}

// ---------------------------------------------------------------------------
// Closing entries
// ---------------------------------------------------------------------------

// Closes a campaign to further entries, once, and moves it to whichever
// awaiting-outcome state is truthful.
//
// **Idempotent by the latch.** A campaign that is not `active` is already
// closed, and this reports that rather than closing it again — which is what
// makes a threshold closure racing a deadline closure produce one closure, and
// a retried worker produce none.
//
// The caller must already hold the giveaway row lock.
async function closeEntries(client, giveaway, { reason, actorUserId = null, actorRole = 'system' }) {
  if (giveaway.status !== STATUS.ACTIVE) {
    return { closed: false, alreadyClosed: true, status: giveaway.status, giveaway };
  }

  const counts = await countEntries(client, giveaway.id);

  // An entry under review means the pool is not final. Entries stop either way —
  // the deadline does not move for anybody — but the draw waits.
  const blocked =
    counts.under_review > 0 || (await integrity.hasBlockingCase(client, giveaway.id));
  const next = blocked ? STATUS.PENDING_INTEGRITY_REVIEW : STATUS.CLOSED_PENDING_DRAW;

  await client.query(
    `UPDATE giveaways
        SET status = $2,
            entries_closed_at = NOW(),
            entries_closed_reason = $3,
            entries_at_close = $4,
            lifecycle_version = lifecycle_version + 1
      WHERE id = $1`,
    [giveaway.id, next, reason, counts.accepted]
  );

  await recordEvent(client, {
    giveawayId: giveaway.id,
    eventType: 'entries_closed',
    fromStatus: giveaway.status,
    toStatus: next,
    reasonCode: reason,
    actorUserId,
    actorRole,
    // Counts and nothing else. No entrant, no ticket, no account.
    metadata: {
      accepted: counts.accepted,
      drawable: counts.drawable,
      under_review: counts.under_review,
      entry_target: giveaway.entry_target,
    },
  });

  if (blocked) {
    await recordEvent(client, {
      giveawayId: giveaway.id,
      eventType: 'draw_postponed_pending_review',
      fromStatus: next,
      toStatus: next,
      actorRole: 'system',
      metadata: { under_review: counts.under_review },
    });
  }

  const refreshed = await client.query('SELECT * FROM giveaways WHERE id = $1', [giveaway.id]);
  return { closed: true, alreadyClosed: false, status: next, counts, giveaway: refreshed.rows[0] };
}

// Called from inside the entry transaction, immediately after an entry commits
// its INSERT and while the giveaway row is still locked.
//
// This is what makes "closes exactly on the 100th accepted entry" true rather
// than approximately true: the count is taken under the same lock that
// serialises entries, so two concurrent entries cannot both read 99.
async function closeIfTargetReached(client, giveaway) {
  if (giveaway.status !== STATUS.ACTIVE) return { closed: false, alreadyClosed: true };
  const counts = await countEntries(client, giveaway.id);
  if (counts.accepted < giveaway.entry_target) {
    return { closed: false, alreadyClosed: false, counts };
  }
  return closeEntries(client, giveaway, { reason: CLOSE_REASONS.TARGET_REACHED });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// The ONLY place a winner is selected.
//
// The route used to do this inline. It is a shared service now because the
// deadline job needs exactly the same operation, and a second implementation of
// "pick a winner" is the last thing this codebase should have — the two would
// drift, and the weaker one would be the one that ran unattended at 03:00.
//
// Caller must hold the giveaway row lock and be inside a transaction.
//
// Returns one of:
//   { drawn: true,  winner }               a winner was selected
//   { drawn: false, postponed: true }      an integrity question is open
//   { drawn: false, noWinner: true }       closed with nobody eligible
//   { drawn: false, alreadyResolved: true } somebody else got there first
async function drawIfReady(client, giveaway, { actorUserId = null, actorRole = 'system' } = {}) {
  if (giveaway.status === STATUS.DRAWN) {
    return { drawn: false, alreadyResolved: true, status: giveaway.status };
  }
  if (TERMINAL.has(giveaway.status)) {
    return { drawn: false, alreadyResolved: true, status: giveaway.status };
  }
  if (!AWAITING_OUTCOME.includes(giveaway.status)) {
    throw new LifecycleError('This giveaway is still accepting entries.', {
      status: 409,
      code: 'ENTRIES_STILL_OPEN',
    });
  }

  // Fails closed on an open question. Unchanged from the original route: if any
  // entry is under review, or a case is open on this campaign, the draw waits.
  // The difference is that waiting is now a recorded state rather than a 409
  // somebody has to notice.
  let blocked = false;
  try {
    await integrity.assertDrawable(client, giveaway.id);
  } catch (err) {
    if (!(err instanceof integrity.IntegrityError)) throw err;
    blocked = true;
  }

  if (blocked) {
    if (giveaway.status !== STATUS.PENDING_INTEGRITY_REVIEW) {
      await client.query(
        `UPDATE giveaways SET status = $2, lifecycle_version = lifecycle_version + 1 WHERE id = $1`,
        [giveaway.id, STATUS.PENDING_INTEGRITY_REVIEW]
      );
      await recordEvent(client, {
        giveawayId: giveaway.id,
        eventType: 'draw_postponed_pending_review',
        fromStatus: giveaway.status,
        toStatus: STATUS.PENDING_INTEGRITY_REVIEW,
        actorUserId,
        actorRole,
      });
    }
    return { drawn: false, postponed: true, status: STATUS.PENDING_INTEGRITY_REVIEW };
  }

  // The pool, locked for the duration of the transaction. A disqualification
  // that commits between this read and the winner write would otherwise be able
  // to disagree with the pool the winner came from.
  const entries = await integrity.lockEligibleEntries(client, giveaway.id);

  if (entries.length === 0) {
    const counts = await countEntries(client, giveaway.id);
    const reason =
      counts.total === 0 ? NO_WINNER_REASONS.NO_ENTRIES : NO_WINNER_REASONS.NO_ELIGIBLE_ENTRIES;

    await client.query(
      `UPDATE giveaways
          SET status = $2, no_winner_reason = $3, lifecycle_version = lifecycle_version + 1
        WHERE id = $1`,
      [giveaway.id, STATUS.CLOSED_NO_WINNER, reason]
    );
    await recordEvent(client, {
      giveawayId: giveaway.id,
      eventType: 'closed_no_winner',
      fromStatus: giveaway.status,
      toStatus: STATUS.CLOSED_NO_WINNER,
      reasonCode: reason,
      actorUserId,
      actorRole,
      metadata: { total_entries: counts.total, accepted: counts.accepted },
    });
    return { drawn: false, noWinner: true, reason, status: STATUS.CLOSED_NO_WINNER };
  }

  // `crypto.randomInt` — unchanged, and deliberately not `Math.random`. This is
  // the existing cryptographically secure selection, moved rather than rewritten.
  const winner = entries[crypto.randomInt(entries.length)];

  // Exactly one winner. The row lock serialises this, and a partial unique index
  // on `winner_entry_id` refuses a second one at the storage layer even if some
  // future code path forgets the lock.
  await client.query(
    `UPDATE giveaways
        SET status = $2, winner_entry_id = $3, drawn_at = NOW(),
            lifecycle_version = lifecycle_version + 1
      WHERE id = $1`,
    [giveaway.id, STATUS.DRAWN, winner.id]
  );

  await recordEvent(client, {
    giveawayId: giveaway.id,
    eventType: 'drawn',
    fromStatus: giveaway.status,
    toStatus: STATUS.DRAWN,
    actorUserId,
    actorRole,
    // The pool size and the winning ticket. The ticket number is already public
    // on the giveaway page; the winner's account id is not, and is not here.
    metadata: { pool_size: entries.length, winning_ticket: winner.ticket_number },
  });

  return { drawn: true, winner, poolSize: entries.length, status: STATUS.DRAWN };
}

// ---------------------------------------------------------------------------
// Exceptional cancellation
// ---------------------------------------------------------------------------

// Not an ordinary option, and this function is written to make that structural
// rather than advisory.
//
// A sponsor who no longer wants to supply the prize is refused by name, with its
// own error code, because that is the request somebody will actually make.
async function cancelExceptionally(
  client,
  { giveawayId, ground, reason, actorUserId, expectedVersion }
) {
  await integrity.assertAdmin(client, actorUserId);

  if (ground === SPONSOR_WITHDRAWAL) {
    throw new LifecycleError(
      'A sponsor changing their mind is not a ground for cancelling a published giveaway. People have entered it. If fulfilment has become genuinely impossible, cancel on that ground and record why in the reason.',
      { status: 409, code: 'SPONSOR_WITHDRAWAL_NOT_A_GROUND' }
    );
  }
  if (!CANCELLATION_GROUND_IDS.includes(ground)) {
    throw new LifecycleError(
      `ground must be one of: ${CANCELLATION_GROUND_IDS.join(', ')}.`,
      { status: 400, code: 'CANCELLATION_GROUND_INVALID', details: { allowed: CANCELLATION_GROUND_IDS } }
    );
  }

  const notes = String(reason || '').trim();
  if (notes.length < 10) {
    throw new LifecycleError(
      'A written reason is required, and it is the only record of why a campaign people entered was stopped.',
      { status: 400, code: 'CANCELLATION_REASON_REQUIRED' }
    );
  }
  if (notes.length > 4000) {
    throw new LifecycleError('That reason is too long.', {
      status: 400,
      code: 'CANCELLATION_REASON_TOO_LONG',
    });
  }

  const giveaway = await lockGiveaway(client, giveawayId);

  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
    if (Number(expectedVersion) !== Number(giveaway.lifecycle_version)) {
      throw new LifecycleError(
        'Somebody else changed this while your screen was open. Reload it and decide again.',
        { status: 409, code: 'STALE_DECISION', details: { version: giveaway.lifecycle_version } }
      );
    }
  }

  if (giveaway.status === STATUS.CANCELLED) {
    return { cancelled: false, alreadyCancelled: true, giveaway };
  }
  // A drawn campaign has a winner and, usually, a claim in progress. Unwinding
  // that is a claim-workflow decision with its own rules and its own audit
  // trail, not something a campaign-level cancellation may do behind its back.
  if (giveaway.status === STATUS.DRAWN) {
    throw new LifecycleError(
      'This giveaway has already been drawn. Cancelling the campaign would not undo the winner or their claim — handle it through the claim workflow, which records what happened to the prize.',
      { status: 409, code: 'ALREADY_DRAWN' }
    );
  }
  if (TERMINAL.has(giveaway.status)) {
    throw new LifecycleError('This giveaway is already closed.', {
      status: 409,
      code: 'ALREADY_CLOSED',
    });
  }

  const counts = await countEntries(client, giveawayId);
  const publicExplanation = CANCELLATION_COPY[ground];

  await client.query(
    `UPDATE giveaways
        SET status = $2,
            cancelled_at = NOW(),
            cancelled_by = $3,
            cancellation_ground = $4,
            cancellation_reason = $5,
            cancellation_public_explanation = $6,
            entries_closed_at = COALESCE(entries_closed_at, NOW()),
            entries_closed_reason = COALESCE(entries_closed_reason, $7),
            entries_at_close = COALESCE(entries_at_close, $8),
            lifecycle_version = lifecycle_version + 1
      WHERE id = $1`,
    [
      giveawayId,
      STATUS.CANCELLED,
      actorUserId,
      ground,
      notes,
      publicExplanation,
      CLOSE_REASONS.CANCELLED,
      counts.accepted,
    ]
  );

  await recordEvent(client, {
    giveawayId,
    eventType: 'cancelled',
    fromStatus: giveaway.status,
    toStatus: STATUS.CANCELLED,
    reasonCode: ground,
    // Internal. Never rendered anywhere public — the entrant sees
    // `cancellation_public_explanation`, which is chosen by code from the ground.
    adminNotes: notes,
    actorUserId,
    actorRole: 'admin',
    metadata: { accepted: counts.accepted },
  });

  const refreshed = await client.query('SELECT * FROM giveaways WHERE id = $1', [giveawayId]);
  return {
    cancelled: true,
    giveaway: refreshed.rows[0],
    entrantCount: counts.accepted,
    publicExplanation,
  };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

// Publication. The one transition that puts a campaign in front of the public,
// and it needs a named administrator, a verified prize and a deliberate act.
async function approveAndPublish(
  client,
  { giveawayId, actorUserId, reviewNotes, evidenceKind, evidenceReference, expectedVersion }
) {
  await integrity.assertAdmin(client, actorUserId);
  const giveaway = await lockGiveaway(client, giveawayId);

  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
    if (Number(expectedVersion) !== Number(giveaway.lifecycle_version)) {
      throw new LifecycleError(
        'Somebody else changed this while your screen was open. Reload it and decide again.',
        { status: 409, code: 'STALE_DECISION', details: { version: giveaway.lifecycle_version } }
      );
    }
  }

  if (giveaway.status !== STATUS.PENDING_APPROVAL) {
    throw new LifecycleError(
      giveaway.status === STATUS.REJECTED
        ? 'This submission was rejected. A rejected submission does not become publishable by being approved afterwards — the host submits a new one.'
        : 'This giveaway has already been published.',
      { status: 409, code: 'NOT_PENDING_APPROVAL', details: { status: giveaway.status } }
    );
  }

  const kind = String(evidenceKind || '').trim();
  const reference = String(evidenceReference || '').trim();
  if (!prizeStandard.EVIDENCE_KINDS.includes(kind)) {
    throw new LifecycleError(
      `evidence_kind must be one of: ${prizeStandard.EVIDENCE_KINDS.join(', ')}.`,
      { status: 400, code: 'EVIDENCE_KIND_INVALID', details: { allowed: prizeStandard.EVIDENCE_KINDS } }
    );
  }
  if (reference.length < 3) {
    throw new LifecycleError(
      'An evidence reference is required — enough for somebody to find what you checked, and no more. Do not paste the document itself.',
      { status: 400, code: 'EVIDENCE_REFERENCE_REQUIRED' }
    );
  }
  if (reference.length > 500) {
    throw new LifecycleError('That evidence reference is too long. A reference, not a document.', {
      status: 400,
      code: 'EVIDENCE_REFERENCE_TOO_LONG',
    });
  }
  const notes = String(reviewNotes || '').trim();
  if (notes.length < 3) {
    throw new LifecycleError(
      'Review notes are required — they are the record of why this prize was approved for publication.',
      { status: 400, code: 'REVIEW_NOTES_REQUIRED' }
    );
  }

  // Everything the standard requires must actually be on the row. The CHECK
  // constraint enforces the same thing at the storage layer; this exists so the
  // administrator gets a list of what is missing instead of a constraint name.
  const missing = prizeStandard.missingForPublication({
    ...giveaway,
    prize_evidence_kind: kind,
    prize_evidence_reference: reference,
    prize_evidence_verified: true,
  });
  if (missing.length) {
    throw new LifecycleError(
      'This submission cannot be published yet: some of what Naseeb reviews is missing.',
      { status: 409, code: 'PRIZE_COMMITMENT_INCOMPLETE', details: { missing } }
    );
  }

  await client.query(
    `UPDATE giveaways
        SET status = $2,
            approved_at = NOW(),
            approved_by = $3,
            review_notes = $4,
            prize_evidence_kind = $5,
            prize_evidence_reference = $6,
            prize_evidence_verified = TRUE,
            prize_evidence_verified_at = NOW(),
            prize_evidence_verified_by = $3,
            published_at = NOW(),
            -- ONE deadline, written twice in two shapes.
            --
            -- closes_at is the authority: the maintenance worker selects on it,
            -- and entry acceptance compares against it. entry_deadline is the
            -- text mirror the pages and the API render, and it is DERIVED from
            -- the same value rather than computed a second time.
            --
            -- This used to call the interval expression twice. Both evaluations
            -- agreed because NOW() is stable within a transaction, so it was
            -- correct — but only accidentally, and the rehearsal showed how
            -- easily the two can be made to disagree by anything that writes
            -- one without the other. Deriving one from the other in a single
            -- scalar removes the possibility rather than relying on it not
            -- happening.
            closes_at = deadline.at,
            entry_deadline = to_char(deadline.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            entry_target = $7,
            prize_governance_version = 1,
            lifecycle_version = lifecycle_version + 1
       FROM (SELECT ${closesAtSql()} AS at) AS deadline
      WHERE id = $1`,
    [giveawayId, STATUS.ACTIVE, actorUserId, notes, kind, reference, ENTRY_TARGET]
  );

  await recordEvent(client, {
    giveawayId,
    eventType: 'approved',
    fromStatus: STATUS.PENDING_APPROVAL,
    toStatus: STATUS.ACTIVE,
    adminNotes: notes,
    actorUserId,
    actorRole: 'admin',
    metadata: { evidence_kind: kind, entry_target: ENTRY_TARGET, entry_window: ENTRY_WINDOW_LABEL },
  });
  await recordEvent(client, {
    giveawayId,
    eventType: 'published',
    fromStatus: STATUS.PENDING_APPROVAL,
    toStatus: STATUS.ACTIVE,
    actorUserId,
    actorRole: 'admin',
  });

  const refreshed = await client.query('SELECT * FROM giveaways WHERE id = $1', [giveawayId]);
  return { approved: true, giveaway: refreshed.rows[0] };
}

async function reject(client, { giveawayId, ground, reviewNotes, actorUserId, expectedVersion }) {
  await integrity.assertAdmin(client, actorUserId);

  if (!prizeStandard.isRejectionGround(ground)) {
    throw new LifecycleError(
      `ground must be one of: ${prizeStandard.REJECTION_GROUND_IDS.join(', ')}.`,
      {
        status: 400,
        code: 'REJECTION_GROUND_INVALID',
        details: { allowed: prizeStandard.REJECTION_GROUND_IDS },
      }
    );
  }
  const notes = String(reviewNotes || '').trim();
  if (notes.length < 3) {
    throw new LifecycleError('Review notes are required.', {
      status: 400,
      code: 'REVIEW_NOTES_REQUIRED',
    });
  }

  const giveaway = await lockGiveaway(client, giveawayId);
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
    if (Number(expectedVersion) !== Number(giveaway.lifecycle_version)) {
      throw new LifecycleError(
        'Somebody else changed this while your screen was open. Reload it and decide again.',
        { status: 409, code: 'STALE_DECISION', details: { version: giveaway.lifecycle_version } }
      );
    }
  }
  if (giveaway.status !== STATUS.PENDING_APPROVAL) {
    throw new LifecycleError('Only a submission awaiting approval can be rejected.', {
      status: 409,
      code: 'NOT_PENDING_APPROVAL',
      details: { status: giveaway.status },
    });
  }

  await client.query(
    `UPDATE giveaways
        SET status = $2, rejected_at = NOW(), rejected_by = $3, rejection_ground = $4,
            review_notes = $5, lifecycle_version = lifecycle_version + 1
      WHERE id = $1`,
    [giveawayId, STATUS.REJECTED, actorUserId, ground, notes]
  );

  await recordEvent(client, {
    giveawayId,
    eventType: 'rejected',
    fromStatus: STATUS.PENDING_APPROVAL,
    toStatus: STATUS.REJECTED,
    reasonCode: ground,
    adminNotes: notes,
    actorUserId,
    actorRole: 'admin',
  });

  const refreshed = await client.query('SELECT * FROM giveaways WHERE id = $1', [giveawayId]);
  return { rejected: true, giveaway: refreshed.rows[0], hostCopy: prizeStandard.rejectionCopyFor(ground) };
}

// ---------------------------------------------------------------------------
// What a visitor may see
// ---------------------------------------------------------------------------

// The public shape of a lifecycle. Coarse, truthful, and carrying none of the
// internal record: no review notes, no evidence reference, no cancellation
// reason, no approving administrator.
const PUBLIC_STATE_COPY = {
  [STATUS.ACTIVE]: 'Open for entries.',
  [STATUS.CLOSED_PENDING_DRAW]: 'Entries are closed. The draw is being run.',
  [STATUS.PENDING_INTEGRITY_REVIEW]:
    'Entries are closed. The draw is paused while a check is completed — nothing about the result has been decided.',
  [STATUS.DRAWN]: 'A winner has been drawn.',
  [STATUS.CLOSED_NO_WINNER]: 'This giveaway closed without an eligible entry, so no winner was drawn.',
  [STATUS.CANCELLED]: 'This giveaway was cancelled.',
};

function publicView(giveaway) {
  if (!giveaway) return null;
  return {
    status: giveaway.status,
    accepting_entries: giveaway.status === STATUS.ACTIVE,
    published_at: giveaway.published_at,
    closes_at: giveaway.closes_at,
    entry_target: giveaway.entry_target,
    entries_closed_at: giveaway.entries_closed_at,
    // Which of the two rules closed it. A fact people are entitled to.
    entries_closed_reason: giveaway.entries_closed_reason,
    drawn_at: giveaway.drawn_at,
    no_winner_reason: giveaway.no_winner_reason,
    state_explanation: PUBLIC_STATE_COPY[giveaway.status] || null,
    // The fixed sentence chosen by code from the ground — never the
    // administrator's written reason.
    cancellation_explanation: giveaway.cancellation_public_explanation || null,
    prize_category: giveaway.prize_category,
    sponsor_name: giveaway.sponsor_name,
    prize_restrictions: giveaway.prize_restrictions,
    prize_expiry_date: giveaway.prize_expiry_date,
    fulfilment_method: giveaway.fulfilment_method,
    custody_explanation: giveaway.naseeb_custody
      ? prizeStandard.CUSTODY_COPY[giveaway.naseeb_custody] || null
      : null,
  };
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  TERMINAL,
  AWAITING_OUTCOME,
  ENTRY_TARGET,
  ENTRY_WINDOW,
  ENTRY_WINDOW_LABEL,
  CLOSE_REASONS,
  NO_WINNER_REASONS,
  CANCELLATION_GROUNDS,
  CANCELLATION_GROUND_IDS,
  CANCELLATION_COPY,
  SPONSOR_WITHDRAWAL,
  PUBLIC_STATE_COPY,
  ACCEPTED_SQL,
  DRAWABLE_SQL,
  LifecycleError,
  countEntries,
  closesAtSql,
  recordEvent,
  lockGiveaway,
  bumpVersion,
  closeEntries,
  closeIfTargetReached,
  drawIfReady,
  cancelExceptionally,
  approveAndPublish,
  reject,
  publicView,
};
