// Coverage for policy approval status and acceptance.
//
// The first cut of Phase 1.6 stamped both documents "Effective 15 August 2026".
// Nothing had been deployed, nobody had read them, and no lawyer had reviewed
// them — so that date asserted a fact about the world that was simply untrue.
// It is the same class of mistake as backfilling an acceptance record: a
// statement nobody could contradict at the time, and one that matters precisely
// when someone later disputes what they agreed to.
//
// These tests hold four things apart that are easy to conflate — which text,
// when it was edited, whether anyone approved it, and from when it binds — and
// prove that none of them implies any other.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { api, pool, ensureInit, signIn, anon } = require('../testHelpers');

const policies = require('../server/lib/policies');
const { POLICY_STATUS, PolicyNotAcceptableError } = policies;

const createdUserIds = [];

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdUserIds.length) {
    await pool.query('DELETE FROM policy_acceptances WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

async function createUser() {
  const id = uuid();
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, age_attestation_status, age_attestation_version)
     VALUES ($1, 'Policy Test User', $2, $3, TRUE, 'confirmed', '2026-08-eligibility-18')`,
    [id, `test-policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, bcrypt.hashSync('correcthorse123', 4)]
  );
  createdUserIds.push(id);
  return id;
}

// Synthetic policies, so the predicates can be exercised in states the real
// documents are deliberately not in.
function policyIn(state, overrides = {}) {
  return {
    id: 'synthetic',
    version: '2030-01-01.1',
    status: state,
    draftRevisedAt: '2030-01-01',
    effectiveDate: null,
    approvedAt: null,
    approvedBy: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The real documents are drafts
// ---------------------------------------------------------------------------

test('both published policies are drafts with no effective date', () => {
  ['terms', 'privacy'].forEach((id) => {
    const policy = policies.getPolicy(id);
    assert.equal(policy.status, POLICY_STATUS.DRAFT, `${id} must be a draft`);
    assert.equal(policy.effectiveDate, null, `${id} must have no effective date`);
    assert.equal(policy.approvedAt, null, `${id} must not be recorded as approved`);
    assert.equal(policy.approvedBy, null);
    assert.equal(policies.isEffective(policy), false);
    assert.equal(policies.canBeAccepted(policy), false);
    assert.ok(policy.blockers.length > 0, `${id} must list what is blocking approval`);
    assert.ok(
      policy.blockers.some((b) => /counsel/i.test(b)),
      `${id} must name counsel review as a blocker`
    );
  });
});

test('the four facts are kept separate', () => {
  const policy = policies.getPolicy('terms');

  // Which text, when edited, whether approved, from when binding — four
  // different questions, four different fields.
  assert.ok(policy.version, 'has a version');
  assert.ok(policy.draftRevisedAt, 'has a revision date');
  assert.ok(policy.status, 'has a status');
  assert.equal(policy.effectiveDate, null, 'and an effective date that is separate from all of them');

  // The revision date must not be quietly reused as an effective date.
  assert.notEqual(policy.draftRevisedAt, policy.effectiveDate);
});

// ---------------------------------------------------------------------------
// Nothing infers approval
// ---------------------------------------------------------------------------

test('a version number does not imply approval', () => {
  const bumped = policyIn(POLICY_STATUS.DRAFT, { version: '2031-06-01.9' });
  assert.equal(policies.isEffective(bumped), false, 'a higher version is still a draft');
  assert.equal(policies.canBeAccepted(bumped), false);
});

test('the calendar moving does not activate a policy', () => {
  // A draft whose revision date is long past, checked far in the future.
  const old = policyIn(POLICY_STATUS.DRAFT, { draftRevisedAt: '2020-01-01' });
  const farFuture = new Date('2099-12-31T00:00:00Z');

  assert.equal(policies.isEffective(old, farFuture), false, 'time passing changes nothing');
  assert.equal(policies.canBeAccepted(old, farFuture), false);

  // Even a draft that somehow carries a past effective date stays inert: the
  // status is what decides, not the date.
  const draftWithDate = policyIn(POLICY_STATUS.DRAFT, { effectiveDate: '2020-01-01' });
  assert.equal(policies.isEffective(draftWithDate, farFuture), false);
});

test('an approved policy is still not effective until it is deliberately made effective', () => {
  // Counsel has signed off and a date has been chosen — and it still does not
  // bind anyone, because approval and activation are separate acts.
  const approved = policyIn(POLICY_STATUS.APPROVED, {
    effectiveDate: '2020-01-01',
    approvedAt: '2019-12-01',
    approvedBy: 'counsel reference',
  });

  assert.equal(policies.isEffective(approved, new Date('2099-01-01T00:00:00Z')), false);
  assert.equal(policies.canBeAccepted(approved), false);

  // Only the explicit transition to EFFECTIVE does it.
  const effective = { ...approved, status: POLICY_STATUS.EFFECTIVE };
  assert.equal(policies.isEffective(effective, new Date('2099-01-01T00:00:00Z')), true);
  assert.equal(policies.canBeAccepted(effective, new Date('2099-01-01T00:00:00Z')), true);
});

test('an effective policy with a future date is not yet in force', () => {
  const scheduled = policyIn(POLICY_STATUS.EFFECTIVE, { effectiveDate: '2099-01-01' });
  assert.equal(policies.isEffective(scheduled, new Date('2026-08-15T00:00:00Z')), false);
  assert.equal(policies.isEffective(scheduled, new Date('2099-06-01T00:00:00Z')), true);
});

test('an effective policy with no date is not in force', () => {
  // A status without a date is a misconfiguration, not an activation.
  const dateless = policyIn(POLICY_STATUS.EFFECTIVE, { effectiveDate: null });
  assert.equal(policies.isEffective(dateless), false);
});

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

test('a draft policy cannot be accepted', () => {
  ['terms', 'privacy'].forEach((id) => {
    assert.throws(
      () => policies.assertAcceptable(id),
      (err) => err instanceof PolicyNotAcceptableError && err.code === 'POLICY_IS_DRAFT',
      `${id} must refuse acceptance while a draft`
    );
  });
});

test('recording an acceptance against a draft writes nothing at all', async () => {
  const userId = await createUser();

  const before = await pool.query('SELECT COUNT(*)::int AS c FROM policy_acceptances');

  await assert.rejects(
    policies.recordAcceptance(pool, { userId, policyId: 'terms' }),
    (err) => err instanceof PolicyNotAcceptableError && err.code === 'POLICY_IS_DRAFT'
  );
  await assert.rejects(
    policies.recordAcceptance(pool, { userId, policyId: 'privacy' }),
    (err) => err instanceof PolicyNotAcceptableError
  );

  const after = await pool.query('SELECT COUNT(*)::int AS c FROM policy_acceptances');
  assert.equal(after.rows[0].c, before.rows[0].c, 'no row may be written for a draft');

  const forUser = await pool.query('SELECT COUNT(*)::int AS c FROM policy_acceptances WHERE user_id = $1', [
    userId,
  ]);
  assert.equal(forUser.rows[0].c, 0);
});

test('the acceptance table is empty, and stays empty', async () => {
  // Nothing in this codebase has ever recorded an acceptance, because no policy
  // has ever been effective. An empty table is the honest answer to "who agreed
  // to what"; a populated one would be a fabricated answer.
  const rows = await pool.query('SELECT COUNT(*)::int AS c FROM policy_acceptances');
  assert.equal(rows.rows[0].c, 0, 'policy_acceptances must be empty while both policies are drafts');
});

test('an unknown policy is refused rather than assumed acceptable', () => {
  assert.throws(
    () => policies.assertAcceptable('marketing-consent'),
    (err) => err.code === 'UNKNOWN_POLICY'
  );
});

// ---------------------------------------------------------------------------
// What the pages and the API say
// ---------------------------------------------------------------------------

test('the API reports draft status and a null effective date', async () => {
  const res = await api().get('/api/config');
  assert.equal(res.status, 200);

  ['terms', 'privacy'].forEach((id) => {
    const policy = res.body.policies[id];
    assert.equal(policy.status, 'draft');
    assert.equal(policy.effectiveDate, null, 'a draft must not report an effective date');
    assert.equal(policy.isEffective, false);
    assert.equal(policy.acceptable, false);
    assert.ok(policy.draftRevisedAt, 'the revision date is reported separately');
  });
});

test('both policy pages present themselves as drafts, with no effective date', () => {
  ['terms', 'privacy'].forEach((name) => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');

    assert.match(page, /Draft — not yet legally effective/i, `${name} must be marked a draft`);
    assert.match(page, /not yet effective/i, `${name} must say it has no effective date`);
    assert.match(page, /never been presented to any user for acceptance/i);
    assert.match(page, /pending owner information|does not yet name a data controller/i);

    // The old wording asserted a date under the word "Effective". Nothing on
    // these pages may do that again.
    assert.ok(
      !/Effective <strong[^>]*>\s*\d/i.test(page),
      `${name} must not print a date as its effective date`
    );
    assert.ok(
      !/effective (date )?:?\s*15 August 2026/i.test(page),
      `${name} must not claim the original fabricated effective date`
    );
  });
});

test('the pages say plainly that approval and activation are separate', () => {
  ['terms', 'privacy'].forEach((name) => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
    assert.match(
      page,
      /separate,? deliberate steps|two separate, deliberate steps|Approval and activation are separate/i,
      `${name} must explain that approval does not make a policy effective`
    );
    assert.match(page, /refuses to record an acceptance against a draft/i);
  });
});

test('activation is a reviewed source change, not configuration or a deploy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'policies.js'), 'utf8');

  // No environment variable may flip a policy live: a deploy with the right
  // variable set would otherwise activate an unreviewed document.
  const statusRegion = source.slice(source.indexOf('const POLICIES'), source.indexOf('class PolicyNotAcceptableError'));
  assert.ok(
    !/process\.env/.test(statusRegion),
    'policy status must not be derived from the environment'
  );

  // And the shipped values are drafts, so a deploy of this branch activates
  // nothing.
  assert.match(source, /status: POLICY_STATUS\.DRAFT/);
  assert.ok(!/status: POLICY_STATUS\.EFFECTIVE/.test(source), 'nothing is shipped effective');
});
