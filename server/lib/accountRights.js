// The account centre: correcting your own details, changing the address your
// account is reached at, taking a copy of your data, and asking us to do
// something about it.
//
// Two principles run through all of it.
//
// **A request is a request.** Nothing here erases anything on its own. A
// deletion request opens a case for a human, because what can actually be
// deleted depends on open claims, payment records, audit obligations and legal
// advice this project does not yet have. Saying "deleted" and meaning "queued"
// would be the dishonest version.
//
// **Changing an email address is a security event.** It is the address a
// password reset goes to, so an attacker holding a live session who can silently
// move it owns the account permanently. Hence: recent password, a token that
// only the new address receives, the old address told what is happening, and
// every session ended when it completes.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const REQUEST_TYPES = ['access', 'correction', 'deletion', 'objection'];

const REQUEST_STATUS = {
  SUBMITTED: 'submitted',
  IN_REVIEW: 'in_review',
  AWAITING_INFORMATION: 'awaiting_information',
  COMPLETED: 'completed',
  DECLINED: 'declined',
  UNABLE_TO_COMPLETE: 'unable_to_complete',
};

const OPEN_STATUSES = [
  REQUEST_STATUS.SUBMITTED,
  REQUEST_STATUS.IN_REVIEW,
  REQUEST_STATUS.AWAITING_INFORMATION,
];
const CLOSED_STATUSES = [
  REQUEST_STATUS.COMPLETED,
  REQUEST_STATUS.DECLINED,
  REQUEST_STATUS.UNABLE_TO_COMPLETE,
];

// The same split the entry-integrity phase established: an allowlisted code
// chooses what the requester reads, and the administrator's notes stay
// internal. A privacy request is exactly the sort of thing whose working notes
// mention other accounts, an open dispute, or a suspicion — none of which
// belongs in the reply.
const OUTCOME_CODES = {
  ACCESS_PROVIDED: 'access_provided',
  CORRECTION_APPLIED: 'correction_applied',
  DELETION_PARTIAL: 'deletion_partial_records_retained',
  DELETION_BLOCKED: 'deletion_blocked_pending_obligations',
  OBJECTION_UPHELD: 'objection_upheld',
  OBJECTION_DECLINED: 'objection_declined',
  NEED_MORE_INFORMATION: 'need_more_information',
  NOT_POSSIBLE: 'not_possible',
};

const OUTCOME_COPY = {
  [OUTCOME_CODES.ACCESS_PROVIDED]:
    'We have provided a copy of the data we hold about your account. You can also download a copy at any time from your account centre.',
  [OUTCOME_CODES.CORRECTION_APPLIED]:
    'The correction you asked for has been made.',
  [OUTCOME_CODES.DELETION_PARTIAL]:
    'Your account data has been removed or anonymised where we are able to do so. Some records are kept because they are needed for prize, payment or audit purposes — your account centre lists which categories those are.',
  [OUTCOME_CODES.DELETION_BLOCKED]:
    'We cannot action this deletion yet. There is an active prize claim, payment record or audit obligation attached to your account that has to be settled first. Nothing has been deleted, and nothing has been refused — this stays open.',
  [OUTCOME_CODES.OBJECTION_UPHELD]:
    'We have stopped the processing you objected to.',
  [OUTCOME_CODES.OBJECTION_DECLINED]:
    'We are not able to stop this processing, because it is needed to run the giveaway or to meet an obligation. If you would like more detail, please reply and a person will explain.',
  [OUTCOME_CODES.NEED_MORE_INFORMATION]:
    'We need a little more information before we can act on this. Please reply to the email we sent you.',
  [OUTCOME_CODES.NOT_POSSIBLE]:
    'We are not able to complete this request as asked. If you would like to know more, please reply and a person will explain.',
};

// Which outcomes may close which status. `completed` needs an outcome that
// actually happened — a request cannot be marked done with "we need more
// information".
const OUTCOMES_FOR_STATUS = {
  [REQUEST_STATUS.COMPLETED]: [
    OUTCOME_CODES.ACCESS_PROVIDED,
    OUTCOME_CODES.CORRECTION_APPLIED,
    OUTCOME_CODES.DELETION_PARTIAL,
    OUTCOME_CODES.OBJECTION_UPHELD,
  ],
  [REQUEST_STATUS.DECLINED]: [OUTCOME_CODES.OBJECTION_DECLINED, OUTCOME_CODES.NOT_POSSIBLE],
  [REQUEST_STATUS.UNABLE_TO_COMPLETE]: [
    OUTCOME_CODES.DELETION_BLOCKED,
    OUTCOME_CODES.NOT_POSSIBLE,
  ],
  [REQUEST_STATUS.AWAITING_INFORMATION]: [OUTCOME_CODES.NEED_MORE_INFORMATION],
  [REQUEST_STATUS.IN_REVIEW]: [],
  [REQUEST_STATUS.SUBMITTED]: [],
};

class RightsError extends Error {
  constructor(message, { status = 400, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Reauthentication
// ---------------------------------------------------------------------------

// Anything that exports data or moves the account's address asks for the
// password again, in the same request. A live session is evidence that somebody
// signed in once; it is not evidence that the person at the keyboard now is the
// same one.
const bcrypt = require('bcryptjs');

async function assertRecentPassword(client, { userId, password }) {
  if (!password || typeof password !== 'string') {
    throw new RightsError('Enter your password to continue.', {
      status: 400,
      code: 'PASSWORD_REQUIRED',
    });
  }
  const result = await client.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  // Compared even when the account is missing, so the timing of the two cases
  // does not differ enough to answer "does this account exist".
  const hash = row ? row.password_hash : '$2a$04$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(password, hash);
  if (!row || !ok) {
    throw new RightsError('That password is not right.', {
      status: 403,
      code: 'PASSWORD_INCORRECT',
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------

const EMAIL_TOKEN_BYTES = 32;
const EMAIL_TOKEN_TTL_HOURS = 2;

function issueEmailToken() {
  const token = crypto.randomBytes(EMAIL_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashEmailToken(token) };
}

function hashEmailToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

// Starts a change. The account's own email is NOT touched here — that is the
// whole point of the table this writes to.
async function startEmailChange(client, { userId, newEmail, now = new Date() }) {
  const email = normaliseEmail(newEmail);
  if (!looksLikeEmail(email)) {
    throw new RightsError('That does not look like an email address.', {
      status: 400,
      code: 'EMAIL_INVALID',
    });
  }

  const me = await client.query('SELECT email FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!me.rows[0]) {
    throw new RightsError('Account not found.', { status: 404, code: 'ACCOUNT_NOT_FOUND' });
  }
  const previousEmail = me.rows[0].email;
  if (normaliseEmail(previousEmail) === email) {
    throw new RightsError('That is already the address on this account.', {
      status: 400,
      code: 'EMAIL_UNCHANGED',
    });
  }

  // Checked here so the person is told early, and checked AGAIN inside the
  // completion transaction — between the two, somebody else can sign up with it.
  const taken = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
  if (taken.rowCount) {
    throw new RightsError('That address cannot be used.', {
      status: 409,
      code: 'EMAIL_TAKEN',
    });
  }

  // One pending change per account. A second request supersedes the first
  // deliberately, and the superseded one is cancelled with a reason rather than
  // vanishing.
  await client.query(
    `UPDATE email_change_requests
        SET status = 'cancelled', cancelled_at = NOW(),
            cancelled_reason = 'superseded by a newer request'
      WHERE user_id = $1 AND status = 'pending'`,
    [userId]
  );

  const { token, hash } = issueEmailToken();
  const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_TTL_HOURS * 3600000);
  const id = uuid();

  await client.query(
    `INSERT INTO email_change_requests
       (id, user_id, token_hash, new_email, previous_email, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
    [id, userId, hash, email, previousEmail, expiresAt]
  );

  // The token is returned to the caller ONCE, to be put in an email. It is never
  // stored, never logged, and never returned by any read endpoint.
  return { id, token, newEmail: email, previousEmail, expiresAt };
}

// Completes a change. Single-use and race-safe: the UPDATE matches only a row
// that is still pending and unexpired, so a second attempt affects zero rows.
async function completeEmailChange(client, { token, now = new Date() }) {
  const hash = hashEmailToken(token);

  const claimed = await client.query(
    `UPDATE email_change_requests
        SET status = 'completed', completed_at = NOW()
      WHERE token_hash = $1 AND status = 'pending' AND expires_at > $2
      RETURNING *`,
    [hash, now]
  );
  const request = claimed.rows[0];
  if (!request) {
    throw new RightsError('That link is no longer valid. Start the change again from your account.', {
      status: 400,
      code: 'EMAIL_CHANGE_TOKEN_INVALID',
    });
  }

  // Re-checked inside the same transaction that writes the new address: the
  // check at the start of the flow is hours old by now.
  const taken = await client.query(
    'SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2',
    [normaliseEmail(request.new_email), request.user_id]
  );
  if (taken.rowCount) {
    throw new RightsError('That address is no longer available.', {
      status: 409,
      code: 'EMAIL_TAKEN',
    });
  }

  await client.query(
    `UPDATE users SET email = $2, email_verified = TRUE WHERE id = $1`,
    [request.user_id, request.new_email]
  );

  return request;
}

async function expireStaleEmailChanges(client, { now = new Date() } = {}) {
  const result = await client.query(
    `UPDATE email_change_requests
        SET status = 'expired', cancelled_at = NOW(), cancelled_reason = 'expired'
      WHERE status = 'pending' AND expires_at <= $1`,
    [now]
  );
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// Privacy requests
// ---------------------------------------------------------------------------

// A short human reference. Not sequential — a sequential id tells anybody
// holding one how many requests exist and roughly when theirs was made.
function newReference() {
  return `PR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// What is standing in the way of acting on a deletion request right now.
//
// Computed rather than asserted, and reported as categories rather than
// details: "you have an open prize claim" is what the requester needs, not the
// claim's contents. The administrator sees the same categories, then opens the
// relevant workflow to look properly.
async function deletionBlockers(client, userId) {
  const blockers = [];

  const openClaims = await client.query(
    `SELECT COUNT(*)::int AS c FROM prize_claims
      WHERE winner_user_id = $1
        AND status NOT IN ('delivered', 'cancelled')`,
    [userId]
  );
  if (openClaims.rows[0].c > 0) {
    blockers.push({
      category: 'open_prize_claim',
      count: openClaims.rows[0].c,
      note: 'A prize claim is still in progress. Deleting the account now would strand it.',
    });
  }

  const hostedOpen = await client.query(
    `SELECT COUNT(*)::int AS c FROM giveaways
      WHERE host_id = $1 AND status = 'active'`,
    [userId]
  );
  if (hostedOpen.rows[0].c > 0) {
    blockers.push({
      category: 'active_giveaway_hosted',
      count: hostedOpen.rows[0].c,
      note: 'This account is hosting a giveaway that is still open to entries.',
    });
  }

  const disputes = await client.query(
    `SELECT COUNT(*)::int AS c FROM prize_claims c
       JOIN giveaways g ON g.id = c.giveaway_id
      WHERE (c.winner_user_id = $1 OR g.host_id = $1)
        AND c.status = 'disputed'`,
    [userId]
  );
  if (disputes.rows[0].c > 0) {
    blockers.push({
      category: 'open_dispute',
      count: disputes.rows[0].c,
      note: 'A dispute is open and has to be resolved by a person first.',
    });
  }

  const integrityCases = await client.query(
    `SELECT COUNT(*)::int AS c
       FROM entry_integrity_cases ic
       JOIN entries e ON e.id = ic.entry_id
      WHERE e.user_id = $1 AND ic.status IN ('open', 'upheld_blocked')`,
    [userId]
  );
  if (integrityCases.rows[0].c > 0) {
    blockers.push({
      category: 'open_integrity_case',
      count: integrityCases.rows[0].c,
      note: 'An entry integrity review attached to this account is still open.',
    });
  }

  // Audit history is always a consideration, whether or not anything is open.
  // Stated so nobody is surprised by it at the end.
  blockers.push({
    category: 'audit_records',
    count: null,
    note: 'Some records — integrity decisions, claim history, payment records — are kept for audit and cannot simply be deleted. What can be erased, anonymised or must be retained is pending counsel review; see docs/PRIVACY_AND_RIGHTS.md §8.',
  });

  return blockers;
}

async function createRequest(client, { userId, requestType, message, now = new Date() }) {
  if (!REQUEST_TYPES.includes(requestType)) {
    throw new RightsError(`request_type must be one of: ${REQUEST_TYPES.join(', ')}.`, {
      status: 400,
      code: 'REQUEST_TYPE_INVALID',
    });
  }
  const text = String(message || '').trim();
  if (text.length > 4000) {
    throw new RightsError('That message is too long.', { status: 400, code: 'MESSAGE_TOO_LONG' });
  }

  const blockers = requestType === 'deletion' ? await deletionBlockers(client, userId) : [];

  const id = uuid();
  const reference = newReference();
  await client.query(
    `INSERT INTO privacy_requests
       (id, reference, user_id, request_type, status, user_message, blockers)
     VALUES ($1, $2, $3, $4, 'submitted', $5, $6)`,
    [id, reference, userId, requestType, text || null, JSON.stringify(blockers)]
  );

  await client.query(
    `INSERT INTO privacy_request_events
       (id, request_id, user_id, from_status, to_status, actor_user_id, actor_role)
     VALUES ($1, $2, $3, NULL, 'submitted', $3, 'user')`,
    [uuid(), id, userId]
  );

  const row = await client.query('SELECT * FROM privacy_requests WHERE id = $1', [id]);
  return row.rows[0];
}

// An administrator moving a request along. Same shape as every other decision in
// this codebase: authorization re-read from the database, notes mandatory,
// version checked, history appended.
async function decideRequest(client, { requestId, toStatus, outcomeCode, adminNotes, actorUserId, expectedVersion }) {
  const admin = await client.query(
    'SELECT is_admin, account_status FROM users WHERE id = $1',
    [actorUserId]
  );
  const actor = admin.rows[0];
  if (!actor || actor.account_status !== 'active' || !actor.is_admin) {
    throw new RightsError('Administrators only.', { status: 403, code: 'ADMIN_REQUIRED' });
  }

  if (!Object.values(REQUEST_STATUS).includes(toStatus)) {
    throw new RightsError('Unknown status.', { status: 400, code: 'STATUS_INVALID' });
  }
  const notes = String(adminNotes || '').trim();
  if (notes.length < 3) {
    throw new RightsError('Administrator notes are required — they are the record of the decision.', {
      status: 400,
      code: 'NOTES_REQUIRED',
    });
  }

  const allowedOutcomes = OUTCOMES_FOR_STATUS[toStatus] || [];
  if (CLOSED_STATUSES.includes(toStatus) || toStatus === REQUEST_STATUS.AWAITING_INFORMATION) {
    if (!allowedOutcomes.includes(outcomeCode)) {
      throw new RightsError(
        `outcome_code must be one of: ${allowedOutcomes.join(', ')}.`,
        { status: 400, code: 'OUTCOME_CODE_INVALID', details: { allowed: allowedOutcomes } }
      );
    }
  }

  const locked = await client.query('SELECT * FROM privacy_requests WHERE id = $1 FOR UPDATE', [
    requestId,
  ]);
  const request = locked.rows[0];
  if (!request) {
    throw new RightsError('That request does not exist.', { status: 404, code: 'REQUEST_NOT_FOUND' });
  }

  const current = { request_id: request.id, status: request.status, version: request.version };
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') {
    throw new RightsError('A version is required. Reload the request and try again.', {
      status: 400,
      code: 'VERSION_REQUIRED',
      details: current,
    });
  }
  if (Number(expectedVersion) !== Number(request.version)) {
    throw new RightsError(
      'Somebody else changed this while your screen was open. Reload it and decide again.',
      { status: 409, code: 'STALE_DECISION', details: current }
    );
  }

  if (CLOSED_STATUSES.includes(request.status)) {
    throw new RightsError('This request is already closed.', {
      status: 409,
      code: 'REQUEST_CLOSED',
      details: current,
    });
  }

  // Completing a deletion while something is still blocking it would be a
  // completion in name only. The blockers are recomputed here rather than read
  // from the row, because they were computed when the request was made.
  if (toStatus === REQUEST_STATUS.COMPLETED && request.request_type === 'deletion') {
    const blockers = (await deletionBlockers(client, request.user_id)).filter(
      (b) => b.category !== 'audit_records'
    );
    if (blockers.length) {
      throw new RightsError(
        'This deletion still has open blockers. Resolve them, or close the request as unable to complete.',
        { status: 409, code: 'DELETION_BLOCKED', details: { ...current, blockers } }
      );
    }
  }

  await client.query(
    `INSERT INTO privacy_request_events
       (id, request_id, user_id, from_status, to_status, outcome_code, admin_notes, actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admin')`,
    [uuid(), request.id, request.user_id, request.status, toStatus, outcomeCode || null, notes, actorUserId]
  );

  const closed = CLOSED_STATUSES.includes(toStatus);
  await client.query(
    `UPDATE privacy_requests
        SET status = $2, outcome_code = $3, admin_notes = $4,
            version = version + 1, updated_at = NOW(),
            closed_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
            closed_by = CASE WHEN $5 THEN $6::text ELSE NULL END
      WHERE id = $1`,
    [request.id, toStatus, outcomeCode || null, notes, closed, actorUserId]
  );

  const updated = await client.query('SELECT * FROM privacy_requests WHERE id = $1', [request.id]);
  return { request: updated.rows[0], previousStatus: request.status };
}

// What the requester sees. Their own message back, a status, and the outcome
// sentence for the code — never the administrator's notes.
function requesterView(row) {
  return {
    reference: row.reference,
    type: row.request_type,
    status: row.status,
    submitted_at: row.created_at,
    updated_at: row.updated_at,
    your_message: row.user_message,
    outcome: row.outcome_code ? OUTCOME_COPY[row.outcome_code] || null : null,
    // Categories only. The requester is told a claim is open, not what is in it.
    blockers: Array.isArray(row.blockers)
      ? row.blockers.map((b) => ({ category: b.category, note: b.note }))
      : [],
    timing_note:
      'We have not published a response deadline. The applicable timescale under UAE law is pending confirmation by qualified counsel — see docs/UAE_COUNSEL_REVIEW.md.',
  };
}

module.exports = {
  REQUEST_TYPES,
  REQUEST_STATUS,
  OPEN_STATUSES,
  CLOSED_STATUSES,
  OUTCOME_CODES,
  OUTCOME_COPY,
  OUTCOMES_FOR_STATUS,
  RightsError,
  assertRecentPassword,
  EMAIL_TOKEN_TTL_HOURS,
  issueEmailToken,
  hashEmailToken,
  normaliseEmail,
  startEmailChange,
  completeEmailChange,
  expireStaleEmailChanges,
  deletionBlockers,
  createRequest,
  decideRequest,
  requesterView,
  newReference,
};
