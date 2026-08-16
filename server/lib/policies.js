// Versions, revision dates and — crucially — approval status for the public
// policy documents.
//
// The previous version of this file stamped both documents with an effective
// date of 15 August 2026. That was wrong in a way worth spelling out: this
// branch has never been deployed, the pages have never been shown to anyone,
// and no lawyer has read them. An "effective date" asserts that a document took
// legal effect on a day — a claim about the world, not a formatting detail — and
// asserting it for a draft is the same category of mistake as backfilling an
// acceptance record.
//
// So four things are kept separate, because they answer four different
// questions:
//
//   version         which text is this?
//   draftRevisedAt  when was this text last edited?
//   status          has anyone with authority approved it?
//   effectiveDate   from when does it bind anyone?
//
// A date passing does not change a status. A version number going up does not
// mean approval. Both documents are drafts, both have a null effective date,
// and nothing can be accepted against either.

const POLICY_STATUS = {
  // Written, not reviewed. Cannot be accepted, has no effective date.
  DRAFT: 'draft',
  // Owner information supplied and counsel has signed off on the text — but it
  // still does not bind anyone until someone deliberately makes it effective.
  APPROVED: 'approved',
  // Live. The only status against which an acceptance may be recorded.
  EFFECTIVE: 'effective',
};

// Moving a policy to EFFECTIVE is a deliberate, reviewed edit to this file —
// setting the status AND an explicit effectiveDate — not something a deploy, a
// date rolling over, or an environment variable can do on its own. That is the
// point: activation should be a decision somebody made and someone else can see
// in a diff.
const POLICIES = {
  terms: {
    id: 'terms',
    version: '2026-08-15.1-draft',
    status: POLICY_STATUS.DRAFT,
    draftRevisedAt: '2026-08-15',
    // Null until the policy is made effective. Never a placeholder date.
    effectiveDate: null,
    approvedAt: null,
    approvedBy: null,
    url: '/terms.html',
    blockers: [
      'owner information outstanding (legal entity, licence, registered address, contact for notices)',
      'qualified UAE counsel review outstanding — see docs/UAE_COUNSEL_REVIEW.md',
    ],
  },
  privacy: {
    id: 'privacy',
    version: '2026-08-15.1-draft',
    status: POLICY_STATUS.DRAFT,
    draftRevisedAt: '2026-08-15',
    effectiveDate: null,
    approvedAt: null,
    approvedBy: null,
    url: '/privacy.html',
    blockers: [
      'data controller identity outstanding',
      'cross-border transfer basis and retention periods outstanding',
      'qualified UAE counsel review outstanding — see docs/UAE_COUNSEL_REVIEW.md',
    ],
  },
};

// The consent wording a winner agrees to when sharing delivery details is
// versioned separately, in server/lib/claims.js: it is presented at a different
// moment, to a different person, and changes for different reasons.

class PolicyNotAcceptableError extends Error {
  constructor(message, { code = 'POLICY_NOT_EFFECTIVE', status = 409 } = {}) {
    super(message);
    this.name = 'PolicyNotAcceptableError';
    this.code = code;
    this.status = status;
  }
}

// Every function below takes an optional registry.
//
// Tests need to exercise "what happens when a policy IS effective" without
// making a real policy effective — because a test that edits POLICIES to prove
// acceptance works is a test one careless merge away from shipping an effective
// policy nobody approved. So the registry is a parameter, the default is the
// real one, and the fixtures live in the test file.
function getPolicy(id, registry = POLICIES) {
  return registry[id] || null;
}

// Whether a newly effective version obliges people who accepted the previous one
// to accept again. Defaults to true for a version that says nothing: a policy
// change that quietly binds people who never saw it is the failure mode worth
// defaulting against. A version can opt out explicitly with
// `requiresReacceptance: false` — for a typo fix, say — and that opt-out is a
// visible line in a diff.
function requiresReacceptance(policy) {
  return policy.requiresReacceptance !== false;
}

// Effective means all three: someone marked it effective, gave it a date, and
// that date has arrived. Any one of them missing means it is not in force.
function isEffective(policy, now = new Date()) {
  if (!policy) return false;
  if (policy.status !== POLICY_STATUS.EFFECTIVE) return false;
  if (!policy.effectiveDate) return false;
  return new Date(`${policy.effectiveDate}T00:00:00Z`) <= now;
}

// The only gate on recording that somebody agreed to something.
function canBeAccepted(policy, now = new Date()) {
  return isEffective(policy, now);
}

// What a person still has to accept before a future gate would let them through.
//
// Returns the exact versions that are missing, not a boolean, because "you must
// accept something" is not a thing anybody can act on. An acceptance of an older
// version satisfies a newer one only when the newer one says reacceptance is not
// required.
async function missingAcceptances(client, { userId, registry = POLICIES, now = new Date() }) {
  const effective = Object.values(registry).filter((policy) => isEffective(policy, now));
  if (!effective.length) return [];

  const accepted = await client.query(
    'SELECT policy_id, policy_version FROM policy_acceptances WHERE user_id = $1',
    [userId]
  );
  const byPolicy = new Map();
  accepted.rows.forEach((row) => {
    if (!byPolicy.has(row.policy_id)) byPolicy.set(row.policy_id, new Set());
    byPolicy.get(row.policy_id).add(row.policy_version);
  });

  return effective
    .filter((policy) => {
      const versions = byPolicy.get(policy.id);
      if (!versions) return true;
      if (versions.has(policy.version)) return false;
      // They accepted an earlier version of this policy. Whether that still
      // counts is the new version's decision, and only its decision.
      return requiresReacceptance(policy);
    })
    .map((policy) => ({
      policy_id: policy.id,
      version: policy.version,
      effective_date: policy.effectiveDate,
      kind: ACCEPTANCE_KIND[policy.id] || 'agreement',
      url: policy.url,
    }));
}

// Terms are agreed to; a privacy notice is acknowledged. Different acts, and the
// record says which one it was rather than flattening both into "accepted".
const ACCEPTANCE_KIND = {
  terms: 'agreement',
  privacy: 'acknowledgement',
};

// Throws rather than returning false, so a caller cannot forget to check.
function assertAcceptable(policyId, now = new Date(), registry = POLICIES) {
  const policy = getPolicy(policyId, registry);
  if (!policy) {
    throw new PolicyNotAcceptableError(`Unknown policy: ${policyId}`, {
      code: 'UNKNOWN_POLICY',
      status: 404,
    });
  }
  if (policy.status === POLICY_STATUS.DRAFT) {
    throw new PolicyNotAcceptableError(
      `The ${policyId} policy is a draft and cannot be accepted. It is pending owner information and qualified UAE counsel review.`,
      { code: 'POLICY_IS_DRAFT' }
    );
  }
  if (policy.status === POLICY_STATUS.APPROVED) {
    throw new PolicyNotAcceptableError(
      `The ${policyId} policy has been approved but has not been made effective. Approval and activation are separate steps.`,
      { code: 'POLICY_NOT_YET_EFFECTIVE' }
    );
  }
  if (!isEffective(policy, now)) {
    throw new PolicyNotAcceptableError(
      `The ${policyId} policy is not in force${policy.effectiveDate ? ` until ${policy.effectiveDate}` : ''}.`,
      { code: 'POLICY_NOT_YET_EFFECTIVE' }
    );
  }
  return policy;
}

// Records that a user accepted a specific version of a policy.
//
// Refuses outright for anything that is not effective, so there is no path —
// deliberate or accidental — by which a draft ends up in policy_acceptances.
// That table stays empty until a policy is genuinely in force, and an empty
// table is the honest answer to "who agreed to what".
async function recordAcceptance(client, { userId, policyId, now = new Date(), registry = POLICIES, source = 'web' }) {
  const policy = assertAcceptable(policyId, now, registry);

  const { v4: uuid } = require('uuid');
  await client.query(
    `INSERT INTO policy_acceptances
       (id, user_id, policy_id, policy_version, policy_effective_date, acceptance_kind, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, policy_id, policy_version) DO NOTHING`,
    [
      uuid(),
      userId,
      policy.id,
      policy.version,
      // The effective date as it stood at the moment of acceptance. Stored, not
      // looked up later: the constants file can change and a consent record
      // must not change with it.
      policy.effectiveDate,
      ACCEPTANCE_KIND[policy.id] || 'agreement',
      source,
    ]
  );
  return {
    policyId: policy.id,
    version: policy.version,
    kind: ACCEPTANCE_KIND[policy.id] || 'agreement',
    effectiveDate: policy.effectiveDate,
  };
}

// What the pages render. Deliberately reports effectiveDate as null for a
// draft rather than substituting the revision date — showing a reader a date
// under the heading "effective" is the mistake this file exists to prevent.
function currentPolicies() {
  return Object.fromEntries(
    Object.values(POLICIES).map((policy) => [
      policy.id,
      {
        id: policy.id,
        version: policy.version,
        status: policy.status,
        draftRevisedAt: policy.draftRevisedAt,
        effectiveDate: policy.effectiveDate,
        isEffective: isEffective(policy),
        acceptable: canBeAccepted(policy),
        blockers: policy.blockers,
      },
    ])
  );
}

function policyVersion(id) {
  return POLICIES[id] ? POLICIES[id].version : null;
}

module.exports = {
  POLICY_STATUS,
  POLICIES,
  ACCEPTANCE_KIND,
  requiresReacceptance,
  missingAcceptances,
  PolicyNotAcceptableError,
  getPolicy,
  isEffective,
  canBeAccepted,
  assertAcceptable,
  recordAcceptance,
  currentPolicies,
  policyVersion,
};
