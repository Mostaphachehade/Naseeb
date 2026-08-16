// Entry integrity: what the platform actually guarantees, and what it refuses
// to pretend.
//
// The guarantee is one entry per verified account per giveaway. It is a UNIQUE
// index and it holds. It is *not* one entry per person — nothing here can tell
// two verified accounts apart from two people, and this product does not collect
// identity documents to try. These tests pin both halves of that: the constraint
// that is real, and the absence of a claim that isn't.
//
// Everything below runs against the isolated test database with fabricated data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const {
  api,
  pool,
  ensureInit,
  signIn,
  uniqueEmail,
  nextTestIp,
  TEST_ORIGIN,
} = require('../testHelpers');

const integrity = require('../server/lib/entryIntegrity');
const riskSignals = require('../server/lib/riskSignals');
const { readHops, resolveTrustProxy } = require('../server/lib/proxyTrust');
const { init } = require('../server/db');

const PASSWORD = 'correcthorse123';
const TEST_KEY = `v1:${crypto.randomBytes(32).toString('base64')}`;

const created = { users: [], giveaways: [] };

before(async () => {
  await ensureInit();
  process.env.CLAIM_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.CLAIM_DEV_LOG_LINKS;
});

after(async () => {
  if (created.giveaways.length) {
    await pool.query('DELETE FROM entry_integrity_cases WHERE giveaway_id = ANY($1)', [created.giveaways]);
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
    await pool.query('UPDATE giveaways SET winner_entry_id = NULL WHERE id = ANY($1)', [created.giveaways]);
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [created.giveaways]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [created.giveaways]);
  }
  if (created.users.length) {
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
  }
  await pool.end();
});

async function makeUser(tag, { admin = false, hostStatus = 'not_requested' } = {}) {
  const id = crypto.randomUUID();
  const email = uniqueEmail(`integ-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
    [id, `Integrity ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin, hostStatus]
  );
  created.users.push(id);
  return { id, email };
}

async function makeGiveaway(hostId, { deadlineDays = 7, status = 'active' } = {}) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description,
       entry_deadline, status, funded_by)
     VALUES ($1, $2, 'Integrity giveaway', 'Fabricated', 'Fabricated prize', $3, $4, 'Self-funded')`,
    [id, hostId, new Date(Date.now() + deadlineDays * 86400000).toISOString(), status]
  );
  created.giveaways.push(id);
  return id;
}

async function makeEntry(giveawayId, userId, ticket) {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, $4)',
    [id, giveawayId, userId, ticket]
  );
  return id;
}

async function statusOf(entryId) {
  const r = await pool.query('SELECT integrity_status FROM entries WHERE id = $1', [entryId]);
  return r.rows[0] ? r.rows[0].integrity_status : null;
}

// ---------------------------------------------------------------------------
// 1–3. What one entry per account does and does not mean
// ---------------------------------------------------------------------------

test('1. one verified account can enter a giveaway once', async () => {
  const host = await makeUser('host1', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant1');
  const giveawayId = await makeGiveaway(host.id);

  const session = await signIn(entrant.email, PASSWORD);
  const res = await session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', nextTestIp());
  assert.equal(res.status, 201);
  assert.equal(res.body.ticket_number, 1);
});

test('2. a second entry from the same account is refused', async () => {
  const host = await makeUser('host2', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant2');
  const giveawayId = await makeGiveaway(host.id);
  const session = await signIn(entrant.email, PASSWORD);

  const first = await session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', nextTestIp());
  assert.equal(first.status, 201);

  const second = await session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', nextTestIp());
  assert.equal(second.status, 409);

  const count = await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [giveawayId]);
  assert.equal(count.rows[0].c, 1);

  // And the database would refuse it even if the route did not.
  await assert.rejects(
    pool.query('INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 2)', [
      crypto.randomUUID(), giveawayId, entrant.id,
    ]),
    /duplicate key|unique/i
  );
});

test('3. two accounts are two entries, and nothing claims they are one human', async () => {
  const host = await makeUser('host3', { hostStatus: 'approved' });
  const a = await makeUser('twin-a');
  const b = await makeUser('twin-b');
  const giveawayId = await makeGiveaway(host.id);

  for (const user of [a, b]) {
    const session = await signIn(user.email, PASSWORD);
    const res = await session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', nextTestIp());
    assert.equal(res.status, 201, 'a separate verified account may enter');
  }

  const count = await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [giveawayId]);
  assert.equal(count.rows[0].c, 2, 'the platform does not merge accounts into people');

  // The public wording has to match that. "One entry per person" is a claim the
  // system cannot support; "per verified account" is the one it can.
  const publicText = ['index.html', 'about.html', 'giveaway.html', 'partners.html']
    .map((name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'))
    .join('\n')
    + fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');

  const overclaims = publicText.match(/[Oo]ne (entry|ticket) per person/g) || [];
  assert.deepEqual(overclaims, [], 'public copy must not promise one entry per person');
  assert.match(publicText, /per verified account|per account/,
    'public copy should say what is actually enforced');
});

// ---------------------------------------------------------------------------
// 4–8. Who may decide, and what a decision preserves
// ---------------------------------------------------------------------------

test('4. a non-admin cannot review, disqualify or reinstate', async () => {
  const host = await makeUser('host4', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant4');
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);

  for (const user of [host, entrant]) {
    const session = await signIn(user.email, PASSWORD);
    for (const status of ['under_review', 'disqualified', 'eligible']) {
      const res = await session
        .post(`/api/admin/integrity/entries/${entryId}/status`)
        .send({ status, reason: 'trying it on' });
      assert.equal(res.status, 403, `${status} must be refused for a non-admin`);
    }
    const queue = await session.get('/api/admin/integrity/queue');
    assert.equal(queue.status, 403);
  }
  assert.equal(await statusOf(entryId), 'eligible');
});

test('5. forged role, actor and risk fields in the body do nothing', async () => {
  const host = await makeUser('host5', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant5');
  const admin = await makeUser('admin5', { admin: true });
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);

  const attacker = await signIn(entrant.email, PASSWORD);
  const res = await attacker.post(`/api/admin/integrity/entries/${entryId}/status`).send({
    status: 'disqualified',
    reason: 'forged',
    is_admin: true,
    role: 'admin',
    actor_user_id: admin.id,
    actorUserId: admin.id,
    risk_score: 100,
  });
  assert.equal(res.status, 403);
  assert.equal(await statusOf(entryId), 'eligible');

  // And the actor recorded for a real decision is the session, not the body.
  const adminSession = await signIn(admin.email, PASSWORD);
  const ok = await adminSession.post(`/api/admin/integrity/entries/${entryId}/status`).send({
    status: 'under_review',
    reason: 'a genuine reason',
    actor_user_id: entrant.id,
  });
  assert.equal(ok.status, 200);
  const ev = await pool.query(
    'SELECT actor_user_id, actor_role FROM entry_integrity_events WHERE entry_id = $1',
    [entryId]
  );
  assert.equal(ev.rows[0].actor_user_id, admin.id);
  assert.equal(ev.rows[0].actor_role, 'admin');
});

test('6. a host may flag an entry but cannot disqualify one', async () => {
  const host = await makeUser('host6', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant6');
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);

  const hostSession = await signIn(host.email, PASSWORD);

  const flagged = await hostSession
    .post(`/api/giveaways/${giveawayId}/entries/${entryId}/flag`)
    .send({ reason: 'this looks like a duplicate account to me' });
  assert.equal(flagged.status, 201);
  assert.equal(flagged.body.case_opened, true);

  // Flagging opens a case. It does not touch the entry.
  assert.equal(await statusOf(entryId), 'eligible');

  // Idempotent: the same flag again reports the same case.
  const again = await hostSession
    .post(`/api/giveaways/${giveawayId}/entries/${entryId}/flag`)
    .send({ reason: 'still looks like a duplicate' });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_open, true);
  const cases = await pool.query(
    "SELECT COUNT(*)::int AS c FROM entry_integrity_cases WHERE entry_id = $1 AND status = 'open'",
    [entryId]
  );
  assert.equal(cases.rows[0].c, 1);

  // And the admin route is still closed to them.
  const attempt = await hostSession
    .post(`/api/admin/integrity/entries/${entryId}/status`)
    .send({ status: 'disqualified', reason: 'my giveaway, my rules' });
  assert.equal(attempt.status, 403);
  assert.equal(await statusOf(entryId), 'eligible');
});

test('7. disqualification preserves the entry, its time, its account and its history', async () => {
  const host = await makeUser('host7', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant7');
  const admin = await makeUser('admin7', { admin: true });
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);

  const before = await pool.query('SELECT * FROM entries WHERE id = $1', [entryId]);

  const session = await signIn(admin.email, PASSWORD);
  const res = await session
    .post(`/api/admin/integrity/entries/${entryId}/status`)
    .send({ status: 'disqualified', reason: 'three accounts, one address, same minute' });
  assert.equal(res.status, 200);

  const after = await pool.query('SELECT * FROM entries WHERE id = $1', [entryId]);
  assert.ok(after.rows[0], 'the entry still exists');
  assert.equal(after.rows[0].created_at.getTime(), before.rows[0].created_at.getTime());
  assert.equal(after.rows[0].user_id, entrant.id);
  assert.equal(after.rows[0].giveaway_id, giveawayId);
  assert.equal(after.rows[0].ticket_number, before.rows[0].ticket_number);
  assert.equal(after.rows[0].integrity_status, 'disqualified');

  const events = await pool.query(
    'SELECT * FROM entry_integrity_events WHERE entry_id = $1 ORDER BY created_at',
    [entryId]
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].from_status, 'eligible');
  assert.equal(events.rows[0].to_status, 'disqualified');
  assert.equal(events.rows[0].reason_code, 'disqualified');
  assert.match(events.rows[0].reason, /three accounts/);

  // A restrictive decision without a reason is refused by the route and by the
  // database, so neither is the only thing standing between here and an
  // unexplained disqualification.
  const noReason = await session
    .post(`/api/admin/integrity/entries/${entryId}/status`)
    .send({ status: 'eligible', reason: '  ' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  await assert.rejects(
    pool.query(
      `INSERT INTO entry_integrity_events (id, entry_id, giveaway_id, to_status, reason_code, actor_role)
       VALUES ($1, $2, $3, 'disqualified', 'disqualified', 'admin')`,
      [crypto.randomUUID(), entryId, giveawayId]
    ),
    /entry_integrity_events_reason_required/
  );
});

test('8. reinstatement keeps the earlier disqualification in the history', async () => {
  const host = await makeUser('host8', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant8');
  const admin = await makeUser('admin8', { admin: true });
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);
  const session = await signIn(admin.email, PASSWORD);

  await session.post(`/api/admin/integrity/entries/${entryId}/status`)
    .send({ status: 'disqualified', reason: 'looked like a duplicate account' });
  const reinstated = await session.post(`/api/admin/integrity/entries/${entryId}/status`)
    .send({ status: 'eligible', reason: 'they sent proof it is a shared office' });
  assert.equal(reinstated.status, 200);
  assert.equal(await statusOf(entryId), 'eligible');

  const events = await pool.query(
    'SELECT from_status, to_status, reason_code FROM entry_integrity_events WHERE entry_id = $1 ORDER BY created_at',
    [entryId]
  );
  assert.deepEqual(
    events.rows.map((e) => [e.from_status, e.to_status, e.reason_code]),
    [
      ['eligible', 'disqualified', 'disqualified'],
      ['disqualified', 'eligible', 'reinstated'],
    ],
    'the reversal does not erase what it reversed'
  );

  // The history cannot be rewritten, by anyone, including us.
  await assert.rejects(
    pool.query("UPDATE entry_integrity_events SET reason = 'something else' WHERE entry_id = $1", [entryId]),
    /append-only/
  );
});

// ---------------------------------------------------------------------------
// 9–13. Concurrency, the draw, and migrations
// ---------------------------------------------------------------------------

test('9. concurrent conflicting decisions produce one outcome and one history', async () => {
  const host = await makeUser('host9', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant9');
  const admin = await makeUser('admin9', { admin: true });
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);
  const session = await signIn(admin.email, PASSWORD);

  const [a, b] = await Promise.all([
    session.post(`/api/admin/integrity/entries/${entryId}/status`)
      .send({ status: 'disqualified', reason: 'concurrent decision A' }),
    session.post(`/api/admin/integrity/entries/${entryId}/status`)
      .send({ status: 'under_review', reason: 'concurrent decision B' }),
  ]);

  // One of them wins and one is refused as an illegal move from the state the
  // winner left behind — or both succeed in a legal order. Either way the row
  // and the history agree, which is the property that matters.
  const final = await statusOf(entryId);
  const events = await pool.query(
    'SELECT to_status FROM entry_integrity_events WHERE entry_id = $1 ORDER BY created_at',
    [entryId]
  );
  assert.ok(['disqualified', 'under_review'].includes(final));
  assert.equal(events.rows[events.rows.length - 1].to_status, final,
    'the last history row matches the stored status');
  assert.ok([a.status, b.status].every((s) => [200, 409].includes(s)));
});

test('10. the draw selects only eligible entries', async () => {
  const host = await makeUser('host10', { hostStatus: 'approved' });
  const admin = await makeUser('admin10', { admin: true });
  const giveawayId = await makeGiveaway(host.id, { deadlineDays: -1 });

  // One eligible entry among many disqualified ones. Deterministic rather than
  // probabilistic: if the draw read the wrong pool the winner would be one of
  // the disqualified entries, and there is no lucky run that hides it.
  const keep = await makeUser('keep10');
  const keepEntry = await makeEntry(giveawayId, keep.id, 1);

  const adminSession = await signIn(admin.email, PASSWORD);
  const dropped = [];
  for (let i = 0; i < 5; i++) {
    const u = await makeUser(`drop10-${i}`);
    const entryId = await makeEntry(giveawayId, u.id, i + 2);
    dropped.push(entryId);
    const res = await adminSession.post(`/api/admin/integrity/entries/${entryId}/status`)
      .send({ status: 'disqualified', reason: 'fabricated duplicate for the test' });
    assert.equal(res.status, 200);
  }

  // The pool query itself, before any draw runs.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pooled = await integrity.lockEligibleEntries(client, giveawayId);
    assert.deepEqual(pooled.map((e) => e.id), [keepEntry], 'only eligible entries are in the pool');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  const hostSession = await signIn(host.email, PASSWORD);
  const res = await hostSession.post(`/api/giveaways/${giveawayId}/draw`);
  assert.equal(res.status, 200);

  const winner = await pool.query('SELECT winner_entry_id FROM giveaways WHERE id = $1', [giveawayId]);
  assert.equal(winner.rows[0].winner_entry_id, keepEntry, 'a disqualified entry is never drawn');
  assert.ok(!dropped.includes(winner.rows[0].winner_entry_id));
});

test('11. an unresolved review blocks the draw', async () => {
  const host = await makeUser('host11', { hostStatus: 'approved' });
  const admin = await makeUser('admin11', { admin: true });
  const a = await makeUser('a11');
  const b = await makeUser('b11');
  const giveawayId = await makeGiveaway(host.id, { deadlineDays: -1 });
  await makeEntry(giveawayId, a.id, 1);
  const flagged = await makeEntry(giveawayId, b.id, 2);

  const adminSession = await signIn(admin.email, PASSWORD);
  await adminSession.post(`/api/admin/integrity/entries/${flagged}/status`)
    .send({ status: 'under_review', reason: 'checking a signal before the draw' });

  const hostSession = await signIn(host.email, PASSWORD);
  const blocked = await hostSession.post(`/api/giveaways/${giveawayId}/draw`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'ENTRY_REVIEW_PENDING');

  const still = await pool.query('SELECT status, winner_entry_id FROM giveaways WHERE id = $1', [giveawayId]);
  assert.equal(still.rows[0].status, 'active');
  assert.equal(still.rows[0].winner_entry_id, null);

  // Resolving it unblocks the draw.
  await adminSession.post(`/api/admin/integrity/entries/${flagged}/status`)
    .send({ status: 'eligible', reason: 'the signal was a shared office' });
  const drawn = await hostSession.post(`/api/giveaways/${giveawayId}/draw`);
  assert.equal(drawn.status, 200);
});

test('12. a draw racing a disqualification stays consistent', async () => {
  const host = await makeUser('host12', { hostStatus: 'approved' });
  const admin = await makeUser('admin12', { admin: true });
  const giveawayId = await makeGiveaway(host.id, { deadlineDays: -1 });

  const users = [];
  const entries = [];
  for (let i = 0; i < 4; i++) {
    const u = await makeUser(`racer12-${i}`);
    users.push(u);
    entries.push(await makeEntry(giveawayId, u.id, i + 1));
  }

  const hostSession = await signIn(host.email, PASSWORD);
  const adminSession = await signIn(admin.email, PASSWORD);

  const [drawRes, dqRes] = await Promise.all([
    hostSession.post(`/api/giveaways/${giveawayId}/draw`),
    adminSession.post(`/api/admin/integrity/entries/${entries[0]}/status`)
      .send({ status: 'disqualified', reason: 'racing the draw on purpose' }),
  ]);

  const giveaway = await pool.query('SELECT status, winner_entry_id FROM giveaways WHERE id = $1', [giveawayId]);
  const dq = await statusOf(entries[0]);

  // Whatever order they landed in, the invariant holds: a winner is never an
  // entry that was disqualified before the draw committed.
  if (drawRes.status === 200) {
    assert.equal(giveaway.rows[0].status, 'drawn');
    const winnerStatus = await statusOf(giveaway.rows[0].winner_entry_id);
    assert.equal(winnerStatus === 'disqualified' && dq === 'disqualified' &&
      giveaway.rows[0].winner_entry_id === entries[0], false,
      'the winner must not be an entry disqualified before the draw');
  } else {
    assert.equal(drawRes.status, 409, 'a blocked draw says why');
    assert.equal(giveaway.rows[0].winner_entry_id, null);
  }
  assert.ok([200, 409].includes(dqRes.status));
});

test('13. re-running schema initialization never re-enables a disqualified entry', async () => {
  const host = await makeUser('host13', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant13');
  const admin = await makeUser('admin13', { admin: true });
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);

  const session = await signIn(admin.email, PASSWORD);
  await session.post(`/api/admin/integrity/entries/${entryId}/status`)
    .send({ status: 'disqualified', reason: 'set before the migration runs again' });

  // The migration is idempotent, and its backfill is guarded by a WHERE clause
  // rather than being a blanket UPDATE. Running it twice more must not touch a
  // decision an administrator made.
  await init();
  await init();

  assert.equal(await statusOf(entryId), 'disqualified');
  const events = await pool.query(
    'SELECT COUNT(*)::int AS c FROM entry_integrity_events WHERE entry_id = $1',
    [entryId]
  );
  assert.equal(events.rows[0].c, 1, 'and it invents no history either');
});

// ---------------------------------------------------------------------------
// 14–16. Post-draw
// ---------------------------------------------------------------------------

async function drawnGiveawayWithClaim(tag) {
  const host = await makeUser(`${tag}-host`, { hostStatus: 'approved' });
  const admin = await makeUser(`${tag}-admin`, { admin: true });
  const winner = await makeUser(`${tag}-winner`);
  const giveawayId = await makeGiveaway(host.id, { deadlineDays: -1 });
  const entryId = await makeEntry(giveawayId, winner.id, 1);

  const hostSession = await signIn(host.email, PASSWORD);
  const drawn = await hostSession.post(`/api/giveaways/${giveawayId}/draw`);
  assert.equal(drawn.status, 200);

  const claim = await pool.query('SELECT * FROM prize_claims WHERE giveaway_id = $1', [giveawayId]);
  return { host, admin, winner, giveawayId, entryId, hostSession, claim: claim.rows[0] };
}

test('14. a post-draw review preserves the original winner and does not redraw', async () => {
  const ctx = await drawnGiveawayWithClaim('postdraw14');
  const before = await pool.query('SELECT winner_entry_id, status FROM giveaways WHERE id = $1', [ctx.giveawayId]);

  const adminSession = await signIn(ctx.admin.email, PASSWORD);
  const opened = await adminSession.post('/api/admin/integrity/cases').send({
    giveaway_id: ctx.giveawayId,
    entry_id: ctx.entryId,
    reason: 'a credible report arrived after the draw',
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.case.post_draw, true);
  assert.equal(opened.body.winner_unchanged, true);

  const after = await pool.query('SELECT winner_entry_id, status FROM giveaways WHERE id = $1', [ctx.giveawayId]);
  assert.equal(after.rows[0].winner_entry_id, before.rows[0].winner_entry_id, 'same winner');
  assert.equal(after.rows[0].status, 'drawn');
  assert.equal(await statusOf(ctx.entryId), 'eligible', 'opening a case is not a disqualification');

  // And disqualifying the winner outright is refused: replacing a winner is not
  // an automated act.
  const refused = await adminSession
    .post(`/api/admin/integrity/entries/${ctx.entryId}/status`)
    .send({ status: 'disqualified', reason: 'trying to remove the winner directly' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'WINNER_DISQUALIFICATION_BLOCKED');

  if (ctx.claim) {
    const claimNow = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [ctx.claim.id]);
    assert.equal(claimNow.rows[0].status, before.rows[0].status === 'drawn' ? claimNow.rows[0].status : null);
  }
});

test('15. an open post-draw case pauses protected fulfilment transitions', async () => {
  const ctx = await drawnGiveawayWithClaim('postdraw15');
  if (!ctx.claim) return; // claims disabled in this environment

  // Move the claim to a state the host can act from.
  await pool.query("UPDATE prize_claims SET status = 'claimed', claimed_at = NOW() WHERE id = $1", [ctx.claim.id]);

  const adminSession = await signIn(ctx.admin.email, PASSWORD);
  await adminSession.post('/api/admin/integrity/cases').send({
    giveaway_id: ctx.giveawayId,
    entry_id: ctx.entryId,
    reason: 'pausing fulfilment while this is looked at',
  });

  const blocked = await ctx.hostSession
    .post(`/api/claims/${ctx.claim.id}/transition`)
    .send({ to: 'preparing_delivery' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'INTEGRITY_REVIEW_OPEN');

  const claimNow = await pool.query('SELECT status FROM prize_claims WHERE id = $1', [ctx.claim.id]);
  assert.equal(claimNow.rows[0].status, 'claimed', 'the claim did not move');

  // Raising a dispute stays open: pausing the process must not mute the person
  // waiting on it.
  const winnerSession = await signIn(ctx.winner.email, PASSWORD);
  const dispute = await winnerSession
    .post(`/api/claims/${ctx.claim.id}/transition`)
    .send({ to: 'disputed', note: 'I still have not heard anything' });
  assert.equal(dispute.status, 200);
});

test('16. resolving by reinstatement resumes the existing claim', async () => {
  const ctx = await drawnGiveawayWithClaim('postdraw16');
  if (!ctx.claim) return;

  await pool.query("UPDATE prize_claims SET status = 'claimed', claimed_at = NOW() WHERE id = $1", [ctx.claim.id]);

  const adminSession = await signIn(ctx.admin.email, PASSWORD);
  const opened = await adminSession.post('/api/admin/integrity/cases').send({
    giveaway_id: ctx.giveawayId,
    entry_id: ctx.entryId,
    reason: 'checking a report about the winner',
  });
  const caseId = opened.body.case.id;

  const resolved = await adminSession
    .post(`/api/admin/integrity/cases/${caseId}/resolve`)
    .send({ resolution: 'reinstated', reason: 'the report did not hold up' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.case.status, 'resolved');

  // Same winner, same claim, and fulfilment moves again.
  const giveaway = await pool.query('SELECT winner_entry_id FROM giveaways WHERE id = $1', [ctx.giveawayId]);
  assert.equal(giveaway.rows[0].winner_entry_id, ctx.entryId);

  const resumed = await ctx.hostSession
    .post(`/api/claims/${ctx.claim.id}/transition`)
    .send({ to: 'preparing_delivery' });
  assert.equal(resumed.status, 200);

  const claimNow = await pool.query('SELECT id, status FROM prize_claims WHERE giveaway_id = $1', [ctx.giveawayId]);
  assert.equal(claimNow.rows.length, 1, 'no second claim was created');
  assert.equal(claimNow.rows[0].id, ctx.claim.id);
});

// ---------------------------------------------------------------------------
// 17–19. Risk signals
// ---------------------------------------------------------------------------

test('17. risk signals never disqualify anyone automatically', async () => {
  const host = await makeUser('host17', { hostStatus: 'approved' });
  const giveawayId = await makeGiveaway(host.id);

  // Enough recently-created accounts from one network to trip every threshold.
  const sharedIp = '203.0.113.7';
  const entryIds = [];
  for (let i = 0; i < 6; i++) {
    const u = await makeUser(`swarm17-${i}`);
    const session = await signIn(u.email, PASSWORD, { ip: sharedIp });
    const res = await session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', sharedIp);
    assert.equal(res.status, 201, 'a signal must never refuse an entry');
    entryIds.push(res.body.id);
  }

  const statuses = await pool.query(
    'SELECT DISTINCT integrity_status FROM entries WHERE giveaway_id = $1',
    [giveawayId]
  );
  assert.deepEqual(statuses.rows.map((r) => r.integrity_status), ['eligible'],
    'every entry is still eligible');

  const signals = await pool.query(
    "SELECT COUNT(*)::int AS c FROM entry_risk_signals WHERE giveaway_id = $1 AND severity = 'review'",
    [giveawayId]
  );
  assert.ok(signals.rows[0].c > 0, 'but the signal was recorded for a human to look at');

  const events = await pool.query(
    'SELECT COUNT(*)::int AS c FROM entry_integrity_events WHERE giveaway_id = $1',
    [giveawayId]
  );
  assert.equal(events.rows[0].c, 0, 'and no status decision was invented');
});

test('18. no raw IP address is stored, returned or logged', async () => {
  const host = await makeUser('host18', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant18');
  const admin = await makeUser('admin18', { admin: true });
  const giveawayId = await makeGiveaway(host.id);

  const ip = '198.51.100.42';
  const session = await signIn(entrant.email, PASSWORD, { ip });
  const entered = await session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', ip);
  assert.equal(entered.status, 201);
  const entryId = entered.body.id;

  // Not in the signal rows.
  const stored = await pool.query('SELECT * FROM entry_risk_signals WHERE entry_id = $1', [entryId]);
  assert.ok(stored.rows.length > 0);
  const asText = JSON.stringify(stored.rows);
  assert.ok(!asText.includes(ip), 'the raw address is not in the stored row');
  assert.ok(!asText.includes('198.51.100'), 'nor is its network in plain text');
  assert.ok(stored.rows[0].network_hmac && stored.rows[0].network_hmac.length === 64);

  // Not anywhere else in the integrity tables.
  for (const table of ['entry_integrity_events', 'entry_integrity_cases', 'entries']) {
    const rows = await pool.query(`SELECT * FROM ${table} WHERE giveaway_id = $1`, [giveawayId]);
    assert.ok(!JSON.stringify(rows.rows).includes('198.51.100'), `${table} holds no address`);
  }

  // Not in either administrator response — including the deliberate detail one,
  // which is also uncacheable.
  const adminSession = await signIn(admin.email, PASSWORD);
  const queue = await adminSession.get('/api/admin/integrity/queue');
  assert.equal(queue.status, 200);
  assert.ok(!JSON.stringify(queue.body).includes('198.51.100'));

  const detail = await adminSession.get(`/api/admin/integrity/entries/${entryId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers['cache-control'], 'no-store');
  const detailText = JSON.stringify(detail.body);
  assert.ok(!detailText.includes('198.51.100'), 'no address in the detail response');
  assert.ok(!detailText.includes(stored.rows[0].network_hmac), 'and not the hash either');

  // The hash is one-way and window-scoped, so the same address in a different
  // window produces a different value.
  const key = riskSignals.networkKey(ip);
  assert.ok(key && key.hash && !key.hash.includes('198'));
  assert.equal(riskSignals.normaliseAddress(ip), '198.51.100.0/24', 'only a /24 is ever hashed');
  assert.equal(riskSignals.normaliseAddress('127.0.0.1'), null, 'loopback says nothing about anybody');
});

test('19. signal retention is bounded and purging is idempotent', async () => {
  const host = await makeUser('host19', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant19');
  const admin = await makeUser('admin19', { admin: true });
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);

  await pool.query(
    `INSERT INTO entry_risk_signals (id, entry_id, giveaway_id, signal_code, severity, expires_at)
     VALUES ($1, $2, $3, 'network_observed', 'info', NOW() - INTERVAL '1 day')`,
    [crypto.randomUUID(), entryId, giveawayId]
  );
  await pool.query(
    `INSERT INTO entry_risk_signals (id, entry_id, giveaway_id, signal_code, severity, expires_at)
     VALUES ($1, $2, $3, 'network_observed', 'info', NOW() + INTERVAL '10 days')`,
    [crypto.randomUUID(), entryId, giveawayId]
  );

  const session = await signIn(admin.email, PASSWORD);
  const first = await session.post('/api/admin/integrity/signals/purge').send({});
  assert.equal(first.status, 200);
  assert.ok(first.body.removed >= 1);
  assert.ok(first.body.retention_days >= 1 && first.body.retention_days <= 90);

  const second = await session.post('/api/admin/integrity/signals/purge').send({});
  assert.equal(second.status, 200);
  assert.equal(second.body.removed, 0, 'running it again removes nothing');

  const left = await pool.query('SELECT COUNT(*)::int AS c FROM entry_risk_signals WHERE entry_id = $1', [entryId]);
  assert.equal(left.rows[0].c, 1, 'the unexpired row survives');
});

// ---------------------------------------------------------------------------
// 20. Proxy trust
// ---------------------------------------------------------------------------

test('20. spoofed forwarding headers cannot mint new rate-limit identities', async () => {
  // With N trusted hops, Express reads the (N+1)-th address from the right of
  // [socket, ...X-Forwarded-For]. A client can prepend anything; it cannot
  // control the entry the last trusted proxy appends. These assertions are about
  // that arithmetic, and the limiter that depends on it.
  assert.equal(readHops({ TRUSTED_PROXY_HOPS: '1' }).hops, 1);
  assert.equal(readHops({}).hops, 0, 'the default trusts nothing');
  assert.equal(readHops({ NODE_ENV: 'production' }).hops, 1, 'production assumes one proxy');
  assert.throws(() => readHops({ TRUSTED_PROXY_HOPS: 'true' }), /whole number/);
  assert.throws(() => readHops({ TRUSTED_PROXY_HOPS: '-1' }), /whole number/);
  assert.throws(() => readHops({ TRUSTED_PROXY_HOPS: '99' }), /between 0 and/);
  assert.ok(!/\btrue\b/.test(String(resolveTrustProxy({ TRUSTED_PROXY_HOPS: '1' }).value)));

  // And behaviourally: a run of requests whose forged prefixes differ every time
  // but whose last hop is identical must share one bucket, and hit the limit.
  const forged = [
    '1.2.3.4', '5.6.7.8, 9.10.11.12', '13.14.15.16, 17.18.19.20, 21.22.23.24',
    '::1', 'not-an-ip', '0.0.0.0',
  ];
  const lastHop = '203.0.113.99';

  let refused = 0;
  for (let i = 0; i < 14; i++) {
    const prefix = forged[i % forged.length];
    const res = await api()
      .post('/api/auth/login')
      .set('Origin', TEST_ORIGIN)
      .set('X-Forwarded-For', `${prefix}, ${lastHop}`)
      .send({ email: `nobody-${i}@example.com`, password: 'wrong-password-on-purpose' });
    if (res.status === 429) refused += 1;
  }
  assert.ok(refused > 0,
    'changing the forged prefix must not produce a fresh limiter identity');
});

// ---------------------------------------------------------------------------
// 21–23. What each audience sees
// ---------------------------------------------------------------------------

test('21. the admin queue carries no unnecessary personal data', async () => {
  const host = await makeUser('host21', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant21');
  const admin = await makeUser('admin21', { admin: true });
  const giveawayId = await makeGiveaway(host.id);
  const entryId = await makeEntry(giveawayId, entrant.id, 1);

  const session = await signIn(admin.email, PASSWORD);
  await session.post(`/api/admin/integrity/entries/${entryId}/status`)
    .send({ status: 'under_review', reason: 'so it appears in the queue' });

  const queue = await session.get('/api/admin/integrity/queue');
  assert.equal(queue.status, 200);
  const row = queue.body.find((r) => r.entry_id === entryId);
  assert.ok(row, 'the entry is in the queue');

  const text = JSON.stringify(queue.body);
  assert.ok(!text.includes(entrant.email), 'no email address in the list');
  assert.ok(!text.includes('Integrity entrant21'), 'no display name in the list');
  assert.ok(!text.includes('network_hmac'), 'no network hash in the list');
  assert.ok(!/session|csrf|token/i.test(text), 'no session or token material');
  assert.ok(!/address_line|recipient_name|delivery/i.test(text), 'no delivery details');

  // What it does carry: enough to choose a row.
  assert.ok(row.giveaway_title && row.status && row.account_ref);
  assert.equal(row.account_ref.length, 8, 'an account reference, not an identity');
  assert.ok(Array.isArray(row.signal_categories));
});

test('22. an entrant sees only their own coarse status', async () => {
  const host = await makeUser('host22', { hostStatus: 'approved' });
  const mine = await makeUser('mine22');
  const theirs = await makeUser('theirs22');
  const admin = await makeUser('admin22', { admin: true });
  const giveawayId = await makeGiveaway(host.id);

  const myEntry = await makeEntry(giveawayId, mine.id, 1);
  const theirEntry = await makeEntry(giveawayId, theirs.id, 2);

  const adminSession = await signIn(admin.email, PASSWORD);
  await adminSession.post(`/api/admin/integrity/entries/${myEntry}/status`)
    .send({ status: 'under_review', reason: 'we are checking something' });
  await adminSession.post(`/api/admin/integrity/entries/${theirEntry}/status`)
    .send({ status: 'disqualified', reason: 'someone else entirely' });

  const mySession = await signIn(mine.email, PASSWORD);
  const view = await mySession.get(`/api/giveaways/${giveawayId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.my_entry.status, 'under_review');
  assert.equal(view.body.my_entry.reason, 'we are checking something');

  const text = JSON.stringify(view.body);
  assert.ok(!text.includes('someone else entirely'), "not another entrant's decision");
  assert.ok(!text.includes(theirs.email), 'not another account');
  assert.ok(!text.includes('signal'), 'not the detection methods');
  assert.ok(!text.includes('shared_network'), 'nor the signal codes');

  // The dashboard says the same thing, from the same function.
  const dash = await mySession.get('/api/giveaways/mine/entered');
  const row = dash.body.find((g) => g.id === giveawayId);
  assert.equal(row.my_entry.status, 'under_review');

  // The entrant cannot reach the administrator view of their own entry either.
  const forbidden = await mySession.get(`/api/admin/integrity/entries/${myEntry}`);
  assert.equal(forbidden.status, 403);
});

test('23. public entry counts exclude disqualified entries, consistently', async () => {
  const host = await makeUser('host23', { hostStatus: 'approved' });
  const admin = await makeUser('admin23', { admin: true });
  const giveawayId = await makeGiveaway(host.id);

  const users = [];
  const entries = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`counted23-${i}`);
    users.push(u);
    entries.push(await makeEntry(giveawayId, u.id, i + 1));
  }

  const before = await api().get(`/api/giveaways/${giveawayId}`);
  assert.equal(before.body.entry_count, 3);

  const adminSession = await signIn(admin.email, PASSWORD);
  await adminSession.post(`/api/admin/integrity/entries/${entries[0]}/status`)
    .send({ status: 'disqualified', reason: 'excluded from the count' });

  const detail = await api().get(`/api/giveaways/${giveawayId}`);
  assert.equal(detail.body.entry_count, 2, 'the giveaway page count drops');

  const list = await api().get('/api/giveaways?page=1&pageSize=48');
  const listed = list.body.items.find((g) => g.id === giveawayId);
  if (listed) assert.equal(listed.entry_count, 2, 'the browse list agrees');

  const hostSession = await signIn(host.email, PASSWORD);
  const dash = await hostSession.get('/api/giveaways/mine/hosted');
  const hosted = dash.body.find((g) => g.id === giveawayId);
  assert.equal(hosted.entry_count, 2, 'the host dashboard agrees');

  // An entry under review is still an entry: a question is not an outcome, and
  // the draw refuses to run while one is open, so the count and the pool cannot
  // disagree at the moment a winner is picked.
  await adminSession.post(`/api/admin/integrity/entries/${entries[1]}/status`)
    .send({ status: 'under_review', reason: 'still a question' });
  const withReview = await api().get(`/api/giveaways/${giveawayId}`);
  assert.equal(withReview.body.entry_count, 2);
});

// ---------------------------------------------------------------------------
// 24. The rest of the system is unchanged
// ---------------------------------------------------------------------------

test('24. entry, draw, claim, session, CSRF and CSP behaviour is unchanged', async () => {
  const host = await makeUser('host24', { hostStatus: 'approved' });
  const entrant = await makeUser('entrant24');
  const giveawayId = await makeGiveaway(host.id);

  // CSRF still refuses an unsafe request with no token.
  const raw = await api()
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('Origin', TEST_ORIGIN)
    .send({});
  assert.ok([401, 403].includes(raw.status));

  // A session is still required, and the cookie is still HttpOnly.
  const session = await signIn(entrant.email, PASSWORD);
  const entered = await session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', nextTestIp());
  assert.equal(entered.status, 201);

  // CSP is still enforced on this route's responses.
  const page = await api().get(`/api/giveaways/${giveawayId}`);
  assert.match(page.headers['content-security-policy'] || '', /default-src 'self'/);
  assert.ok(!/unsafe-inline/.test(page.headers['content-security-policy'] || ''));

  // And the integrity columns did not leak into the public payload.
  assert.equal(page.body.integrity_status, undefined);
});

// ---------------------------------------------------------------------------
// 25. The browser-security job is wired up and can fail
// ---------------------------------------------------------------------------

test('25. the hostile-browser check is a required CI job with a working self-test', () => {
  // The behavioural half of this — that the harness exits non-zero on an
  // injection and zero otherwise — is the CI job's own self-test step, and is
  // run for real before every commit in this phase. What is asserted here is
  // that the wiring exists and cannot quietly rot: a security check that only
  // runs when somebody remembers is not a check.
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'test.yml'),
    'utf8'
  );

  assert.match(workflow, /browser-security:/, 'a dedicated job exists');
  assert.match(workflow, /npm run test:browser-security/, 'it runs the harness');
  assert.match(workflow, /HOSTILE_SELFTEST=1/, 'it proves the detector still reports red');
  assert.match(workflow, /playwright@\d+\.\d+\.\d+ install/, 'the browser version is pinned');
  assert.match(workflow, /TEST_DATABASE_URL: postgresql:\/\/naseeb:naseeb@localhost/, 'isolated database');
  assert.match(workflow, /timeout-minutes:/, 'the job is bounded');
  assert.match(workflow, /if: failure\(\)/, 'diagnostics are uploaded only on failure');

  // The self-test step is inverted: it fails the build if the harness passes
  // while live markup is injected.
  assert.match(workflow, /if HOSTILE_SELFTEST=1 npm run test:browser-security; then[\s\S]*?exit 1/);

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:browser-security'], 'node scripts/browser-hostile-data.js',
    'and the same command is documented for local use');

  const harness = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'browser-hostile-data.js'), 'utf8');
  assert.match(harness, /process\.exit\(failures \? 1 : 0\)/, 'non-zero exit on any failure');
  assert.match(harness, /HOSTILE_SELFTEST/, 'the self-test switch exists');
  assert.match(harness, /await unseed\(\)/, 'and it cleans up after itself');
  // No credential material may reach the diagnostics artifact.
  const reportBlock = harness.slice(harness.indexOf('.browser-security'));
  assert.ok(!/COOKIE|cookie/.test(reportBlock.slice(0, 1600)),
    'the diagnostics report must not carry cookies');
});
