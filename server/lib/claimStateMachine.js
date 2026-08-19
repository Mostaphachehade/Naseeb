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
//
// 'admin_rescue' is an administrator standing in for a host who has been
// suspended mid-delivery. It is not the same thing as 'admin': an administrator
// resolving a dispute is exercising their own authority, while a rescuer is
// doing the one job the absent host would otherwise have done. It is therefore
// granted exactly the host's three forward moves and nothing else — see
// RESCUE_ELIGIBLE_STATES below, and server/lib/claimRescue.js for when it may
// be assumed at all.
// ---------------------------------------------------------------------------
// The fulfilment role model is NOT the approved one
// ---------------------------------------------------------------------------
//
// The approved future model is: the sponsor supplies or funds the prize; Naseeb
// manages the winner relationship, coordinates delivery or fulfilment, and is
// who the winner contacts; the winner alone confirms receipt; and the sponsor or
// host does not drive the winner's claim state as though they were the
// fulfilment operator.
//
// The transitions below still give `ROLES.HOST` the operational moves —
// `PREPARING_DELIVERY`, `SHIPPED_OR_ARRANGED`, `DELIVERED_PENDING_CONFIRMATION`.
// The winner already holds the one that matters most (only `ROLES.WINNER` can
// move a claim to `DELIVERED`), and `ADMIN_RESCUE` already lets Naseeb act when
// a host does not. But the shape is a host-operated fulfilment workflow, and the
// approved model is a Naseeb-operated one.
//
// Changing it touches consent wording, delivery-detail access, the dispute path,
// retention and the audit trail, and it is not a change to make against a
// deadline. So it is recorded here as FALSE, `config.launchBlockers()` reads
// this constant, and no deployment can accept a real campaign until somebody
// changes it deliberately — with the work done and tested.
const FULFILMENT_ROLE_MODEL_RESOLVED = false;

const ROLES = {
  WINNER: 'winner',
  HOST: 'host',
  ADMIN: 'admin',
  ADMIN_RESCUE: 'admin_rescue',
  SYSTEM: 'system',
};

const TRANSITIONS = {
  [STATES.AWAITING_CLAIM]: {
    // Only the winner, and only by presenting a valid claim token plus consent.
    [STATES.CLAIMED]: [ROLES.WINNER],
    [STATES.EXPIRED]: [ROLES.SYSTEM, ROLES.ADMIN],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.CLAIMED]: {
    [STATES.PREPARING_DELIVERY]: [ROLES.HOST, ROLES.ADMIN_RESCUE],
    [STATES.DISPUTED]: [ROLES.WINNER, ROLES.HOST],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.PREPARING_DELIVERY]: {
    [STATES.SHIPPED_OR_ARRANGED]: [ROLES.HOST, ROLES.ADMIN_RESCUE],
    [STATES.DISPUTED]: [ROLES.WINNER, ROLES.HOST],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.SHIPPED_OR_ARRANGED]: {
    // The furthest a host can move it on their own. Saying "I sent it" is a
    // claim about their own actions; saying "you received it" is not theirs to
    // make. A rescuer inherits exactly that limit, for exactly that reason.
    [STATES.DELIVERED_PENDING_CONFIRMATION]: [ROLES.HOST, ROLES.ADMIN_RESCUE],
    [STATES.DISPUTED]: [ROLES.WINNER, ROLES.HOST],
    [STATES.CANCELLED]: [ROLES.ADMIN],
  },
  [STATES.DELIVERED_PENDING_CONFIRMATION]: {
    // Only the winner closes this. Not the host, not an administrator, not a
    // rescuer, not an automatic timer. Rescue exists so that a suspended host
    // does not strand a winner — not so that somebody else can answer the one
    // question only the winner can answer.
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

// The states a rescuer may act from, derived from the table above rather than
// listed a second time — a role that appears in TRANSITIONS but not here (or
// the reverse) would be a silent disagreement between the gate and the queue.
const RESCUE_ELIGIBLE_STATES = new Set(
  Object.entries(TRANSITIONS)
    .filter(([, moves]) => Object.values(moves).some((roles) => roles.includes(ROLES.ADMIN_RESCUE)))
    .map(([from]) => from)
);

// Every claim that is not finished. A suspended host's claims all go into the
// rescue queue so an administrator sees the whole picture, even the ones where
// nothing is waiting on a host right now (a claim the winner has not opened
// yet, or one waiting on the winner's confirmation).
const ACTIVE_STATES = new Set(Object.values(STATES).filter((state) => !TERMINAL.has(state)));

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
  FULFILMENT_ROLE_MODEL_RESOLVED,
  TERMINAL,
  TRANSITIONS,
  RESCUE_ELIGIBLE_STATES,
  ACTIVE_STATES,
  PUBLIC_STATUS,
  ClaimTransitionError,
  isValidState,
  allowedTransitions,
  assertTransition,
};
