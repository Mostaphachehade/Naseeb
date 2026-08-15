// The prize claim lifecycle, written down once and enforced on every request.
//
// Before this, "delivered" was a boolean the host could set by clicking a
// button — the host asserting, alone and unverifiably, that they had sent the
// thing they promised. There was no way for a winner to say otherwise, no way
// to tell an unclaimed prize from an undelivered one, and nothing recording who
// did what or when.
//
// Every transition below names both the state it moves to and who is allowed to
// make that move. Anything not listed is rejected, so an out-of-order or
// unauthorised change is a 4xx rather than a surprising row.

const STATES = {
  AWAITING_CLAIM: 'awaiting_claim',
  CLAIMED: 'claimed',
  PREPARING_DELIVERY: 'preparing_delivery',
  SHIPPED_OR_ARRANGED: 'shipped_or_arranged',
  DELIVERED_PENDING_CONFIRMATION: 'delivered_pending_confirmation',
  DELIVERED: 'delivered',
  DISPUTED: 'disputed',
  // A claim window that ran out. Deliberately NOT a redraw and NOT a
  // cancellation: someone genuinely won, and whether they lost the email, gave
  // up, or never existed is a question for a human. It sits in the admin review
  // queue until one answers it.
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

const TERMINAL = new Set([STATES.DELIVERED, STATES.CANCELLED]);

// Roles are resolved from the database per request — never taken from the
// browser. 'system' is the scheduled expiry sweep, which has no user behind it.
const ROLES = { WINNER: 'winner', HOST: 'host', ADMIN: 'admin', SYSTEM: 'system' };

const TRANSITIONS = {
  [STATES.AWAITING_CLAIM]: {
    // Only the winner, and only by presenting a valid claim token plus consent.
    [STATES.CLAIMED]: [ROLES.WINNER],
    [STATES.EXPIRED]: [ROLES.SYSTEM, ROLES.ADMIN],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.CLAIMED]: {
    [STATES.PREPARING_DELIVERY]: [ROLES.HOST],
    [STATES.DISPUTED]: [ROLES.WINNER, ROLES.HOST],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.PREPARING_DELIVERY]: {
    [STATES.SHIPPED_OR_ARRANGED]: [ROLES.HOST],
    [STATES.DISPUTED]: [ROLES.WINNER, ROLES.HOST],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.SHIPPED_OR_ARRANGED]: {
    // The furthest a host can move it on their own. Saying "I sent it" is a
    // claim about their own actions; saying "you received it" is not theirs to
    // make.
    [STATES.DELIVERED_PENDING_CONFIRMATION]: [ROLES.HOST],
    [STATES.DISPUTED]: [ROLES.WINNER, ROLES.HOST],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.DELIVERED_PENDING_CONFIRMATION]: {
    // Only the winner closes this. Not the host, not an automatic timer.
    [STATES.DELIVERED]: [ROLES.WINNER],
    [STATES.DISPUTED]: [ROLES.WINNER, ROLES.HOST],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.DISPUTED]: {
    // Only an administrator, and only with a recorded reason.
    [STATES.DELIVERED]: [ROLES.ADMIN],
    [STATES.PREPARING_DELIVERY]: [ROLES.ADMIN],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.EXPIRED]: {
    // An administrator can reissue the claim to the same winner, or close it.
    // Nothing here draws a different winner.
    [STATES.AWAITING_CLAIM]: [ROLES.ADMIN],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.DELIVERED]: {},
  [STATES.CANCELLED]: {},
};

// What the public may see. Deliberately coarse: a giveaway page shows that a
// delivery is in progress, never who is delivering what to which address.
const PUBLIC_STATUS = {
  [STATES.AWAITING_CLAIM]: 'awaiting_winner_claim',
  [STATES.CLAIMED]: 'delivery_in_progress',
  [STATES.PREPARING_DELIVERY]: 'delivery_in_progress',
  [STATES.SHIPPED_OR_ARRANGED]: 'delivery_in_progress',
  [STATES.DELIVERED_PENDING_CONFIRMATION]: 'delivery_in_progress',
  [STATES.DELIVERED]: 'delivered',
  [STATES.DISPUTED]: 'under_review',
  [STATES.EXPIRED]: 'under_review',
  [STATES.CANCELLED]: 'cancelled',
};

class ClaimTransitionError extends Error {
  constructor(message, { status = 400, code = 'INVALID_TRANSITION' } = {}) {
    super(message);
    this.name = 'ClaimTransitionError';
    this.status = status;
    this.code = code;
  }
}

function isValidState(state) {
  return Object.values(STATES).includes(state);
}

function allowedTransitions(from) {
  return TRANSITIONS[from] || {};
}

// The single gate every state change goes through. Separating "is this move
// legal at all" from "is this person allowed to make it" matters for the
// response: a move nobody can make from here is a 409, while a legal move by
// the wrong person is a 403.
function assertTransition(from, to, role) {
  if (!isValidState(from)) {
    throw new ClaimTransitionError(`Unknown claim state: ${from}`, { status: 500 });
  }
  if (!isValidState(to)) {
    throw new ClaimTransitionError(`Unknown target state: ${to}`);
  }
  if (TERMINAL.has(from)) {
    throw new ClaimTransitionError(
      `This claim is already ${from.replace(/_/g, ' ')} and cannot be changed.`,
      { status: 409 }
    );
  }

  const permitted = allowedTransitions(from)[to];
  if (!permitted) {
    throw new ClaimTransitionError(
      `A claim cannot go from ${from.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}.`,
      { status: 409 }
    );
  }
  if (!permitted.includes(role)) {
    throw new ClaimTransitionError('You are not allowed to make this change.', {
      status: 403,
      code: 'FORBIDDEN_TRANSITION',
    });
  }
  return true;
}

module.exports = {
  STATES,
  ROLES,
  TERMINAL,
  TRANSITIONS,
  PUBLIC_STATUS,
  ClaimTransitionError,
  isValidState,
  allowedTransitions,
  assertTransition,
};
