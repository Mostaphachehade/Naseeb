// Versions and effective dates for the public policy documents.
//
// Two things this makes possible that were not before: telling a reader which
// version they are looking at, and — once signup captures it — recording which
// version a particular person agreed to.
//
// What it deliberately does NOT do is claim anyone has agreed to anything. No
// account on this platform has ever been shown a versioned policy, so there is
// no historical acceptance to record and none is invented. The
// policy_acceptances table starts empty on purpose, and stays empty until
// signup-time capture is built. An empty table is an honest answer to "who
// accepted what"; a backfilled one would be a fabricated answer.
//
// Bump the version and the effective date together whenever the wording changes
// in a way a reader would care about.
const POLICIES = {
  terms: {
    id: 'terms',
    version: '2026-08-15.1',
    effectiveDate: '2026-08-15',
    url: '/terms.html',
    // Everything here is under review; see docs/UAE_COUNSEL_REVIEW.md.
    reviewStatus: 'pending_counsel_review',
  },
  privacy: {
    id: 'privacy',
    version: '2026-08-15.1',
    effectiveDate: '2026-08-15',
    url: '/privacy.html',
    reviewStatus: 'pending_counsel_review',
  },
};

// The consent wording a winner agrees to when sharing delivery details is
// versioned separately, in server/lib/claims.js, because it is presented at a
// different moment and changes for different reasons.

function currentPolicies() {
  return POLICIES;
}

function policyVersion(id) {
  return POLICIES[id] ? POLICIES[id].version : null;
}

module.exports = { POLICIES, currentPolicies, policyVersion };
