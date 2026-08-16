// Who may host, and what happens to everyone who may not.
//
// The gap this closes: POST /api/giveaways checked users.email_verified and
// nothing else, so any address that could receive one email could publish
// unlimited prize draws to the public. The draw endpoint checked ownership but
// never whether the owner still had access, and the host dashboard checked only
// that somebody was signed in.
//
// Everything here uses fabricated accounts against the isolated test database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { api, pool, ensureInit, signIn, anon } = require('../testHelpers');

const { HOST_STATUS } = require('../server/lib/hostAccess');

const createdUserIds = [];
const createdGiveawayIds = [];
const createdApplicationIds = [];

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdGiveawayIds.length) {
    await pool.query('DELETE FROM claim_rescue_queue WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query(
      'DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query(
      'DELETE FROM claim_notifications WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('UPDATE giveaways SET winner_entry_id = NULL WHERE id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM host_status_events WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM host_applications WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

const PASSWORD = 'correcthorse123';

// Sign-in and application submission are both rate limited per IP, and this
// file makes far more of each than any one person would. A distinct forwarded
// address per request keeps the limiter doing its job for real callers instead
// of being switched off for the tests.
let ipCounter = 0;
function uniqueIp() {
  ipCounter += 1;
  return `10.40.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
}

async function createUser(tag, { admin = false, hostStatus = HOST_STATUS.NOT_REQUESTED, verified = true } = {}) {
  const id = uuid();
  const email = `test-hostaccess-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, `Host Access ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), verified, admin, hostStatus]
  );
  createdUserIds.push(id);
  // A cookie jar, not a token: authentication is an HttpOnly cookie the page
  // cannot read, so a test cannot hold one either.
  const session = await signIn(email, PASSWORD, { ip: uniqueIp() });
  return { ...session, id, email };
}

function giveawayPayload(n) {
  return {
    title: `Host access test giveaway ${n}`,
    description: 'A fabricated listing for the host access tests.',
    prize_description: 'A fabricated prize',
    funded_by: 'Fabricated marketing budget',
    entry_deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function createGiveaway(token, n) {
  return token.post('/api/giveaways').send(giveawayPayload(n));
}

async function setStatus(userId, status, reason = 'test fixture') {
  await pool.query(
    `UPDATE users SET host_status = $1, host_status_changed_at = NOW(), host_status_reason = $2 WHERE id = $3`,
    [status, reason, userId]
  );
}

// ---------------------------------------------------------------------------
// 1. Default state
// ---------------------------------------------------------------------------

test('a brand new account starts as not_requested and holds no host access', async () => {
  const res = await api().post('/api/auth/signup').set('X-Forwarded-For', uniqueIp()).send({
    name: 'Fresh Signup',
    email: `test-hostaccess-fresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  createdUserIds.push(res.body.user.id);

  const row = await pool.query('SELECT host_status, host_status_changed_at FROM users WHERE id = $1', [
    res.body.user.id,
  ]);
  assert.equal(row.rows[0].host_status, HOST_STATUS.NOT_REQUESTED);
  assert.equal(row.rows[0].host_status_changed_at, null, 'nothing has decided anything about this account');
});

// ---------------------------------------------------------------------------
// 2. Creation is gated on status, not on being logged in
// ---------------------------------------------------------------------------

test('a verified account that has never applied cannot create a giveaway', async () => {
  const user = await createUser('not-requested');
  const res = await createGiveaway(user, 'not-requested');

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'HOST_APPROVAL_REQUIRED');
  assert.equal(res.body.host_status, HOST_STATUS.NOT_REQUESTED);

  const count = await pool.query('SELECT COUNT(*)::int AS c FROM giveaways WHERE host_id = $1', [user.id]);
  assert.equal(count.rows[0].c, 0, 'nothing may be written by a refused request');
});

test('an account waiting for review cannot create a giveaway', async () => {
  const user = await createUser('pending', { hostStatus: HOST_STATUS.PENDING });
  const res = await createGiveaway(user, 'pending');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'HOST_APPROVAL_PENDING');
});

test('a rejected account cannot create a giveaway', async () => {
  const user = await createUser('rejected', { hostStatus: HOST_STATUS.REJECTED });
  const res = await createGiveaway(user, 'rejected');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'HOST_APPROVAL_REJECTED');
});

test('an approved account can create a giveaway', async () => {
  const user = await createUser('approved', { hostStatus: HOST_STATUS.APPROVED });
  const res = await createGiveaway(user, 'approved');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  createdGiveawayIds.push(res.body.id);
});

test('an unverified email is still refused, even when approved to host', async () => {
  const user = await createUser('unverified', { hostStatus: HOST_STATUS.APPROVED, verified: false });
  const res = await createGiveaway(user, 'unverified');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'EMAIL_VERIFICATION_REQUIRED');
});

// ---------------------------------------------------------------------------
// 3. The status is read from the database, not from the session
// ---------------------------------------------------------------------------

test('suspension takes effect on the very next request, with no new sign-in', async () => {
  const user = await createUser('suspend-live', { hostStatus: HOST_STATUS.APPROVED });

  const before = await createGiveaway(user, 'suspend-before');
  assert.equal(before.status, 201);
  createdGiveawayIds.push(before.body.id);

  // The token is untouched. Only the database changed.
  await setStatus(user.id, HOST_STATUS.SUSPENDED, 'suspended mid-session by a test');

  const after = await createGiveaway(user, 'suspend-after');
  assert.equal(after.status, 403, 'the same 30-day token must not keep asserting approval');
  assert.equal(after.body.code, 'HOST_ACCESS_SUSPENDED');

  // And nothing was deleted.
  const kept = await pool.query('SELECT COUNT(*)::int AS c FROM giveaways WHERE host_id = $1', [user.id]);
  assert.equal(kept.rows[0].c, 1, 'a suspended host keeps every record they had');
});

test('the session asserts nothing a client could forge', async () => {
  const user = await createUser('token-shape', { hostStatus: HOST_STATUS.APPROVED });

  // There is nothing in the browser to read a status out of. The session is an
  // opaque random token in an HttpOnly cookie; every claim about this account —
  // its host status, whether it is an administrator — is looked up in Postgres
  // on the request that needs it.
  const bootstrap = await user.get('/api/auth/session');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.host_status, undefined, 'host status is not part of the session');
  assert.equal(bootstrap.body.token, undefined);
  assert.equal(bootstrap.body.session_token, undefined);

  // And sending one changes nothing.
  const forged = await user
    .post('/api/giveaways')
    .send({ ...giveawayPayload('forged'), host_status: 'approved', is_admin: true, userId: 'someone-else' });
  assert.equal(forged.status, 201);
  createdGiveawayIds.push(forged.body.id);
  const row = await pool.query('SELECT host_id FROM giveaways WHERE id = $1', [forged.body.id]);
  assert.equal(row.rows[0].host_id, user.id, 'the host is the session owner, not a field in the body');
});

// ---------------------------------------------------------------------------
// 4. The administrator exemption, explicitly
// ---------------------------------------------------------------------------

test('an administrator can host without ever having been approved', async () => {
  const admin = await createUser('admin-exempt', { admin: true, hostStatus: HOST_STATUS.NOT_REQUESTED });

  // Six in a row: well past the most restrictive plan cap that the old pricing
  // page advertised, and past anything a future quota would plausibly set.
  for (let i = 0; i < 6; i++) {
    const res = await createGiveaway(admin, `admin-${i}`);
    assert.equal(res.status, 201, `giveaway ${i}: ${JSON.stringify(res.body)}`);
    createdGiveawayIds.push(res.body.id);
  }
});

test('an administrator can host even while their own host_status says suspended', async () => {
  // The site owner must not be able to lock themselves out of their own
  // platform by fat-fingering a status change.
  const admin = await createUser('admin-suspended', { admin: true, hostStatus: HOST_STATUS.SUSPENDED });
  const res = await createGiveaway(admin, 'admin-suspended');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  createdGiveawayIds.push(res.body.id);
});

// ---------------------------------------------------------------------------
// 5. Approval is not ownership
// ---------------------------------------------------------------------------

test('an approved host cannot draw, or manage delivery on, another host of theirs', async () => {
  const owner = await createUser('owner', { hostStatus: HOST_STATUS.APPROVED });
  const other = await createUser('other', { hostStatus: HOST_STATUS.APPROVED });

  const created = await createGiveaway(owner, 'ownership');
  assert.equal(created.status, 201);
  createdGiveawayIds.push(created.body.id);

  const draw = await other.post(`/api/giveaways/${created.body.id}/draw`);
  assert.equal(draw.status, 403, 'approval must not grant access to somebody else\'s giveaway');
  assert.match(draw.body.error, /Only the host of this giveaway/i);

  const delivery = await other.post(`/api/giveaways/${created.body.id}/confirm-delivery`);
  assert.equal(delivery.status, 403);
});

test('a suspended host cannot draw their own giveaway', async () => {
  const host = await createUser('draw-suspended', { hostStatus: HOST_STATUS.APPROVED });
  const created = await createGiveaway(host, 'draw-suspended');
  assert.equal(created.status, 201);
  createdGiveawayIds.push(created.body.id);

  await setStatus(host.id, HOST_STATUS.SUSPENDED, 'suspended before the draw');

  const draw = await host.post(`/api/giveaways/${created.body.id}/draw`);
  assert.equal(draw.status, 403);
  assert.equal(draw.body.code, 'HOST_ACCESS_SUSPENDED');

  const row = await pool.query('SELECT status, winner_entry_id FROM giveaways WHERE id = $1', [
    created.body.id,
  ]);
  assert.equal(row.rows[0].status, 'active', 'a refused draw must not change the giveaway');
  assert.equal(row.rows[0].winner_entry_id, null);
});

// ---------------------------------------------------------------------------
// 6. Host-only dashboard data
// ---------------------------------------------------------------------------

test('host-only dashboard data is refused to an account with no host access', async () => {
  const nobody = await createUser('dash-nobody');
  const res = await nobody.get('/api/giveaways/mine/hosted');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'HOST_APPROVAL_REQUIRED');
});

test('a suspended host loses the hosted list but keeps the giveaways behind it', async () => {
  const host = await createUser('dash-suspended', { hostStatus: HOST_STATUS.APPROVED });
  const created = await createGiveaway(host, 'dash-suspended');
  createdGiveawayIds.push(created.body.id);

  const before = await host.get('/api/giveaways/mine/hosted');
  assert.equal(before.status, 200);
  assert.equal(before.body.length, 1);

  await setStatus(host.id, HOST_STATUS.SUSPENDED, 'suspended for a dashboard test');

  const after = await host.get('/api/giveaways/mine/hosted');
  assert.equal(after.status, 403);

  const stillThere = await pool.query('SELECT COUNT(*)::int AS c FROM giveaways WHERE host_id = $1', [host.id]);
  assert.equal(stillThere.rows[0].c, 1);

  // And the giveaway is still public — losing host access is not a takedown.
  const publicView = await api().get(`/api/giveaways/${created.body.id}`);
  assert.equal(publicView.status, 200);
});

test('entering giveaways is untouched by host status', async () => {
  const host = await createUser('entry-host', { hostStatus: HOST_STATUS.APPROVED });
  const created = await createGiveaway(host, 'entry-target');
  createdGiveawayIds.push(created.body.id);

  // Someone who may not host at all can still enter, which is the whole point
  // of the platform.
  const entrant = await createUser('entrant', { hostStatus: HOST_STATUS.REJECTED });
  const entered = await entrant.post(`/api/giveaways/${created.body.id}/enter`)
    .set('X-Forwarded-For', uniqueIp());
  assert.equal(entered.status, 201, JSON.stringify(entered.body));

  const mine = await entrant.get('/api/giveaways/mine/entered');
  assert.equal(mine.status, 200, 'the entrant dashboard is not host-only');
  assert.equal(mine.body.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Applying
// ---------------------------------------------------------------------------

function applicationPayload(overrides = {}) {
  return {
    applicant_type: 'individual',
    full_name: 'Fabricated Applicant',
    message: 'A fabricated application for the tests.',
    ...overrides,
  };
}

test('applying requires a signed-in account', async () => {
  const res = await api().post('/api/host-applications').send(applicationPayload());
  assert.equal(res.status, 401);
});

test('applying requires a verified email', async () => {
  const user = await createUser('apply-unverified', { verified: false });
  const res = await user.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send(applicationPayload());
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'EMAIL_VERIFICATION_REQUIRED');
});

test('applying grants nothing — it moves the account to pending and stops there', async () => {
  const user = await createUser('apply-grants-nothing');

  const applied = await user.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send(applicationPayload());
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  createdApplicationIds.push(applied.body.id);
  assert.equal(applied.body.host_status, HOST_STATUS.PENDING);

  const row = await pool.query('SELECT host_status FROM users WHERE id = $1', [user.id]);
  assert.equal(row.rows[0].host_status, HOST_STATUS.PENDING);

  // The point of the whole phase: an application is not an approval.
  const create = await createGiveaway(user, 'apply-grants-nothing');
  assert.equal(create.status, 403);
  assert.equal(create.body.code, 'HOST_APPROVAL_PENDING');
});

test('applying stores no plan, and the application route knows nothing about payment', async () => {
  const user = await createUser('apply-no-plan');
  const applied = await user.post('/api/host-applications')
    // A client sending a plan gets it ignored rather than stored.
    .send(applicationPayload({ plan: 'partner' }));
  assert.equal(applied.status, 201);
  createdApplicationIds.push(applied.body.id);

  const row = await pool.query('SELECT plan FROM host_applications WHERE id = $1', [applied.body.id]);
  assert.equal(row.rows[0].plan, null, 'there is no plan to select, so none may be recorded');
});

test('the application route never reaches Stripe', async () => {
  const user = await createUser('apply-no-stripe');

  // Two independent proofs. First: nothing leaves the process for Stripe.
  const realFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (input, init) => {
    outbound.push(String(typeof input === 'string' ? input : input.url));
    return realFetch(input, init);
  };
  try {
    const applied = await user.post('/api/host-applications')
      .set('X-Forwarded-For', uniqueIp())
      .send(applicationPayload());
    assert.equal(applied.status, 201);
    createdApplicationIds.push(applied.body.id);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    outbound.filter((url) => /stripe/i.test(url)),
    [],
    'applying to host must not call a payment provider'
  );

  // Second: the source itself has no payment code in it, so a future edit that
  // adds one fails here rather than in production.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'hostApplications.js'),
    'utf8'
  );
  // Comments are stripped first: the file says in prose that it never touches
  // Stripe, and a guard that cannot tell a promise from a payment is no guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/stripe/i.test(code), 'the host application route must not reference Stripe');
  assert.ok(!/checkout|charge|payment_intent/i.test(code), 'nothing here may take a payment');
});

test('two applications submitted at the same instant produce exactly one', async () => {
  const user = await createUser('apply-race');

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      user.post('/api/host-applications')
        .set('X-Forwarded-For', uniqueIp())
        .send(applicationPayload())
    )
  );

  const created = attempts.filter((r) => r.status === 201);
  const conflicted = attempts.filter((r) => r.status === 409);
  assert.equal(created.length, 1, `expected exactly one application, got ${created.length}`);
  assert.equal(conflicted.length, 4, 'the rest must be told they already have one');
  conflicted.forEach((r) => assert.equal(r.body.code, 'APPLICATION_ALREADY_PENDING'));
  created.forEach((r) => createdApplicationIds.push(r.body.id));

  const rows = await pool.query(
    "SELECT COUNT(*)::int AS c FROM host_applications WHERE user_id = $1 AND status = 'pending'",
    [user.id]
  );
  assert.equal(rows.rows[0].c, 1);

  // And exactly one status event, not five.
  const events = await pool.query(
    "SELECT COUNT(*)::int AS c FROM host_status_events WHERE user_id = $1 AND to_status = 'pending'",
    [user.id]
  );
  assert.equal(events.rows[0].c, 1);
});

test('an approved account is told there is nothing to apply for', async () => {
  const user = await createUser('apply-already', { hostStatus: HOST_STATUS.APPROVED });
  const res = await user.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send(applicationPayload());
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_APPROVED');
});

test('a suspended account cannot apply its way out of a suspension', async () => {
  const user = await createUser('apply-suspended', { hostStatus: HOST_STATUS.SUSPENDED });
  const res = await user.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send(applicationPayload());
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HOST_ACCESS_SUSPENDED');

  const row = await pool.query('SELECT host_status FROM users WHERE id = $1', [user.id]);
  assert.equal(row.rows[0].host_status, HOST_STATUS.SUSPENDED);
});

test('the application uses the account email, not one typed into the form', async () => {
  const user = await createUser('apply-email');
  const applied = await user.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send(applicationPayload({ contact_email: 'someone-else@example.com' }));
  assert.equal(applied.status, 201);
  createdApplicationIds.push(applied.body.id);

  const row = await pool.query('SELECT contact_email FROM host_applications WHERE id = $1', [
    applied.body.id,
  ]);
  assert.equal(row.rows[0].contact_email, user.email);
});

// ---------------------------------------------------------------------------
// 8. Administrator review
// ---------------------------------------------------------------------------

async function applyAs(user) {
  const res = await user.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send(applicationPayload());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  createdApplicationIds.push(res.body.id);
  return res.body.id;
}

test('approving records the reason, the decision-maker and the time, and grants access', async () => {
  const admin = await createUser('decider-approve', { admin: true });
  const applicant = await createUser('decided-approve');
  const applicationId = await applyAs(applicant);

  const decision = await admin.post(`/api/admin/host-applications/${applicationId}/decision`)
    .send({ decision: 'approved', reason: 'Spoke to them; they fund their own prizes.' });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  assert.equal(decision.body.host_status, HOST_STATUS.APPROVED);

  const app = await pool.query(
    'SELECT status, decided_by, decided_at, decision_reason FROM host_applications WHERE id = $1',
    [applicationId]
  );
  assert.equal(app.rows[0].status, 'approved');
  assert.equal(app.rows[0].decided_by, admin.id);
  assert.ok(app.rows[0].decided_at, 'a decision must carry a timestamp');
  assert.match(app.rows[0].decision_reason, /fund their own prizes/);

  const event = await pool.query(
    `SELECT from_status, to_status, reason, source, changed_by
       FROM host_status_events WHERE user_id = $1 AND to_status = 'approved'`,
    [applicant.id]
  );
  assert.equal(event.rows.length, 1);
  assert.equal(event.rows[0].from_status, HOST_STATUS.PENDING);
  assert.equal(event.rows[0].source, 'admin_decision');
  assert.equal(event.rows[0].changed_by, admin.id);

  const created = await createGiveaway(applicant, 'after-approval');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdGiveawayIds.push(created.body.id);
});

test('a decision without a reason is refused, and changes nothing', async () => {
  const admin = await createUser('decider-noreason', { admin: true });
  const applicant = await createUser('decided-noreason');
  const applicationId = await applyAs(applicant);

  const res = await admin.post(`/api/admin/host-applications/${applicationId}/decision`)
    .send({ decision: 'approved', reason: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'REASON_REQUIRED');

  const row = await pool.query('SELECT host_status FROM users WHERE id = $1', [applicant.id]);
  assert.equal(row.rows[0].host_status, HOST_STATUS.PENDING, 'a refused decision must not move anything');
});

test('rejecting refuses hosting and is recorded the same way', async () => {
  const admin = await createUser('decider-reject', { admin: true });
  const applicant = await createUser('decided-reject');
  const applicationId = await applyAs(applicant);

  const decision = await admin.post(`/api/admin/host-applications/${applicationId}/decision`)
    .send({ decision: 'rejected', reason: 'Could not confirm who is behind the account.' });
  assert.equal(decision.status, 200);

  const create = await createGiveaway(applicant, 'after-rejection');
  assert.equal(create.status, 403);
  assert.equal(create.body.code, 'HOST_APPROVAL_REJECTED');
});

test('a decided application cannot be decided twice, or closed over', async () => {
  const admin = await createUser('decider-twice', { admin: true });
  const applicant = await createUser('decided-twice');
  const applicationId = await applyAs(applicant);

  const first = await admin.post(`/api/admin/host-applications/${applicationId}/decision`)
    .send({ decision: 'approved', reason: 'first decision' });
  assert.equal(first.status, 200);

  const second = await admin.post(`/api/admin/host-applications/${applicationId}/decision`)
    .send({ decision: 'rejected', reason: 'second decision' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'ALREADY_DECIDED');

  // There is no delete route on this resource at all — see
  // test/host-rescue.test.js, which proves that and guards the source.
  const deleted = await admin.delete(`/api/admin/host-applications/${applicationId}`);
  assert.equal(deleted.status, 404, 'nothing may delete an application');

  // And closing it afterwards would write a second outcome over the first.
  const closed = await admin.post(`/api/admin/host-applications/${applicationId}/close`)
    .send({ reason: 'trying to reopen a settled question' });
  assert.equal(closed.status, 409, 'a decision is part of the audit record');
  assert.equal(closed.body.code, 'ALREADY_DECIDED');

  const still = await pool.query('SELECT decision_reason FROM host_applications WHERE id = $1', [
    applicationId,
  ]);
  assert.equal(still.rows[0].decision_reason, 'first decision');
});

test('suspending and reinstating both need a reason and are both recorded', async () => {
  const admin = await createUser('suspender', { admin: true });
  const host = await createUser('suspendee', { hostStatus: HOST_STATUS.APPROVED });

  const noReason = await admin.post(`/api/admin/hosts/${host.id}/status`)
    .send({ status: 'suspended' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  const suspended = await admin.post(`/api/admin/hosts/${host.id}/status`)
    .send({ status: 'suspended', reason: 'Two undelivered prizes.' });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.host_status, HOST_STATUS.SUSPENDED);

  assert.equal((await createGiveaway(host, 'while-suspended')).status, 403);

  const reinstated = await admin.post(`/api/admin/hosts/${host.id}/status`)
    .send({ status: 'approved', reason: 'Both prizes delivered and confirmed.' });
  assert.equal(reinstated.status, 200);

  const back = await createGiveaway(host, 'after-reinstatement');
  assert.equal(back.status, 201);
  createdGiveawayIds.push(back.body.id);

  const events = await pool.query(
    'SELECT from_status, to_status, reason, changed_by FROM host_status_events WHERE user_id = $1 ORDER BY created_at ASC',
    [host.id]
  );
  const trail = events.rows.map((e) => `${e.from_status}->${e.to_status}`);
  assert.deepEqual(trail, ['approved->suspended', 'suspended->approved']);
  events.rows.forEach((e) => {
    assert.equal(e.changed_by, admin.id);
    assert.ok(e.reason && e.reason.trim().length > 0, 'every change carries a reason');
  });
});

test('a non-admin cannot decide an application or change anyone\'s host access', async () => {
  const approved = await createUser('not-an-admin', { hostStatus: HOST_STATUS.APPROVED });
  const applicant = await createUser('victim');
  const applicationId = await applyAs(applicant);

  const decision = await approved.post(`/api/admin/host-applications/${applicationId}/decision`)
    .send({ decision: 'approved', reason: 'approving myself a friend' });
  assert.equal(decision.status, 403);

  const selfGrant = await approved.post(`/api/admin/hosts/${approved.id}/status`)
    .send({ status: 'approved', reason: 'me' });
  assert.equal(selfGrant.status, 403);

  const row = await pool.query('SELECT host_status FROM users WHERE id = $1', [applicant.id]);
  assert.equal(row.rows[0].host_status, HOST_STATUS.PENDING);
});

test('the admin review queue carries no applicant contact details', async () => {
  const admin = await createUser('queue-reader', { admin: true });
  const applicant = await createUser('queue-subject');
  const applicationId = await applicant.post('/api/host-applications')
    .set('X-Forwarded-For', uniqueIp())
    .send(
      applicationPayload({
        applicant_type: 'company',
        business_name: 'Fabricated Trading LLC',
        trade_license: 'CN-0000000',
        contact_phone: '+971 50 000 0000',
        message: 'A fabricated message that should not be in the queue.',
      })
    )
    .then((r) => {
      assert.equal(r.status, 201, JSON.stringify(r.body));
      createdApplicationIds.push(r.body.id);
      return r.body.id;
    });

  const queue = await admin.get('/api/admin/host-applications');
  assert.equal(queue.status, 200);
  const serialised = JSON.stringify(queue.body);

  [applicant.email, '+971 50 000 0000', 'CN-0000000', 'A fabricated message'].forEach((secret) => {
    assert.ok(!serialised.includes(secret), `the queue must not carry "${secret}"`);
  });
  const row = queue.body.find((a) => a.id === applicationId);
  assert.ok(row, 'the application must still appear in the queue');
  assert.equal(row.display_name, 'Fabricated Trading LLC');

  // The detail view, opened deliberately, does carry them.
  const detail = await admin.get(`/api/admin/host-applications/${applicationId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.contact_phone, '+971 50 000 0000');
  assert.equal(detail.body.trade_license, 'CN-0000000');
});

// ---------------------------------------------------------------------------
// 8b. Host claim actions
// ---------------------------------------------------------------------------

test('a suspended host loses claim access, and every record survives it', async () => {
  const claims = require('../server/lib/claims');

  const host = await createUser('claim-host', { hostStatus: HOST_STATUS.APPROVED });
  const winner = await createUser('claim-winner');

  const giveawayId = uuid();
  await pool.query(
    `INSERT INTO giveaways
       (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Fabricated claim giveaway', 'd', 'p', 'Fabricated budget', $3, 'drawn')`,
    [giveawayId, host.id, new Date(Date.now() - 86400000).toISOString()]
  );
  createdGiveawayIds.push(giveawayId);

  const entryId = uuid();
  await pool.query('INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)', [
    entryId,
    giveawayId,
    winner.id,
  ]);
  await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);

  const client = await pool.connect();
  let claim;
  try {
    await client.query('BEGIN');
    claim = await claims.createClaimForDraw(client, {
      giveawayId,
      winnerUserId: winner.id,
      entryId,
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // While approved, the host is the host.
  const before = await host.get(`/api/claims/giveaway/${giveawayId}`);
  assert.equal(before.status, 200);
  assert.equal(before.body.role, 'host');

  await setStatus(host.id, HOST_STATUS.SUSPENDED, 'suspended with a claim open');

  const after = await host.get(`/api/claims/giveaway/${giveawayId}`);
  assert.equal(after.status, 403, 'a suspended host may not read a winner\'s delivery details');

  const move = await host.post(`/api/claims/${claim.id}/transition`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ to: 'preparing_delivery' });
  assert.equal(move.status, 403);

  // Nothing was deleted: the claim, its giveaway, the entry and the history are
  // all exactly where they were.
  const stillThere = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [claim.id]);
  assert.equal(stillThere.rows[0].status, 'awaiting_claim', 'a refused transition changes nothing');

  const winnerView = await winner.get(`/api/claims/giveaway/${giveawayId}`);
  assert.equal(winnerView.status, 200, 'the winner keeps their claim');
  assert.equal(winnerView.body.role, 'winner');
});

test('suspending a host reports how many open claims it hands to administrators', async () => {
  const claims = require('../server/lib/claims');
  const admin = await createUser('claim-suspender', { admin: true });
  const host = await createUser('claim-counted-host', { hostStatus: HOST_STATUS.APPROVED });
  const winner = await createUser('claim-counted-winner');

  const giveawayId = uuid();
  await pool.query(
    `INSERT INTO giveaways
       (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Counted claim giveaway', 'd', 'p', 'Fabricated budget', $3, 'drawn')`,
    [giveawayId, host.id, new Date(Date.now() - 86400000).toISOString()]
  );
  createdGiveawayIds.push(giveawayId);
  const entryId = uuid();
  await pool.query('INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)', [
    entryId,
    giveawayId,
    winner.id,
  ]);
  await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await claims.createClaimForDraw(client, { giveawayId, winnerUserId: winner.id, entryId });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const res = await admin.post(`/api/admin/hosts/${host.id}/status`)
    .send({ status: 'suspended', reason: 'A fabricated suspension.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.open_claims_affected, 1, 'the administrator must be told what they just took on');
});

// ---------------------------------------------------------------------------
// 9. The migration
// ---------------------------------------------------------------------------

test('the backfill approves accounts that were already hosting, and only those', async () => {
  const { init } = require('../server/db');

  // Someone who was hosting before approval existed.
  const legacyHost = await createUser('legacy-host');
  const created = await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline)
     VALUES ($1, $2, 'Legacy listing', 'd', 'p', 'f', $3) RETURNING id`,
    [uuid(), legacyHost.id, new Date(Date.now() + 86400000).toISOString()]
  );
  createdGiveawayIds.push(created.rows[0].id);
  // Put them back where the migration would find them.
  await pool.query(
    "UPDATE users SET host_status = 'not_requested', host_status_changed_at = NULL WHERE id = $1",
    [legacyHost.id]
  );

  // Someone who only ever submitted the old paid-plan enquiry. Ambiguous: that
  // form promised billing and was never reviewed, so it is not an application
  // to this beta and must not be recorded as one.
  const legacyEnquirer = await createUser('legacy-enquirer');
  const enquiryId = uuid();
  await pool.query(
    `INSERT INTO host_applications
       (id, user_id, applicant_type, full_name, contact_email, plan, status)
     VALUES ($1, $2, 'individual', 'Legacy Enquirer', $3, 'partner', 'pending')`,
    [enquiryId, legacyEnquirer.id, legacyEnquirer.email]
  );
  createdApplicationIds.push(enquiryId);

  // And someone an administrator has already turned down. A migration must
  // never reverse a human decision on the next boot.
  const alreadyDecided = await createUser('already-decided');
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline)
     VALUES ($1, $2, 'Decided listing', 'd', 'p', 'f', $3)`,
    [uuid(), alreadyDecided.id, new Date(Date.now() + 86400000).toISOString()]
  );
  const decidedGiveaway = await pool.query('SELECT id FROM giveaways WHERE host_id = $1', [alreadyDecided.id]);
  decidedGiveaway.rows.forEach((r) => createdGiveawayIds.push(r.id));
  await setStatus(alreadyDecided.id, HOST_STATUS.SUSPENDED, 'a deliberate admin decision');

  await init();

  const statuses = await pool.query(
    'SELECT id, host_status FROM users WHERE id = ANY($1)',
    [[legacyHost.id, legacyEnquirer.id, alreadyDecided.id]]
  );
  const byId = Object.fromEntries(statuses.rows.map((r) => [r.id, r.host_status]));

  assert.equal(byId[legacyHost.id], HOST_STATUS.APPROVED, 'an existing host keeps hosting');
  assert.equal(
    byId[legacyEnquirer.id],
    HOST_STATUS.NOT_REQUESTED,
    'an old paid-plan enquiry is ambiguous and must be left alone'
  );
  assert.equal(
    byId[alreadyDecided.id],
    HOST_STATUS.SUSPENDED,
    'a migration must never overturn a decision a human made'
  );

  // Auditable: the grant says it was a migration and names no decision-maker,
  // because none exists.
  const event = await pool.query(
    'SELECT to_status, source, changed_by, reason FROM host_status_events WHERE user_id = $1',
    [legacyHost.id]
  );
  assert.equal(event.rows.length, 1);
  assert.equal(event.rows[0].source, 'migration');
  assert.equal(event.rows[0].changed_by, null);
  assert.match(event.rows[0].reason, /already published at least one giveaway/i);

  // Idempotent: running it again grants nothing new and writes no second event.
  await init();
  const after = await pool.query('SELECT COUNT(*)::int AS c FROM host_status_events WHERE user_id = $1', [
    legacyHost.id,
  ]);
  assert.equal(after.rows[0].c, 1, 'a second run must not duplicate the grant');
});

// ---------------------------------------------------------------------------
// 10. What the pages say
// ---------------------------------------------------------------------------

test('no page advertises a purchasable hosting tier', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'public');

  const BANNED = [
    { pattern: /most popular/i, why: 'ranks plans that do not exist' },
    { pattern: /unlimited giveaway listings/i, why: 'an entitlement nothing enforces' },
    { pattern: /partner plan/i, why: 'a paid tier that was never built' },
    { pattern: /standard listing/i, why: 'a paid tier that was never built' },
    { pattern: /pilot listing/i, why: 'a paid tier that was never built' },
    { pattern: /\/ 3 giveaways/i, why: 'prices a listing bundle nobody can buy' },
    { pattern: /set up billing/i, why: 'implies a purchase the application does not make' },
    { pattern: /renews monthly/i, why: 'describes a subscription that does not exist' },
    { pattern: /featured placement on the homepage/i, why: 'an entitlement nothing implements' },
  ];

  const failures = [];
  fs.readdirSync(dir)
    .filter((name) => name.endsWith('.html'))
    .forEach((name) => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      BANNED.forEach(({ pattern, why }) => {
        const match = text.match(pattern);
        if (match) failures.push(`public/${name}: "${match[0]}" — ${why}`);
      });
    });

  assert.deepEqual(failures, [], `Unbuilt hosting products advertised:\n  ${failures.join('\n  ')}`);
});

test('the pricing page says what hosting actually is, and invents no replacement price', () => {
  const fs = require('fs');
  const path = require('path');
  const pricing = fs.readFileSync(path.join(__dirname, '..', 'public', 'pricing.html'), 'utf8');

  assert.match(pricing, /closed beta/i, 'hosting must be described as what it is');
  assert.match(pricing, /grants? (you )?nothing|does not grant access|only an administrator/i);
  assert.match(pricing, /not set a review deadline|not promising/i, 'no deadline may be promised');
  assert.match(pricing, /no paid hosting tier/i);

  // No AED figure may be typed into the hosting copy. The advertising price is
  // the one real price, and it is fetched from the server.
  const hostingSection = pricing.slice(
    pricing.indexOf('Hosting a giveaway'),
    pricing.indexOf('Advertising with us')
  );
  assert.ok(
    !/AED\s*[\d,]+/i.test(hostingSection),
    'the hosting section must not state a price for something nobody can buy'
  );
});

test('the application page does not imply a purchase', () => {
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'host-apply.html'), 'utf8');

  assert.match(page, /charges you nothing|costs nothing/i);
  assert.match(page, /grants you nothing|grants no/i);
  assert.match(page, /not set a review deadline/i);
  assert.ok(!/plan-card|plan-cards/.test(page), 'the plan picker must be gone, not hidden');
});
