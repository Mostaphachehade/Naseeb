// Entry integrity: reviewing, disqualifying and reinstating an entry without
// ever destroying the record that it was made.
//
// What this module is for, and what it deliberately is not:
//
// The platform enforces one entry per verified account per giveaway. That is a
// UNIQUE index, and it is genuinely enforced. It is *not* one entry per person,
// because nothing here can tell two verified accounts apart from two people
// without collecting identity documents — which this product does not do, and
// which this phase is explicitly not adding. Everything in this module operates
// on that honest footing: a human decides, with a written reason, on evidence
// they can see, and the decision is recorded so it can be argued with later.
//
// Three rules the rest of the file exists to keep:
//
//   1. An entry is never deleted to remove it from a draw. The row, its
//      submission time, its account and its giveaway all survive every outcome.
//   2. No signal, score or heuristic changes a status. Only an administrator
//      does, and only with a reason.
//   3. Every decision is one transaction, takes its locks in a fixed order, and
//      is safe to repeat.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const STATUS = {
  ELIGIBLE: 'eligible',
  UNDER_REVIEW: 'under_review',
  DISQUALIFIED: 'disqualified',
};

const ALL_STATUSES = Object.values(STATUS);

// Which moves an administrator may make from where.
//
// Reinstatement is `-> eligible`, from either of the other two. There is no
// separate `reinstated` status: a reinstated entry is an ordinary eligible one,
// and calling it something else would mean the draw query had to know about two
// kinds of eligible. The *outcome* is recorded — the history row carries the
// reason code `reinstated`, so "was this entry ever disqualified?" is a question
// the record answers.
const TRANSITIONS = {
  [STATUS.ELIGIBLE]: [STATUS.UNDER_REVIEW, STATUS.DISQUALIFIED],
  [STATUS.UNDER_REVIEW]: [STATUS.ELIGIBLE, STATUS.DISQUALIFIED],
  [STATUS.DISQUALIFIED]: [STATUS.ELIGIBLE],
};

const REASON_CODES = {
  UNDER_REVIEW: 'placed_under_review',
  DISQUALIFIED: 'disqualified',
  REINSTATED: 'reinstated',
  SYSTEM_SIGNAL: 'signal_recorded',
};

// Statuses that still count as "this person entered" for a public tally. A
// review is a question, not an outcome, so an entry under review is still an
// entry; a disqualified one is not. See docs/ENTRY_INTEGRITY.md §6 for why the
// draw and the public count still agree despite that.
const COUNTED_STATUSES = [STATUS.ELIGIBLE, STATUS.UNDER_REVIEW];

// SQL fragment shared by every public and dashboard count, so the number on the
// homepage, the number on the giveaway page and the number in the dashboard can
// never drift apart by someone writing a fourth variant of it.
const COUNTED_SQL = "integrity_status <> 'disqualified'";

class IntegrityError extends Error {
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The administrator check is a fresh read of users.is_admin inside the caller's
// transaction. Never a claim from the request body, never a role carried in a
// session payload, never a cached value — the same rule the host-access gate
// follows, for the same reason.
async function assertAdmin(client, userId) {
  if (!userId) {
    throw new IntegrityError('Sign in to continue.', { status: 401, code: 'AUTH_REQUIRED' });
  }
  const result = await client.query(
    'SELECT is_admin, account_status FROM users WHERE id = $1',
    [userId]
  );
  const row = result.rows[0];
  if (!row || row.account_status !== 'active' || !row.is_admin) {
    throw new IntegrityError('Administrators only.', { status: 403, code: 'ADMIN_REQUIRED' });
  }
  return true;
}

function requireReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < 3) {
    throw new IntegrityError(
      'A short reason is required — it is recorded against the decision and may be shown to the entrant.',
      { status: 400, code: 'REASON_REQUIRED' }
    );
  }
  if (text.length > 1000) {
    throw new IntegrityError('That reason is too long.', { status: 400, code: 'REASON_TOO_LONG' });
  }
  return text;
}

// Locks the giveaway first, then the entry — the same order the draw uses, so
// the two can race without deadlocking. Whichever gets the giveaway row first
// finishes first, and the other sees the result rather than a lock cycle.
async function lockEntryForDecision(client, entryId) {
  const found = await client.query(
    'SELECT giveaway_id FROM entries WHERE id = $1',
    [entryId]
  );
  if (!found.rows[0]) {
    throw new IntegrityError('That entry does not exist.', { status: 404, code: 'ENTRY_NOT_FOUND' });
  }
  await client.query('SELECT id FROM giveaways WHERE id = $1 FOR UPDATE', [found.rows[0].giveaway_id]);

  const locked = await client.query(
    `SELECT e.*, g.status AS giveaway_status, g.winner_entry_id
       FROM entries e
       JOIN giveaways g ON g.id = e.giveaway_id
      WHERE e.id = $1
      FOR UPDATE OF e`,
    [entryId]
  );
  return locked.rows[0];
}

async function recordEvent(client, { entry, toStatus, reasonCode, reason, actorUserId, actorRole, metadata }) {
  await client.query(
    `INSERT INTO entry_integrity_events
       (id, entry_id, giveaway_id, from_status, to_status, reason_code, reason,
        actor_user_id, actor_role, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      uuid(),
      entry.id,
      entry.giveaway_id,
      entry.integrity_status,
      toStatus,
      reasonCode,
      reason || null,
      actorUserId || null,
      actorRole,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

// The one function that changes an entry's status.
//
// Idempotent: asking for the status an entry is already in records nothing and
// reports `changed: false`, so a double-clicked button does not produce two
// history rows saying the same thing. Concurrency-safe: the row is locked
// before its current status is read, so two administrators pressing opposite
// buttons produce one outcome and one history, not an interleaving.
async function setStatus(client, { entryId, toStatus, reason, actorUserId, metadata }) {
  if (!ALL_STATUSES.includes(toStatus)) {
    throw new IntegrityError('Unknown entry status.', { status: 400, code: 'STATUS_INVALID' });
  }
  await assertAdmin(client, actorUserId);
  const text = requireReason(reason);

  const entry = await lockEntryForDecision(client, entryId);

  if (entry.integrity_status === toStatus) {
    return { changed: false, entry, status: toStatus };
  }
  if (!TRANSITIONS[entry.integrity_status].includes(toStatus)) {
    throw new IntegrityError(
      `An entry that is ${entry.integrity_status.replace(/_/g, ' ')} cannot become ${toStatus.replace(/_/g, ' ')}.`,
      { status: 409, code: 'TRANSITION_NOT_ALLOWED' }
    );
  }

  // Disqualifying the entry that has already won is not a quiet redraw, and it
  // is not allowed to become one. A post-draw allegation opens a case (below),
  // which pauses fulfilment and puts a human in front of it.
  if (
    toStatus === STATUS.DISQUALIFIED &&
    entry.winner_entry_id === entry.id
  ) {
    throw new IntegrityError(
      'This entry has already won. Open a post-draw integrity case instead — replacing a winner is a separate decision that is not automated.',
      { status: 409, code: 'WINNER_DISQUALIFICATION_BLOCKED' }
    );
  }

  const reasonCode =
    toStatus === STATUS.DISQUALIFIED
      ? REASON_CODES.DISQUALIFIED
      : toStatus === STATUS.UNDER_REVIEW
        ? REASON_CODES.UNDER_REVIEW
        : REASON_CODES.REINSTATED;

  await recordEvent(client, {
    entry,
    toStatus,
    reasonCode,
    reason: text,
    actorUserId,
    actorRole: 'admin',
    metadata,
  });

  await client.query(
    `UPDATE entries
        SET integrity_status = $2,
            integrity_status_reason = $3,
            integrity_status_changed_at = NOW(),
            integrity_status_changed_by = $4
      WHERE id = $1`,
    [entryId, toStatus, text, actorUserId]
  );

  return { changed: true, entry, status: toStatus, previousStatus: entry.integrity_status };
}

// ---------------------------------------------------------------------------
// Draw safety
// ---------------------------------------------------------------------------

// Called inside the draw's transaction, after the giveaway row is locked.
//
// Fails closed on an open question. If any entry is under review, the draw stops
// with a conflict rather than quietly drawing from a pool somebody is currently
// arguing about — the result would be unexplainable either way round, and a
// giveaway that draws thirty seconds later is a much smaller problem than a
// winner nobody can defend.
async function assertDrawable(client, giveawayId) {
  const result = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE integrity_status = 'under_review')::int AS under_review,
       COUNT(*) FILTER (WHERE integrity_status = 'eligible')::int AS eligible
     FROM entries WHERE giveaway_id = $1`,
    [giveawayId]
  );
  const { under_review: underReview, eligible } = result.rows[0];

  if (underReview > 0) {
    throw new IntegrityError(
      `${underReview} ${underReview === 1 ? 'entry is' : 'entries are'} under integrity review. The draw is paused until an administrator resolves ${underReview === 1 ? 'it' : 'them'}.`,
      { status: 409, code: 'ENTRY_REVIEW_PENDING' }
    );
  }

  const open = await client.query(
    "SELECT COUNT(*)::int AS c FROM entry_integrity_cases WHERE giveaway_id = $1 AND status = 'open'",
    [giveawayId]
  );
  if (open.rows[0].c > 0) {
    throw new IntegrityError(
      'An integrity case is open on this giveaway. The draw is paused until an administrator resolves it.',
      { status: 409, code: 'INTEGRITY_CASE_OPEN' }
    );
  }

  return { eligible };
}

// The draw pool. Locked, so a disqualification cannot land between the pool
// being read and the winner being written — the two would otherwise be able to
// disagree about who was in it.
async function lockEligibleEntries(client, giveawayId) {
  const result = await client.query(
    `SELECT * FROM entries
      WHERE giveaway_id = $1 AND integrity_status = 'eligible'
      ORDER BY ticket_number
      FOR UPDATE`,
    [giveawayId]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Integrity cases
// ---------------------------------------------------------------------------

// Opening a case is idempotent by a partial unique index: a second open for the
// same entry returns the existing row instead of creating a duplicate.
async function openCase(client, { giveawayId, entryId, reason, actorUserId, actorRole, postDraw }) {
  const text = requireReason(reason);

  const inserted = await client.query(
    `INSERT INTO entry_integrity_cases
       (id, giveaway_id, entry_id, status, post_draw, opened_reason, opened_by)
     VALUES ($1, $2, $3, 'open', $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [uuid(), giveawayId, entryId || null, Boolean(postDraw), text, actorUserId || null]
  );
  if (inserted.rows[0]) {
    return { created: true, case: inserted.rows[0] };
  }

  const existing = await client.query(
    `SELECT * FROM entry_integrity_cases
      WHERE status = 'open' AND giveaway_id = $1
        AND ((entry_id IS NULL AND $2::text IS NULL) OR entry_id = $2)`,
    [giveawayId, entryId || null]
  );
  return { created: false, case: existing.rows[0] || null };
}

async function resolveCase(client, { caseId, resolution, reason, actorUserId }) {
  await assertAdmin(client, actorUserId);
  const text = requireReason(reason);

  if (!['reinstated', 'upheld', 'no_action'].includes(resolution)) {
    throw new IntegrityError('Unknown resolution.', { status: 400, code: 'RESOLUTION_INVALID' });
  }

  const locked = await client.query(
    `SELECT * FROM entry_integrity_cases WHERE id = $1 FOR UPDATE`,
    [caseId]
  );
  const row = locked.rows[0];
  if (!row) {
    throw new IntegrityError('That case does not exist.', { status: 404, code: 'CASE_NOT_FOUND' });
  }
  if (row.status === 'resolved') {
    return { changed: false, case: row };
  }

  await client.query(
    `UPDATE entry_integrity_cases
        SET status = 'resolved', resolution = $2, resolution_reason = $3,
            resolved_by = $4, resolved_at = NOW()
      WHERE id = $1`,
    [caseId, resolution, text, actorUserId]
  );

  // Resolving by reinstatement puts an entry that was held back into the pool
  // again, and says so in the entry's own history. `upheld` and `no_action`
  // change no status here: upholding a disqualification means the entry is
  // already disqualified, and the resolution is the record of the decision.
  if (resolution === 'reinstated' && row.entry_id) {
    const entry = await lockEntryForDecision(client, row.entry_id);
    if (entry.integrity_status !== STATUS.ELIGIBLE) {
      await recordEvent(client, {
        entry,
        toStatus: STATUS.ELIGIBLE,
        reasonCode: REASON_CODES.REINSTATED,
        reason: text,
        actorUserId,
        actorRole: 'admin',
        metadata: { case_id: caseId },
      });
      await client.query(
        `UPDATE entries
            SET integrity_status = 'eligible', integrity_status_reason = $2,
                integrity_status_changed_at = NOW(), integrity_status_changed_by = $3
          WHERE id = $1`,
        [row.entry_id, text, actorUserId]
      );
    }
  }

  const updated = await client.query('SELECT * FROM entry_integrity_cases WHERE id = $1', [caseId]);
  return { changed: true, case: updated.rows[0] };
}

// Whether a claim's fulfilment is paused. Asked by the claim transition route,
// which is why it takes a giveaway id rather than a case id: the claim knows
// what it is for, not what is being alleged about it.
async function hasOpenCase(client, giveawayId) {
  const result = await client.query(
    "SELECT 1 FROM entry_integrity_cases WHERE giveaway_id = $1 AND status = 'open' LIMIT 1",
    [giveawayId]
  );
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// What an entrant may see about their own entry: a coarse status and, if a
// decision was made about them, the reason they were given. Never the signals,
// never another account, never an administrator's notes.
const ENTRANT_STATUS_LABEL = {
  [STATUS.ELIGIBLE]: 'entered',
  [STATUS.UNDER_REVIEW]: 'under_review',
  [STATUS.DISQUALIFIED]: 'disqualified',
};

function entrantView(entry) {
  if (!entry) return null;
  return {
    entered_at: entry.created_at,
    ticket_number: entry.ticket_number,
    status: ENTRANT_STATUS_LABEL[entry.integrity_status] || 'entered',
    // Shown to the person it is about, because a decision nobody explains is a
    // decision nobody can contest. Only ever the administrator's written
    // reason — the signals that prompted a review are not disclosed.
    reason: entry.integrity_status === STATUS.ELIGIBLE ? null : entry.integrity_status_reason || null,
  };
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  TRANSITIONS,
  REASON_CODES,
  COUNTED_STATUSES,
  COUNTED_SQL,
  IntegrityError,
  assertAdmin,
  requireReason,
  setStatus,
  assertDrawable,
  lockEligibleEntries,
  openCase,
  resolveCase,
  hasOpenCase,
  entrantView,
  ENTRANT_STATUS_LABEL,
  // Exposed for tests that need to build a deterministic id.
  _uuid: () => uuid(),
  _hash: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
};
