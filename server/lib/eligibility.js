// "I confirm that I am 18 years of age or older."
//
// What this is: a versioned, timestamped record that somebody ticked a box
// saying that. What it is not, and must never be described as: age
// verification. No date of birth is collected, no identity document, no
// biometric, no third-party age-estimation service. If somebody unticks the
// truth, this system does not know and cannot find out.
//
// That limitation is not a gap to be closed quietly later. Closing it means
// collecting identity data about every entrant, which is a much larger
// decision with its own legal weight — see docs/UAE_COUNSEL_REVIEW.md B10.
//
// Kept deliberately separate from policy acceptance. Agreeing to a document and
// attesting a fact about yourself are different acts: conflating them would mean
// a future Terms revision silently re-asking an age question, or an age prompt
// implying agreement to a document that is not even effective.
const { v4: uuid } = require('uuid');

const STATUS = {
  // Every account that existed before this phase, and the honest answer for
  // them. Never backfilled to 'confirmed': nobody was asked, so nobody answered.
  UNKNOWN: 'unknown',
  CONFIRMED: 'confirmed',
};

// Versioned so that a change of wording is a change of record. Bumping this
// makes every existing attestation stale for the purposes of `needsAttestation`
// below — which is why it is a deliberate edit and not a date or a variable.
const CURRENT_VERSION = '2026-08-eligibility-18';

// The exact sentence. Held here rather than in a template so the recorded
// version and the words the person read cannot drift apart.
//
// MARKED FOR COUNSEL REVIEW: whether self-attestation is sufficient, whether
// this wording is adequate, and what (if anything) is required beyond it.
const WORDING = 'I confirm that I am 18 years of age or older.';

const REVIEW_NOTE =
  'Self-attestation only. This is not age or identity verification, and no date of birth or document is collected. Wording and sufficiency are pending qualified UAE counsel review.';

function isConfirmed(user) {
  return Boolean(
    user &&
    user.age_attestation_status === STATUS.CONFIRMED &&
    user.age_attestation_version === CURRENT_VERSION
  );
}

// Whether this account should be asked before it does something new.
//
// "Something new" is the whole point: entering a giveaway, or starting a hosting
// action. It deliberately does not cover finishing something already begun —
// see `blocksAction` below.
function needsAttestation(user) {
  return !isConfirmed(user);
}

// Actions that require an attestation first, and actions that must never be
// blocked by one.
//
// A winner mid-delivery, or somebody with an open claim, must not be stranded
// because a question we never asked them has no answer on file. Blocking a
// prize on a missing checkbox would make an administrative gap the winner's
// problem — the same mistake the host-suspension phase had to correct.
const GATED_ACTIONS = ['enter_giveaway', 'create_giveaway', 'apply_to_host'];
const NEVER_GATED_ACTIONS = [
  'claim_prize',
  'claim_transition',
  'confirm_delivery',
  'raise_dispute',
  'export_data',
  'privacy_request',
  'sign_in',
  'sign_out',
];

function blocksAction(user, action) {
  if (NEVER_GATED_ACTIONS.includes(action)) return false;
  if (!GATED_ACTIONS.includes(action)) return false;
  return needsAttestation(user);
}

async function recordAttestation(client, { userId, confirmed, version = CURRENT_VERSION }) {
  // Nothing else is an attestation. An absent, false or "on"-ish value is a box
  // that was not ticked, and a box that was not ticked is not consent.
  if (confirmed !== true) {
    const err = new Error(
      'Please confirm you are 18 or older to continue. This is a self-declaration; we do not ask for a date of birth or any document.'
    );
    err.status = 400;
    err.code = 'AGE_ATTESTATION_REQUIRED';
    throw err;
  }

  await client.query(
    `UPDATE users
        SET age_attestation_status = $2,
            age_attestation_version = $3,
            age_attested_at = NOW()
      WHERE id = $1`,
    [userId, STATUS.CONFIRMED, version]
  );

  return { status: STATUS.CONFIRMED, version, wording: WORDING };
}

// What a user may see about their own attestation. There is no public age
// information anywhere: no badge, no field on a profile, nothing in a card, and
// nothing in any list response.
function selfView(user) {
  return {
    status: user.age_attestation_status || STATUS.UNKNOWN,
    version: user.age_attestation_version || null,
    attested_at: user.age_attested_at || null,
    current_version: CURRENT_VERSION,
    needs_attestation: needsAttestation(user),
    wording: WORDING,
    limitation: REVIEW_NOTE,
  };
}

module.exports = {
  STATUS,
  CURRENT_VERSION,
  WORDING,
  REVIEW_NOTE,
  GATED_ACTIONS,
  NEVER_GATED_ACTIONS,
  isConfirmed,
  needsAttestation,
  blocksAction,
  recordAttestation,
  selfView,
  _uuid: () => uuid(),
};
