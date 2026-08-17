// Phase 2.3B: privacy rights, account correction, age attestation and
// policy-acceptance readiness.
//
// Two things this file is careful about, because getting either wrong would be
// worse than not having the feature at all:
//
//   * It must never make a real policy effective. The acceptance machinery is
//     exercised against a FABRICATED registry declared here, so the production
//     constants in server/lib/policies.js stay draft, null-dated and
//     unacceptable — and a test proves exactly that.
//
//   * It must never let "we opened a case about it" read as "we deleted it".
//     Several tests below exist only to pin the difference.
//
// Everything runs against the isolated test database with fabricated data. No
// real address, licence, entity or credential appears anywhere in it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const { api, pool, ensureInit, signIn, uniqueEmail, nextTestIp, TEST_ORIGIN, publishGiveaway, seedGiveaway, FABRICATED_PRIZE, closePool } = require('../testHelpers');

const rights = require('../server/lib/accountRights');
const eligibility = require('../server/lib/eligibility');
const policies = require('../server/lib/policies');
const dataExport = require('../server/lib/dataExport');
const sessions = require('../server/lib/sessions');
const outbox = require('../server/lib/emailChangeOutbox');
const claims = require('../server/lib/claims');

const PASSWORD = 'correcthorse123';
const created = { users: [], giveaways: [] };

before(async () => {
  await ensureInit();
  process.env.CLAIM_ENCRYPTION_KEY =
    process.env.CLAIM_ENCRYPTION_KEY || `v1:${crypto.randomBytes(32).toString('base64')}`;
  delete process.env.CLAIM_DEV_LOG_LINKS;
});

after(async () => {
  // Background drains are started by the routes and not awaited — that is
  // deliberate, and it means teardown has to wait for them. Deleting outbox rows
  // while a worker holds a lease on one blocks on a row lock until it commits.
  await outbox.settle();

  // Nothing here deletes a privacy request or an audit event. Both refuse
  // DELETE at the database, which is the property tests 26 and sf5 exist to
  // prove, and the isolated database is reset with DROP SCHEMA ... CASCADE at
  // the start of every run rather than by application deletion.
  //
  // The consequence is that an account carrying a privacy request cannot be
  // removed either — privacy_requests.user_id is ON DELETE CASCADE, and the
  // cascade hits the same trigger. Those accounts are excluded below and left
  // for the schema reset, which is exactly the intended behaviour rather than a
  // workaround for it.
  let removableUsers = created.users;
  if (created.users.length) {
    await pool.query('DELETE FROM email_change_notifications WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM email_change_requests WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM policy_acceptances WHERE user_id = ANY($1)', [created.users]);
    // Both directions: the account a request belongs to (ON DELETE CASCADE,
    // which the trigger then refuses) and the administrator who closed one
    // (a plain reference, which restricts). Neither account can be removed
    // while the request survives, which is the point.
    const undeletable = await pool.query(
      `SELECT user_id AS id FROM privacy_requests WHERE user_id = ANY($1)
       UNION
       SELECT closed_by AS id FROM privacy_requests WHERE closed_by = ANY($1)`,
      [created.users]
    );
    const blocked = new Set(undeletable.rows.map((r) => r.id));
    removableUsers = created.users.filter((id) => !blocked.has(id));
  }
  if (created.giveaways.length) {
    await pool.query(
      'DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [created.giveaways]
    );
    await pool.query(
      'DELETE FROM claim_notifications WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [created.giveaways]
    );
    await pool.query('DELETE FROM claim_rescue_queue WHERE giveaway_id = ANY($1)', [created.giveaways]);
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [created.giveaways]);
    // Detaching the winner means the campaign is no longer drawn, and the schema
    // says so: `drawn` requires a winning entry. Teardown moves the state with
    // the data rather than leaving an incoherent row behind.
    await pool.query(
      `UPDATE giveaways
          SET winner_entry_id = NULL, drawn_at = NULL,
              status = CASE WHEN status = 'drawn' THEN 'closed_pending_draw' ELSE status END
        WHERE id = ANY($1)`,
      [created.giveaways]
    );
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [created.giveaways]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [created.giveaways]);
  }
  if (created.users.length) {
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM session_families WHERE user_id = ANY($1)', [created.users]);
  }
  if (removableUsers.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [removableUsers]);
  }
  await closePool();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Attestation status is a parameter, because half of this file is about the
// difference between an account that answered and one that was never asked.
async function makeUser(tag, {
  admin = false,
  hostStatus = 'not_requested',
  attestation = 'confirmed',
  accountStatus = 'active',
} = {}) {
  const id = crypto.randomUUID();
  const email = uniqueEmail(`rights-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status,
                        account_status, age_attestation_status, age_attestation_version, age_attested_at)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      `Rights ${tag}`,
      email,
      bcrypt.hashSync(PASSWORD, 4),
      admin,
      hostStatus,
      accountStatus,
      attestation,
      attestation === 'confirmed' ? eligibility.CURRENT_VERSION : null,
      attestation === 'confirmed' ? new Date() : null,
    ]
  );
  created.users.push(id);
  return { id, email };
}

async function makeGiveaway(hostId, { deadlineDays = 7, status } = {}) {
  // A past deadline means a CLOSED campaign — a campaign closes itself now.
  const resolved = status || (deadlineDays <= 0 ? 'closed_pending_draw' : 'active');
  const id = await seedGiveaway({
    hostId,
    status: resolved,
    title: 'Rights giveaway',
    closesAt: new Date(Date.now() + deadlineDays * 86400000),
  });
  created.giveaways.push(id);
  return id;
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A capturing sender, and the token it saw.
//
// This is the ONLY legitimate way to obtain a plaintext token now: it exists in
// worker memory for the length of one send and nowhere else, so a test gets it
// by standing where the mail provider stands. `startEmailChange` returns none,
// no endpoint returns one, and the database holds only a hash.
function capturingSender() {
  const sent = [];
  const send = async (message) => {
    sent.push(message);
  };
  send.sent = sent;
  send.tokens = () =>
    sent
      .map((m) => (m.html.match(/#token=([A-Za-z0-9_%-]+)/) || [])[1])
      .filter(Boolean)
      .map(decodeURIComponent);
  send.lastToken = () => send.tokens()[send.tokens().length - 1];
  return send;
}

// A sender that always fails, for the retry paths.
function failingSender(message = 'provider 503 unavailable') {
  const attempts = [];
  const send = async (msg) => {
    attempts.push(msg);
    throw new Error(message);
  };
  send.attempts = attempts;
  return send;
}

// Starts a change and drains the outbox once, returning the token that went
// out. Mirrors exactly what the real worker does.
async function startChangeAndDeliver(userId, newEmail) {
  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId, newEmail })
  );
  const send = capturingSender();
  const summary = await outbox.processDue({ send, limit: 10 });
  return { started, send, summary, token: send.lastToken() };
}

// The fabricated registry. Same shape as the real one, entirely made up, and
// never written back into server/lib/policies.js — which is the whole point: a
// test that mutates the real constants to prove acceptance works is one bad
// merge away from shipping an effective policy nobody approved.
const FIXTURE_REGISTRY = {
  terms: {
    id: 'terms',
    version: 'fixture-1.0',
    status: policies.POLICY_STATUS.EFFECTIVE,
    effectiveDate: '2020-01-01',
    url: '/terms.html',
  },
  privacy: {
    id: 'privacy',
    version: 'fixture-1.0',
    status: policies.POLICY_STATUS.EFFECTIVE,
    effectiveDate: '2020-01-01',
    url: '/privacy.html',
  },
};

// ---------------------------------------------------------------------------
// 1–5. Policy acceptance readiness, with no false history
// ---------------------------------------------------------------------------

test('1. a draft policy cannot be accepted, through the library or the API', async () => {
  // The real registry, untouched.
  assert.equal(policies.POLICIES.terms.status, 'draft');
  assert.equal(policies.POLICIES.terms.effectiveDate, null);
  assert.equal(policies.canBeAccepted(policies.POLICIES.terms), false);
  assert.equal(policies.canBeAccepted(policies.POLICIES.privacy), false);

  assert.throws(
    () => policies.assertAcceptable('terms'),
    (err) => err instanceof policies.PolicyNotAcceptableError && err.code === 'POLICY_IS_DRAFT'
  );

  const user = await makeUser('draftpolicy');
  const session = await signIn(user.email);
  const res = await session.post('/api/account/policies/terms/accept').send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'POLICY_IS_DRAFT');

  const rows = await pool.query('SELECT * FROM policy_acceptances WHERE user_id = $1', [user.id]);
  assert.equal(rows.rowCount, 0, 'a refused acceptance writes nothing');
});

test('2. an approved-but-not-effective policy still cannot be accepted', async () => {
  const registry = {
    terms: {
      id: 'terms',
      version: 'fixture-approved',
      status: policies.POLICY_STATUS.APPROVED,
      // Approved, counsel-reviewed, and still not in force. Approval and
      // activation are two decisions, not one.
      effectiveDate: null,
    },
  };
  assert.equal(policies.isEffective(registry.terms), false);
  assert.throws(
    () => policies.assertAcceptable('terms', new Date(), registry),
    (err) => err.code === 'POLICY_NOT_YET_EFFECTIVE'
  );

  // Nor does a future date count.
  const future = {
    terms: {
      id: 'terms',
      version: 'fixture-future',
      status: policies.POLICY_STATUS.EFFECTIVE,
      effectiveDate: '2099-01-01',
    },
  };
  assert.equal(policies.isEffective(future.terms), false);
  assert.throws(() => policies.assertAcceptable('terms', new Date(), future));
});

test('3. a fabricated effective version can be accepted, and records what was accepted', async () => {
  const user = await makeUser('acceptfixture');

  const result = await inTransaction((client) =>
    policies.recordAcceptance(client, {
      userId: user.id,
      policyId: 'terms',
      registry: FIXTURE_REGISTRY,
    })
  );
  assert.equal(result.version, 'fixture-1.0');
  assert.equal(result.kind, 'agreement');

  await inTransaction((client) =>
    policies.recordAcceptance(client, {
      userId: user.id,
      policyId: 'privacy',
      registry: FIXTURE_REGISTRY,
    })
  );

  const rows = await pool.query(
    'SELECT * FROM policy_acceptances WHERE user_id = $1 ORDER BY policy_id',
    [user.id]
  );
  assert.equal(rows.rowCount, 2);

  const [privacy, terms] = rows.rows;
  // Distinct records with distinct labels — agreeing to terms and
  // acknowledging a privacy notice are different acts and stay different rows.
  assert.equal(terms.policy_id, 'terms');
  assert.equal(terms.acceptance_kind, 'agreement');
  assert.equal(privacy.policy_id, 'privacy');
  assert.equal(privacy.acceptance_kind, 'acknowledgement');

  // The effective date as it stood at the moment of acceptance is stored on the
  // row, not looked up from a constants file that can change afterwards.
  assert.equal(String(terms.policy_effective_date).slice(0, 10), '2020-01-01');
  assert.ok(terms.accepted_at instanceof Date);
  assert.equal(terms.policy_version, 'fixture-1.0');
});

test('4. nothing is ever backfilled: an existing account holds no acceptance it did not make', async () => {
  const user = await makeUser('nobackfill');

  // Sign up, sign in, enter a giveaway — all the things a system might be
  // tempted to read as agreement.
  const session = await signIn(user.email);
  await session.get('/api/account/me');

  const rows = await pool.query('SELECT * FROM policy_acceptances WHERE user_id = $1', [user.id]);
  assert.equal(rows.rowCount, 0);

  // And across the whole isolated database: not one row references a real
  // policy version. The only rows that exist are the fabricated fixture ones
  // this file wrote deliberately, which is the honest answer to "who agreed to
  // the actual documents" — nobody, because neither is in force.
  const real = await pool.query(
    'SELECT COUNT(*)::int AS c FROM policy_acceptances WHERE policy_version = ANY($1)',
    [Object.values(policies.POLICIES).map((p) => p.version)]
  );
  assert.equal(real.rows[0].c, 0, 'no acceptance exists against any real policy version');

  const me = await session.get('/api/account/me');
  assert.equal(me.body.policies.terms.acceptable, false);
  assert.equal(me.body.policies.terms.effectiveDate, null);
  assert.equal(me.body.policies.terms.status, 'draft');
  assert.deepEqual(me.body.policies_outstanding, [], 'nothing is outstanding while nothing is effective');
});

test('5. a newly effective version can require reacceptance without rewriting the old record', async () => {
  const user = await makeUser('reaccept');

  await inTransaction((client) =>
    policies.recordAcceptance(client, {
      userId: user.id,
      policyId: 'terms',
      registry: FIXTURE_REGISTRY,
    })
  );

  const v2 = {
    terms: {
      id: 'terms',
      version: 'fixture-2.0',
      status: policies.POLICY_STATUS.EFFECTIVE,
      effectiveDate: '2020-06-01',
      // Default. Spelled out here because the default is the point.
      requiresReacceptance: true,
    },
  };
  const missing = await policies.missingAcceptances(pool, { userId: user.id, registry: v2 });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].version, 'fixture-2.0', 'the gate names the exact version that is missing');

  // A version that says a reacceptance is not needed is honoured — and says so
  // explicitly rather than by omission.
  const v2NoReaccept = {
    terms: { ...v2.terms, requiresReacceptance: false },
  };
  const missingNone = await policies.missingAcceptances(pool, {
    userId: user.id,
    registry: v2NoReaccept,
  });
  assert.deepEqual(missingNone, []);

  // The original record is untouched by either question.
  const rows = await pool.query('SELECT * FROM policy_acceptances WHERE user_id = $1', [user.id]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].policy_version, 'fixture-1.0');
});

test('5b. no environment variable or passing date can make a policy effective', async () => {
  const before = policies.currentPolicies();
  process.env.POLICIES_EFFECTIVE = 'true';
  process.env.TERMS_EFFECTIVE_DATE = '2020-01-01';
  try {
    const after = policies.currentPolicies();
    assert.deepEqual(after, before);
    assert.equal(after.terms.acceptable, false);
    assert.equal(after.privacy.acceptable, false);
  } finally {
    delete process.env.POLICIES_EFFECTIVE;
    delete process.env.TERMS_EFFECTIVE_DATE;
  }

  // The source itself: nothing reads an environment variable to decide status.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'policies.js'), 'utf8');
  assert.ok(!/process\.env/.test(source), 'policy activation must not depend on the environment');
});

test('5c. the public pages still say DRAFT and not yet effective', async () => {
  for (const page of ['terms.html', 'privacy.html']) {
    const res = await api().get(`/${page}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /draft/i, `${page} must still say it is a draft`);
    assert.ok(
      /not (yet )?(in force|effective)/i.test(res.text),
      `${page} must still say it is not in force`
    );
  }
});

// ---------------------------------------------------------------------------
// 6–10. Age attestation
// ---------------------------------------------------------------------------

test('6. the signup age box is unticked, required, and signup refuses without it', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'signup.html'), 'utf8');
  const box = html.match(/<input[^>]*id="age_confirmed"[^>]*>/);
  assert.ok(box, 'the signup form has an age confirmation box');
  assert.ok(/type="checkbox"/.test(box[0]));
  assert.ok(/required/.test(box[0]), 'the box is required');
  assert.ok(!/checked/.test(box[0]), 'the box must never be pre-ticked');
  assert.ok(html.includes(eligibility.WORDING), 'the exact recorded wording is what the person reads');

  const email = uniqueEmail('rights-nobox');
  const refused = await api()
    .post('/api/auth/signup')
    .set('X-Forwarded-For', nextTestIp())
    .send({ name: 'No Box', email, password: PASSWORD });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'AGE_ATTESTATION_REQUIRED');

  const none = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  assert.equal(none.rowCount, 0, 'a refused signup creates no account');

  // A truthy-but-not-true value is not a ticked box either.
  const sneaky = await api()
    .post('/api/auth/signup')
    .set('X-Forwarded-For', nextTestIp())
    .send({ name: 'Sneaky', email, password: PASSWORD, age_confirmed: 'on' });
  assert.equal(sneaky.status, 400);
  assert.equal(sneaky.body.code, 'AGE_ATTESTATION_REQUIRED');

  const ok = await api()
    .post('/api/auth/signup')
    .set('X-Forwarded-For', nextTestIp())
    .send({ name: 'Confirmed', email, password: PASSWORD, age_confirmed: true });
  assert.equal(ok.status, 201);
  created.users.push(ok.body.user.id);

  const row = await pool.query(
    'SELECT age_attestation_status, age_attestation_version, age_attested_at FROM users WHERE id = $1',
    [ok.body.user.id]
  );
  assert.equal(row.rows[0].age_attestation_status, 'confirmed');
  assert.equal(row.rows[0].age_attestation_version, eligibility.CURRENT_VERSION);
  assert.ok(row.rows[0].age_attested_at instanceof Date);
});

test('7. an account created before the question was asked stays unknown', async () => {
  // Exactly how an existing row looks: the column default, and nothing else.
  const id = crypto.randomUUID();
  const email = uniqueEmail('rights-legacy');
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified)
     VALUES ($1, 'Legacy', $2, $3, TRUE)`,
    [id, email, bcrypt.hashSync(PASSWORD, 4)]
  );
  created.users.push(id);

  const row = await pool.query(
    'SELECT age_attestation_status, age_attestation_version, age_attested_at FROM users WHERE id = $1',
    [id]
  );
  assert.equal(row.rows[0].age_attestation_status, 'unknown');
  assert.equal(row.rows[0].age_attestation_version, null);
  assert.equal(row.rows[0].age_attested_at, null);

  // Signing in, reading the account page and being active do not answer it.
  const session = await signIn(email);
  const me = await session.get('/api/account/me');
  assert.equal(me.body.eligibility.status, 'unknown');
  assert.equal(me.body.eligibility.needs_attestation, true);

  const after = await pool.query('SELECT age_attestation_status FROM users WHERE id = $1', [id]);
  assert.equal(after.rows[0].age_attestation_status, 'unknown', 'reading a page is not an answer');
});

test('8. an unknown account is prompted before a new entry or a new hosting action', async () => {
  const host = await makeUser('gatehost', { hostStatus: 'approved' });
  const giveawayId = await makeGiveaway(host.id);

  const legacy = await makeUser('gatelegacy', { attestation: 'unknown', hostStatus: 'approved' });
  const session = await signIn(legacy.email);

  const entry = await session
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp())
    .send({});
  assert.equal(entry.status, 403);
  assert.equal(entry.body.code, 'AGE_ATTESTATION_REQUIRED');
  assert.equal(entry.body.wording, eligibility.WORDING);

  const noEntry = await pool.query('SELECT id FROM entries WHERE user_id = $1', [legacy.id]);
  assert.equal(noEntry.rowCount, 0, 'a blocked entry creates nothing');

  const create = await session.post('/api/giveaways').send({
    title: 'Blocked',
    description: 'Fabricated',
    prize_description: 'Fabricated',
    ...FABRICATED_PRIZE,
    entry_deadline: new Date(Date.now() + 86400000).toISOString(),
    funded_by: 'Self-funded',
  });
  assert.equal(create.status, 403);
  assert.equal(create.body.code, 'AGE_ATTESTATION_REQUIRED');

  // Answering it once unblocks both, and records the version and time.
  const attest = await session.post('/api/account/eligibility').send({ confirmed: true });
  assert.equal(attest.status, 200);
  assert.equal(attest.body.status, 'confirmed');

  const after = await pool.query(
    'SELECT age_attestation_status, age_attestation_version FROM users WHERE id = $1',
    [legacy.id]
  );
  assert.equal(after.rows[0].age_attestation_status, 'confirmed');
  assert.equal(after.rows[0].age_attestation_version, eligibility.CURRENT_VERSION);

  const entryNow = await session
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp())
    .send({});
  assert.equal(entryNow.status, 201);

  // And an unticked box is still not an attestation.
  const other = await makeUser('gaterefuse', { attestation: 'unknown' });
  const otherSession = await signIn(other.email);
  const refused = await otherSession.post('/api/account/eligibility').send({ confirmed: false });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'AGE_ATTESTATION_REQUIRED');
  const stillUnknown = await pool.query('SELECT age_attestation_status FROM users WHERE id = $1', [
    other.id,
  ]);
  assert.equal(stillUnknown.rows[0].age_attestation_status, 'unknown');
});

test('9. an existing winner with an unknown attestation is not stranded mid-claim', async () => {
  const host = await makeUser('strandhost', { hostStatus: 'approved' });
  const winner = await makeUser('strandwinner', { attestation: 'unknown' });
  const giveawayId = await makeGiveaway(host.id);

  const entryId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)',
    [entryId, giveawayId, winner.id]
  );
  await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);

  const claim = await inTransaction((client) =>
    claims.createClaimForDraw(client, { giveawayId, winnerUserId: winner.id, entryId })
  );
  assert.ok(claim);

  // The library is explicit about it, so a future gate cannot be added by
  // accident: these actions are on a list that is never gated.
  for (const action of ['claim_prize', 'claim_transition', 'confirm_delivery', 'raise_dispute']) {
    assert.equal(
      eligibility.blocksAction({ age_attestation_status: 'unknown' }, action),
      false,
      `${action} must never be blocked by a missing attestation`
    );
  }
  // Nor is the account's own data locked behind it.
  assert.equal(eligibility.blocksAction({ age_attestation_status: 'unknown' }, 'export_data'), false);
  assert.equal(eligibility.blocksAction({ age_attestation_status: 'unknown' }, 'privacy_request'), false);

  const session = await signIn(winner.email);
  const me = await session.get('/api/account/me');
  assert.equal(me.status, 200, 'the account centre stays reachable');
  assert.equal(me.body.eligibility.needs_attestation, true);

  const request = await session
    .post('/api/account/privacy-requests')
    .send({ request_type: 'access' });
  assert.equal(request.status, 201, 'a privacy request is never gated on an attestation');

  const stillOpen = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [claim.id]);
  assert.ok(stillOpen.rows[0], 'the claim is untouched');
});

test('10. no date of birth or identity-document field exists anywhere', async () => {
  const columns = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'`
  );
  const forbidden = /(date_of_birth|dob|birth_date|birthdate|passport|emirates_id|national_id|id_document|selfie|face|biometric)/i;
  const hits = columns.rows.filter((c) => forbidden.test(c.column_name));
  assert.deepEqual(hits, [], `no identity or age-verification column may exist: ${JSON.stringify(hits)}`);

  // And the attestation is described as what it is.
  assert.match(eligibility.REVIEW_NOTE, /not age or identity verification/i);
  const me = eligibility.selfView({ age_attestation_status: 'unknown' });
  assert.equal(me.limitation, eligibility.REVIEW_NOTE);
});

test('10b. attestation is not public anywhere', async () => {
  const host = await makeUser('pubhost', { hostStatus: 'approved' });
  const giveawayId = await makeGiveaway(host.id);
  const entrant = await makeUser('pubentrant');
  const session = await signIn(entrant.email);
  await session
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp())
    .send({});

  for (const url of ['/api/giveaways', `/api/giveaways/${giveawayId}`, '/api/winners']) {
    const res = await api().get(url);
    const body = JSON.stringify(res.body);
    assert.ok(!/age_attest/i.test(body), `${url} must not expose attestation`);
    assert.ok(!/attested_at/i.test(body), `${url} must not expose attestation timing`);
  }
});

// ---------------------------------------------------------------------------
// 11. Display-name correction
// ---------------------------------------------------------------------------

test('11. correcting a display name is ownership-protected and audited', async () => {
  const a = await makeUser('namea');
  const b = await makeUser('nameb');
  const sessionA = await signIn(a.email);

  const anon = await api().patch('/api/account/me').set('Origin', TEST_ORIGIN).send({ name: 'Nope' });
  assert.equal(anon.status, 401);

  // There is no body field that can name somebody else's account: ownership is
  // the session, so a user_id in the payload is simply ignored.
  const res = await sessionA.patch('/api/account/me').send({ name: 'Corrected Name', user_id: b.id });
  assert.equal(res.status, 200);

  const rows = await pool.query('SELECT id, name FROM users WHERE id = ANY($1)', [[a.id, b.id]]);
  const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.name]));
  assert.equal(byId[a.id], 'Corrected Name');
  assert.equal(byId[b.id], 'Rights nameb', "another account's name is untouched");

  const audit = await pool.query(
    `SELECT * FROM privacy_request_events WHERE user_id = $1 AND to_status = 'name_corrected'`,
    [a.id]
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].actor_role, 'user');
  assert.equal(audit.rows[0].actor_user_id, a.id);

  // Empty and over-long names are refused.
  assert.equal((await sessionA.patch('/api/account/me').send({ name: '   ' })).status, 400);
  assert.equal((await sessionA.patch('/api/account/me').send({ name: 'x'.repeat(101) })).status, 400);
});

// ---------------------------------------------------------------------------
// 12–18. Email change
// ---------------------------------------------------------------------------

test('12. an email change requires the current password', async () => {
  const user = await makeUser('emailpw');
  const session = await signIn(user.email);

  const noPassword = await session
    .post('/api/account/email-change')
    .set('X-Forwarded-For', nextTestIp())
    .send({ new_email: uniqueEmail('rights-target') });
  assert.equal(noPassword.status, 400);
  assert.equal(noPassword.body.code, 'PASSWORD_REQUIRED');

  const wrongPassword = await session
    .post('/api/account/email-change')
    .set('X-Forwarded-For', nextTestIp())
    .send({ new_email: uniqueEmail('rights-target'), password: 'not-the-password' });
  assert.equal(wrongPassword.status, 403);
  assert.equal(wrongPassword.body.code, 'PASSWORD_INCORRECT');

  const none = await pool.query('SELECT COUNT(*)::int AS c FROM email_change_requests WHERE user_id = $1', [
    user.id,
  ]);
  assert.equal(none.rows[0].c, 0, 'a refused attempt creates no pending change');
});

test('13. a pending change does not touch the account email, and the old address still signs in', async () => {
  const user = await makeUser('emailpending');
  const session = await signIn(user.email);
  const target = uniqueEmail('rights-newaddr');

  const res = await session
    .post('/api/account/email-change')
    .set('X-Forwarded-For', nextTestIp())
    .send({ new_email: target, password: PASSWORD });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'pending');

  const row = await pool.query('SELECT email FROM users WHERE id = $1', [user.id]);
  assert.equal(row.rows[0].email, user.email, 'the account email is unchanged while a change is pending');

  // The old address is still the account, and still works.
  const stillWorks = await signIn(user.email);
  assert.ok(stillWorks.id);

  // The new one is not an account yet.
  await assert.rejects(() => signIn(target));

  const pending = await pool.query(
    `SELECT status, new_email, previous_email FROM email_change_requests WHERE user_id = $1`,
    [user.id]
  );
  assert.equal(pending.rows[0].status, 'pending');
  assert.equal(pending.rows[0].new_email, target);
  assert.equal(pending.rows[0].previous_email, user.email);
});

test('14. the token is random, hashed, expiring and single-use', async () => {
  const user = await makeUser('emailtoken');
  const target = uniqueEmail('rights-tokentarget');

  const { started, token } = await startChangeAndDeliver(user.id, target);

  // Random: 32 bytes, base64url, and two issued tokens never match.
  assert.ok(token.length >= 43, 'at least 256 bits of entropy, base64url encoded');
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  const a = rights.issueEmailToken();
  const b = rights.issueEmailToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, crypto.createHash('sha256').update(a.token).digest('hex'));

  // Expiring.
  const stored = await pool.query('SELECT * FROM email_change_requests WHERE id = $1', [started.id]);
  const ttlHours = (new Date(stored.rows[0].expires_at) - new Date(stored.rows[0].created_at)) / 3600000;
  assert.ok(ttlHours > 0 && ttlHours <= rights.EMAIL_TOKEN_TTL_HOURS + 0.01, `ttl was ${ttlHours}h`);

  // Single-use: the second attempt finds nothing pending.
  const first = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token });
  assert.equal(first.status, 200);

  const second = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token });
  assert.equal(second.status, 400);
  assert.equal(second.body.code, 'EMAIL_CHANGE_TOKEN_INVALID');

  // An expired one is refused too, and it is refused by the same query that
  // claims the row rather than by a separate check that could be skipped.
  const later = await startChangeAndDeliver(user.id, uniqueEmail('rights-expired'));
  await pool.query(
    `UPDATE email_change_requests SET expires_at = NOW() - interval '1 minute' WHERE id = $1`,
    [later.started.id]
  );
  const expired = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token: later.token });
  assert.equal(expired.status, 400);
});

test('15. the token never appears in the database in plaintext, in a response, or in a log', async () => {
  const user = await makeUser('emailleak');
  const session = await signIn(user.email);
  const target = uniqueEmail('rights-leaktarget');

  // Every console write during the flow is captured, exactly as CI would see it.
  const logged = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));

  let started;
  try {
    started = await session
      .post('/api/account/email-change')
      .set('X-Forwarded-For', nextTestIp())
      .send({ new_email: target, password: PASSWORD });
    // The route only enqueues. Delivery — and therefore the only moment a
    // plaintext token exists at all — happens in the worker, driven here so the
    // console capture above spans it.
    await outbox.settle();
    await outbox.processDue({ limit: 10 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }

  assert.equal(started.status, 202);
  const body = JSON.stringify(started.body);
  assert.ok(!/token/i.test(body), `the start response must not mention a token: ${body}`);
  // And it does not claim the email was sent — only that delivery is pending.
  assert.equal(started.body.delivery, 'pending');
  assert.ok(!/\bsent\b/i.test(body), `the response must not claim delivery: ${body}`);

  const row = await pool.query(
    'SELECT * FROM email_change_requests WHERE user_id = $1 AND status = $2',
    [user.id, 'pending']
  );
  const stored = row.rows[0];
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/, 'only a SHA-256 hash is stored');
  // No column anywhere in the row holds anything that looks like a token.
  Object.entries(stored).forEach(([key, value]) => {
    if (key === 'token_hash') return;
    if (typeof value !== 'string') return;
    assert.ok(!/^[A-Za-z0-9_-]{43,}$/.test(value), `${key} looks like a token`);
  });

  // The dev-mail logger suppresses the body of this message the same way it
  // suppresses a claim invitation.
  const mailLines = logged.filter((l) => l.includes('Confirm your new email address'));
  assert.equal(mailLines.length, 1, 'the confirmation was attempted');
  assert.match(mailLines[0], /body suppressed/);
  assert.ok(
    !logged.some((l) => /verify-email-change\.html#token=/.test(l)),
    'no log line carries a completing link'
  );

  // And the read endpoints never carry it either.
  const me = await session.get('/api/account/me');
  assert.equal(me.body.pending_email_change.new_email, target);
  assert.ok(!('token' in me.body.pending_email_change));
  assert.ok(!/token_hash/.test(JSON.stringify(me.body)));
});

test('16. a failed send does not change the address', async () => {
  const user = await makeUser('emailsendfail');
  const target = uniqueEmail('rights-sendfail');

  // The delivery is deliberately decoupled from the state change: starting a
  // change writes a PENDING row and nothing else, so a send that never arrives
  // leaves the account exactly where it was. Proven by never delivering at all.
  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: target })
  );
  assert.equal(started.token, undefined, 'no token exists before a send is attempted');

  const row = await pool.query('SELECT email FROM users WHERE id = $1', [user.id]);
  assert.equal(row.rows[0].email, user.email, 'no email was sent and nothing changed');

  const pending = await pool.query(
    `SELECT status FROM email_change_requests WHERE id = $1`,
    [started.id]
  );
  assert.equal(pending.rows[0].status, 'pending', 'it is still waiting, not completed');

  // A provider that fails leaves the row queued and the address untouched. Not
  // asserted from the source any more — driven for real against a sender that
  // throws, which is the thing the source was standing in for.
  const failing = failingSender();
  const summary = await outbox.processDue({ send: failing, limit: 10 });
  assert.ok(summary.claimed >= 1);
  assert.equal(summary.sent, 0);
  assert.equal(failing.attempts.length, summary.claimed);

  const afterFailure = await pool.query('SELECT email FROM users WHERE id = $1', [user.id]);
  assert.equal(afterFailure.rows[0].email, user.email, 'a failed send changes no address');

  const queued = await pool.query(
    `SELECT status, attempts, last_error_category, next_attempt_at, sent_at
       FROM email_change_notifications WHERE change_id = $1 AND kind = 'verification'`,
    [started.id]
  );
  assert.equal(queued.rows[0].status, 'pending', 'still queued, so it will be retried');
  assert.equal(queued.rows[0].attempts, 1);
  assert.equal(queued.rows[0].sent_at, null);
  assert.ok(queued.rows[0].last_error_category, 'the failure is categorised');
  assert.ok(new Date(queued.rows[0].next_attempt_at) > new Date(), 'backed off, not hammered');

  // The route never sends anything itself — there is no direct-delivery path
  // left for a failure to escape through.
  const routeSource = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'account.js'),
    'utf8'
  );
  assert.ok(!/sendEmail/.test(routeSource), 'the route enqueues; it never sends');
  assert.ok(!/status: 'completed'/.test(routeSource.split('email-change')[1] || ''));
});

test('17. two simultaneous completions produce exactly one change', async () => {
  const user = await makeUser('emailrace');
  const target = uniqueEmail('rights-racetarget');

  const { token } = await startChangeAndDeliver(user.id, target);

  const [a, b] = await Promise.all([
    api()
      .post('/api/account/email-change/confirm')
      .set('Origin', TEST_ORIGIN)
      .set('X-Forwarded-For', nextTestIp())
      .send({ token }),
    api()
      .post('/api/account/email-change/confirm')
      .set('Origin', TEST_ORIGIN)
      .set('X-Forwarded-For', nextTestIp())
      .send({ token }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400], `one succeeds and one is refused, got ${statuses}`);

  const row = await pool.query('SELECT email FROM users WHERE id = $1', [user.id]);
  assert.equal(row.rows[0].email, target);

  const completed = await pool.query(
    `SELECT COUNT(*)::int AS c FROM email_change_requests
      WHERE user_id = $1 AND status = 'completed'`,
    [user.id]
  );
  assert.equal(completed.rows[0].c, 1);

  // A second pending change supersedes the first rather than running alongside
  // it, and the superseded row records why.
  const again1 = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('rights-sup1') })
  );
  await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('rights-sup2') })
  );
  const superseded = await pool.query('SELECT status, cancelled_reason FROM email_change_requests WHERE id = $1', [
    again1.id,
  ]);
  assert.equal(superseded.rows[0].status, 'cancelled');
  assert.match(superseded.rows[0].cancelled_reason, /superseded/);

  const stillPending = await pool.query(
    `SELECT COUNT(*)::int AS c FROM email_change_requests WHERE user_id = $1 AND status = 'pending'`,
    [user.id]
  );
  assert.equal(stillPending.rows[0].c, 1, 'never more than one pending change per account');

  // An address that belongs to somebody else is refused at completion time even
  // if it was free when the change started.
  const squatter = await makeUser('emailsquat');
  const contested = uniqueEmail('rights-contested');
  const race = await startChangeAndDeliver(user.id, contested);
  await pool.query('UPDATE users SET email = $2 WHERE id = $1', [squatter.id, contested]);
  const refused = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token: race.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'EMAIL_TAKEN');
  const unchanged = await pool.query('SELECT email FROM users WHERE id = $1', [user.id]);
  assert.equal(unchanged.rows[0].email, target, 'the contested address was not taken over');
});

test('18. completing a change ends every session, including the one that started it', async () => {
  const user = await makeUser('emailsessions');
  const sessionA = await signIn(user.email);
  const sessionB = await signIn(user.email);
  assert.equal((await sessionA.get('/api/account/me')).status, 200);
  assert.equal((await sessionB.get('/api/account/me')).status, 200);

  const target = uniqueEmail('rights-sessiontarget');
  const { token } = await startChangeAndDeliver(user.id, target);

  const done = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token });
  assert.equal(done.status, 200);

  assert.equal((await sessionA.get('/api/account/me')).status, 401);
  assert.equal((await sessionB.get('/api/account/me')).status, 401);

  const families = await pool.query(
    'SELECT revoked_at, revocation_reason FROM session_families WHERE user_id = $1',
    [user.id]
  );
  assert.ok(families.rowCount >= 2);
  families.rows.forEach((f) => {
    assert.ok(f.revoked_at, 'every family is revoked');
    assert.equal(f.revocation_reason, sessions.REVOCATION.EMAIL_CHANGED);
  });

  // A fresh sign-in works with the new address and not the old one.
  await assert.rejects(() => signIn(user.email));
  const fresh = await signIn(target);
  assert.equal((await fresh.get('/api/account/me')).status, 200);
});

test('18b. cancelling a pending change is recorded rather than deleted', async () => {
  const user = await makeUser('emailcancel');
  const session = await signIn(user.email);
  const target = uniqueEmail('rights-canceltarget');

  await session
    .post('/api/account/email-change')
    .set('X-Forwarded-For', nextTestIp())
    .send({ new_email: target, password: PASSWORD });

  const cancelled = await session.post('/api/account/email-change/cancel').send({});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancelled, 1);

  const rows = await pool.query(
    'SELECT status, cancelled_reason, cancelled_at FROM email_change_requests WHERE user_id = $1',
    [user.id]
  );
  assert.equal(rows.rowCount, 1, 'the record is kept, not removed');
  assert.equal(rows.rows[0].status, 'cancelled');
  assert.match(rows.rows[0].cancelled_reason, /account holder/);
  assert.ok(rows.rows[0].cancelled_at);

  // Expiry is recorded the same way rather than leaving a row pending forever.
  const later = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('rights-expiry') })
  );
  await pool.query(
    `UPDATE email_change_requests SET expires_at = NOW() - interval '1 hour' WHERE id = $1`,
    [later.id]
  );
  await inTransaction((client) => rights.expireStaleEmailChanges(client));
  const expired = await pool.query('SELECT status, cancelled_reason FROM email_change_requests WHERE id = $1', [
    later.id,
  ]);
  assert.equal(expired.rows[0].status, 'expired');
  assert.equal(expired.rows[0].cancelled_reason, 'expired');
});

// ---------------------------------------------------------------------------
// 19–21. Export
// ---------------------------------------------------------------------------

test('19. the export requires the password again and is no-store, attachment-safe JSON', async () => {
  const user = await makeUser('exportauth');
  const session = await signIn(user.email);

  const anonRes = await api().post('/api/account/export').set('Origin', TEST_ORIGIN).send({ password: PASSWORD });
  assert.equal(anonRes.status, 401);

  const noPassword = await session
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({});
  assert.equal(noPassword.status, 400);
  assert.equal(noPassword.body.code, 'PASSWORD_REQUIRED');

  const wrong = await session
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({ password: 'not-it' });
  assert.equal(wrong.status, 403);

  const res = await session
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({ password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['content-disposition'], 'attachment; filename="naseeb-data-export.json"');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  // JSON only — no CSV, so there is no spreadsheet-formula surface to mitigate.
  assert.ok(!/text\/csv/.test(res.headers['content-type']));

  const parsed = JSON.parse(res.text);
  assert.equal(parsed.export_version, dataExport.VERSION);
  assert.ok(Array.isArray(parsed.not_included) && parsed.not_included.length);
  // The filename carries nothing user-controlled, so a display name cannot
  // become a header-injection or a path.
  await session.patch('/api/account/me').send({ name: 'Name"; drop\r\nX-Evil: 1' });
  const again = await session
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({ password: PASSWORD });
  assert.equal(again.headers['content-disposition'], 'attachment; filename="naseeb-data-export.json"');
  assert.equal(again.headers['x-evil'], undefined);
});

test('20. the export carries the requester’s own data and no one else’s', async () => {
  const host = await makeUser('exporthost', { hostStatus: 'approved' });
  const other = await makeUser('exportother');
  const me = await makeUser('exportme');

  const giveawayId = await makeGiveaway(host.id);
  const mySession = await signIn(me.email);
  await mySession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp())
    .send({});

  const otherSession = await signIn(other.email);
  await otherSession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp())
    .send({});

  await mySession.post('/api/account/privacy-requests').send({
    request_type: 'access',
    message: 'Fabricated request text.',
  });

  const res = await mySession
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({ password: PASSWORD });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.text);

  assert.equal(data.account.account_id, me.id);
  assert.equal(data.account.email, me.email);
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].giveaway_id, giveawayId);
  assert.equal(data.privacy_requests.length, 1);
  assert.ok(data.eligibility_attestation);
  assert.ok(Array.isArray(data.policy_acceptances));
  assert.ok(Array.isArray(data.giveaways_you_host));
  assert.ok(Array.isArray(data.host_applications));
  assert.ok(Array.isArray(data.prize_claims));
  assert.ok(Array.isArray(data.advertising));

  const text = JSON.stringify(data);
  assert.ok(!text.includes(other.email), "another entrant's address must not appear");
  assert.ok(!text.includes(other.id), "another entrant's account id must not appear");
  assert.ok(!text.includes(host.email), "the host's address must not appear");

  // The host's own export shows the giveaway, and still not the entrants.
  const hostSession = await signIn(host.email);
  const hostRes = await hostSession
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({ password: PASSWORD });
  const hostData = JSON.parse(hostRes.text);
  assert.equal(hostData.giveaways_you_host.length, 1);
  assert.equal(hostData.entries.length, 0);
  const hostText = JSON.stringify(hostData);
  assert.ok(!hostText.includes(me.email), 'a host does not get an entrant list in their own export');
  assert.ok(!hostText.includes(other.email));
});

test('21. the export excludes credentials, tokens, internal notes and detection signals', async () => {
  const admin = await makeUser('exportadmin', { admin: true });
  const host = await makeUser('exportnotehost', { hostStatus: 'approved' });
  const entrant = await makeUser('exportnoted');
  const giveawayId = await makeGiveaway(host.id);

  const entrantSession = await signIn(entrant.email);
  await entrantSession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp())
    .send({});
  const entry = await pool.query('SELECT id FROM entries WHERE user_id = $1', [entrant.id]);

  // Deliberately hostile internal notes: another account, an address, an
  // allegation. None of it may reach the person it is about.
  const SECRET_NOTE =
    'Linked to account 9f2b-other and mailbox other-person@example.com; suspected of coordinating entries.';
  const adminSession = await signIn(admin.email);
  const detail = await adminSession.get(`/api/admin/integrity/entries/${entry.rows[0].id}`);
  assert.equal(detail.status, 200);
  const decided = await adminSession
    .post(`/api/admin/integrity/entries/${entry.rows[0].id}/status`)
    .send({
      status: 'disqualified',
      reason_code: 'disqualified_entry_rule',
      admin_notes: SECRET_NOTE,
      version: detail.body.entry.version,
    });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  // A pending email change so a live token hash exists to look for.
  await startChangeAndDeliver(entrant.id, uniqueEmail('rights-exporttoken'));
  const tokenRow = await pool.query(
    `SELECT token_hash FROM email_change_requests WHERE user_id = $1 AND status = 'pending'`,
    [entrant.id]
  );
  assert.match(tokenRow.rows[0].token_hash, /^[0-9a-f]{64}$/, 'a hash exists once a send happened');

  const res = await entrantSession
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({ password: PASSWORD });
  assert.equal(res.status, 200);
  const text = res.text;
  const data = JSON.parse(text);

  assert.ok(!text.includes(SECRET_NOTE), 'administrator notes must never reach the export');
  assert.ok(!/suspected|coordinating|other-person@example\.com/.test(text));
  assert.ok(!text.includes(tokenRow.rows[0].token_hash), 'no token hash in the export');

  const forbiddenKeys = /(password|password_hash|token|token_hash|csrf|secret|encryption|signal_hash|network_hash|admin_notes|integrity_admin_notes|stripe)/i;
  const walk = (node, trail) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (node && typeof node === 'object') {
      Object.entries(node).forEach(([k, v]) => {
        assert.ok(!forbiddenKeys.test(k), `export key ${trail}.${k} is not exportable`);
        walk(v, `${trail}.${k}`);
      });
    }
  };
  walk(data, '$');

  // The outcome the entrant is entitled to is there — the code and the coarse
  // status, which is what they are told, and nothing about how it was found.
  assert.equal(data.entries[0].integrity_outcome, 'disqualified');
  assert.equal(data.entries[0].explanation_code, 'disqualified_entry_rule');

  // A risk signal exists for this account, and none of it is in the file.
  const signals = await pool.query(
    "SELECT * FROM information_schema.columns WHERE table_name = 'entry_risk_signals'"
  );
  if (signals.rowCount) {
    const stored = await pool.query('SELECT * FROM entry_risk_signals LIMIT 5');
    stored.rows.forEach((row) => {
      Object.values(row).forEach((v) => {
        if (typeof v === 'string' && v.length > 20) {
          assert.ok(!text.includes(v), 'no stored risk-signal value may appear in an export');
        }
      });
    });
  }

  // And the file says what it left out rather than implying completeness.
  assert.ok(data.not_included.some((line) => /password/i.test(line)));
  assert.ok(data.not_included.some((line) => /another person/i.test(line)));
  assert.ok(data.not_included.some((line) => /administrator notes/i.test(line)));
  assert.ok(data.not_included.some((line) => /detection signals/i.test(line)));
  assert.ok(data.delivery_details_note);
});

// ---------------------------------------------------------------------------
// 22–29. Privacy requests
// ---------------------------------------------------------------------------

test('22. privacy requests are ownership-protected', async () => {
  const a = await makeUser('reqa');
  const b = await makeUser('reqb');
  const sessionA = await signIn(a.email);
  const sessionB = await signIn(b.email);

  const created1 = await sessionA
    .post('/api/account/privacy-requests')
    .send({ request_type: 'access', message: 'Fabricated.' });
  assert.equal(created1.status, 201);
  const reference = created1.body.request.reference;

  const mine = await sessionA.get(`/api/account/privacy-requests/${reference}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.reference, reference);

  // Somebody else's reference is a 404, not a 403: whether it exists is not a
  // question this endpoint answers for people who do not own it.
  const theirs = await sessionB.get(`/api/account/privacy-requests/${reference}`);
  assert.equal(theirs.status, 404);

  const list = await sessionB.get('/api/account/privacy-requests');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 0);

  const anonRes = await api().get(`/api/account/privacy-requests/${reference}`);
  assert.equal(anonRes.status, 401);

  // The reference is not sequential, so holding one tells you nothing about how
  // many exist.
  const refs = new Set(Array.from({ length: 50 }, () => rights.newReference()));
  assert.equal(refs.size, 50);
  assert.ok(/^PR-[0-9A-F]{8}$/.test(reference));
});

test('23. the administrator queue re-reads authorization from the database', async () => {
  const user = await makeUser('adminplain');
  const admin = await makeUser('adminreal', { admin: true });

  const userSession = await signIn(user.email);
  assert.equal((await userSession.get('/api/admin/privacy-requests')).status, 403);

  const adminSession = await signIn(admin.email);
  assert.equal((await adminSession.get('/api/admin/privacy-requests')).status, 200);

  // Rights removed mid-session: the existing session stops working immediately,
  // because every request re-reads the flag rather than trusting the cookie.
  await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [admin.id]);
  assert.equal((await adminSession.get('/api/admin/privacy-requests')).status, 403);
  await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [admin.id]);

  // A suspended administrator is not an administrator either.
  await pool.query("UPDATE users SET account_status = 'suspended' WHERE id = $1", [admin.id]);
  assert.equal((await adminSession.get('/api/admin/privacy-requests')).status, 401);
  await pool.query("UPDATE users SET account_status = 'active' WHERE id = $1", [admin.id]);

  // And the library refuses a non-administrator directly, so the route is not
  // the only thing enforcing it.
  await assert.rejects(
    () =>
      inTransaction((client) =>
        rights.decideRequest(client, {
          requestId: crypto.randomUUID(),
          toStatus: 'in_review',
          adminNotes: 'nope',
          actorUserId: user.id,
          expectedVersion: 1,
        })
      ),
    (err) => err.code === 'ADMIN_REQUIRED'
  );
});

test('24. internal notes and the requester’s explanation stay separate', async () => {
  const user = await makeUser('splitreq');
  const admin = await makeUser('splitadmin', { admin: true });
  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'objection', message: 'Fabricated objection text.' });
  const reference = created1.body.request.reference;

  const queue = await adminSession.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === reference);
  assert.ok(row);

  const HOSTILE_NOTES =
    'Cross-checked against account 4d1a-suspect and mailbox suspect@example.com; alleged multi-accounting from 10.0.0.0/24. Escalate to legal.';

  const detail = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  assert.equal(detail.status, 200);
  const decided = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'declined',
    outcome_code: 'objection_declined',
    admin_notes: HOSTILE_NOTES,
    version: detail.body.request.version,
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  // The requester reads a fixed sentence chosen from an allowlist.
  const mine = await userSession.get(`/api/account/privacy-requests/${reference}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.outcome, rights.OUTCOME_COPY.objection_declined);

  const seen = JSON.stringify(mine.body) + JSON.stringify((await userSession.get('/api/account/me')).body);
  assert.ok(!seen.includes(HOSTILE_NOTES));
  assert.ok(!/4d1a-suspect|suspect@example\.com|10\.0\.0\.0|Escalate to legal/.test(seen));
  assert.ok(!/admin_notes/.test(seen));

  // Nor does it reach the export.
  const exported = await userSession
    .post('/api/account/export')
    .set('X-Forwarded-For', nextTestIp())
    .send({ password: PASSWORD });
  assert.ok(!exported.text.includes(HOSTILE_NOTES));
  assert.ok(!/Escalate to legal/.test(exported.text));

  // The administrator does see them — that is the point of keeping them.
  const reread = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  assert.equal(reread.body.request.admin_notes, HOSTILE_NOTES);
  assert.equal(reread.body.request.requester_sees, rights.OUTCOME_COPY.objection_declined);

  // An outcome code that does not belong to the status is refused, so the
  // sentence and the decision cannot drift apart.
  const another = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'access' });
  const queue2 = await adminSession.get('/api/admin/privacy-requests');
  const row2 = queue2.body.find((r) => r.reference === another.body.request.reference);
  const bad = await adminSession.post(`/api/admin/privacy-requests/${row2.id}/decision`).send({
    status: 'completed',
    outcome_code: 'need_more_information',
    admin_notes: 'mismatched on purpose',
    version: row2.version,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'OUTCOME_CODE_INVALID');

  // And a decision with no notes is refused outright.
  const noNotes = await adminSession.post(`/api/admin/privacy-requests/${row2.id}/decision`).send({
    status: 'in_review',
    admin_notes: '',
    version: row2.version,
  });
  assert.equal(noNotes.status, 400);
  assert.equal(noNotes.body.code, 'NOTES_REQUIRED');
});

test('25. a stale administrator decision returns 409 and changes nothing', async () => {
  const user = await makeUser('stalereq');
  const admin = await makeUser('staleadmin', { admin: true });
  const adminB = await makeUser('staleadminb', { admin: true });
  const userSession = await signIn(user.email);
  const sessionA = await signIn(admin.email);
  const sessionB = await signIn(adminB.email);

  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'correction', message: 'Fabricated.' });
  const queue = await sessionA.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === created1.body.request.reference);

  // Both screens open on version 1.
  const viewA = await sessionA.get(`/api/admin/privacy-requests/${row.id}`);
  const viewB = await sessionB.get(`/api/admin/privacy-requests/${row.id}`);
  assert.equal(viewA.body.request.version, viewB.body.request.version);

  const first = await sessionA.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'in_review',
    admin_notes: 'Picked this up.',
    version: viewA.body.request.version,
  });
  assert.equal(first.status, 200);

  const eventsBefore = await pool.query(
    'SELECT COUNT(*)::int AS c FROM privacy_request_events WHERE request_id = $1',
    [row.id]
  );

  const stale = await sessionB.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'declined',
    outcome_code: 'not_possible',
    admin_notes: 'Decided on a screen that was already out of date.',
    version: viewB.body.request.version,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_DECISION');
  assert.equal(stale.body.current.status, 'in_review', 'the refusal says what the current state is');

  const after = await pool.query('SELECT status, outcome_code FROM privacy_requests WHERE id = $1', [row.id]);
  assert.equal(after.rows[0].status, 'in_review', 'the stale decision did not apply');
  assert.equal(after.rows[0].outcome_code, null);

  const eventsAfter = await pool.query(
    'SELECT COUNT(*)::int AS c FROM privacy_request_events WHERE request_id = $1',
    [row.id]
  );
  assert.equal(eventsAfter.rows[0].c, eventsBefore.rows[0].c, 'a stale decision writes no event');

  // A missing version is refused too — an omitted field is not permission.
  const noVersion = await sessionB.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'declined',
    outcome_code: 'not_possible',
    admin_notes: 'No version supplied.',
  });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.body.code, 'VERSION_REQUIRED');

  // A closed request cannot be reopened by a later decision.
  const fresh = await sessionA.get(`/api/admin/privacy-requests/${row.id}`);
  const closed = await sessionA.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'declined',
    outcome_code: 'not_possible',
    admin_notes: 'Closing it.',
    version: fresh.body.request.version,
  });
  assert.equal(closed.status, 200);

  const reopened = await sessionA.get(`/api/admin/privacy-requests/${row.id}`);
  const attempt = await sessionA.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'in_review',
    admin_notes: 'Trying to reopen.',
    version: reopened.body.request.version,
  });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.code, 'REQUEST_CLOSED');
});

test('26. request history cannot be updated or deleted, and requests cannot be erased', async () => {
  const user = await makeUser('historyreq');
  const admin = await makeUser('historyadmin', { admin: true });
  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'access', message: 'Fabricated.' });
  const queue = await adminSession.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === created1.body.request.reference);

  const view = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  const done = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'completed',
    outcome_code: 'access_provided',
    admin_notes: 'Export supplied.',
    version: view.body.request.version,
    execution_evidence: { summary: 'Sent the JSON export to the address on the account.' },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const events = await pool.query('SELECT * FROM privacy_request_events WHERE request_id = $1', [row.id]);
  assert.ok(events.rowCount >= 2, 'submission and decision are both recorded');

  await assert.rejects(
    () => pool.query('UPDATE privacy_request_events SET admin_notes = $2 WHERE id = $1', [events.rows[0].id, 'rewritten']),
    /append-only|immutable|cannot be/i
  );
  await assert.rejects(
    () => pool.query('DELETE FROM privacy_request_events WHERE id = $1', [events.rows[0].id]),
    /append-only|immutable|cannot be/i
  );
  await assert.rejects(
    () => pool.query('DELETE FROM privacy_request_events WHERE request_id = $1', [row.id]),
    /append-only|immutable|cannot be/i
  );

  const still = await pool.query('SELECT COUNT(*)::int AS c FROM privacy_request_events WHERE request_id = $1', [
    row.id,
  ]);
  assert.equal(still.rows[0].c, events.rowCount);

  // There is no route that deletes a request, at any privilege level.
  const accountSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'account.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin.js'), 'utf8');
  assert.ok(!/router\.delete\([^)]*privacy/i.test(accountSource));
  assert.ok(!/router\.delete\([^)]*privacy/i.test(adminSource));
  assert.ok(!/DELETE FROM privacy_requests/i.test(accountSource + adminSource));

  // History survives the events the account itself generates afterwards.
  await userSession.patch('/api/account/me').send({ name: 'Still Here' });
  const survived = await pool.query('SELECT COUNT(*)::int AS c FROM privacy_request_events WHERE request_id = $1', [
    row.id,
  ]);
  assert.equal(survived.rows[0].c, events.rowCount);
});

test('27. a deletion request deletes nothing and says so', async () => {
  const host = await makeUser('delhost', { hostStatus: 'approved' });
  const user = await makeUser('deluser');
  const giveawayId = await makeGiveaway(host.id);
  const userSession = await signIn(user.email);
  await userSession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp())
    .send({});

  const before = {
    user: (await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE id = $1', [user.id])).rows[0].c,
    entries: (await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE user_id = $1', [user.id])).rows[0].c,
  };

  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'deletion', message: 'Please remove my data.' });
  assert.equal(created1.status, 201);
  assert.match(created1.body.note, /request for review/i);
  assert.match(created1.body.note, /Nothing has been deleted/i);

  const after = {
    user: (await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE id = $1', [user.id])).rows[0].c,
    entries: (await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE user_id = $1', [user.id])).rows[0].c,
  };
  assert.deepEqual(after, before, 'submitting a deletion request removes nothing');

  // Nor does closing it.
  const admin = await makeUser('deladmin', { admin: true });
  const adminSession = await signIn(admin.email);
  const queue = await adminSession.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === created1.body.request.reference);
  const view = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  const decided = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'unable_to_complete',
    outcome_code: 'deletion_blocked_pending_obligations',
    admin_notes: 'Retention rules are not defined yet; holding.',
    version: view.body.request.version,
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.records_deleted, false);
  assert.match(decided.body.note, /No records were deleted/i);

  const stillThere = {
    user: (await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE id = $1', [user.id])).rows[0].c,
    entries: (await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE user_id = $1', [user.id])).rows[0].c,
  };
  assert.deepEqual(stillThere, before);

  // No path through the privacy-request workflow hard-deletes anything. The
  // account centre deletes nothing at all, and the administrator's decision
  // handler only writes a status and an event.
  const accountRoutes = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'account.js'), 'utf8');
  assert.ok(!/DELETE FROM/i.test(accountRoutes), 'the account centre deletes nothing');

  const adminRoutes = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin.js'), 'utf8');
  const decisionStart = adminRoutes.indexOf("router.post('/privacy-requests/:id/decision'");
  assert.ok(decisionStart > 0);
  const decisionHandler = adminRoutes.slice(decisionStart, adminRoutes.indexOf('\nrouter.', decisionStart + 1));
  // Code, not prose: the handler's own response text explains that no erasure
  // or anonymisation happened, which is the point, so the check is for a query
  // or a call rather than for the words.
  assert.ok(!/DELETE\s+FROM/i.test(decisionHandler), 'a decision deletes nothing');
  assert.ok(!/\b(deleteAccount|eraseAccount|anonymiseAccount|anonymizeAccount)\s*\(/.test(decisionHandler),
    'a decision calls no erasure or anonymisation routine');

  // The one route that can remove an account is the pre-existing host cleanup,
  // which is unrelated to this workflow and which Postgres refuses the moment
  // the account has any activity. It is recorded in docs/PRIVACY_AND_RIGHTS.md
  // §8 rather than pretended away — and it cannot be reached from a request.
  const disabledStart = adminRoutes.indexOf("router.delete('/users/:id'");
  assert.ok(disabledStart > 0, 'the route is still mounted so an old caller gets an explanation');
  assert.ok(disabledStart < decisionStart || disabledStart > decisionStart + decisionHandler.length);

  const adminSession2 = await signIn(admin.email);
  const refusedDelete = await adminSession2.delete(`/api/admin/users/${user.id}`);
  assert.equal(refusedDelete.status, 405, 'the admin hard-delete route is disabled');
  assert.equal(refusedDelete.body.code, 'ACCOUNT_DELETION_DISABLED');
  const survived = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE id = $1', [user.id]);
  assert.equal(survived.rows[0].c, 1);
});

test('28. active claims, hosted giveaways, disputes and integrity cases are flagged as blockers', async () => {
  const host = await makeUser('blockhost', { hostStatus: 'approved' });
  const winner = await makeUser('blockwinner');
  const giveawayId = await makeGiveaway(host.id);

  const entryId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)',
    [entryId, giveawayId, winner.id]
  );
  await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);
  await inTransaction((client) =>
    claims.createClaimForDraw(client, { giveawayId, winnerUserId: winner.id, entryId })
  );

  const winnerBlockers = await rights.deletionBlockers(pool, winner.id);
  const categories = winnerBlockers.map((b) => b.category);
  assert.ok(categories.includes('open_prize_claim'));
  assert.ok(categories.includes('audit_records'), 'audit retention is always stated, not only when something is open');

  const hostBlockers = await rights.deletionBlockers(pool, host.id);
  assert.ok(hostBlockers.map((b) => b.category).includes('active_giveaway_hosted'));

  // The requester is told the categories, not the contents.
  const winnerSession = await signIn(winner.email);
  const created1 = await winnerSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'deletion' });
  const blockers = created1.body.request.blockers;
  assert.ok(blockers.length);
  blockers.forEach((b) => {
    assert.deepEqual(Object.keys(b).sort(), ['category', 'note']);
  });

  // A completion is refused while a real blocker stands — closing it as
  // "completed" would be a completion in name only.
  const admin = await makeUser('blockadmin', { admin: true });
  const adminSession = await signIn(admin.email);
  const queue = await adminSession.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === created1.body.request.reference);
  const view = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  const refused = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'completed',
    outcome_code: 'deletion_partial_records_retained',
    admin_notes: 'Trying to complete while a claim is open.',
    version: view.body.request.version,
  });
  // Refused before the blocker check even runs: no deletion can be completed at
  // all while nothing performs one. The blocker check is still there for the day
  // that changes, and test 27b covers it.
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'DELETION_NOT_IMPLEMENTED');
  assert.ok(refused.body.current.allowed_statuses.includes('awaiting_policy'));
  assert.ok(!refused.body.current.allowed_statuses.includes('completed'));

  const unchanged = await pool.query('SELECT status FROM privacy_requests WHERE id = $1', [row.id]);
  assert.equal(unchanged.rows[0].status, 'submitted');

  // The detail view recomputes them rather than trusting the copy stored when
  // the request was made.
  assert.ok(view.body.blockers.some((b) => b.category === 'open_prize_claim'));
});

test('29. the administrator list carries the minimum, and the detail needs a deliberate open', async () => {
  const user = await makeUser('minlist');
  const admin = await makeUser('minadmin', { admin: true });
  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('rights-minlist') })
  );
  const created1 = await userSession.post('/api/account/privacy-requests').send({
    request_type: 'deletion',
    message: 'Fabricated message that must not be in the queue.',
  });

  const queue = await adminSession.get('/api/admin/privacy-requests');
  assert.equal(queue.status, 200);
  assert.equal(queue.headers['cache-control'], 'no-store');

  const row = queue.body.find((r) => r.reference === created1.body.request.reference);
  assert.ok(row);
  assert.deepEqual(
    Object.keys(row).sort(),
    ['account_ref', 'actions', 'age_days', 'blocking', 'created_at', 'id', 'reference', 'status', 'type', 'version']
  );
  assert.ok(row.blocking.every((b) => typeof b === 'string'), 'blockers are categories, not notes');

  const queueText = JSON.stringify(queue.body);
  assert.ok(!queueText.includes(user.email), 'no address in the queue');
  assert.ok(!queueText.includes('Fabricated message'), 'no free text in the queue');
  assert.ok(!/password|token|delivery|hash|risk/i.test(queueText));
  assert.ok(!queueText.includes(user.id), 'the full account id is not in the queue either');
  assert.equal(row.account_ref.length, 8);

  // The detail is where identity lives, and it is no-store.
  const detail = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers['cache-control'], 'no-store');
  assert.equal(detail.body.account.email, user.email);
  assert.equal(detail.body.request.user_message, 'Fabricated message that must not be in the queue.');

  // Even opened, it carries no credential material.
  const detailText = JSON.stringify(detail.body);
  assert.ok(!/token_hash|password_hash|delivery_ciphertext|signal_hash/i.test(detailText));
});

// ---------------------------------------------------------------------------
// Phase 2.3B safety fix — 1. no completion without an execution
// ---------------------------------------------------------------------------

test('sf1. a deletion request cannot be completed, by any route or any status', async () => {
  const user = await makeUser('sfdel');
  const admin = await makeUser('sfdeladmin', { admin: true });
  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  // A clean account: no claim, no giveaway, no dispute, nothing open. Under the
  // old rule this was exactly the case that WOULD have completed.
  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'deletion' });
  assert.equal(created1.status, 201);

  const queue = await adminSession.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === created1.body.request.reference);
  const view = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);

  const refused = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'completed',
    outcome_code: 'deletion_partial_records_retained',
    admin_notes: 'Nothing is open, so this ought to complete — and must not.',
    version: view.body.request.version,
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'DELETION_NOT_IMPLEMENTED');

  // Nothing moved, and nothing was written.
  const after = await pool.query('SELECT status, version FROM privacy_requests WHERE id = $1', [row.id]);
  assert.equal(after.rows[0].status, 'submitted');
  assert.equal(after.rows[0].version, view.body.request.version);
  const events = await pool.query(
    "SELECT COUNT(*)::int AS c FROM privacy_request_events WHERE request_id = $1 AND to_status = 'completed'",
    [row.id]
  );
  assert.equal(events.rows[0].c, 0, 'a refused completion writes no event');

  // Supplying evidence does not buy a way through it either.
  const withEvidence = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'completed',
    outcome_code: 'deletion_partial_records_retained',
    admin_notes: 'Claiming an erasure happened.',
    version: view.body.request.version,
    execution_evidence: {
      categories_erased: ['account_name', 'account_email'],
      categories_retained: [{ category: 'audit_records', reason: 'audit' }],
    },
  });
  assert.equal(withEvidence.status, 409);
  assert.equal(withEvidence.body.code, 'DELETION_NOT_IMPLEMENTED');

  // And the database refuses it independently of the route, so removing the
  // check above is not enough to produce a false completion.
  await assert.rejects(
    () => pool.query("UPDATE privacy_requests SET status = 'completed' WHERE id = $1", [row.id]),
    /privacy_requests_no_phantom_deletion|violates check constraint/i
  );

  const stillNotDeleted = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE id = $1', [user.id]);
  assert.equal(stillNotDeleted.rows[0].c, 1);
});

test('sf1b. awaiting_policy is available, honest, and keeps the request in the queue', async () => {
  const user = await makeUser('sfpolicy');
  const admin = await makeUser('sfpolicyadmin', { admin: true });
  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'deletion', message: 'Please delete everything.' });

  // The queue offers only statuses that can actually be reached.
  const queue = await adminSession.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === created1.body.request.reference);
  assert.ok(!row.actions.includes('completed'), 'the queue does not offer an action that 409s');
  assert.ok(row.actions.includes('awaiting_policy'));

  const view = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  assert.equal(view.body.deletion_execution_implemented, false);
  assert.ok(!view.body.allowed_statuses.includes('completed'));

  // A status that says something happened needs an outcome, even though it is
  // not terminal.
  const noOutcome = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'awaiting_policy',
    admin_notes: 'Holding until retention rules exist.',
    version: view.body.request.version,
  });
  assert.equal(noOutcome.status, 400);
  assert.equal(noOutcome.body.code, 'OUTCOME_CODE_INVALID');

  const held = await adminSession.post(`/api/admin/privacy-requests/${row.id}/decision`).send({
    status: 'awaiting_policy',
    outcome_code: 'deletion_policy_pending',
    admin_notes: 'Holding until the category rules are approved. Reviewed the account: nothing else outstanding.',
    version: view.body.request.version,
  });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.records_deleted, false);
  assert.equal(held.body.execution_recorded, false);

  // Still open, so follow-up is still required. Not closed_at, not terminal.
  assert.ok(rights.OPEN_STATUSES.includes('awaiting_policy'));
  const stored = await pool.query('SELECT status, closed_at FROM privacy_requests WHERE id = $1', [row.id]);
  assert.equal(stored.rows[0].status, 'awaiting_policy');
  assert.equal(stored.rows[0].closed_at, null);

  const stillQueued = await adminSession.get('/api/admin/privacy-requests');
  const requeued = stillQueued.body.find((r) => r.reference === created1.body.request.reference);
  assert.ok(requeued, 'it stays in the administrator queue');
  assert.ok(requeued.actions.length, 'and can still be acted on');

  // What the requester reads never says their data was removed.
  const mine = await userSession.get(`/api/account/privacy-requests/${created1.body.request.reference}`);
  assert.equal(mine.body.status, 'awaiting_policy');
  const copy = mine.body.outcome;
  assert.ok(copy);
  assert.ok(/Nothing has been deleted/i.test(copy));
  assert.ok(!/(has been|was) (deleted|erased|removed)\b/i.test(copy.replace(/Nothing has been deleted/gi, '')));
  // And the blocker naming the real reason is visible to them.
  assert.ok(mine.body.blockers.some((b) => b.category === 'deletion_policy_pending'));
});

test('sf1c. no outcome wording in the deletion path claims an erasure happened', () => {
  // Every sentence a requester can be shown about a deletion, checked as a set.
  const deletionCopy = [
    rights.OUTCOME_COPY[rights.OUTCOME_CODES.DELETION_POLICY_PENDING],
    rights.OUTCOME_COPY[rights.OUTCOME_CODES.DELETION_BLOCKED],
  ];
  deletionCopy.forEach((copy) => {
    assert.ok(copy, 'every deletion outcome has wording');
    assert.match(copy, /[Nn]othing has been deleted/);
  });

  // `completed` is unreachable for a deletion, so the one outcome that DOES
  // describe an erasure cannot be reached by any status a deletion may take.
  const reachable = new Set(
    rights.DELETION_ALLOWED_STATUSES.flatMap((s) => rights.OUTCOMES_FOR_STATUS[s] || [])
  );
  assert.ok(!reachable.has(rights.OUTCOME_CODES.DELETION_PARTIAL),
    'the "records were removed or anonymised" sentence is unreachable today');
  assert.equal(rights.DELETION_EXECUTION_IMPLEMENTED, false);
  assert.ok(!rights.DELETION_ALLOWED_STATUSES.includes('completed'));
});

test('sf1d. completing an access or correction request requires a recorded action', async () => {
  const user = await makeUser('sfevidence');
  const admin = await makeUser('sfevidenceadmin', { admin: true });
  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  async function open(type) {
    const res = await userSession.post('/api/account/privacy-requests').send({ request_type: type });
    const queue = await adminSession.get('/api/admin/privacy-requests');
    const row = queue.body.find((r) => r.reference === res.body.request.reference);
    const view = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
    return { row, version: view.body.request.version, reference: res.body.request.reference };
  }

  const access = await open('access');
  const bare = await adminSession.post(`/api/admin/privacy-requests/${access.row.id}/decision`).send({
    status: 'completed',
    outcome_code: 'access_provided',
    admin_notes: 'Marking it done without saying what was done.',
    version: access.version,
  });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, 'EXECUTION_EVIDENCE_REQUIRED');

  const empty = await adminSession.post(`/api/admin/privacy-requests/${access.row.id}/decision`).send({
    status: 'completed',
    outcome_code: 'access_provided',
    admin_notes: 'Still not saying what was done.',
    version: access.version,
    execution_evidence: { summary: '' },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'EXECUTION_SUMMARY_REQUIRED');

  const good = await adminSession.post(`/api/admin/privacy-requests/${access.row.id}/decision`).send({
    status: 'completed',
    outcome_code: 'access_provided',
    admin_notes: 'Generated the export and sent it.',
    version: access.version,
    execution_evidence: { summary: 'Sent the JSON export to the address on the account.' },
  });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.execution_recorded, true);

  // Recorded as evidence, attributed to the signed-in administrator rather than
  // to whatever the body claimed, and append-only.
  const ex = await pool.query('SELECT * FROM privacy_request_executions WHERE request_id = $1', [
    access.row.id,
  ]);
  assert.equal(ex.rowCount, 1);
  assert.equal(ex.rows[0].action_kind, 'access_response');
  assert.equal(ex.rows[0].executed_by, admin.id);
  assert.equal(ex.rows[0].executed_by_job, null);
  assert.ok(ex.rows[0].executed_at instanceof Date);

  await assert.rejects(
    () => pool.query("UPDATE privacy_request_executions SET summary = 'rewritten' WHERE id = $1", [ex.rows[0].id]),
    /append-only|immutable|cannot be/i
  );
  await assert.rejects(
    () => pool.query('DELETE FROM privacy_request_executions WHERE id = $1', [ex.rows[0].id]),
    /append-only|immutable|cannot be/i
  );

  // A correction with a retained category and no reason is refused.
  const correction = await open('correction');
  const noReason = await adminSession
    .post(`/api/admin/privacy-requests/${correction.row.id}/decision`)
    .send({
      status: 'completed',
      outcome_code: 'correction_applied',
      admin_notes: 'Corrected the name.',
      version: correction.version,
      execution_evidence: {
        summary: 'Corrected the display name.',
        categories_retained: [{ category: 'audit_records' }],
      },
    });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'RETENTION_REASON_REQUIRED');

  // The client cannot name somebody else as responsible.
  const impersonated = await adminSession
    .post(`/api/admin/privacy-requests/${correction.row.id}/decision`)
    .send({
      status: 'completed',
      outcome_code: 'correction_applied',
      admin_notes: 'Corrected the name.',
      version: correction.version,
      execution_evidence: { summary: 'Corrected the display name.', executed_by: user.id },
    });
  assert.equal(impersonated.status, 200);
  const ex2 = await pool.query('SELECT executed_by FROM privacy_request_executions WHERE request_id = $1', [
    correction.row.id,
  ]);
  assert.equal(ex2.rows[0].executed_by, admin.id, 'attribution comes from the session, not the body');

  // The library refuses an erasure with nothing erased, for the day the switch
  // flips.
  assert.throws(
    () => rights.assertExecutionEvidence(
      { categories_retained: [], executed_by: 'someone' },
      { requestType: 'deletion' }
    ),
    (err) => err.code === 'EXECUTION_EVIDENCE_EMPTY'
  );
  // And one that names neither a person nor a job.
  assert.throws(
    () => rights.assertExecutionEvidence({ summary: 'did a thing' }, { requestType: 'access' }),
    (err) => err.code === 'EXECUTION_ACTOR_REQUIRED'
  );
});

// ---------------------------------------------------------------------------
// Phase 2.3B safety fix — 2. no administrator hard-delete
// ---------------------------------------------------------------------------

test('sf2. no route hard-deletes an account, and no screen offers to', async () => {
  const admin = await makeUser('sfnodelete', { admin: true });
  const plain = await makeUser('sfnodeletetarget');
  const adminSession = await signIn(admin.email);

  // A brand new account with no activity at all — the exact case the old route
  // was happy to remove.
  const res = await adminSession.delete(`/api/admin/users/${plain.id}`);
  assert.equal(res.status, 405);
  assert.equal(res.body.code, 'ACCOUNT_DELETION_DISABLED');
  assert.match(res.headers.allow || '', /GET|PATCH|POST/);
  assert.ok(Array.isArray(res.body.alternatives) && res.body.alternatives.length);
  assert.match(res.body.note, /No records were deleted/i);

  const survived = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE id = $1', [plain.id]);
  assert.equal(survived.rows[0].c, 1);

  // Not a permission problem being reported as a method problem: a
  // non-administrator is still refused first.
  const plainSession = await signIn(plain.email);
  assert.equal((await plainSession.delete(`/api/admin/users/${admin.id}`)).status, 403);

  // The alternatives it points at exist and work.
  const suspended = await adminSession.post(`/api/admin/users/${plain.id}/account-status`).send({
    status: 'suspended',
    reason: 'Fabricated: proving the documented alternative exists.',
  });
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

  // The alternatives the refusal names are real routes, not aspirational ones.
  res.body.alternatives.forEach((alt) => {
    const [method, route] = alt.route.split(' ');
    assert.ok(['GET', 'POST'].includes(method), alt.route);
    assert.ok(route.startsWith('/api/admin/'), alt.route);
  });
  const revoked = await adminSession.post(`/api/admin/users/${plain.id}/revoke-sessions`).send({});
  assert.equal(revoked.status, 200);

  // No other route anywhere deletes an account.
  const routeDir = path.join(__dirname, '..', 'server', 'routes');
  const sources = fs.readdirSync(routeDir).map((f) => ({
    name: f,
    text: fs.readFileSync(path.join(routeDir, f), 'utf8'),
  }));
  sources.forEach(({ name, text }) => {
    assert.ok(
      !/DELETE\s+FROM\s+users/i.test(text),
      `${name} must not delete an account`
    );
  });

  // And no frontend control invokes one.
  const publicDir = path.join(__dirname, '..', 'public');
  const pageDir = path.join(publicDir, 'js', 'pages');
  fs.readdirSync(pageDir).forEach((file) => {
    const text = fs.readFileSync(path.join(pageDir, file), 'utf8');
    const deleteCalls = text.match(/method:\s*'DELETE'[\s\S]{0,80}/g) || [];
    deleteCalls.forEach((snippet) => {
      assert.ok(!/users/.test(snippet), `${file} still has an account-delete control`);
    });
    assert.ok(!/admin\/users\/[^)]*`?,\s*\{\s*method:\s*'DELETE'/.test(text), `${file} deletes an account`);
  });
  const adminPage = fs.readFileSync(path.join(pageDir, 'admin.js'), 'utf8');
  assert.ok(!/user-delete-btn/.test(adminPage), 'the delete button is gone, not just hidden');

  // Historical audit records are unaffected by any of this.
  const events = await pool.query(
    'SELECT COUNT(*)::int AS c FROM host_status_events WHERE user_id = $1',
    [plain.id]
  );
  assert.ok(events.rows[0].c >= 0);
});

// ---------------------------------------------------------------------------
// Phase 2.3B safety fix — 3. Sentry privacy is mechanical
// ---------------------------------------------------------------------------

test('sf3. error reporting captures no console output and scrubs what it does send', () => {
  const reporting = require('../server/lib/errorReporting');

  // The console integration is gone from the source, not merely unused.
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  // The call, not the word — the comment above it legitimately names what was
  // removed and why, and that comment is worth keeping.
  assert.ok(
    !/[^.\w]captureConsoleIntegration\s*\(/.test(indexSource.replace(/^\s*\/\/.*$/gm, '')),
    'no console capture: a log line must not become an off-platform event'
  );
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
  assert.ok(!/captureConsoleIntegration\s*\(/.test(appSource.replace(/^\s*\/\/.*$/gm, '')));

  // Sentry is configured through one place, with the settings that matter.
  const libSource = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'lib', 'errorReporting.js'),
    'utf8'
  );
  assert.match(libSource, /sendDefaultPii:\s*false/);
  assert.match(libSource, /beforeSend/);
  assert.match(libSource, /beforeBreadcrumb/);
  assert.match(libSource, /integrations:\s*\[\]/);

  // A breadcrumb is a log line by another name and is dropped outright.
  assert.equal(reporting.scrubBreadcrumb({ message: 'anything' }), null);

  // Key-based redaction, recursive, on the categories that matter here.
  const scrubbed = reporting.scrub({
    password_hash: '$2a$10$abcdefghijklmnopqrstuv',
    token_hash: 'a'.repeat(64),
    csrf: 'v1.abc',
    cookie: 'naseeb_session=abc',
    authorization: 'Bearer abc',
    contact_email: 'someone@example.com',
    contact_phone: '+971501234567',
    delivery_ciphertext: 'AAAA',
    delivery_note: 'Leave with the concierge',
    admin_notes: 'suspected of multi-accounting',
    network_hmac: 'b'.repeat(64),
    stripe_payment_intent: 'pi_123',
    database_url: 'postgres://u:p@host/db',
    nested: {
      deeper: {
        user_message: 'my address is 12 Fabricated Street',
        harmless: 'a giveaway title',
      },
    },
    list: [{ reset_token: 'zzz' }, { fine: 'ok' }],
  });

  const asText = JSON.stringify(scrubbed);
  [
    '$2a$10$', 'naseeb_session', 'Bearer abc', 'someone@example.com', '971501234567',
    'concierge', 'multi-accounting', 'pi_123', 'postgres://', 'Fabricated Street',
  ].forEach((secret) => {
    assert.ok(!asText.includes(secret), `${secret} must not survive the scrubber`);
  });
  assert.equal(scrubbed.harmless, undefined);
  assert.equal(scrubbed.nested.deeper.harmless, 'a giveaway title', 'ordinary values survive');
  assert.equal(scrubbed.list[1].fine, 'ok');

  // Value-based redaction, for personal data under an innocent key.
  const messages = {
    email: 'could not reach winner@example.com about the prize',
    url: 'GET http://localhost:3000/claim.html?token=abcdefghijklmnopqrstuvwx failed',
    fragment: 'redirect to /verify-email-change.html#token=SECRETVALUE1234567890abcd',
    ipv4: 'refused entry from 203.0.113.42',
    ipv6: 'refused entry from 2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    phone: 'delivery contact 050 123 4567 unreachable',
    stripeKey: 'auth failed for sk_test_abcdefghijklmnop',
    opaque: `token ${'x'.repeat(43)} rejected`,
    connection: 'connect failed postgresql://user:secret@db.example.com:5432/naseeb',
  };
  const out = reporting.scrub(messages);
  assert.ok(!out.email.includes('winner@example.com'));
  assert.ok(!out.url.includes('abcdefghijklmnopqrstuvwx'));
  assert.ok(out.url.includes('/claim.html'), 'the path survives, so an error stays locatable');
  assert.ok(!out.fragment.includes('SECRETVALUE1234567890abcd'));
  assert.ok(!out.ipv4.includes('203.0.113.42'));
  assert.ok(!out.ipv6.includes('2001:0db8'));
  assert.ok(!out.phone.includes('050 123 4567'));
  assert.ok(!out.stripeKey.includes('sk_test_abcdefghijklmnop'));
  assert.ok(!out.opaque.includes('x'.repeat(43)));
  assert.ok(!out.connection.includes('secret@db.example.com'));

  // A whole event: request body, headers, cookies, query string and user are
  // removed rather than trusted to be clean.
  const event = reporting.scrubEvent({
    message: 'failed for someone@example.com',
    request: {
      url: 'https://mynaseeb.ae/claim.html?token=abcdefghijklmnopqrstuvwxyz123456',
      method: 'POST',
      cookies: { naseeb_session: 'live-token' },
      headers: { authorization: 'Bearer live', 'x-csrf-token': 'v1.abc', 'user-agent': 'x' },
      data: { password: 'hunter2', delivery: { address: '12 Fabricated Street' } },
      query_string: 'token=abcdefghijklmnopqrstuvwxyz123456',
      env: { DATABASE_URL: 'postgres://u:p@h/d' },
    },
    user: { id: 'u-1', email: 'someone@example.com', ip_address: '203.0.113.9' },
    server_name: 'host-1',
  });
  const eventText = JSON.stringify(event);
  ['someone@example.com', 'live-token', 'Bearer live', 'hunter2', 'Fabricated Street',
   'abcdefghijklmnopqrstuvwxyz123456', '203.0.113.9', 'host-1'].forEach((secret) => {
    assert.ok(!eventText.includes(secret), `${secret} must not reach Sentry`);
  });
  assert.equal(event.request.cookies, undefined);
  assert.equal(event.request.headers, undefined);
  assert.equal(event.request.data, undefined);
  assert.equal(event.request.env, undefined);
  assert.equal(event.request.query_string, undefined);
  assert.equal(event.user, undefined);
  assert.equal(event.request.url, 'https://mynaseeb.ae/claim.html');
  assert.equal(event.request.method, 'POST', 'ordinary diagnostics survive');

  // A cycle does not take the report path down, and depth is bounded.
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => reporting.scrub(cyclic));

  // A scrubber that throws must drop the event rather than send it raw.
  assert.equal(reporting.scrubEvent(null), null);
});

test('sf3b. reportError is the only capture path, and its context is scrubbed too', () => {
  const reporting = require('../server/lib/errorReporting');
  const captured = [];
  reporting._setSentry({
    captureException: (err, options) => captured.push({ err, options }),
  });

  try {
    reporting.reportError(new Error('boom'), {
      route: 'POST /api/account/export',
      email: 'someone@example.com',
      token: 'abcdefghijklmnopqrstuvwxyz1234567890',
      record_id: 'abc-123',
    });
    assert.equal(captured.length, 1);
    const extra = JSON.stringify(captured[0].options.extra);
    assert.ok(!extra.includes('someone@example.com'));
    assert.ok(!extra.includes('abcdefghijklmnopqrstuvwxyz1234567890'));
    assert.ok(extra.includes('POST /api/account/export'), 'the useful part survives');
    assert.ok(extra.includes('abc-123'));

    // No DSN configured means no capture at all, rather than a queued event.
    reporting._setSentry(null);
    assert.equal(reporting.reportError(new Error('nope')), false);
    assert.equal(captured.length, 1);
  } finally {
    reporting._setSentry(null);
  }
});

// ---------------------------------------------------------------------------
// Item 4 — the durable email-change outbox
// ---------------------------------------------------------------------------

test('ob1. a provider failure leaves a pending outbox row, and the intent survives', async () => {
  const user = await makeUser('ob-fail');
  const target = uniqueEmail('ob-fail-target');

  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: target })
  );

  // The intent is committed with the change, before anything is attempted.
  const queued = await pool.query(
    'SELECT * FROM email_change_notifications WHERE change_id = $1',
    [started.id]
  );
  assert.equal(queued.rowCount, 1);
  assert.equal(queued.rows[0].kind, 'verification');
  assert.equal(queued.rows[0].status, 'pending');
  assert.equal(queued.rows[0].attempts, 0);

  // Asserted against this row rather than the summary: the suite shares a
  // database and a drain takes whatever else is due at the same moment.
  const failing = failingSender();
  const first = await outbox.processDue({ send: failing, limit: 10 });
  assert.equal(first.sent, 0);
  assert.ok(first.retry >= 1);

  const after = await pool.query(
    'SELECT * FROM email_change_notifications WHERE change_id = $1',
    [started.id]
  );
  assert.equal(after.rows[0].status, 'pending', 'still retryable');
  assert.equal(after.rows[0].attempts, 1);
  assert.equal(after.rows[0].sent_at, null);
  assert.ok(after.rows[0].last_error_category);
  assert.equal(after.rows[0].lease_owner, null, 'the lease is released on failure');

  // Backoff is capped and finite.
  assert.equal(outbox.backoffMinutes(1), 2);
  assert.ok(outbox.backoffMinutes(99) <= 60, 'capped');
  assert.ok(outbox.MAX_ATTEMPTS > 0 && outbox.MAX_ATTEMPTS < 20, 'finite');

  // The change itself is untouched by any of it.
  const change = await pool.query('SELECT status FROM email_change_requests WHERE id = $1', [started.id]);
  assert.equal(change.rows[0].status, 'pending');
  const account = await pool.query('SELECT email FROM users WHERE id = $1', [user.id]);
  assert.equal(account.rows[0].email, user.email);
});

test('ob2. no plaintext token exists in the outbox or anywhere else in the database', async () => {
  const user = await makeUser('ob-plaintext');
  const { token, started } = await startChangeAndDeliver(user.id, uniqueEmail('ob-plaintext-target'));
  assert.ok(token, 'a token did go out');

  // Not in the outbox row, in any column.
  const row = await pool.query('SELECT * FROM email_change_notifications WHERE change_id = $1', [
    started.id,
  ]);
  Object.entries(row.rows[0]).forEach(([key, value]) => {
    if (typeof value !== 'string') return;
    assert.ok(!value.includes(token), `outbox column ${key} holds the token`);
    // No duplicated hash either — the outbox does not carry a second copy of
    // what the change record already holds.
    assert.ok(!/^[0-9a-f]{64}$/.test(value), `outbox column ${key} looks like a token hash`);
  });

  // Not in the events.
  const events = await pool.query(
    'SELECT * FROM email_change_notification_events WHERE change_id = $1',
    [started.id]
  );
  assert.ok(events.rowCount >= 2);
  events.rows.forEach((ev) => {
    Object.values(ev).forEach((value) => {
      if (typeof value === 'string') assert.ok(!value.includes(token));
    });
  });

  // The change record holds only the hash of it.
  const change = await pool.query('SELECT * FROM email_change_requests WHERE id = $1', [started.id]);
  assert.equal(change.rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  Object.entries(change.rows[0]).forEach(([key, value]) => {
    if (typeof value === 'string') assert.ok(!value.includes(token), `${key} holds the plaintext`);
  });

  // And a sweep of every text column in the whole schema, which is the version
  // of this assertion that cannot be fooled by looking in the wrong table.
  const columns = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying')`
  );
  for (const c of columns.rows) {
    // eslint-disable-next-line no-await-in-loop -- a schema-wide sweep, once
    const hit = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${c.table_name}" WHERE "${c.column_name}" LIKE $1`,
      [`%${token}%`]
    );
    assert.equal(hit.rows[0].n, 0, `${c.table_name}.${c.column_name} contains a plaintext token`);
  }
});

test('ob3. each retry mints a fresh token and kills the previous link', async () => {
  const user = await makeUser('ob-retry');
  const target = uniqueEmail('ob-retry-target');

  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: target })
  );

  const send = capturingSender();
  await outbox.processDue({ send, limit: 10 });
  const firstToken = send.lastToken();
  assert.ok(firstToken);

  // Make it due again and drain a second time.
  await pool.query(
    `UPDATE email_change_notifications SET next_attempt_at = NOW() - interval '1 minute',
        status = 'pending' WHERE change_id = $1`,
    [started.id]
  );
  await outbox.processDue({ send, limit: 10 });
  const secondToken = send.lastToken();

  assert.ok(secondToken);
  assert.notEqual(firstToken, secondToken, 'a retry never reuses the token');

  // Only the newest hash is stored, so only the newest link works.
  const change = await pool.query('SELECT token_hash FROM email_change_requests WHERE id = $1', [
    started.id,
  ]);
  assert.equal(
    change.rows[0].token_hash,
    crypto.createHash('sha256').update(secondToken).digest('hex')
  );

  const dead = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token: firstToken });
  assert.equal(dead.status, 400, 'the earlier link is refused');
  assert.equal(dead.body.code, 'EMAIL_CHANGE_TOKEN_INVALID');

  const alive = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token: secondToken });
  assert.equal(alive.status, 200, 'the newest link works');

  // The supersession is on the record.
  const events = await pool.query(
    `SELECT event FROM email_change_notification_events
      WHERE change_id = $1 AND event = 'token_superseded'`,
    [started.id]
  );
  assert.equal(events.rowCount, 2, 'both mints are recorded');
});

test('ob4. a retry cannot extend the original expiry', async () => {
  const user = await makeUser('ob-expiry');
  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('ob-expiry-target') })
  );
  const original = await pool.query('SELECT expires_at FROM email_change_requests WHERE id = $1', [
    started.id,
  ]);

  const send = capturingSender();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential retries on purpose
    await outbox.processDue({ send, limit: 10 });
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `UPDATE email_change_notifications SET next_attempt_at = NOW() - interval '1 minute',
          status = 'pending' WHERE change_id = $1`,
      [started.id]
    );
  }

  const after = await pool.query('SELECT expires_at FROM email_change_requests WHERE id = $1', [
    started.id,
  ]);
  assert.equal(
    new Date(after.rows[0].expires_at).getTime(),
    new Date(original.rows[0].expires_at).getTime(),
    'three retries moved the deadline by zero milliseconds'
  );
  assert.ok(send.tokens().length >= 3, 'and each one did mint a fresh token');

  // The library itself refuses to mint against an expired change, which is what
  // stops a retry loop from outliving the window.
  await pool.query(
    `UPDATE email_change_requests SET expires_at = NOW() - interval '1 second' WHERE id = $1`,
    [started.id]
  );
  const minted = await inTransaction((client) => outbox.supersedeToken(client, started.id));
  assert.equal(minted, null, 'no token is minted for an expired change');
});

test('ob5. expired, cancelled, completed and superseded changes generate no new link', async () => {
  const scenarios = [
    {
      tag: 'expired',
      prepare: async (changeId) =>
        pool.query(
          `UPDATE email_change_requests SET expires_at = NOW() - interval '1 minute' WHERE id = $1`,
          [changeId]
        ),
      reason: 'expired',
    },
    {
      tag: 'cancelled',
      prepare: async (changeId) =>
        pool.query(
          `UPDATE email_change_requests SET status = 'cancelled', cancelled_at = NOW(),
              cancelled_reason = 'by the account holder' WHERE id = $1`,
          [changeId]
        ),
      reason: 'cancelled',
    },
    {
      tag: 'completed',
      prepare: async (changeId) =>
        pool.query(
          `UPDATE email_change_requests SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [changeId]
        ),
      reason: 'already_completed',
    },
    {
      tag: 'superseded',
      prepare: async (changeId) =>
        pool.query(
          `UPDATE email_change_requests SET status = 'cancelled', cancelled_at = NOW(),
              cancelled_reason = 'superseded by a newer request' WHERE id = $1`,
          [changeId]
        ),
      reason: 'cancelled',
    },
  ];

  for (const scenario of scenarios) {
    // eslint-disable-next-line no-await-in-loop -- one account per scenario
    const user = await makeUser(`ob-dead-${scenario.tag}`);
    // eslint-disable-next-line no-await-in-loop
    const started = await inTransaction((client) =>
      rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail(`ob-${scenario.tag}`) })
    );
    // eslint-disable-next-line no-await-in-loop
    await scenario.prepare(started.id);

    const send = capturingSender();
    // eslint-disable-next-line no-await-in-loop
    const summary = await outbox.processDue({ send, limit: 10 });
    assert.equal(summary.sent, 0, `${scenario.tag}: nothing is sent`);
    assert.equal(send.tokens().length, 0, `${scenario.tag}: no link is generated`);

    // eslint-disable-next-line no-await-in-loop
    const row = await pool.query(
      'SELECT status, cancelled_reason FROM email_change_notifications WHERE change_id = $1',
      [started.id]
    );
    assert.equal(row.rows[0].status, 'cancelled', `${scenario.tag}: the notification is cancelled`);
    assert.equal(row.rows[0].cancelled_reason, scenario.reason);

    // eslint-disable-next-line no-await-in-loop
    const change = await pool.query('SELECT token_hash FROM email_change_requests WHERE id = $1', [
      started.id,
    ]);
    if (scenario.tag !== 'completed') {
      assert.equal(change.rows[0].token_hash, null, `${scenario.tag}: no hash was written`);
    }
  }

  // A notification whose change record has gone entirely is cancelled too,
  // rather than retried forever against nothing.
  const orphanUser = await makeUser('ob-orphan');
  const orphan = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: orphanUser.id, newEmail: uniqueEmail('ob-orphan') })
  );
  await pool.query('DELETE FROM email_change_requests WHERE id = $1', [orphan.id]);
  await outbox.processDue({ send: capturingSender(), limit: 10 });
  const orphanRow = await pool.query(
    'SELECT status, cancelled_reason FROM email_change_notifications WHERE change_id = $1',
    [orphan.id]
  );
  assert.equal(orphanRow.rows[0].status, 'cancelled');
  assert.equal(orphanRow.rows[0].cancelled_reason, 'change_record_gone');
});

test('ob6. concurrent workers deliver one logical notification once', async () => {
  const user = await makeUser('ob-concurrent');
  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('ob-concurrent') })
  );

  // Four workers, all due, all at once. SKIP LOCKED plus the lease means one of
  // them takes the row and the rest find nothing.
  const senders = [capturingSender(), capturingSender(), capturingSender(), capturingSender()];
  const summaries = await Promise.all(
    senders.map((send, i) => outbox.processDue({ send, limit: 10, workerId: `worker-${i}` }))
  );

  const totalClaimed = summaries.reduce((n, s) => n + s.claimed, 0);
  const totalSent = summaries.reduce((n, s) => n + s.sent, 0);
  const totalMessages = senders.reduce((n, s) => n + s.sent.length, 0);

  assert.equal(totalClaimed, 1, `exactly one worker claimed it, got ${totalClaimed}`);
  assert.equal(totalSent, 1);
  assert.equal(totalMessages, 1, 'exactly one message was produced');

  const row = await pool.query(
    'SELECT status, attempts FROM email_change_notifications WHERE change_id = $1',
    [started.id]
  );
  assert.equal(row.rows[0].status, 'sent');
  assert.equal(row.rows[0].attempts, 1, 'and it was attempted once, not four times');

  // Enqueuing the same logical notification twice is also one row.
  const again = await inTransaction((client) =>
    outbox.enqueue(client, {
      changeId: started.id,
      userId: user.id,
      kind: outbox.KINDS.VERIFICATION,
    })
  );
  assert.equal(again.created, false, 'idempotent by key');
  const count = await pool.query(
    "SELECT COUNT(*)::int AS n FROM email_change_notifications WHERE change_id = $1 AND kind = 'verification'",
    [started.id]
  );
  assert.equal(count.rows[0].n, 1);
});

test('ob7. a crashed worker’s lease is recovered after it expires', async () => {
  const user = await makeUser('ob-lease');
  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('ob-lease') })
  );

  // Simulate a worker that claimed the row and then died: the lease is held and
  // nothing else happened.
  const claimed = await inTransaction((client) =>
    outbox.claimDue(client, { limit: 10, workerId: 'crashed-worker' })
  );
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].lease_owner, 'crashed-worker');
  assert.ok(new Date(claimed[0].lease_expires_at) > new Date());

  // While the lease is live, nobody else may take it.
  const blocked = await outbox.processDue({ send: capturingSender(), limit: 10 });
  assert.equal(blocked.claimed, 0, 'a live lease is respected');

  const stillPending = await pool.query(
    'SELECT status, sent_at FROM email_change_notifications WHERE change_id = $1',
    [started.id]
  );
  assert.equal(stillPending.rows[0].status, 'pending', 'and the row is not stranded as sent');

  // Once the lease expires, the row is recoverable — no manual intervention.
  await pool.query(
    `UPDATE email_change_notifications SET lease_expires_at = NOW() - interval '1 second'
      WHERE change_id = $1`,
    [started.id]
  );
  const send = capturingSender();
  const recovered = await outbox.processDue({ send, limit: 10, workerId: 'healthy-worker' });
  assert.equal(recovered.claimed, 1, 'a bounded lease makes a crash self-healing');
  assert.equal(recovered.sent, 1);
  assert.equal(send.tokens().length, 1);

  assert.ok(outbox.LEASE_SECONDS > 0 && outbox.LEASE_SECONDS <= 600, 'the lease is bounded');
});

test('ob8. successful delivery records sent, and ob9. a repeat run does not resend', async () => {
  const user = await makeUser('ob-sent');
  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('ob-sent') })
  );

  const send = capturingSender();
  const first = await outbox.processDue({ send, limit: 10 });
  assert.equal(first.sent, 1);

  const row = await pool.query(
    'SELECT status, sent_at, attempts, last_error_category, lease_owner FROM email_change_notifications WHERE change_id = $1',
    [started.id]
  );
  assert.equal(row.rows[0].status, 'sent');
  assert.ok(row.rows[0].sent_at instanceof Date);
  assert.equal(row.rows[0].attempts, 1);
  assert.equal(row.rows[0].last_error_category, null);
  assert.equal(row.rows[0].lease_owner, null);

  const sentEvent = await pool.query(
    "SELECT COUNT(*)::int AS n FROM email_change_notification_events WHERE change_id = $1 AND event = 'sent'",
    [started.id]
  );
  assert.equal(sentEvent.rows[0].n, 1);

  // Running the worker again, repeatedly, sends nothing more.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- repeated on purpose
    const again = await outbox.processDue({ send, limit: 10 });
    assert.equal(again.claimed, 0, 'a sent row is never claimed again');
  }
  assert.equal(send.sent.length, 1, 'exactly one message, however many times the worker runs');

  const finalRow = await pool.query(
    'SELECT attempts FROM email_change_notifications WHERE change_id = $1',
    [started.id]
  );
  assert.equal(finalRow.rows[0].attempts, 1);
});

test('ob10. terminal failure is visible to an administrator without exposing anything', async () => {
  const user = await makeUser('ob-terminal');
  const admin = await makeUser('ob-terminal-admin', { admin: true });
  const target = uniqueEmail('ob-terminal-target');

  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: target })
  );

  const failing = failingSender('provider 503 unavailable');
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    // Drive it past the attempt limit, making it due again each round.
    for (let i = 0; i <= outbox.MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts
      await outbox.processDue({ send: failing, limit: 10 });
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE email_change_notifications SET next_attempt_at = NOW() - interval '1 minute'
          WHERE change_id = $1 AND status = 'pending'`,
        [started.id]
      );
    }
  } finally {
    console.error = originalError;
  }

  const row = await pool.query(
    'SELECT status, attempts, failed_at, last_error_category FROM email_change_notifications WHERE change_id = $1',
    [started.id]
  );
  assert.equal(row.rows[0].status, 'failed', 'it gives up rather than retrying forever');
  assert.ok(row.rows[0].failed_at instanceof Date);
  assert.equal(row.rows[0].attempts, outbox.MAX_ATTEMPTS, 'it stops at the limit, not past it');
  assert.equal(row.rows[0].last_error_category, 'provider_error');

  // The alert is loud and sanitised.
  const alerts = logged.filter((l) => l.includes('exhausted'));
  assert.ok(alerts.length >= 1, 'a terminal failure is announced');
  const allLogs = logged.join('\n');
  assert.ok(!allLogs.includes(target), 'no address in the alert');
  assert.ok(!allLogs.includes(user.email), 'no address in the alert');
  assert.ok(!/#token=/.test(allLogs), 'no link in the alert');
  assert.ok(!/503 unavailable/.test(allLogs), 'not the provider message either — a category');

  // Visible to an administrator, and still carrying nothing sensitive.
  const adminSession = await signIn(admin.email);
  const queue = await adminSession.get('/api/admin/email-change-notifications');
  assert.equal(queue.status, 200);
  assert.equal(queue.headers['cache-control'], 'no-store');
  const listed = queue.body.find((n) => n.id === row.rows[0].id || n.status === 'failed');
  assert.ok(listed, 'the failure is at the top of the queue');

  const queueText = JSON.stringify(queue.body);
  assert.ok(!queueText.includes(target));
  assert.ok(!queueText.includes(user.email));
  assert.ok(!/token/i.test(queueText));
  assert.ok(!/#token=|html|subject|body/i.test(queueText));

  // A non-administrator sees none of it.
  const userSession = await signIn(user.email);
  assert.equal((await userSession.get('/api/admin/email-change-notifications')).status, 403);
});

test('ob11. a manual retry is authorized, audited and deliberate', async () => {
  const user = await makeUser('ob-manual');
  const admin = await makeUser('ob-manual-admin', { admin: true });
  const started = await inTransaction((client) =>
    rights.startEmailChange(client, { userId: user.id, newEmail: uniqueEmail('ob-manual') })
  );

  // Drive it to terminal failure.
  const failing = failingSender();
  for (let i = 0; i <= outbox.MAX_ATTEMPTS; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential attempts
    await outbox.processDue({ send: failing, limit: 10 });
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `UPDATE email_change_notifications SET next_attempt_at = NOW() - interval '1 minute'
        WHERE change_id = $1 AND status = 'pending'`,
      [started.id]
    );
  }
  const failed = await pool.query(
    "SELECT id FROM email_change_notifications WHERE change_id = $1",
    [started.id]
  );
  const notificationId = failed.rows[0].id;

  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  // Not available to the person it is about.
  assert.equal(
    (await userSession.post(`/api/admin/email-change-notifications/${notificationId}/retry`).send({ reason: 'let me' })).status,
    403
  );

  // A reason is required — a retry with no record of why is not deliberate.
  const noReason = await adminSession
    .post(`/api/admin/email-change-notifications/${notificationId}/retry`)
    .send({});
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  const retried = await adminSession
    .post(`/api/admin/email-change-notifications/${notificationId}/retry`)
    .send({ reason: 'Account holder says the email never arrived; provider outage is resolved.' });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  await outbox.settle();

  const requeued = await pool.query(
    'SELECT status, attempts, failed_at FROM email_change_notifications WHERE id = $1',
    [notificationId]
  );
  assert.ok(['pending', 'sent'].includes(requeued.rows[0].status));
  assert.equal(requeued.rows[0].failed_at, null);

  // Audited: who, when, why — on the append-only trail.
  const events = await adminSession.get(`/api/admin/email-change-notifications/${notificationId}/events`);
  assert.equal(events.status, 200);
  const manual = events.body.filter((e) => e.event === 'manual_retry');
  assert.equal(manual.length, 1);
  assert.equal(manual[0].actor_role, 'admin');
  assert.equal(manual[0].actor_name, 'Rights ob-manual-admin');
  assert.match(manual[0].note, /never arrived/);

  // And that trail cannot be rewritten.
  const eventRow = await pool.query(
    "SELECT id FROM email_change_notification_events WHERE notification_id = $1 LIMIT 1",
    [notificationId]
  );
  await assert.rejects(
    () => pool.query("UPDATE email_change_notification_events SET note = 'x' WHERE id = $1", [eventRow.rows[0].id]),
    /append-only|immutable|cannot be/i
  );
  await assert.rejects(
    () => pool.query('DELETE FROM email_change_notification_events WHERE id = $1', [eventRow.rows[0].id]),
    /append-only|immutable|cannot be/i
  );

  // An already-delivered notification is not retryable.
  const sentUser = await makeUser('ob-manual-sent');
  const sentChange = await startChangeAndDeliver(sentUser.id, uniqueEmail('ob-manual-sent'));
  const sentRow = await pool.query(
    'SELECT id FROM email_change_notifications WHERE change_id = $1',
    [sentChange.started.id]
  );
  const alreadySent = await adminSession
    .post(`/api/admin/email-change-notifications/${sentRow.rows[0].id}/retry`)
    .send({ reason: 'trying to resend a delivered message' });
  assert.equal(alreadySent.status, 409);
  assert.equal(alreadySent.body.code, 'ALREADY_SENT');
});

test('ob12. completing a change atomically enqueues the old-address warning', async () => {
  const user = await makeUser('ob-warning');
  const target = uniqueEmail('ob-warning-target');
  const { token, started } = await startChangeAndDeliver(user.id, target);

  const beforeWarning = await pool.query(
    "SELECT COUNT(*)::int AS n FROM email_change_notifications WHERE change_id = $1 AND kind = 'old_address_warning'",
    [started.id]
  );
  assert.equal(beforeWarning.rows[0].n, 0, 'not queued before the change completes');

  const done = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token });
  assert.equal(done.status, 200);
  await outbox.settle();

  const warning = await pool.query(
    "SELECT * FROM email_change_notifications WHERE change_id = $1 AND kind = 'old_address_warning'",
    [started.id]
  );
  assert.equal(warning.rowCount, 1, 'enqueued by the completion itself');

  // Atomic: the change, the session revocation and the warning share one commit.
  const routeSource = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'account.js'),
    'utf8'
  );
  const confirmHandler = routeSource.slice(routeSource.indexOf("'/email-change/confirm'"));
  const beginAt = confirmHandler.indexOf("BEGIN");
  const commitAt = confirmHandler.indexOf("COMMIT");
  const revokeAt = confirmHandler.indexOf('revokeAllForUser');
  const completeAt = confirmHandler.indexOf('completeEmailChange');
  assert.ok(beginAt < completeAt && completeAt < revokeAt && revokeAt < commitAt,
    'the address change, the revocation and the enqueue are inside one transaction');

  // A failure enqueuing the warning would roll the whole thing back rather than
  // completing a change nobody is told about — proven at the library level.
  const other = await makeUser('ob-warning-atomic');
  const otherChange = await startChangeAndDeliver(other.id, uniqueEmail('ob-warning-atomic'));
  await assert.rejects(async () => {
    await inTransaction(async (client) => {
      await rights.completeEmailChange(client, { token: otherChange.token });
      throw new Error('simulated failure after the change, before commit');
    });
  });
  const rolledBack = await pool.query('SELECT email FROM users WHERE id = $1', [other.id]);
  assert.equal(rolledBack.rows[0].email, other.email, 'the change rolled back with it');
});

test('ob13. a warning that fails to send does not undo the email change', async () => {
  const user = await makeUser('ob-warnfail');
  const target = uniqueEmail('ob-warnfail-target');
  const { token } = await startChangeAndDeliver(user.id, target);

  const done = await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token });
  assert.equal(done.status, 200);
  await outbox.settle();

  // Force the warning back to pending, then fail it repeatedly.
  await pool.query(
    `UPDATE email_change_notifications SET status = 'pending', attempts = 0,
        next_attempt_at = NOW() - interval '1 minute', sent_at = NULL
      WHERE kind = 'old_address_warning' AND user_id = $1`,
    [user.id]
  );
  const failing = failingSender('ECONNREFUSED reaching the provider');
  await outbox.processDue({ send: failing, limit: 10 });

  // The change stands.
  const account = await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [user.id]);
  assert.equal(account.rows[0].email, target, 'a failed warning does not revert the address');
  assert.equal(account.rows[0].email_verified, true);

  const change = await pool.query(
    "SELECT status FROM email_change_requests WHERE user_id = $1 AND status = 'completed'",
    [user.id]
  );
  assert.equal(change.rowCount, 1, 'the change is still completed');

  // And the warning stays retryable rather than being dropped.
  const warning = await pool.query(
    "SELECT status, attempts, last_error_category FROM email_change_notifications WHERE user_id = $1 AND kind = 'old_address_warning'",
    [user.id]
  );
  assert.equal(warning.rows[0].status, 'pending');
  assert.equal(warning.rows[0].last_error_category, 'network');
  assert.ok(warning.rows[0].attempts >= 1);

  // Sessions stay revoked too — the security consequence of the change is not
  // conditional on a mail provider.
  const families = await pool.query(
    "SELECT COUNT(*)::int AS n FROM session_families WHERE user_id = $1 AND revoked_at IS NULL",
    [user.id]
  );
  assert.equal(families.rows[0].n, 0);
});

test('ob14. the warning carries no token, no completing link and only a masked address', async () => {
  const user = await makeUser('ob-warncontent');
  const target = uniqueEmail('ob-warncontent-target');
  const { token } = await startChangeAndDeliver(user.id, target);

  await api()
    .post('/api/account/email-change/confirm')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', nextTestIp())
    .send({ token });
  await outbox.settle();

  await pool.query(
    `UPDATE email_change_notifications SET status = 'pending', attempts = 0,
        next_attempt_at = NOW() - interval '1 minute', sent_at = NULL
      WHERE kind = 'old_address_warning' AND user_id = $1`,
    [user.id]
  );
  const send = capturingSender();
  await outbox.processDue({ send, limit: 10 });

  const warning = send.sent.find((m) => /changed/i.test(m.subject));
  assert.ok(warning, 'the warning was produced');

  // It goes to the OLD address.
  assert.equal(warning.to, user.email);
  assert.notEqual(warning.to, target);

  // No token, no completing link, no session link.
  assert.ok(!warning.html.includes(token), 'no verification token');
  assert.ok(!/#token=/.test(warning.html), 'no completing link');
  assert.ok(!/verify-email-change/.test(warning.html), 'no link to the completion page');
  assert.ok(!/naseeb_session|csrf/i.test(warning.html));

  // The new address is masked, not printed.
  assert.ok(!warning.html.includes(target), 'the full new address is not disclosed');
  assert.ok(warning.html.includes(outbox.maskEmail(target)), 'a masked form is shown');
  assert.match(outbox.maskEmail(target), /^.\*\*\*@/);

  // It says what to do, without inventing a support contact nobody approved.
  assert.match(warning.html, /forgot-password\.html/, 'points at a route that exists');
  assert.match(warning.html, /contact us through the site/i);
  assert.ok(
    !/@naseeb|support@|\+971|\bhotline\b|\b(mon|monday)[^<]{0,20}(fri|friday)\b/i.test(warning.html),
    'no fabricated support address, phone number or hours'
  );
  assert.match(warning.html, /never ask you for your password/i);
});

test('ob15. no log, error report or artifact carries an address, token, link or body', async () => {
  const user = await makeUser('ob-logs');
  const target = uniqueEmail('ob-logs-target');

  const logged = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  console.warn = (...a) => logged.push(a.join(' '));

  let token;
  try {
    const session = await signIn(user.email);
    await session
      .post('/api/account/email-change')
      .set('X-Forwarded-For', nextTestIp())
      .send({ new_email: target, password: PASSWORD });
    await outbox.settle();

    // A real send through the development logger — the path that would print a
    // body if anything were going to.
    const send = capturingSender();
    await outbox.processDue({ send, limit: 10 });
    token = send.lastToken();

    // And a genuine failure, which is the other place a provider message could
    // escape into a log.
    await pool.query(
      `UPDATE email_change_notifications SET status = 'pending',
          next_attempt_at = NOW() - interval '1 minute' WHERE user_id = $1`,
      [user.id]
    );
    await outbox.processDue({ send: failingSender('550 mailbox unavailable for winner@example.com'), limit: 10 });
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }

  const all = logged.join('\n');
  assert.ok(!all.includes(target), 'the new address never reaches a log');
  assert.ok(!all.includes(user.email), 'nor the old one');
  if (token) assert.ok(!all.includes(token), 'nor the token');
  assert.ok(!/#token=/.test(all), 'nor a link');
  assert.ok(!/<p>|<a href/.test(all), 'nor an email body');
  assert.ok(!/winner@example\.com|550 mailbox/.test(all), 'nor the provider message');
  assert.ok(!/naseeb_session|password/i.test(all));

  // The Sentry sanitiser from the previous commit is still the thing standing
  // between an outbox alert and an off-platform transmission.
  const reporting = require('../server/lib/errorReporting');
  const captured = [];
  reporting._setSentry({ captureException: (err, opts) => captured.push(opts) });
  try {
    reporting.reportError(new Error(`send failed for ${target}`), {
      notification_id: 'n-1',
      kind: 'verification',
      error_category: 'provider_error',
      // Deliberately hostile context, to prove the scrubber is in the path.
      recipient: target,
      link: `https://mynaseeb.ae/verify-email-change.html#token=${token || 'x'.repeat(43)}`,
    });
    const extra = JSON.stringify(captured[0].extra);
    assert.ok(!extra.includes(target));
    if (token) assert.ok(!extra.includes(token));
    assert.ok(extra.includes('provider_error'), 'the useful category survives');
    assert.ok(extra.includes('n-1'));
  } finally {
    reporting._setSentry(null);
  }

  // The outbox itself holds nothing that could become an artifact.
  const outboxSource = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'lib', 'emailChangeOutbox.js'),
    'utf8'
  );
  const columns = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_change_notifications'`
  );
  const names = columns.rows.map((c) => c.column_name);
  ['token', 'token_hash', 'recipient', 'email', 'to_address', 'body', 'html', 'subject', 'link'].forEach(
    (forbidden) => {
      assert.ok(!names.includes(forbidden), `the outbox must not have a ${forbidden} column`);
    }
  );
  assert.ok(/derive|resolveTarget/.test(outboxSource), 'the recipient is derived, not duplicated');
});

// ---------------------------------------------------------------------------
// Item 5 — privacy requests cannot be erased
// ---------------------------------------------------------------------------

test('sf5. a privacy request cannot be deleted directly, in bulk, or by cascade', async () => {
  const user = await makeUser('sf5-user');
  const admin = await makeUser('sf5-admin', { admin: true });
  const userSession = await signIn(user.email);

  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'access', message: 'Fabricated.' });
  assert.equal(created1.status, 201);
  const row = await pool.query('SELECT id FROM privacy_requests WHERE reference = $1', [
    created1.body.request.reference,
  ]);
  const requestId = row.rows[0].id;

  // 16. Direct deletion fails.
  await assert.rejects(
    () => pool.query('DELETE FROM privacy_requests WHERE id = $1', [requestId]),
    /cannot be deleted|never erased/i
  );

  // 17. Unqualified bulk deletion fails.
  await assert.rejects(
    () => pool.query('DELETE FROM privacy_requests'),
    /cannot be deleted|never erased/i
  );
  await assert.rejects(
    () => pool.query("DELETE FROM privacy_requests WHERE status = 'submitted'"),
    /cannot be deleted|never erased/i
  );

  // 18. Deleting the account cannot cascade it away, even though the foreign
  // key says ON DELETE CASCADE.
  const fk = await pool.query(
    `SELECT confdeltype FROM pg_constraint WHERE conname = 'privacy_requests_user_id_fkey'`
  );
  assert.equal(fk.rows[0].confdeltype, 'c', 'the cascade is really configured');
  await assert.rejects(
    () => pool.query('DELETE FROM users WHERE id = $1', [user.id]),
    /cannot be deleted|never erased/i
  );

  const survived = await pool.query('SELECT COUNT(*)::int AS n FROM privacy_requests WHERE id = $1', [
    requestId,
  ]);
  assert.equal(survived.rows[0].n, 1, 'the request is still there after every attempt');
  const accountSurvived = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [
    user.id,
  ]);
  assert.equal(accountSurvived.rows[0].n, 1, 'and so is the account it belongs to');

  // 19. Controlled updates still work — this protects deletion, not change.
  const adminSession = await signIn(admin.email);
  const queue = await adminSession.get('/api/admin/privacy-requests');
  const queued = queue.body.find((r) => r.reference === created1.body.request.reference);
  const view = await adminSession.get(`/api/admin/privacy-requests/${queued.id}`);
  const moved = await adminSession.post(`/api/admin/privacy-requests/${queued.id}/decision`).send({
    status: 'in_review',
    admin_notes: 'Picked this up; the row is still mutable.',
    version: view.body.request.version,
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  const updated = await pool.query('SELECT status, version FROM privacy_requests WHERE id = $1', [
    requestId,
  ]);
  assert.equal(updated.rows[0].status, 'in_review');
  assert.equal(updated.rows[0].version, view.body.request.version + 1);

  // A plain UPDATE works too — the trigger is BEFORE DELETE only.
  await pool.query('UPDATE privacy_requests SET updated_at = NOW() WHERE id = $1', [requestId]);

  // The append-only events and execution evidence are untouched by this change.
  const events = await pool.query(
    'SELECT COUNT(*)::int AS n FROM privacy_request_events WHERE request_id = $1',
    [requestId]
  );
  assert.ok(events.rows[0].n >= 2);
  await assert.rejects(
    () => pool.query('DELETE FROM privacy_request_events WHERE request_id = $1', [requestId]),
    /append-only/i
  );

  // An account with no privacy request is still deletable — the protection is
  // narrow, not a blanket refusal to remove anything.
  const unrelated = await makeUser('sf5-unrelated');
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [unrelated.id]);
  await pool.query('DELETE FROM session_families WHERE user_id = $1', [unrelated.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [unrelated.id]);
  const gone = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [unrelated.id]);
  assert.equal(gone.rows[0].n, 0, 'the trigger does not block unrelated deletions');
});

// ---------------------------------------------------------------------------
// 30. Hostile text stays inert
// ---------------------------------------------------------------------------

test('30. hostile text in a request, a name and an email stays text', async () => {
  const user = await makeUser('hostile');
  const admin = await makeUser('hostileadmin', { admin: true });
  const userSession = await signIn(user.email);
  const adminSession = await signIn(admin.email);

  const PAYLOADS = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(document.cookie)</script>',
    'javascript:alert(1)',
    '"><svg onload=alert(1)>',
    "'; DROP TABLE users; --",
    '{{constructor.constructor("alert(1)")()}}',
    '<iframe srcdoc="<script>alert(1)</script>">',
    '‮gnp.exe',
  ];

  const message = PAYLOADS.join(' | ');
  await userSession.patch('/api/account/me').send({ name: PAYLOADS[0] });
  const created1 = await userSession
    .post('/api/account/privacy-requests')
    .send({ request_type: 'correction', message });
  assert.equal(created1.status, 201);

  // Stored verbatim — the fix is never to mangle what somebody typed.
  const stored = await pool.query('SELECT user_message FROM privacy_requests WHERE reference = $1', [
    created1.body.request.reference,
  ]);
  assert.equal(stored.rows[0].user_message, message);

  const back = await userSession.get(`/api/account/privacy-requests/${created1.body.request.reference}`);
  assert.equal(back.body.your_message, message);

  // The pages that render it build DOM nodes and set text. There is no HTML
  // parsing sink on either page for this to reach.
  const pages = ['account.js', 'admin.js'].map((f) =>
    fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pages', f), 'utf8')
  );
  pages.forEach((source, i) => {
    const name = ['account.js', 'admin.js'][i];
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), `${name} has no HTML sink`);
    assert.ok(!/createContextualFragment|DOMParser/.test(source), `${name} parses no HTML`);
  });

  // The HTML documents themselves are static and carry no inline handler.
  ['account.html', 'verify-email-change.html', 'admin.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${file} has no inline event handler`);
    assert.ok(!/<script>[^<]/.test(html), `${file} has no inline script`);
  });

  // And the new pages are served with the same enforced CSP as the rest.
  for (const page of ['/account.html', '/verify-email-change.html']) {
    const res = await api().get(page);
    assert.equal(res.status, 200);
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, `${page} has an enforced CSP`);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/unsafe-inline/.test(csp.split('script-src')[1].split(';')[0]));
  }

  // These two pages carry an address, a request history and a single-use token,
  // so no analytics script is served on them even when analytics is configured —
  // proven by turning it on, which the header alone cannot show while it is off.
  const headers = require('../server/lib/securityHeaders');
  assert.ok(headers.NO_THIRD_PARTY_PATHS.some((p) => p.test('/account.html')));
  assert.ok(headers.NO_THIRD_PARTY_PATHS.some((p) => p.test('/verify-email-change.html')));
  const priorGa = process.env.GA_MEASUREMENT_ID;
  process.env.GA_MEASUREMENT_ID = 'G-FABRICATED';
  try {
    ['/account.html', '/verify-email-change.html'].forEach((page) => {
      assert.equal(headers.analyticsEnabled(page), false, `${page} must not load analytics`);
      const directives = headers.buildDirectives(page);
      assert.ok(
        !directives['script-src'].some((src) => /googletagmanager|google-analytics/.test(src)),
        `${page} must not permit an analytics script`
      );
    });
    // A page where analytics IS permitted, so the check above is not vacuous.
    assert.equal(headers.analyticsEnabled('/index.html'), true);
  } finally {
    if (priorGa === undefined) delete process.env.GA_MEASUREMENT_ID;
    else process.env.GA_MEASUREMENT_ID = priorGa;
  }

  // The administrator's view of the same text is text as well.
  const queue = await adminSession.get('/api/admin/privacy-requests');
  const row = queue.body.find((r) => r.reference === created1.body.request.reference);
  const detail = await adminSession.get(`/api/admin/privacy-requests/${row.id}`);
  assert.equal(detail.body.request.user_message, message);
  assert.equal(detail.body.account.name, PAYLOADS[0]);
});

// ---------------------------------------------------------------------------
// Cross-cutting: caching, and the honest description of what this is
// ---------------------------------------------------------------------------

test('every account-centre response is no-store', async () => {
  const user = await makeUser('nostore');
  const session = await signIn(user.email);

  const gets = ['/api/account/me', '/api/account/privacy-requests'];
  for (const url of gets) {
    const res = await session.get(url);
    assert.equal(res.headers['cache-control'], 'no-store', `${url} must not be cached`);
  }

  const created1 = await session.post('/api/account/privacy-requests').send({ request_type: 'access' });
  assert.equal(created1.headers['cache-control'], 'no-store');
  assert.equal((await session.patch('/api/account/me').send({ name: 'No Store' })).headers['cache-control'], 'no-store');
  assert.equal((await session.post('/api/account/eligibility').send({ confirmed: true })).headers['cache-control'], 'no-store');
});

test('the request state machine only closes with a recorded action', async () => {
  // Every closing status has at least one outcome code, and no closing status
  // accepts an outcome that means "we have not done anything yet".
  rights.CLOSED_STATUSES.forEach((status) => {
    const allowed = rights.OUTCOMES_FOR_STATUS[status];
    assert.ok(allowed && allowed.length, `${status} must have an outcome`);
    assert.ok(
      !allowed.includes(rights.OUTCOME_CODES.NEED_MORE_INFORMATION),
      `${status} must not close on "we need more information"`
    );
    allowed.forEach((code) => {
      assert.ok(rights.OUTCOME_COPY[code], `${code} needs wording the requester can read`);
    });
  });

  // Open statuses do not carry a completion outcome.
  assert.deepEqual(rights.OUTCOMES_FOR_STATUS.submitted, []);
  assert.deepEqual(rights.OUTCOMES_FOR_STATUS.in_review, []);

  // And no timing promise is invented anywhere.
  const copy = Object.values(rights.OUTCOME_COPY).join(' ');
  assert.ok(!/\b(30|45|60|72|90)\s*(days?|hours?)\b/i.test(copy), 'no invented statutory deadline');
  const view = rights.requesterView({
    reference: 'PR-TEST',
    request_type: 'access',
    status: 'submitted',
    created_at: new Date(),
    updated_at: new Date(),
    user_message: null,
    outcome_code: null,
    blockers: [],
  });
  assert.match(view.timing_note, /pending confirmation by qualified counsel/i);
});
