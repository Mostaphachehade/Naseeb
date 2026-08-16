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
// on that honest footing: a human decides, with written notes, on evidence they
// can see, and the decision is recorded so it can be argued with later.
//
// Four rules the rest of the file exists to keep:
//
//   1. An entry is never deleted to remove it from a draw. The row, its
//      submission time, its account and its giveaway all survive every outcome.
//   2. No signal, score or heuristic changes a status. Only an administrator
//      does, and only with notes.
//   3. **What the administrator writes and what the entrant reads are two
//      different things.** The notes are evidence — other accounts, a network
//      pattern, an allegation not yet established. The entrant gets a fixed
//      sentence looked up from an allowlisted code. There is no path from one to
//      the other, and that is the whole point of the split.
//   4. Every decision is one transaction, takes its locks in a fixed order, is
//      safe to repeat, and refuses a decision made from a stale screen.
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
// kinds of eligible. The *outcome* is recorded — the history row carries a
// `reinstated_after_review` code, so "was this entry ever disqualified?" is a
// question the record answers.
const TRANSITIONS = {
  [STATUS.ELIGIBLE]: [STATUS.UNDER_REVIEW, STATUS.DISQUALIFIED],
  [STATUS.UNDER_REVIEW]: [STATUS.ELIGIBLE, STATUS.DISQUALIFIED],
  [STATUS.DISQUALIFIED]: [STATUS.ELIGIBLE],
};

// ---------------------------------------------------------------------------
// The entrant-facing vocabulary
// ---------------------------------------------------------------------------
//
// An allowlist, and the only thing an entrant ever reads about a decision. The
// wording lives here rather than in a database column so that it cannot be
// edited per-row into an accusation, cannot carry somebody else's email address
// or account id, and cannot describe how anything was detected.
//
// The tone is deliberate. None of these sentences accuses anybody of anything:
// a review is a check, not a charge, and a disqualification says which rule was
// not met rather than what we think the person did.
const REASON_CODES = {
  REVIEW_ROUTINE: 'review_routine_check',
  REVIEW_FOLLOW_UP: 'review_signal_follow_up',
  DISQUALIFIED_ENTRY_RULE: 'disqualified_entry_rule',
  DISQUALIFIED_TERMS: 'disqualified_terms',
  REINSTATED: 'reinstated_after_review',
  // Only ever written by the migration, for decisions made before this split
  // existed. Their original free text is administrator notes now, and is not
  // promoted into something a stranger reads.
  LEGACY: 'legacy_unspecified',
};

const ENTRANT_COPY = {
  [REASON_CODES.REVIEW_ROUTINE]:
    'Your entry is being checked before the draw. This is a routine check, nothing has been decided, and your entry has not been removed.',
  [REASON_CODES.REVIEW_FOLLOW_UP]:
    'Your entry is being checked before the draw. Nothing has been decided, and your entry has not been removed.',
  [REASON_CODES.DISQUALIFIED_ENTRY_RULE]:
    'This entry is not included in the draw, because it does not meet the rule of one entry per verified account for this giveaway.',
  [REASON_CODES.DISQUALIFIED_TERMS]:
    'This entry is not included in the draw, because it does not meet the entry terms for this giveaway.',
  [REASON_CODES.REINSTATED]:
    'This entry was reviewed and is included in the draw as normal.',
  [REASON_CODES.LEGACY]:
    'This entry was reviewed by an administrator. If you would like to know more, please get in touch.',
  // Codes written by the first version of this phase, before the split. Kept
  // valid so old rows still read, and mapped to neutral copy.
  under_review: 'Your entry is being checked before the draw. Nothing has been decided.',
  disqualified: 'This entry is not included in the draw following an administrator review.',
  reinstated: 'This entry was reviewed and is included in the draw as normal.',
};

// Which codes may be chosen for which destination. A `disqualified_terms` code
// on a review, or a review code on a disqualification, would produce a sentence
// that does not match what happened.
const CODES_FOR_STATUS = {
  [STATUS.UNDER_REVIEW]: [REASON_CODES.REVIEW_ROUTINE, REASON_CODES.REVIEW_FOLLOW_UP],
  [STATUS.DISQUALIFIED]: [REASON_CODES.DISQUALIFIED_ENTRY_RULE, REASON_CODES.DISQUALIFIED_TERMS],
  [STATUS.ELIGIBLE]: [REASON_CODES.REINSTATED],
};

function entrantCopyFor(code) {
  return ENTRANT_COPY[code] || ENTRANT_COPY[REASON_CODES.LEGACY];
}

// Statuses that still count as "this person entered" for a public tally. A
// review is a question, not an outcome, so an entry under review is still an
// entry; a disqualified one is not. See docs/ENTRY_INTEGRITY.md §6 for why the
// draw and the public count still agree despite that.
const COUNTED_STATUSES = [STATUS.ELIGIBLE, STATUS.UNDER_REVIEW];

// SQL fragment shared by every public and dashboard count, so the number on the
// homepage, the number on the giveaway page and the number in the dashboard can
// never drift apart by someone writing a fourth variant of it.
const COUNTED_SQL = "integrity_status <> 'disqualified'";

// ---------------------------------------------------------------------------
// Case states
// ---------------------------------------------------------------------------
//
// `upheld_blocked` is not a resolution. It is the state a case enters when an
// administrator confirms the concern: the prize stops moving and stays stopped,
// because what to do about a confirmed concern after a winner exists is a policy
// question this codebase does not answer.
const CASE_STATUS = {
  OPEN: 'open',
  UPHELD_BLOCKED: 'upheld_blocked',
  RESOLVED: 'resolved',
};

const CASE_RESOLUTIONS = {
  REINSTATED: 'reinstated',
  UPHELD: 'upheld',
  NO_ACTION: 'no_action',
};

// The substantive predicate. Fulfilment pauses on either of these, and asking
// "is the case open?" was the bug: an upheld case is closed to further review
// and still absolutely blocking.
const BLOCKING_CASE_STATUSES = [CASE_STATUS.OPEN, CASE_STATUS.UPHELD_BLOCKED];

class IntegrityError extends Error {
  constructor(message, { status = 400, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The administrator check is a fresh read of users.is_admin inside the caller's
// transaction. Never a claim from the request body, never a role carried in a
// session payload, never a cached value, and never inferred from the fact that
// somebody supplied a valid version token — a concurrency token says when a
// screen was drawn, not who is allowed to act.
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

// Administrator notes. Mandatory, internal, and never rendered to anybody but an
// administrator who deliberately opened one entry.
function requireNotes(notes) {
  const text = String(notes || '').trim();
  if (text.length < 3) {
    throw new IntegrityError(
      'Administrator notes are required — they are the record of why this decision was made.',
      { status: 400, code: 'NOTES_REQUIRED' }
    );
  }
  if (text.length > 4000) {
    throw new IntegrityError('Those notes are too long.', { status: 400, code: 'NOTES_TOO_LONG' });
  }
  return text;
}

function requireReasonCode(toStatus, code) {
  const allowed = CODES_FOR_STATUS[toStatus] || [];
  if (!allowed.includes(code)) {
    throw new IntegrityError(
      `reason_code must be one of: ${allowed.join(', ')}.`,
      { status: 400, code: 'REASON_CODE_INVALID', details: { allowed } }
    );
  }
  return code;
}

// Optimistic concurrency.
//
// Row locking makes two requests serial; it does not make the second one
// informed. Two administrators looking at the same screen, one of whom
// reinstates while the other disqualifies, both get their way in turn and the
// last one wins silently. The version is what turns that into a refusal.
function assertVersion(expected, actual, current) {
  if (expected === undefined || expected === null || expected === '') {
    throw new IntegrityError(
      'A version is required. Reload the entry and try again.',
      { status: 400, code: 'VERSION_REQUIRED', details: current }
    );
  }
  if (Number(expected) !== Number(actual)) {
    throw new IntegrityError(
      'Somebody else changed this while your screen was open. Reload it and decide again.',
      { status: 409, code: 'STALE_DECISION', details: current }
    );
  }
}

// Locks the giveaway first, then the entry — the same order the draw uses, so
// the two can race without deadlocking. Whichever gets the giveaway row first
// finishes first, and the other sees the result rather than a lock cycle.
async function lockEntryForDecision(client, entryId) {
  const found = await client.query('SELECT giveaway_id FROM entries WHERE id = $1', [entryId]);
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

async function recordEvent(client, { entry, toStatus, reasonCode, adminNotes, actorUserId, actorRole, metadata }) {
  await client.query(
    `INSERT INTO entry_integrity_events
       (id, entry_id, giveaway_id, from_status, to_status, reason_code, admin_notes,
        actor_user_id, actor_role, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      uuid(),
      entry.id,
      entry.giveaway_id,
      entry.integrity_status,
      toStatus,
      reasonCode,
      adminNotes || null,
      actorUserId || null,
      actorRole,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

// The one function that changes an entry's status.
//
// Idempotent: asking for the status an entry is already in records nothing and
// reports `changed: false`. Concurrency-safe twice over — the row is locked
// before its status is read, and the caller's version must match what the row
// actually holds.
async function setStatus(client, { entryId, toStatus, reasonCode, adminNotes, actorUserId, expectedVersion, metadata }) {
  if (!ALL_STATUSES.includes(toStatus)) {
    throw new IntegrityError('Unknown entry status.', { status: 400, code: 'STATUS_INVALID' });
  }
  // Authorization first, and from the database. A stale-version refusal must
  // never be the thing that tells an unauthorised caller they got the id right.
  await assertAdmin(client, actorUserId);
  const code = requireReasonCode(toStatus, reasonCode);
  const notes = requireNotes(adminNotes);

  const entry = await lockEntryForDecision(client, entryId);

  const current = {
    entry_id: entry.id,
    status: entry.integrity_status,
    version: entry.integrity_version,
  };
  assertVersion(expectedVersion, entry.integrity_version, current);

  if (entry.integrity_status === toStatus) {
    return { changed: false, entry, status: toStatus, version: entry.integrity_version };
  }
  if (!TRANSITIONS[entry.integrity_status].includes(toStatus)) {
    throw new IntegrityError(
      `An entry that is ${entry.integrity_status.replace(/_/g, ' ')} cannot become ${toStatus.replace(/_/g, ' ')}.`,
      { status: 409, code: 'TRANSITION_NOT_ALLOWED', details: current }
    );
  }

  // Disqualifying the entry that has already won is not a quiet redraw, and it
  // is not allowed to become one. A post-draw allegation opens a case (below),
  // which pauses fulfilment and puts a human in front of it.
  if (toStatus === STATUS.DISQUALIFIED && entry.winner_entry_id === entry.id) {
    throw new IntegrityError(
      'This entry has already won. Open a post-draw integrity case instead — replacing a winner is a separate decision that is not automated.',
      { status: 409, code: 'WINNER_DISQUALIFICATION_BLOCKED', details: current }
    );
  }

  await recordEvent(client, {
    entry,
    toStatus,
    reasonCode: code,
    adminNotes: notes,
    actorUserId,
    actorRole: 'admin',
    metadata,
  });

  const updated = await client.query(
    `UPDATE entries
        SET integrity_status = $2,
            integrity_reason_code = $3,
            integrity_admin_notes = $4,
            integrity_status_changed_at = NOW(),
            integrity_status_changed_by = $5,
            integrity_version = integrity_version + 1
      WHERE id = $1
      RETURNING integrity_version`,
    [entryId, toStatus, code, notes, actorUserId]
  );

  return {
    changed: true,
    entry,
    status: toStatus,
    previousStatus: entry.integrity_status,
    version: updated.rows[0].integrity_version,
  };
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

  if (await hasBlockingCase(client, giveawayId)) {
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

async function recordCaseEvent(client, { caseRow, toStatus, resolution, adminNotes, actorUserId, actorRole }) {
  await client.query(
    `INSERT INTO entry_integrity_case_events
       (id, case_id, giveaway_id, entry_id, from_status, to_status, resolution,
        admin_notes, actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      uuid(),
      caseRow.id,
      caseRow.giveaway_id,
      caseRow.entry_id || null,
      caseRow.status || null,
      toStatus,
      resolution || null,
      adminNotes || null,
      actorUserId || null,
      actorRole,
    ]
  );
}

// Opening a case is idempotent by a partial unique index: a second open for the
// same entry returns the existing row instead of creating a duplicate — and the
// index covers blocked cases too, so a confirmed one cannot be shadowed.
async function openCase(client, { giveawayId, entryId, adminNotes, actorUserId, actorRole, postDraw }) {
  const notes = requireNotes(adminNotes);

  const inserted = await client.query(
    `INSERT INTO entry_integrity_cases
       (id, giveaway_id, entry_id, status, post_draw, opened_reason, opened_by)
     VALUES ($1, $2, $3, 'open', $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [uuid(), giveawayId, entryId || null, Boolean(postDraw), notes, actorUserId || null]
  );
  if (inserted.rows[0]) {
    await recordCaseEvent(client, {
      caseRow: { ...inserted.rows[0], status: null },
      toStatus: CASE_STATUS.OPEN,
      adminNotes: notes,
      actorUserId,
      actorRole: actorRole || 'admin',
    });
    return { created: true, case: inserted.rows[0] };
  }

  const existing = await client.query(
    `SELECT * FROM entry_integrity_cases
      WHERE status = ANY($3) AND giveaway_id = $1
        AND ((entry_id IS NULL AND $2::text IS NULL) OR entry_id = $2)`,
    [giveawayId, entryId || null, BLOCKING_CASE_STATUSES]
  );
  return { created: false, case: existing.rows[0] || null };
}

// Resolving a case.
//
//   reinstated  -> resolved. The entry goes back in the pool if it was held
//                  back, and fulfilment of the existing winner resumes.
//   no_action   -> resolved. Nothing was wrong; nothing changes.
//   upheld      -> upheld_blocked. NOT closed. The concern was confirmed, so the
//                  prize stays where it is: still in the queue, still blocking
//                  fulfilment, still with the same winner and the same claim.
//                  What happens next needs the owner and counsel, and is
//                  deliberately not a thing this code can do.
async function resolveCase(client, { caseId, resolution, adminNotes, actorUserId, expectedVersion }) {
  await assertAdmin(client, actorUserId);
  const notes = requireNotes(adminNotes);

  if (!Object.values(CASE_RESOLUTIONS).includes(resolution)) {
    throw new IntegrityError('Unknown resolution.', { status: 400, code: 'RESOLUTION_INVALID' });
  }

  const locked = await client.query('SELECT * FROM entry_integrity_cases WHERE id = $1 FOR UPDATE', [caseId]);
  const row = locked.rows[0];
  if (!row) {
    throw new IntegrityError('That case does not exist.', { status: 404, code: 'CASE_NOT_FOUND' });
  }

  const current = { case_id: row.id, status: row.status, version: row.version };
  assertVersion(expectedVersion, row.version, current);

  if (row.status === CASE_STATUS.RESOLVED) {
    return { changed: false, case: row };
  }
  // A confirmed concern is not re-resolvable into silence. Reopening it, or
  // deciding what to do about it, is the owner-and-counsel decision this state
  // exists to wait for.
  if (row.status === CASE_STATUS.UPHELD_BLOCKED) {
    throw new IntegrityError(
      'This case was upheld and is blocked pending an owner and legal decision. It cannot be closed from here.',
      { status: 409, code: 'CASE_BLOCKED_PENDING_DECISION', details: current }
    );
  }

  const nextStatus =
    resolution === CASE_RESOLUTIONS.UPHELD ? CASE_STATUS.UPHELD_BLOCKED : CASE_STATUS.RESOLVED;

  await recordCaseEvent(client, {
    caseRow: row,
    toStatus: nextStatus,
    resolution,
    adminNotes: notes,
    actorUserId,
    actorRole: 'admin',
  });

  await client.query(
    `UPDATE entry_integrity_cases
        SET status = $2, resolution = $3, resolution_reason = $4,
            resolved_by = $5, resolved_at = NOW(), version = version + 1
      WHERE id = $1`,
    [caseId, nextStatus, resolution, notes, actorUserId]
  );

  // Only reinstatement puts a held-back entry back in the pool. `upheld` changes
  // no entry status here — the entry is whatever it already was, and the case is
  // the record of the confirmed concern. `no_action` changes nothing by
  // definition.
  if (resolution === CASE_RESOLUTIONS.REINSTATED && row.entry_id) {
    const entry = await lockEntryForDecision(client, row.entry_id);
    if (entry.integrity_status !== STATUS.ELIGIBLE) {
      await recordEvent(client, {
        entry,
        toStatus: STATUS.ELIGIBLE,
        reasonCode: REASON_CODES.REINSTATED,
        adminNotes: notes,
        actorUserId,
        actorRole: 'admin',
        metadata: { case_id: caseId },
      });
      await client.query(
        `UPDATE entries
            SET integrity_status = 'eligible',
                integrity_reason_code = $2,
                integrity_admin_notes = $3,
                integrity_status_changed_at = NOW(),
                integrity_status_changed_by = $4,
                integrity_version = integrity_version + 1
          WHERE id = $1`,
        [row.entry_id, REASON_CODES.REINSTATED, notes, actorUserId]
      );
    }
  }

  const updated = await client.query('SELECT * FROM entry_integrity_cases WHERE id = $1', [caseId]);
  return { changed: true, case: updated.rows[0] };
}

// Whether a claim's fulfilment is paused.
//
// The predicate is the substantive one: a case blocks while it is open OR while
// it is upheld-and-blocked. Asking `status = 'open'` was the bug — resolving as
// "upheld" closed the case, released the pause, and let the prize ship to the
// winner whose entry had just been found wanting.
async function hasBlockingCase(client, giveawayId) {
  const result = await client.query(
    'SELECT 1 FROM entry_integrity_cases WHERE giveaway_id = $1 AND status = ANY($2) LIMIT 1',
    [giveawayId, BLOCKING_CASE_STATUSES]
  );
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// What an entrant may see about their own entry.
//
// A coarse status and a fixed sentence chosen by an allowlisted code. Never the
// administrator's notes, never a signal, never a hash, never another account,
// never anything about how a concern was noticed. If a giveaway they entered has
// a blocking case, they are told the outcome is pending — in those words, with
// no allegation attached.
const ENTRANT_STATUS_LABEL = {
  [STATUS.ELIGIBLE]: 'entered',
  [STATUS.UNDER_REVIEW]: 'under_review',
  [STATUS.DISQUALIFIED]: 'disqualified',
};

const PENDING_RESOLUTION_COPY =
  'This giveaway is under review. The outcome is pending — nothing about the result has been decided.';

function entrantView(entry, { blockingCase = false } = {}) {
  if (!entry) return null;
  const status = entry.integrity_status || STATUS.ELIGIBLE;
  return {
    entered_at: entry.created_at,
    ticket_number: entry.ticket_number,
    status: ENTRANT_STATUS_LABEL[status] || 'entered',
    // Derived from the code, never from stored free text. `explanation` rather
    // than `reason`: it explains what is happening, and does not report what
    // anybody was accused of.
    explanation:
      status === STATUS.ELIGIBLE && !blockingCase
        ? null
        : blockingCase && status === STATUS.ELIGIBLE
          ? PENDING_RESOLUTION_COPY
          : entrantCopyFor(entry.integrity_reason_code),
    resolution_pending: Boolean(blockingCase),
  };
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  TRANSITIONS,
  REASON_CODES,
  ENTRANT_COPY,
  CODES_FOR_STATUS,
  entrantCopyFor,
  COUNTED_STATUSES,
  COUNTED_SQL,
  CASE_STATUS,
  CASE_RESOLUTIONS,
  BLOCKING_CASE_STATUSES,
  PENDING_RESOLUTION_COPY,
  IntegrityError,
  assertAdmin,
  requireNotes,
  requireReasonCode,
  assertVersion,
  setStatus,
  assertDrawable,
  lockEligibleEntries,
  openCase,
  resolveCase,
  hasBlockingCase,
  entrantView,
  ENTRANT_STATUS_LABEL,
  _uuid: () => uuid(),
  _hash: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
};
