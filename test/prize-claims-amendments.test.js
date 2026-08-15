// Coverage for the Phase 1.5 amendments.
//
// Three things the first cut got wrong, and three it left undone:
//
//   * the claim token travelled in a query string, which writes a live
//     single-use credential into every access log between the winner and this
//     process;
//   * the claim invitation was an unawaited promise, so a mail outage lost it
//     silently and nothing recorded that it had;
//   * retention ran only when an administrator happened to open a screen, which
//     is not a retention policy;
//   * plus: no way to issue a claim for an already-drawn giveaway, and no
//     proof of what happens with the feature switched off.
//
// Every person and address here is fabricated; the database is the isolated
// local cluster.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { api, pool, ensureInit } = require('../testHelpers');

const app = require('../server/app');
const claims = require('../server/lib/claims');
const notifications = require('../server/lib/claimNotifications');
const scheduler = require('../server/lib/claimScheduler');
const { STATES } = require('../server/lib/claimStateMachine');
const { hashToken } = require('../server/lib/claimTokens');
const { claimInvitationHtml } = require('../server/lib/emailTemplates');

const TEST_KEY = `v1:${crypto.randomBytes(32).toString('base64')}`;

const FABRICATED_DELIVERY = {
  recipient_name: 'Fabricated Winner',
  phone: '+971500000123',
  address_line1: 'Villa 9, Invented Road',
  city: 'Fictionville',
  emirate: 'Testopolis',
};

const createdUserIds = [];
const createdGiveawayIds = [];
const realFetch = globalThis.fetch;

before(async () => {
  await ensureInit();
  process.env.CLAIM_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.CLAIMS_ENABLED;
  delete process.env.CLAIM_DEV_LOG_LINKS;
});

beforeEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.CLAIMS_ENABLED;
});

after(async () => {
  globalThis.fetch = realFetch;
  scheduler.stop();
  if (createdGiveawayIds.length) {
    await pool.query(
      'DELETE FROM claim_notifications WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query(
      'DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [createdGiveawayIds]
    );
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${224 + ((ipCounter >> 16) & 31)}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

async function createUser(tag, { admin = false } = {}) {
  const id = uuid();
  const email = `test-amend-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin)
     VALUES ($1, $2, $3, $4, TRUE, $5)`,
    [id, `Fabricated ${tag}`, email, bcrypt.hashSync('correcthorse123', 4), admin]
  );
  createdUserIds.push(id);
  const login = await api()
    .post('/api/auth/login')
    .set('X-Forwarded-For', nextIp())
    .send({ email, password: 'correcthorse123' });
  return { id, email, token: login.body.token };
}

// A drawn giveaway with no claim — exactly what a giveaway drawn before this
// workflow existed looks like.
async function createDrawnGiveawayWithoutClaim() {
  const host = await createUser('host');
  const winner = await createUser('winner');
  const giveawayId = uuid();
  await pool.query(
    `INSERT INTO giveaways
       (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Historical Giveaway', 'Drawn before claims existed', 'A fabricated prize',
             'Marketing budget (fabricated)', $3, 'drawn')`,
    [giveawayId, host.id, new Date(Date.now() - 86400000).toISOString()]
  );
  createdGiveawayIds.push(giveawayId);
  const entryId = uuid();
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)',
    [entryId, giveawayId, winner.id]
  );
  await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);
  return { host, winner, giveawayId, entryId };
}

async function createClaimWithOutbox(ctx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await claims.createClaimForDraw(client, {
      giveawayId: ctx.giveawayId,
      winnerUserId: ctx.winner.id,
      entryId: ctx.entryId,
    });
    await notifications.queueInvitation(client, claim.id);
    await client.query('COMMIT');
    return claim;
  } finally {
    client.release();
  }
}

// Captures the link out of the invitation email, which is the only place it
// legitimately appears.
function captureSentEmails() {
  const sent = [];
  process.env.RESEND_API_KEY = 're_fabricated_key';
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.resend.com')) {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: 'fabricated' }), { status: 200 });
    }
    return realFetch(url, options);
  };
  return sent;
}

function failAllEmails() {
  process.env.RESEND_API_KEY = 're_fabricated_key';
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      throw new Error('Simulated provider outage: ECONNREFUSED');
    }
    throw new Error('unexpected outbound request');
  };
}

function tokenFromEmail(html) {
  const match = String(html).match(/claim\.html#token=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// 1. The token never reaches the server in a URL
// ---------------------------------------------------------------------------

test('the emailed claim link puts the token in a fragment, not a query string', () => {
  const html = claimInvitationHtml({
    winnerName: 'Fabricated Winner',
    giveawayTitle: 'A giveaway',
    claimUrl: 'https://example.com/claim.html#token=FABRICATEDTOKEN',
    expiresAt: new Date(),
  });

  assert.ok(html.includes('claim.html#token=FABRICATEDTOKEN'), 'the link uses a fragment');
  assert.ok(!/claim\.html\?token=/.test(html), 'never a query string');
});

test('the whole delivered link is built as a fragment by the sender', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  await createClaimWithOutbox(ctx);

  const sent = captureSentEmails();
  await notifications.processDueNotifications({ appUrl: 'https://example.test' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /https:\/\/example\.test\/claim\.html#token=[A-Za-z0-9_-]{43}/);
  assert.ok(!sent[0].html.includes('claim.html?token='), 'no query-string form anywhere');
});

test('the query-string lookup endpoint is gone', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  const legacy = await api()
    .get(`/api/claims/lookup?token=${encodeURIComponent(claim.token)}`)
    .set('X-Forwarded-For', nextIp());

  assert.equal(legacy.status, 410, 'a token in a query string must fail loudly, not work quietly');
  assert.equal(legacy.body.code, 'USE_FRAGMENT_LINK');
});

test('the token never appears in a request target or Referer, end to end', async () => {
  // Wraps the real app in a recording layer, so these are genuine request
  // lines: method, the URL the server actually received, and the Referer the
  // browser actually sent.
  const requestLog = [];
  const recorder = express();
  recorder.use((req, res, next) => {
    requestLog.push({
      target: `${req.method} ${req.originalUrl}`,
      referer: req.headers.referer || req.headers.referrer || '',
    });
    next();
  });
  recorder.use(app);

  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);
  const sent = captureSentEmails();
  await notifications.processDueNotifications({ appUrl: 'http://127.0.0.1' });
  const token = tokenFromEmail(sent[0].html);
  assert.ok(token, 'the invitation carries a link');

  // The two calls the claim page makes, exactly as it makes them.
  const lookup = await request(recorder)
    .post('/api/claims/lookup')
    .set('X-Forwarded-For', nextIp())
    .set('Referer', 'http://127.0.0.1/claim.html')
    .send({ token });
  assert.equal(lookup.status, 200);

  const redeem = await request(recorder)
    .post('/api/claims/redeem')
    .set('X-Forwarded-For', nextIp())
    .set('Referer', 'http://127.0.0.1/claim.html')
    .send({
      token,
      consent: true,
      consent_version: claims.CONSENT_VERSION,
      delivery: FABRICATED_DELIVERY,
    });
  assert.equal(redeem.status, 200);

  assert.ok(requestLog.length >= 2, 'requests were recorded');
  requestLog.forEach((entry) => {
    assert.ok(!entry.target.includes(token), `token leaked into request target: ${entry.target}`);
    assert.ok(!entry.referer.includes(token), `token leaked into Referer: ${entry.referer}`);
  });
});

test('the claim page strips the fragment before any other script runs', () => {
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'claim.html'), 'utf8');

  const capture = page.indexOf('captureClaimToken');
  const appScript = page.indexOf('/js/app.js');
  const i18nScript = page.indexOf('/js/i18n.js');

  assert.ok(capture !== -1, 'the page captures the fragment');
  assert.ok(capture < i18nScript && capture < appScript, 'and does so before any other script loads');
  assert.ok(page.includes('history.replaceState'), 'the fragment is erased immediately');
  assert.ok(!/claims\/lookup\?token=/.test(page), 'lookup is never a query string');

  // Analytics must not initialise on this page at all.
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const analytics = appJs.slice(appJs.indexOf('loadAnalytics'), appJs.indexOf('function getToken'));
  assert.ok(analytics.includes("'/claim.html'"), 'analytics is skipped on the claim page');
});

// ---------------------------------------------------------------------------
// 2. Durable invitation delivery
// ---------------------------------------------------------------------------

test('a mail outage leaves a pending outbox row rather than losing the invitation', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  failAllEmails();
  const summary = await notifications.processDueNotifications({});

  assert.equal(summary.attempted, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.failed, 1);

  const state = await notifications.notificationStateFor(pool, claim.id);
  assert.equal(state.status, 'pending', 'still owed, so still queued');
  assert.equal(state.attempts, 1);
  assert.equal(state.delivered_at, null);
  assert.equal(state.last_error_category, 'network');
  assert.ok(new Date(state.next_attempt_at) > new Date(), 'backed off rather than retried instantly');

  // No provider message, and nothing resembling an address, is recorded.
  const row = await pool.query('SELECT * FROM claim_notifications WHERE claim_id = $1', [claim.id]);
  const serialized = JSON.stringify(row.rows[0]);
  assert.ok(!serialized.includes('ECONNREFUSED'), 'a provider message is not stored verbatim');
  assert.ok(!serialized.includes(ctx.winner.email), 'the outbox holds no address');
});

test('the outbox never holds a token, and each retry issues a fresh one', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  const sent = captureSentEmails();
  await notifications.processDueNotifications({});
  const firstToken = tokenFromEmail(sent[0].html);

  const outbox = await pool.query('SELECT * FROM claim_notifications WHERE claim_id = $1', [claim.id]);
  const serialized = JSON.stringify(outbox.rows[0]);
  assert.ok(!serialized.includes(firstToken), 'the outbox must never contain a token');
  assert.ok(!Object.keys(outbox.rows[0]).some((c) => /token/i.test(c)), 'and has no token column at all');

  // Requeue and send again — a different link, and the first one dies.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await claims.invalidateTokens(client, claim.id);
    await notifications.requeueInvitation(client, claim.id);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  await notifications.processDueNotifications({});
  const secondToken = tokenFromEmail(sent[1].html);

  assert.notEqual(secondToken, firstToken, 'a retry issues a new token');
  const stored = await pool.query('SELECT token_hash FROM prize_claims WHERE id = $1', [claim.id]);
  assert.equal(stored.rows[0].token_hash, hashToken(secondToken), 'only the newest token is valid');
  assert.notEqual(stored.rows[0].token_hash, hashToken(firstToken));

  // And the replaced link genuinely no longer works.
  const old = await api()
    .post('/api/claims/lookup')
    .set('X-Forwarded-For', nextIp())
    .send({ token: firstToken });
  assert.equal(old.status, 404, 'the previous link is invalidated');
});

test('a retry after an outage eventually delivers', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  failAllEmails();
  await notifications.processDueNotifications({});
  let state = await notifications.notificationStateFor(pool, claim.id);
  assert.equal(state.status, 'pending');

  // The provider comes back. Backoff has pushed the next attempt out, so bring
  // it forward the way the scheduler would once the time arrives.
  await pool.query('UPDATE claim_notifications SET next_attempt_at = NOW() WHERE claim_id = $1', [
    claim.id,
  ]);
  const sent = captureSentEmails();
  const summary = await notifications.processDueNotifications({});

  assert.equal(summary.delivered, 1);
  assert.equal(sent.length, 1, 'and the winner is finally told');

  state = await notifications.notificationStateFor(pool, claim.id);
  assert.equal(state.status, 'sent');
  assert.ok(state.delivered_at);
  assert.equal(state.attempts, 2);

  const stamped = await pool.query('SELECT invitation_sent_at FROM prize_claims WHERE id = $1', [
    claim.id,
  ]);
  assert.ok(stamped.rows[0].invitation_sent_at);
});

test('concurrent delivery runs send exactly one invitation', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  const sent = captureSentEmails();
  // SKIP LOCKED means the second and third runs find nothing to take rather
  // than sending the same invitation again.
  await Promise.all([
    notifications.processDueNotifications({}),
    notifications.processDueNotifications({}),
    notifications.processDueNotifications({}),
  ]);

  assert.equal(sent.length, 1, 'exactly one email for one outbox row');
  const state = await notifications.notificationStateFor(pool, claim.id);
  assert.equal(state.status, 'sent');
  assert.equal(state.attempts, 1);
});

test('an exhausted invitation stops retrying and says so loudly', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  failAllEmails();
  for (let i = 0; i < notifications.MAX_ATTEMPTS; i += 1) {
    await pool.query('UPDATE claim_notifications SET next_attempt_at = NOW() WHERE claim_id = $1', [
      claim.id,
    ]);
    await notifications.processDueNotifications({});
  }

  const state = await notifications.notificationStateFor(pool, claim.id);
  assert.equal(state.status, 'failed', 'it stops rather than retrying for ever');
  assert.equal(state.attempts, notifications.MAX_ATTEMPTS);

  // Which is exactly what the admin reissue path is for.
  const admin = await createUser('exhausted-admin', { admin: true });
  const sent = captureSentEmails();
  const reissued = await api()
    .post(`/api/claims/${claim.id}/admin/reissue`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Forwarded-For', nextIp())
    .send({ note: 'winner reported never receiving it' });

  assert.equal(reissued.status, 200);
  assert.equal(reissued.body.delivery_succeeded, 1);
  assert.equal(sent.length, 1);
});

test('drawing a winner never leaves an unhandled rejection when email fails', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  try {
    const host = await createUser('draw-host');
    const winner = await createUser('draw-winner');
    const giveawayId = uuid();
    await pool.query(
      `INSERT INTO giveaways
         (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
       VALUES ($1, $2, 'Draw With Failing Email', 'desc', 'prize', 'budget', $3, 'active')`,
      [giveawayId, host.id, new Date(Date.now() - 60000).toISOString()]
    );
    createdGiveawayIds.push(giveawayId);
    await pool.query(
      'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)',
      [uuid(), giveawayId, winner.id]
    );

    failAllEmails();
    const drawn = await api()
      .post(`/api/giveaways/${giveawayId}/draw`)
      .set('Authorization', `Bearer ${host.token}`)
      .send();
    assert.equal(drawn.status, 200, 'the draw itself still succeeds');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rejections.length, 0, 'no unhandled rejection escaped');

    // And the invitation is queued rather than lost.
    const claim = await pool.query('SELECT id FROM prize_claims WHERE giveaway_id = $1', [giveawayId]);
    const state = await notifications.notificationStateFor(pool, claim.rows[0].id);
    assert.equal(state.status, 'pending');
    assert.ok(state.attempts >= 1);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

// ---------------------------------------------------------------------------
// 5. Automatic retention
// ---------------------------------------------------------------------------

test('scheduled maintenance erases eligible details and leaves everything else', async () => {
  // Eligible: delivered long ago.
  const done = await createDrawnGiveawayWithoutClaim();
  const doneClaim = await createClaimWithOutbox(done);
  const sent = captureSentEmails();
  await notifications.processDueNotifications({});
  await api()
    .post('/api/claims/redeem')
    .set('X-Forwarded-For', nextIp())
    .send({
      token: tokenFromEmail(sent[0].html),
      consent: true,
      consent_version: claims.CONSENT_VERSION,
      delivery: FABRICATED_DELIVERY,
    });
  for (const [state, actor] of [
    [STATES.PREPARING_DELIVERY, done.host],
    [STATES.SHIPPED_OR_ARRANGED, done.host],
    [STATES.DELIVERED_PENDING_CONFIRMATION, done.host],
    [STATES.DELIVERED, done.winner],
  ]) {
    await api()
      .post(`/api/claims/${doneClaim.id}/transition`)
      .set('Authorization', `Bearer ${actor.token}`)
      .set('X-Forwarded-For', nextIp())
      .send({ to: state });
  }
  await pool.query("UPDATE prize_claims SET delivered_at = NOW() - INTERVAL '400 days' WHERE id = $1", [
    doneClaim.id,
  ]);

  // Ineligible: disputed, and therefore still needed.
  const open = await createDrawnGiveawayWithoutClaim();
  const openClaim = await createClaimWithOutbox(open);
  const sent2 = captureSentEmails();
  await notifications.processDueNotifications({});
  await api()
    .post('/api/claims/redeem')
    .set('X-Forwarded-For', nextIp())
    .send({
      token: tokenFromEmail(sent2[0].html),
      consent: true,
      consent_version: claims.CONSENT_VERSION,
      delivery: FABRICATED_DELIVERY,
    });
  await api()
    .post(`/api/claims/${openClaim.id}/transition`)
    .set('Authorization', `Bearer ${open.winner.token}`)
    .set('X-Forwarded-For', nextIp())
    .send({ to: STATES.DISPUTED, note: 'Never arrived (fabricated).' });
  await pool.query("UPDATE prize_claims SET disputed_at = NOW() - INTERVAL '400 days' WHERE id = $1", [
    openClaim.id,
  ]);

  // The scheduler's own code path, not a parallel implementation.
  const summary = await scheduler.runMaintenanceOnce({ skipNotifications: true });
  assert.ok(summary.erased >= 1);

  const erased = await pool.query('SELECT delivery_ciphertext, delivery_erased_at FROM prize_claims WHERE id = $1', [doneClaim.id]);
  assert.equal(erased.rows[0].delivery_ciphertext, null, 'a delivered claim past retention is erased');
  assert.ok(erased.rows[0].delivery_erased_at);

  const retained = await pool.query('SELECT delivery_ciphertext, status FROM prize_claims WHERE id = $1', [openClaim.id]);
  assert.equal(retained.rows[0].status, STATES.DISPUTED);
  assert.ok(retained.rows[0].delivery_ciphertext, 'a disputed claim keeps what it needs to resolve');
});

test('maintenance is idempotent and safe to run twice at once', async () => {
  const first = await scheduler.runMaintenanceOnce({ skipNotifications: true });
  assert.equal(first.skipped, false);

  // Two at once: the advisory lock means one does the work and the other says
  // so, rather than both racing over the same rows.
  const [a, b] = await Promise.all([
    scheduler.runMaintenanceOnce({ skipNotifications: true }),
    scheduler.runMaintenanceOnce({ skipNotifications: true }),
  ]);
  assert.ok(a.skipped || b.skipped, 'one of two concurrent runs stands down');
  assert.ok(!(a.skipped && b.skipped), 'but not both');
});

test('the scheduler is not reachable over HTTP', async () => {
  // The automatic path is an in-process timer with no route, so there is
  // nothing for the public to invoke. The only HTTP surface is admin-only.
  const anonymous = await api().post('/api/claims/admin/maintenance').send({});
  assert.equal(anonymous.status, 401);

  const ordinary = await createUser('not-an-admin');
  const denied = await api()
    .post('/api/claims/admin/maintenance')
    .set('Authorization', `Bearer ${ordinary.token}`)
    .send({});
  assert.equal(denied.status, 403);
});

// ---------------------------------------------------------------------------
// 6. Recovery for existing drawn giveaways
// ---------------------------------------------------------------------------

test('an admin can issue a claim for a giveaway drawn before this workflow existed', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const admin = await createUser('backfill-admin', { admin: true });

  const listed = await api()
    .get('/api/claims/admin/missing-claims')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.some((row) => row.giveaway_id === ctx.giveawayId));

  const sent = captureSentEmails();
  const created = await api()
    .post(`/api/claims/admin/backfill/${ctx.giveawayId}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Forwarded-For', nextIp())
    .send({});

  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
  assert.equal(created.body.status, STATES.AWAITING_CLAIM);
  assert.equal(sent.length, 1, 'the winner is emailed a link');

  // The winner the draw chose — not a new one.
  const claim = await pool.query('SELECT winner_user_id FROM prize_claims WHERE giveaway_id = $1', [
    ctx.giveawayId,
  ]);
  assert.equal(claim.rows[0].winner_user_id, ctx.winner.id);

  const giveaway = await pool.query('SELECT winner_entry_id FROM giveaways WHERE id = $1', [
    ctx.giveawayId,
  ]);
  assert.equal(giveaway.rows[0].winner_entry_id, ctx.entryId, 'nothing was redrawn');
});

test('backfill refuses a giveaway with no drawn winner', async () => {
  const host = await createUser('undrawn-host');
  const admin = await createUser('undrawn-admin', { admin: true });
  const giveawayId = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline)
     VALUES ($1, $2, 'Not drawn yet', 'desc', 'prize', 'budget', $3)`,
    [giveawayId, host.id, new Date(Date.now() + 86400000).toISOString()]
  );
  createdGiveawayIds.push(giveawayId);

  const res = await api()
    .post(`/api/claims/admin/backfill/${giveawayId}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Forwarded-For', nextIp())
    .send({});

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_WINNER', 'issuing a claim must never choose a winner');
});

test('repeated and concurrent backfill attempts produce exactly one claim', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const admin = await createUser('repeat-admin', { admin: true });

  captureSentEmails();
  const attempts = await Promise.all([
    api().post(`/api/claims/admin/backfill/${ctx.giveawayId}`).set('Authorization', `Bearer ${admin.token}`).set('X-Forwarded-For', nextIp()).send({}),
    api().post(`/api/claims/admin/backfill/${ctx.giveawayId}`).set('Authorization', `Bearer ${admin.token}`).set('X-Forwarded-For', nextIp()).send({}),
    api().post(`/api/claims/admin/backfill/${ctx.giveawayId}`).set('Authorization', `Bearer ${admin.token}`).set('X-Forwarded-For', nextIp()).send({}),
  ]);

  assert.ok(attempts.every((r) => r.status === 200 || r.status === 201));
  assert.equal(attempts.filter((r) => r.body.created === true).length, 1, 'only one creates');

  const count = await pool.query('SELECT COUNT(*)::int AS c FROM prize_claims WHERE giveaway_id = $1', [
    ctx.giveawayId,
  ]);
  assert.equal(count.rows[0].c, 1);

  // A fourth, later attempt is a no-op rather than an error.
  const again = await api()
    .post(`/api/claims/admin/backfill/${ctx.giveawayId}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Forwarded-For', nextIp())
    .send({});
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
});

test('reissuing invalidates every previous unused token, including concurrently', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const admin = await createUser('reissue-admin', { admin: true });
  const claim = await createClaimWithOutbox(ctx);

  const sent = captureSentEmails();
  await notifications.processDueNotifications({});
  const original = tokenFromEmail(sent[0].html);

  const reissues = await Promise.all([
    api().post(`/api/claims/${claim.id}/admin/reissue`).set('Authorization', `Bearer ${admin.token}`).set('X-Forwarded-For', nextIp()).send({}),
    api().post(`/api/claims/${claim.id}/admin/reissue`).set('Authorization', `Bearer ${admin.token}`).set('X-Forwarded-For', nextIp()).send({}),
  ]);
  assert.ok(reissues.every((r) => r.status === 200));

  // Whatever the interleaving, exactly one token is live and it is the newest.
  const stored = await pool.query('SELECT token_hash FROM prize_claims WHERE id = $1', [claim.id]);
  const issued = sent.map((mail) => tokenFromEmail(mail.html)).filter(Boolean);
  assert.equal(stored.rows[0].token_hash, hashToken(issued[issued.length - 1]));

  // Every earlier one is dead.
  for (const dead of [original, ...issued.slice(0, -1)]) {
    const res = await api().post('/api/claims/lookup').set('X-Forwarded-For', nextIp()).send({ token: dead });
    assert.equal(res.status, 404, 'a replaced token must never work');
  }
});

// ---------------------------------------------------------------------------
// 7. The feature flag
// ---------------------------------------------------------------------------

test('with claims disabled the workflow is inert and the old unsafe path stays closed', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  process.env.CLAIMS_ENABLED = 'false';
  try {
    // Every claim route refuses, with a reason.
    const lookup = await api().post('/api/claims/lookup').set('X-Forwarded-For', nextIp()).send({ token: claim.token });
    assert.equal(lookup.status, 503);
    assert.equal(lookup.body.code, 'CLAIMS_DISABLED');

    const view = await api()
      .get(`/api/claims/giveaway/${ctx.giveawayId}`)
      .set('Authorization', `Bearer ${ctx.host.token}`);
    assert.equal(view.status, 503);

    // Critically, the host still cannot declare delivery on their own. Turning
    // claims off must not reopen the door this whole phase closed.
    const legacy = await api()
      .post(`/api/giveaways/${ctx.giveawayId}/confirm-delivery`)
      .set('Authorization', `Bearer ${ctx.host.token}`)
      .send({});
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.code, 'USE_CLAIM_WORKFLOW');

    const giveaway = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [
      ctx.giveawayId,
    ]);
    assert.equal(giveaway.rows[0].prize_delivered, false);

    // And the UI is told, so it renders no controls at all.
    const config = await api().get('/api/config');
    assert.equal(config.body.claims_enabled, false);
  } finally {
    delete process.env.CLAIMS_ENABLED;
  }

  const config = await api().get('/api/config');
  assert.equal(config.body.claims_enabled, true, 'and back on by default');
});

test('the giveaway page hides claim controls unless the server says they exist', () => {
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'giveaway.html'), 'utf8');

  assert.ok(page.includes('claims_enabled'), 'the page checks the flag before rendering controls');
  assert.ok(
    !page.includes('confirm-delivery-btn'),
    'the old host-only "confirm delivered" button is gone from the markup entirely'
  );
  // Delivery details are set with textContent, never interpolated into HTML.
  assert.ok(!/innerHTML\s*=\s*`?[^;]*d\.address/.test(page), 'delivery details are never written as HTML');
});

test('sensitive claim responses are marked no-store', async () => {
  const ctx = await createDrawnGiveawayWithoutClaim();
  const claim = await createClaimWithOutbox(ctx);

  const lookup = await api().post('/api/claims/lookup').set('X-Forwarded-For', nextIp()).send({ token: claim.token });
  assert.match(lookup.headers['cache-control'], /no-store/);

  const view = await api()
    .get(`/api/claims/giveaway/${ctx.giveawayId}`)
    .set('Authorization', `Bearer ${ctx.host.token}`);
  assert.match(view.headers['cache-control'], /no-store/);
});
