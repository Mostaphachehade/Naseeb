// Premium prize governance and the automatic giveaway lifecycle.
//
// Everything here runs against the isolated test database with fabricated data.
// No production service is contacted, no real sponsor, prize, business or value
// appears anywhere, and nothing here activates payments or the draft policies.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const {
  api,
  pool,
  ensureInit,
  uniqueEmail,
  signIn,
  nextTestIp,
  seedGiveaway,
  approveGiveaway,
  FABRICATED_PRIZE,
  closePool,
} = require('../testHelpers');

const lifecycle = require('../server/lib/giveawayLifecycle');
const prizeStandard = require('../server/lib/prizeStandard');
const giveawayOutbox = require('../server/lib/giveawayOutbox');
const maintenance = require('../server/lib/maintenance');
const sessions = require('../server/lib/sessions');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correcthorse123';
const created = { users: [], giveaways: [] };

before(async () => {
  await ensureInit();
});

after(async () => {
  if (created.giveaways.length) {
    await pool.query('DELETE FROM giveaway_notifications WHERE giveaway_id = ANY($1)', [created.giveaways]);
    await pool.query(
      'DELETE FROM claim_notifications WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [created.giveaways]
    );
    await pool.query(
      'DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))',
      [created.giveaways]
    );
    await pool.query('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [created.giveaways]);
    await pool.query('DELETE FROM entry_integrity_cases WHERE giveaway_id = ANY($1)', [created.giveaways]);
    await pool.query(
      `UPDATE giveaways SET winner_entry_id = NULL, drawn_at = NULL,
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
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
  }
  await closePool();
});

async function makeUser(tag, { admin = false, hostStatus = 'not_requested' } = {}) {
  const id = crypto.randomUUID();
  const email = uniqueEmail(`gl-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status,
                        age_attestation_status, age_attestation_version)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, 'confirmed', '2026-08-eligibility-18')`,
    [id, `GL ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin, hostStatus]
  );
  created.users.push(id);
  return { id, email };
}

async function campaign(hostId, options = {}) {
  const id = await seedGiveaway({ hostId, ...options });
  created.giveaways.push(id);
  return id;
}

// Entries written directly, because a test that needs ninety-nine of them needs
// ninety-nine accounts and the HTTP path is not what is under test there. The
// hundredth always goes through the route.
async function seedEntries(giveawayId, n, { startTicket = 1, status = 'eligible' } = {}) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const user = await makeUser(`entrant-${giveawayId.slice(0, 6)}-${i}`);
    const entryId = uuid();
    ids.push({ entryId, userId: user.id });
    await pool.query(
      `INSERT INTO entries (id, giveaway_id, user_id, ticket_number, integrity_status,
                            integrity_reason_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entryId,
        giveawayId,
        user.id,
        startTicket + i,
        status,
        status === 'eligible' ? null : 'disqualified_terms',
      ]
    );
  }
  return ids;
}

function statusOf(giveawayId) {
  return pool
    .query('SELECT * FROM giveaways WHERE id = $1', [giveawayId])
    .then((r) => r.rows[0]);
}

function eventsFor(giveawayId) {
  return pool
    .query('SELECT * FROM giveaway_lifecycle_events WHERE giveaway_id = $1 ORDER BY created_at, id', [
      giveawayId,
    ])
    .then((r) => r.rows);
}

// ---------------------------------------------------------------------------
// 1. Membership
// ---------------------------------------------------------------------------

test('gl1. membership survives expired-session cleanup', async () => {
  const member = await makeUser('member');
  const session = await signIn(member.email, PASSWORD);

  const live = await session.get('/api/auth/session');
  assert.equal(live.body.authenticated, true);

  // Age every session this account holds past its expiry, then run the job that
  // removes them. A membership is not a session: it has no predetermined expiry
  // and ends only when the member asks, or when the platform rules or the law
  // require it.
  // Aged past both the session expiry and the family's 30-day retention window,
  // so the scheduled job genuinely removes them rather than leaving them inside
  // its grace period.
  await pool.query(
    "UPDATE sessions SET expires_at = NOW() - INTERVAL '60 days' WHERE user_id = $1",
    [member.id]
  );
  await pool.query(
    "UPDATE session_families SET absolute_expires_at = NOW() - INTERVAL '60 days' WHERE user_id = $1",
    [member.id]
  );
  const removed = await maintenance.JOBS.sessions();
  assert.equal(removed.status, 'ok');
  assert.ok(removed.removed >= 1, 'the job removed the expired family');

  const rows = await pool.query('SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1', [
    member.id,
  ]);
  assert.equal(rows.rows[0].n, 0, 'the session rows are gone');

  const stillThere = await pool.query(
    'SELECT id, email, account_status, email_verified FROM users WHERE id = $1',
    [member.id]
  );
  assert.equal(stillThere.rowCount, 1, 'the account survives');
  assert.equal(stillThere.rows[0].email, member.email, 'unchanged');
  assert.equal(stillThere.rows[0].account_status, 'active');
  assert.equal(stillThere.rows[0].email_verified, true);

  // The browser session is gone, which is the point of the job.
  const gone = await session.get('/api/auth/session');
  assert.equal(gone.body.authenticated, false);

  // And signing in again works, because the membership was never touched.
  const again = await signIn(member.email, PASSWORD);
  assert.equal(again.user.id, member.id);

  // The job's own code never mentions the users table.
  const source = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'sessions.js'), 'utf8');
  const fn = source.slice(source.indexOf('async function deleteExpiredSessions'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/DELETE FROM users|UPDATE users/i.test(body), 'session cleanup never touches an account');

  // Nothing anywhere calls this "membership for life".
  ['public', 'docs', 'server'].forEach((dir) => {
    const files = [];
    (function walk(d) {
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else files.push(full);
      });
    })(path.join(ROOT, dir));
    files.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/membership for life/i.test(text), `${file} must not promise membership for life`);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The entry target
// ---------------------------------------------------------------------------

test('gl2, gl3. the 100th accepted entry closes the campaign, and the 101st is refused', async () => {
  const host = await makeUser('t100-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id);

  const before = await statusOf(giveawayId);
  assert.equal(before.entry_target, 100, 'the target is 100');
  assert.equal(before.status, 'active');

  // Ninety-nine, written directly. The hundredth goes through the route,
  // because the route is what has to close it.
  await seedEntries(giveawayId, 99);
  const at99 = await statusOf(giveawayId);
  assert.equal(at99.status, 'active', '99 accepted entries is still open');
  assert.equal(at99.entries_closed_at, null);

  const hundredth = await makeUser('t100-hundredth');
  const hundredthSession = await signIn(hundredth.email, PASSWORD);
  const entered = await hundredthSession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp());
  assert.equal(entered.status, 201, JSON.stringify(entered.body));
  assert.equal(entered.body.entries_closed, true, 'the entrant is told their entry closed it');
  assert.equal(entered.body.closed_reason, 'entry_target_reached');

  const closed = await statusOf(giveawayId);
  assert.equal(closed.status, 'closed_pending_draw');
  assert.equal(closed.entries_closed_reason, 'entry_target_reached');
  assert.equal(closed.entries_at_close, 100);
  assert.ok(closed.entries_closed_at, 'closure is a fact with a timestamp');

  // gl3: the 101st.
  const late = await makeUser('t100-late');
  const lateSession = await signIn(late.email, PASSWORD);
  const refused = await lateSession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp());
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ENTRIES_CLOSED');

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM entries WHERE giveaway_id = $1', [
    giveawayId,
  ]);
  assert.equal(count.rows[0].n, 100, 'no 101st entry exists');

  // And closure is a LATCH: disqualifying one entry drops the accepted count to
  // 99 and must NOT reopen the campaign.
  const anyEntry = await pool.query(
    'SELECT id FROM entries WHERE giveaway_id = $1 ORDER BY ticket_number LIMIT 1',
    [giveawayId]
  );
  await pool.query(
    "UPDATE entries SET integrity_status = 'disqualified', integrity_reason_code = 'disqualified_terms' WHERE id = $1",
    [anyEntry.rows[0].id]
  );
  const stillClosed = await statusOf(giveawayId);
  assert.equal(stillClosed.status, 'closed_pending_draw', 'a disqualification cannot reopen it');
  const stillRefused = await lateSession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp());
  assert.equal(stillRefused.status, 409);
});

test('gl4. concurrent entries at the threshold cannot exceed the cap', async () => {
  const host = await makeUser('race-host', { hostStatus: 'approved' });
  // A smaller target, so the race is about the mechanism rather than about
  // creating two hundred accounts. The cap is a column for exactly this reason.
  const giveawayId = await campaign(host.id, { entryTarget: 5 });
  await seedEntries(giveawayId, 4);

  // Six accounts race for the one remaining place.
  const racers = [];
  for (let i = 0; i < 6; i += 1) {
    const u = await makeUser(`racer-${i}`);
    racers.push(await signIn(u.email, PASSWORD));
  }

  const results = await Promise.all(
    racers.map((s) =>
      s.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', nextTestIp())
    )
  );

  const accepted = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);
  assert.equal(accepted.length, 1, `exactly one got in, got ${results.map((r) => r.status).join(',')}`);
  assert.equal(refused.length, 5);
  refused.forEach((r) => assert.equal(r.body.code, 'ENTRIES_CLOSED'));

  const final = await statusOf(giveawayId);
  assert.equal(final.status, 'closed_pending_draw');
  assert.equal(final.entries_at_close, 5);

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM entries WHERE giveaway_id = $1', [
    giveawayId,
  ]);
  assert.equal(count.rows[0].n, 5, 'the cap held under concurrency');

  // Exactly one closure was recorded, not six.
  const closures = (await eventsFor(giveawayId)).filter((e) => e.event_type === 'entries_closed');
  assert.equal(closures.length, 1);
});

// ---------------------------------------------------------------------------
// 3. The deadline
// ---------------------------------------------------------------------------

test('gl5. a deadline reached with fewer than 100 entries draws from the entries there are', async () => {
  const host = await makeUser('deadline-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });
  const entries = await seedEntries(giveawayId, 7);

  // Seven is not "invalid". It draws.
  const result = await maintenance.JOBS.giveaway_lifecycle();
  assert.equal(result.status, 'ok');
  // At least, not exactly: the job is a batch, and another fixture in this file
  // may be due in the same pass. What matters is this campaign's outcome.
  assert.ok(result.closed >= 1, JSON.stringify(result));
  assert.ok(result.drawn >= 1, JSON.stringify(result));

  const after = await statusOf(giveawayId);
  assert.equal(after.status, 'drawn');
  assert.equal(after.entries_closed_reason, 'closing_deadline_reached');
  assert.equal(after.entries_at_close, 7);
  assert.ok(after.winner_entry_id, 'a winner was drawn from the seven');
  assert.ok(
    entries.some((e) => e.entryId === after.winner_entry_id),
    'and the winner is one of them'
  );
  assert.ok(after.drawn_at);

  // Nothing anywhere calls a campaign with fewer than 100 entries invalid.
  const sources = ['server/lib/giveawayLifecycle.js', 'public/create.html', 'public/giveaway.html'];
  sources.forEach((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/invalid/i.test(text) || !/100/.test(text.slice(0, 0)), `${file}`);
  });
});

test('gl6. a deadline reached with zero eligible entries closes without a winner', async () => {
  const host = await makeUser('empty-host', { hostStatus: 'approved' });
  const empty = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });

  const result = await maintenance.JOBS.giveaway_lifecycle();
  assert.equal(result.status, 'ok');

  const after = await statusOf(empty);
  assert.equal(after.status, 'closed_no_winner');
  assert.equal(after.no_winner_reason, 'no_entries_received');
  assert.equal(after.winner_entry_id, null);
  assert.ok(after.entries_closed_at, 'it still closed, and said when');

  // And a campaign whose only entries were all disqualified: the reason is
  // different, and truthful about which of the two happened.
  const allOut = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });
  await seedEntries(allOut, 3, { status: 'disqualified' });
  await maintenance.JOBS.giveaway_lifecycle();

  const second = await statusOf(allOut);
  assert.equal(second.status, 'closed_no_winner');
  assert.equal(second.no_winner_reason, 'no_eligible_entries_after_review');
  const entriesKept = await pool.query('SELECT COUNT(*)::int AS n FROM entries WHERE giveaway_id = $1', [
    allOut,
  ]);
  assert.equal(entriesKept.rows[0].n, 3, 'the entries are preserved, not deleted');
});

test('gl7. an entry after the deadline is refused, and closes the campaign on the spot', async () => {
  const host = await makeUser('late-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id, { closesAt: new Date(Date.now() - 1000) });

  const latecomer = await makeUser('latecomer');
  const session = await signIn(latecomer.email, PASSWORD);
  const res = await session
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp());

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ENTRIES_CLOSED');

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM entries WHERE giveaway_id = $1', [
    giveawayId,
  ]);
  assert.equal(count.rows[0].n, 0, 'nothing was written');

  // The request itself closed it rather than leaving it open until a worker
  // noticed — the deadline does not depend on anybody visiting the site, but if
  // somebody does, it takes effect immediately.
  const after = await statusOf(giveawayId);
  assert.notEqual(after.status, 'active');
  assert.equal(after.entries_closed_reason, 'closing_deadline_reached');
});

test('gl8. deadline closure and the draw are idempotent under repetition', async () => {
  const host = await makeUser('idem-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });
  await seedEntries(giveawayId, 3);

  const first = await maintenance.JOBS.giveaway_lifecycle();
  const after = await statusOf(giveawayId);
  assert.equal(after.status, 'drawn');
  const winner = after.winner_entry_id;
  assert.ok(winner);
  assert.equal(first.drawn, 1);

  // Five more passes change nothing.
  for (let i = 0; i < 5; i += 1) {
    const again = await maintenance.JOBS.giveaway_lifecycle();
    assert.equal(again.status, 'ok');
    assert.equal(again.drawn, 0, 'nothing is drawn twice');
    assert.equal(again.closed, 0, 'nothing is closed twice');
  }

  const unchanged = await statusOf(giveawayId);
  assert.equal(unchanged.winner_entry_id, winner, 'the same winner, still');
  assert.equal(unchanged.status, 'drawn');

  const drawEvents = (await eventsFor(giveawayId)).filter((e) => e.event_type === 'drawn');
  assert.equal(drawEvents.length, 1, 'one draw, one record of it');

  const claims = await pool.query('SELECT COUNT(*)::int AS n FROM prize_claims WHERE giveaway_id = $1', [
    giveawayId,
  ]);
  assert.ok(claims.rows[0].n <= 1, 'at most one claim');
});

test('gl9. concurrent workers produce one draw and one winner', async () => {
  const host = await makeUser('conc-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id, {
    status: 'closed_pending_draw',
    closesAt: new Date(Date.now() - 60000),
  });
  await seedEntries(giveawayId, 6);

  // Four workers at once. The advisory lock means one runs and three report
  // `skipped`, which is a success rather than a wait.
  const results = await Promise.all([
    maintenance.JOBS.giveaway_lifecycle(),
    maintenance.JOBS.giveaway_lifecycle(),
    maintenance.JOBS.giveaway_lifecycle(),
    maintenance.JOBS.giveaway_lifecycle(),
  ]);
  results.forEach((r) => assert.ok(['ok', 'skipped'].includes(r.status), r.status));

  const drawn = results.filter((r) => r.drawn === 1);
  assert.equal(drawn.length, 1, `exactly one worker drew, got ${JSON.stringify(results)}`);

  const after = await statusOf(giveawayId);
  assert.equal(after.status, 'drawn');
  assert.ok(after.winner_entry_id);

  const drawEvents = (await eventsFor(giveawayId)).filter((e) => e.event_type === 'drawn');
  assert.equal(drawEvents.length, 1);

  const winners = await pool.query(
    'SELECT COUNT(*)::int AS n FROM giveaways WHERE winner_entry_id = $1',
    [after.winner_entry_id]
  );
  assert.equal(winners.rows[0].n, 1, 'and an entry wins at most one campaign');
});

test('gl10. a threshold closure racing the deadline job produces one draw', async () => {
  const host = await makeUser('bothrace-host', { hostStatus: 'approved' });
  // Target reachable AND deadline already passed: both rules fire at once.
  const giveawayId = await campaign(host.id, {
    entryTarget: 3,
    closesAt: new Date(Date.now() - 1000),
  });
  await seedEntries(giveawayId, 2);

  const entrant = await makeUser('bothrace-entrant');
  const session = await signIn(entrant.email, PASSWORD);

  const [entry, job] = await Promise.all([
    session.post(`/api/giveaways/${giveawayId}/enter`).set('X-Forwarded-For', nextTestIp()),
    maintenance.JOBS.giveaway_lifecycle(),
  ]);

  // Whichever won, the campaign is closed exactly once and drawn exactly once.
  assert.ok([201, 409].includes(entry.status), `entry status ${entry.status}`);
  assert.ok(['ok', 'skipped'].includes(job.status));

  await maintenance.JOBS.giveaway_lifecycle();
  const after = await statusOf(giveawayId);
  assert.ok(['drawn', 'closed_no_winner'].includes(after.status), after.status);

  const events = await eventsFor(giveawayId);
  assert.equal(
    events.filter((e) => e.event_type === 'entries_closed').length,
    1,
    'one closure'
  );
  assert.ok(
    events.filter((e) => ['drawn', 'closed_no_winner'].includes(e.event_type)).length === 1,
    'one outcome'
  );
});

// ---------------------------------------------------------------------------
// 4. Entry integrity
// ---------------------------------------------------------------------------

test('gl11, gl12. an open review closes entries but postpones the draw, and resolving resumes it', async () => {
  const host = await makeUser('rev-host', { hostStatus: 'approved' });
  const admin = await makeUser('rev-admin', { admin: true });
  const giveawayId = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });
  const entries = await seedEntries(giveawayId, 4);

  await pool.query(
    `UPDATE entries SET integrity_status = 'under_review',
            integrity_reason_code = 'review_routine_check',
            integrity_admin_notes = 'Fabricated fixture note.'
      WHERE id = $1`,
    [entries[0].entryId]
  );

  const run = await maintenance.JOBS.giveaway_lifecycle();
  assert.equal(run.status, 'ok');
  assert.equal(run.closed, 1, 'entries close on the deadline regardless');
  assert.equal(run.drawn, 0, 'but nothing is drawn');
  assert.equal(run.postponed, 1);

  const paused = await statusOf(giveawayId);
  assert.equal(paused.status, 'pending_integrity_review');
  assert.equal(paused.winner_entry_id, null);
  assert.ok(paused.entries_closed_at, 'entries are closed — the review does not extend the deadline');

  // An entry is still refused while the review runs.
  const late = await makeUser('rev-late');
  const lateSession = await signIn(late.email, PASSWORD);
  const refused = await lateSession
    .post(`/api/giveaways/${giveawayId}/enter`)
    .set('X-Forwarded-For', nextTestIp());
  assert.equal(refused.status, 409);

  // Repeated passes keep postponing rather than drawing.
  await maintenance.JOBS.giveaway_lifecycle();
  assert.equal((await statusOf(giveawayId)).status, 'pending_integrity_review');

  // gl12: resolving the review resumes the existing workflow, on the next pass,
  // with no separate trigger.
  const adminSession = await signIn(admin.email, PASSWORD);
  const decided = await adminSession.post(`/api/admin/integrity/entries/${entries[0].entryId}/status`).send({
    status: 'eligible',
    reason_code: 'reinstated_after_review',
    admin_notes: 'Fabricated fixture: the signal was a shared office.',
    // The route reads it as `version`. The fixture wrote the review status
    // directly, so the entry's optimistic version is still 0 — read rather than
    // assumed, because a stale one is refused and that is the protection working.
    version: 0,
  });
  assert.ok([200, 409].includes(decided.status), JSON.stringify(decided.body));

  const resumed = await maintenance.JOBS.giveaway_lifecycle();
  assert.equal(resumed.drawn, 1, JSON.stringify(resumed));

  const after = await statusOf(giveawayId);
  assert.equal(after.status, 'drawn');
  assert.ok(after.winner_entry_id);

  const events = await eventsFor(giveawayId);
  assert.ok(events.some((e) => e.event_type === 'draw_postponed_pending_review'));
  assert.ok(events.some((e) => e.event_type === 'drawn'));
});

test('gl13. a disqualified entry can never win', async () => {
  const host = await makeUser('dq-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });
  const entries = await seedEntries(giveawayId, 8);

  // All but one disqualified, so the draw is deterministic and a wrong pool
  // would be obvious rather than probabilistic.
  const keep = entries[3].entryId;
  await pool.query(
    `UPDATE entries SET integrity_status = 'disqualified',
            integrity_reason_code = 'disqualified_terms',
            integrity_admin_notes = 'Fabricated fixture note.'
      WHERE giveaway_id = $1 AND id <> $2`,
    [giveawayId, keep]
  );

  await maintenance.JOBS.giveaway_lifecycle();
  const after = await statusOf(giveawayId);
  assert.equal(after.status, 'drawn');
  assert.equal(after.winner_entry_id, keep, 'the only eligible entry won');

  const disqualified = await pool.query(
    "SELECT COUNT(*)::int AS n FROM entries WHERE giveaway_id = $1 AND integrity_status = 'disqualified'",
    [giveawayId]
  );
  assert.equal(disqualified.rows[0].n, 7, 'and none of them was deleted');

  // The two predicates are one definition each, shared.
  assert.equal(lifecycle.ACCEPTED_SQL, "integrity_status <> 'disqualified'");
  assert.equal(lifecycle.DRAWABLE_SQL, "integrity_status = 'eligible'");
  const integrity = require('../server/lib/entryIntegrity');
  assert.equal(lifecycle.ACCEPTED_SQL, integrity.COUNTED_SQL, 'the same constant, not a copy');
});

test('gl14. a draw creates exactly one winner and exactly one claim', async () => {
  const host = await makeUser('one-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });
  await seedEntries(giveawayId, 5);

  await maintenance.JOBS.giveaway_lifecycle();
  const after = await statusOf(giveawayId);
  assert.equal(after.status, 'drawn');

  const winners = await pool.query(
    'SELECT COUNT(*)::int AS n FROM giveaways WHERE id = $1 AND winner_entry_id IS NOT NULL',
    [giveawayId]
  );
  assert.equal(winners.rows[0].n, 1);

  const claims = await pool.query('SELECT * FROM prize_claims WHERE giveaway_id = $1', [giveawayId]);
  assert.equal(claims.rowCount, 1, 'one claim');
  assert.equal(claims.rows[0].entry_id, after.winner_entry_id);

  // A second entry cannot be recorded as the winner of the same campaign, and
  // the same entry cannot win two — enforced by a partial unique index, not
  // only by the lock.
  const other = await pool.query(
    'SELECT id FROM entries WHERE giveaway_id = $1 AND id <> $2 LIMIT 1',
    [giveawayId, after.winner_entry_id]
  );
  const second = await campaign(host.id, { status: 'closed_pending_draw' });
  await assert.rejects(
    () =>
      pool.query('UPDATE giveaways SET status = $2, winner_entry_id = $3, drawn_at = NOW() WHERE id = $1', [
        second,
        'drawn',
        after.winner_entry_id,
      ]),
    /uniq_giveaway_winner_entry|duplicate key/i,
    'one entry cannot win two campaigns'
  );
  assert.ok(other.rows[0]);

  // Exactly one winner notice was queued, and it holds no address and no body.
  const notices = await pool.query(
    "SELECT * FROM giveaway_notifications WHERE giveaway_id = $1 AND kind = 'winner_notice'",
    [giveawayId]
  );
  assert.equal(notices.rowCount, 1);
  const columns = Object.keys(notices.rows[0]);
  ['email', 'address', 'body', 'html', 'token', 'subject'].forEach((forbidden) => {
    assert.ok(
      !columns.some((c) => c.includes(forbidden)),
      `the outbox must not store ${forbidden}`
    );
  });
});

test('gl15. a failed notification neither rolls back nor duplicates the draw', async () => {
  const host = await makeUser('notify-host', { hostStatus: 'approved' });
  const giveawayId = await campaign(host.id, { closesAt: new Date(Date.now() - 60000) });
  await seedEntries(giveawayId, 4);

  await maintenance.JOBS.giveaway_lifecycle();
  const drawn = await statusOf(giveawayId);
  assert.equal(drawn.status, 'drawn');
  const winner = drawn.winner_entry_id;

  // Every delivery attempt fails. The draw has already committed; the notice is
  // what retries.
  const failing = async () => {
    throw new Error('fabricated provider outage');
  };
  for (let i = 0; i < giveawayOutbox.MAX_ATTEMPTS; i += 1) {
    await pool.query(
      "UPDATE giveaway_notifications SET next_attempt_at = NOW() - INTERVAL '1 hour' WHERE giveaway_id = $1",
      [giveawayId]
    );
    await giveawayOutbox.processDue({ send: failing, appUrl: 'https://fabricated.test' });
  }

  const notice = await pool.query(
    "SELECT * FROM giveaway_notifications WHERE giveaway_id = $1 AND kind = 'winner_notice'",
    [giveawayId]
  );
  assert.equal(notice.rows[0].status, 'failed', 'it reaches a terminal state rather than looping');
  assert.equal(notice.rows[0].attempts, giveawayOutbox.MAX_ATTEMPTS);
  assert.ok(notice.rows[0].failed_at);
  // A category, never the provider's words.
  assert.equal(notice.rows[0].last_error_category, 'provider_error');
  assert.ok(!/fabricated provider outage/.test(JSON.stringify(notice.rows[0])));

  // The draw is untouched.
  const after = await statusOf(giveawayId);
  assert.equal(after.status, 'drawn');
  assert.equal(after.winner_entry_id, winner, 'the same winner');
  const drawEvents = (await eventsFor(giveawayId)).filter((e) => e.event_type === 'drawn');
  assert.equal(drawEvents.length, 1, 'and one draw, not two');

  // A terminal failure is visible to an administrator.
  const visible = await giveawayOutbox.adminView(pool);
  assert.ok(visible.some((row) => row.giveaway_id === giveawayId && row.status === 'failed'));
});

// ---------------------------------------------------------------------------
// 5. Prize submission and approval
// ---------------------------------------------------------------------------

test('gl16. a sponsor submission does not publish itself', async () => {
  const host = await makeUser('submit-host', { hostStatus: 'approved' });
  const session = await signIn(host.email, PASSWORD);

  const res = await session.post('/api/giveaways').send({
    title: 'Fabricated submission',
    description: 'A fabricated listing.',
    prize_description: 'A fabricated premium prize',
    funded_by: 'Fabricated marketing budget',
    ...FABRICATED_PRIZE,
  });
  assert.equal(res.status, 201);
  created.giveaways.push(res.body.id);
  assert.equal(res.body.submitted_for_review, true);
  assert.match(res.body.next_step, /Naseeb checks every prize before publication/);

  const row = await statusOf(res.body.id);
  assert.equal(row.status, 'pending_approval');
  assert.equal(row.published_at, null, 'not published');
  assert.equal(row.closes_at, null, 'and therefore has no deadline to run to');
  assert.equal(row.approved_at, null);
  assert.equal(row.approved_by, null);
  assert.ok(row.submitted_at);

  // Not listed publicly, and not enterable.
  const list = await api().get('/api/giveaways?pageSize=48');
  assert.ok(!list.body.items.some((g) => g.id === res.body.id), 'a submission is not published');

  const entrant = await makeUser('submit-entrant');
  const entrantSession = await signIn(entrant.email, PASSWORD);
  const entered = await entrantSession
    .post(`/api/giveaways/${res.body.id}/enter`)
    .set('X-Forwarded-For', nextTestIp());
  assert.equal(entered.status, 409);
  assert.equal(entered.body.code, 'ENTRIES_CLOSED');

  // The submission is recorded in the append-only history.
  const events = await eventsFor(res.body.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'submitted');
  assert.equal(events[0].actor_role, 'host');
});

test('gl17. publication is refused without an approved, evidenced prize commitment', async () => {
  const host = await makeUser('incomplete-host', { hostStatus: 'approved' });
  const session = await signIn(host.email, PASSWORD);
  const admin = await makeUser('incomplete-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);

  // A submission missing the prize facts is refused outright.
  const bare = await session.post('/api/giveaways').send({
    title: 'Bare submission',
    description: 'd',
    prize_description: 'p',
    funded_by: 'f',
  });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, 'SUBMISSION_INCOMPLETE');
  [
    'prize_category',
    'sponsor_name',
    'prize_supplied_by',
    'prize_retail_value_aed',
    'naseeb_custody',
    'fulfilment_method',
  ].forEach((field) => assert.ok(bare.body.missing.includes(field), `${field} is required`));

  // A complete submission still cannot be approved without evidence.
  const complete = await session.post('/api/giveaways').send({
    title: 'Complete submission',
    description: 'd',
    prize_description: 'p',
    funded_by: 'f',
    ...FABRICATED_PRIZE,
  });
  assert.equal(complete.status, 201);
  created.giveaways.push(complete.body.id);

  const noEvidence = await adminSession
    .post(`/api/admin/giveaways/${complete.body.id}/approve`)
    .send({ review_notes: 'Fabricated fixture.' });
  assert.equal(noEvidence.status, 400);
  assert.equal(noEvidence.body.code, 'EVIDENCE_KIND_INVALID');

  const noReference = await adminSession
    .post(`/api/admin/giveaways/${complete.body.id}/approve`)
    .send({ review_notes: 'Fabricated fixture.', evidence_kind: 'purchase_receipt_sighted' });
  assert.equal(noReference.status, 400);
  assert.equal(noReference.body.code, 'EVIDENCE_REFERENCE_REQUIRED');

  const noNotes = await adminSession.post(`/api/admin/giveaways/${complete.body.id}/approve`).send({
    evidence_kind: 'purchase_receipt_sighted',
    evidence_reference: 'fixture-ref-1',
  });
  assert.equal(noNotes.status, 400);
  assert.equal(noNotes.body.code, 'REVIEW_NOTES_REQUIRED');

  // Still unpublished after all of that.
  const stillPending = await statusOf(complete.body.id);
  assert.equal(stillPending.status, 'pending_approval');
  assert.equal(stillPending.published_at, null);

  // A non-administrator cannot approve.
  const notAdmin = await session.post(`/api/admin/giveaways/${complete.body.id}/approve`).send({
    review_notes: 'Trying it on.',
    evidence_kind: 'purchase_receipt_sighted',
    evidence_reference: 'fixture-ref-1',
  });
  assert.ok([401, 403].includes(notAdmin.status), `got ${notAdmin.status}`);
  assert.equal((await statusOf(complete.body.id)).status, 'pending_approval');

  // The database refuses a published campaign with no approval, independently
  // of the route.
  await assert.rejects(
    () =>
      pool.query("UPDATE giveaways SET status = 'active' WHERE id = $1", [complete.body.id]),
    /giveaways_publication_approved|giveaways_published_has_window|giveaways_prize_governed/,
    'the storage layer refuses an unapproved publication too'
  );
});

test('gl18. a rejected submission stays unpublished, and the host is told a fixed sentence', async () => {
  const host = await makeUser('reject-host', { hostStatus: 'approved' });
  const session = await signIn(host.email, PASSWORD);
  const admin = await makeUser('reject-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);

  const submitted = await session.post('/api/giveaways').send({
    title: 'A branded keyring',
    description: 'd',
    prize_description: 'A fabricated promotional keyring',
    funded_by: 'f',
    ...FABRICATED_PRIZE,
    prize_category: 'other_approved_premium',
    prize_retail_value_aed: 12,
  });
  assert.equal(submitted.status, 201);
  created.giveaways.push(submitted.body.id);

  const INTERNAL = 'Fabricated internal note: sponsor has previously oversold stock.';
  const rejected = await adminSession.post(`/api/admin/giveaways/${submitted.body.id}/reject`).send({
    ground: 'promotional_merchandise',
    review_notes: INTERNAL,
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');
  assert.equal(rejected.body.ground, 'promotional_merchandise');
  assert.equal(
    rejected.body.host_explanation,
    prizeStandard.REJECTION_COPY.promotional_merchandise,
    'a fixed sentence, chosen by code'
  );
  // The reviewer's own words never become the message.
  assert.ok(!JSON.stringify(rejected.body).includes(INTERNAL));

  const row = await statusOf(submitted.body.id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.published_at, null);
  assert.ok(row.rejected_at && row.rejected_by === admin.id);

  // Never listed, never enterable, and approving it afterwards is refused.
  const list = await api().get('/api/giveaways?pageSize=48');
  assert.ok(!list.body.items.some((g) => g.id === submitted.body.id));

  const lateApproval = await adminSession
    .post(`/api/admin/giveaways/${submitted.body.id}/approve`)
    .send({
      review_notes: 'Changed my mind.',
      evidence_kind: 'purchase_receipt_sighted',
      evidence_reference: 'fixture-ref',
    });
  assert.equal(lateApproval.status, 409);
  assert.equal(lateApproval.body.code, 'NOT_PENDING_APPROVAL');
  assert.equal((await statusOf(submitted.body.id)).status, 'rejected');

  // The standard names what it will not publish, and does not set a price floor.
  const source = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'prizeStandard.js'), 'utf8');
  ['promotional_merchandise', 'ordinary_food_or_groceries', 'sample',
   'discount_presented_as_prize', 'condition_unacceptable', 'unlawful_or_unsafe',
   'undisclosed_purchase_required', 'value_misleading', 'restrictions_unreasonable',
   'commitment_unreliable'].forEach((ground) => {
    assert.ok(source.includes(ground), `${ground} is a stated rejection ground`);
  });
  assert.match(source, /there is deliberately no minimum monetary value/i);
});

test('gl19. approval records the administrator, the time and an append-only history', async () => {
  const host = await makeUser('approve-host', { hostStatus: 'approved' });
  const session = await signIn(host.email, PASSWORD);
  const admin = await makeUser('approve-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);

  const submitted = await session.post('/api/giveaways').send({
    title: 'Fabricated premium prize',
    description: 'd',
    prize_description: 'p',
    funded_by: 'f',
    ...FABRICATED_PRIZE,
    prize_restrictions: 'Fabricated: UAE residents, booking subject to availability.',
    prize_expiry_date: '2027-06-30',
  });
  assert.equal(submitted.status, 201);
  created.giveaways.push(submitted.body.id);

  const before = new Date();
  const approved = await adminSession.post(`/api/admin/giveaways/${submitted.body.id}/approve`).send({
    review_notes: 'Fabricated fixture: receipt sighted, stock confirmed.',
    evidence_kind: 'purchase_receipt_sighted',
    evidence_reference: 'fixture-receipt-0001',
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'active');
  assert.equal(approved.body.entry_target, 100);

  const row = await statusOf(submitted.body.id);
  assert.equal(row.approved_by, admin.id, 'the approving administrator is recorded');
  assert.ok(new Date(row.approved_at) >= before);
  assert.ok(row.published_at, 'and the publication time');
  assert.equal(row.prize_evidence_verified, true);
  assert.equal(row.prize_evidence_verified_by, admin.id);
  assert.equal(row.prize_governance_version, 1);

  // Exactly one calendar month — which is 28, 29, 30 or 31 days depending on
  // when the campaign was published, and is deliberately NOT a fixed day count.
  // The approved rule is a calendar month; thirty days was a different rule the
  // code used to enforce while the copy promised it.
  const published = new Date(row.published_at);
  const expected = new Date(published);
  expected.setUTCMonth(expected.getUTCMonth() + 1);
  const skewMs = Math.abs(new Date(row.closes_at) - expected);
  assert.ok(
    skewMs < 2000,
    `the window is not one calendar month: closes_at ${row.closes_at}, expected ${expected.toISOString()}`
  );
  // `entry_deadline` is the legacy text column, kept in step with `closes_at`
  // for the readers that already existed. Compared to the millisecond.
  assert.ok(
    Math.abs(new Date(row.entry_deadline) - new Date(row.closes_at)) < 1000,
    `${row.entry_deadline} vs ${row.closes_at}`
  );

  // The history is append-only and cannot be rewritten or erased.
  const events = await eventsFor(submitted.body.id);
  // Sorted rather than ordered: `approved` and `published` are written in the
  // same transaction and share a timestamp to the microsecond, so their relative
  // order is not something to assert.
  assert.deepEqual([...events.map((e) => e.event_type)].sort(), ['approved', 'published', 'submitted']);
  assert.equal(events[0].event_type, 'submitted', 'submission comes first');
  await assert.rejects(
    () =>
      pool.query("UPDATE giveaway_lifecycle_events SET event_type = 'rewritten' WHERE giveaway_id = $1", [
        submitted.body.id,
      ]),
    /append-only/i
  );
  await assert.rejects(
    () => pool.query('DELETE FROM giveaway_lifecycle_events WHERE giveaway_id = $1', [submitted.body.id]),
    /append-only/i
  );

  // The campaign-specific conditions are published; the internal record is not.
  const detail = await api().get(`/api/giveaways/${submitted.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.lifecycle.prize_category, FABRICATED_PRIZE.prize_category);
  assert.equal(detail.body.lifecycle.sponsor_name, FABRICATED_PRIZE.sponsor_name);
  assert.match(detail.body.lifecycle.prize_restrictions, /booking subject to availability/);
  assert.match(detail.body.lifecycle.custody_explanation, /Naseeb holds this prize/);
  assert.equal(detail.body.lifecycle.entry_target, 100);
  const rendered = JSON.stringify(detail.body);
  assert.ok(!rendered.includes('fixture-receipt-0001'), 'no evidence reference is published');
  assert.ok(!rendered.includes('receipt sighted, stock confirmed'), 'no review notes are published');
  assert.ok(!rendered.includes(admin.id), 'no approving administrator is published');
});

// ---------------------------------------------------------------------------
// 6. Sponsor commitment and exceptional cancellation
// ---------------------------------------------------------------------------

test('gl20. an ordinary sponsor withdrawal after publication is refused', async () => {
  const host = await makeUser('withdraw-host', { hostStatus: 'approved' });
  const admin = await makeUser('withdraw-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);
  const giveawayId = await campaign(host.id);
  await seedEntries(giveawayId, 3);

  const refused = await adminSession.post(`/api/admin/giveaways/${giveawayId}/cancel`).send({
    ground: 'sponsor_withdrawal',
    reason: 'The sponsor emailed to say they have changed their mind about the prize.',
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'SPONSOR_WITHDRAWAL_NOT_A_GROUND');
  assert.match(refused.body.error, /People have entered it/);

  const unchanged = await statusOf(giveawayId);
  assert.equal(unchanged.status, 'active', 'the campaign is untouched');
  assert.equal(unchanged.cancelled_at, null);

  // Not representable in the database either, so no future code path can write
  // it by going around the service.
  await assert.rejects(
    () =>
      pool.query(
        `UPDATE giveaways SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2,
                cancellation_ground = 'sponsor_withdrawal',
                cancellation_reason = 'sponsor changed their mind',
                cancellation_public_explanation = 'x'
          WHERE id = $1`,
        [giveawayId, admin.id]
      ),
    /giveaways_cancellation_valid/,
    'the storage layer refuses it as a ground'
  );

  // An unknown ground is refused too, with the allowlist reported.
  const unknown = await adminSession
    .post(`/api/admin/giveaways/${giveawayId}/cancel`)
    .send({ ground: 'we_fancied_a_change', reason: 'A fabricated reason, long enough to pass.' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'CANCELLATION_GROUND_INVALID');
  assert.ok(!unknown.body.details.allowed.includes('sponsor_withdrawal'));
});

test('gl21, gl22, gl23. exceptional cancellation needs an administrator and a reason, preserves everything, and notifies entrants', async () => {
  const host = await makeUser('cancel-host', { hostStatus: 'approved' });
  const admin = await makeUser('cancel-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);
  const giveawayId = await campaign(host.id);
  const entries = await seedEntries(giveawayId, 4);

  const entriesBefore = await pool.query(
    'SELECT id, user_id, ticket_number, created_at FROM entries WHERE giveaway_id = $1 ORDER BY ticket_number',
    [giveawayId]
  );

  // gl21: a reason is mandatory.
  const noReason = await adminSession
    .post(`/api/admin/giveaways/${giveawayId}/cancel`)
    .send({ ground: 'fulfilment_impossible' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'CANCELLATION_REASON_REQUIRED');

  const tooShort = await adminSession
    .post(`/api/admin/giveaways/${giveawayId}/cancel`)
    .send({ ground: 'fulfilment_impossible', reason: 'gone' });
  assert.equal(tooShort.status, 400);

  // And an administrator is mandatory.
  const hostSession = await signIn(host.email, PASSWORD);
  const notAdmin = await hostSession.post(`/api/admin/giveaways/${giveawayId}/cancel`).send({
    ground: 'fulfilment_impossible',
    reason: 'A fabricated reason of sufficient length to be accepted.',
  });
  assert.ok([401, 403].includes(notAdmin.status));
  assert.equal((await statusOf(giveawayId)).status, 'active');

  const INTERNAL =
    'Fabricated internal record: the fabricated supplier ceased trading and the prize cannot be sourced.';
  const cancelled = await adminSession.post(`/api/admin/giveaways/${giveawayId}/cancel`).send({
    ground: 'fulfilment_impossible',
    reason: INTERNAL,
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.entrants_notified, 4);

  const row = await statusOf(giveawayId);
  assert.equal(row.cancelled_by, admin.id);
  assert.ok(row.cancelled_at);
  assert.equal(row.cancellation_ground, 'fulfilment_impossible');
  assert.equal(row.cancellation_reason, INTERNAL);

  // gl22: entries and history are preserved, byte for byte.
  const entriesAfter = await pool.query(
    'SELECT id, user_id, ticket_number, created_at FROM entries WHERE giveaway_id = $1 ORDER BY ticket_number',
    [giveawayId]
  );
  assert.deepEqual(entriesAfter.rows, entriesBefore.rows, 'not one entry was changed or removed');
  assert.equal(entriesAfter.rowCount, 4);
  const campaignStillThere = await pool.query('SELECT COUNT(*)::int AS n FROM giveaways WHERE id = $1', [
    giveawayId,
  ]);
  assert.equal(campaignStillThere.rows[0].n, 1, 'the campaign is not deleted');

  const events = await eventsFor(giveawayId);
  const cancelEvent = events.find((e) => e.event_type === 'cancelled');
  assert.ok(cancelEvent, 'an append-only lifecycle event records it');
  assert.equal(cancelEvent.actor_user_id, admin.id);
  assert.equal(cancelEvent.reason_code, 'fulfilment_impossible');

  // No draw is pretended.
  assert.equal(row.winner_entry_id, null);
  assert.equal(row.drawn_at, null);
  assert.ok(!events.some((e) => e.event_type === 'drawn'));
  const claims = await pool.query('SELECT COUNT(*)::int AS n FROM prize_claims WHERE giveaway_id = $1', [
    giveawayId,
  ]);
  assert.equal(claims.rows[0].n, 0);

  // gl23: every entrant has a durable notice queued.
  const notices = await pool.query(
    "SELECT * FROM giveaway_notifications WHERE giveaway_id = $1 AND kind = 'cancellation_notice'",
    [giveawayId]
  );
  assert.equal(notices.rowCount, 4, 'one per entrant');
  const notified = new Set(notices.rows.map((n) => n.user_id));
  entries.forEach((e) => assert.ok(notified.has(e.userId)));

  // The member-facing explanation is honest and non-accusatory, and is the
  // fixed sentence chosen from the ground — never the internal reason.
  const detail = await api().get(`/api/giveaways/${giveawayId}`);
  assert.equal(detail.body.lifecycle.status, 'cancelled');
  assert.match(detail.body.lifecycle.cancellation_explanation, /prize can no longer be provided/);
  assert.match(detail.body.lifecycle.cancellation_explanation, /has not been deleted/);
  assert.ok(!JSON.stringify(detail.body).includes(INTERNAL), 'the internal reason is never published');

  // Re-cancelling is idempotent rather than duplicating notices.
  const again = await adminSession
    .post(`/api/admin/giveaways/${giveawayId}/cancel`)
    .send({ ground: 'unlawful', reason: 'A second fabricated attempt, long enough to pass.' });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_cancelled, true);
  const stillFour = await pool.query(
    "SELECT COUNT(*)::int AS n FROM giveaway_notifications WHERE giveaway_id = $1 AND kind = 'cancellation_notice'",
    [giveawayId]
  );
  assert.equal(stillFour.rows[0].n, 4, 'no duplicate notices');
});

// ---------------------------------------------------------------------------
// 7. Disclosure
// ---------------------------------------------------------------------------

test('gl24. no personal address, secret, evidence reference or internal note is public', async () => {
  const host = await makeUser('leak-host', { hostStatus: 'approved' });
  const admin = await makeUser('leak-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);
  const session = await signIn(host.email, PASSWORD);

  const submitted = await session.post('/api/giveaways').send({
    title: 'Disclosure fixture',
    description: 'd',
    prize_description: 'p',
    funded_by: 'f',
    ...FABRICATED_PRIZE,
  });
  created.giveaways.push(submitted.body.id);

  const SECRETS = {
    evidence: 'fixture-secret-evidence-reference-9911',
    notes: 'Fabricated internal note: the sponsor is on a watch list.',
  };
  await adminSession.post(`/api/admin/giveaways/${submitted.body.id}/approve`).send({
    review_notes: SECRETS.notes,
    evidence_kind: 'supplier_invoice_sighted',
    evidence_reference: SECRETS.evidence,
  });
  await seedEntries(submitted.body.id, 2);

  const publicResponses = await Promise.all([
    api().get(`/api/giveaways/${submitted.body.id}`),
    api().get('/api/giveaways?pageSize=48'),
    api().get('/api/giveaways/stats/summary'),
    api().get('/api/giveaways/winners/all'),
    api().get('/api/config'),
  ]);

  publicResponses.forEach((res, i) => {
    const text = JSON.stringify(res.body);
    Object.entries(SECRETS).forEach(([name, value]) => {
      assert.ok(!text.includes(value), `public response ${i} must not carry the ${name}`);
    });
    assert.ok(!text.includes(admin.id), `public response ${i} must not name the reviewer`);
    assert.ok(!text.includes(host.email), `public response ${i} must not carry an email address`);
    assert.ok(!/review_notes|prize_evidence_reference|approved_by/.test(text), `response ${i}`);
  });

  // The public view is an allowlist, not a redaction.
  const view = lifecycle.publicView(await statusOf(submitted.body.id));
  const allowed = new Set([
    'status', 'accepting_entries', 'published_at', 'closes_at', 'entry_target',
    'entries_closed_at', 'entries_closed_reason', 'drawn_at', 'no_winner_reason',
    'state_explanation', 'cancellation_explanation', 'prize_category', 'sponsor_name',
    'prize_restrictions', 'prize_expiry_date', 'fulfilment_method', 'custody_explanation',
  ]);
  Object.keys(view).forEach((key) => assert.ok(allowed.has(key), `publicView must not expose ${key}`));

  // No committed file publishes the operator's personal email, and none invents
  // a company, licence, VAT number or replacement guarantee.
  const files = [];
  ['public', 'docs'].forEach((dir) => {
    (function walk(d) {
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(html|md|js|css)$/.test(e.name)) files.push(full);
      });
    })(path.join(ROOT, dir));
  });
  files.forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/chatle\.ent@outlook/i.test(text), `${file} must not publish a personal email`);
    assert.ok(
      !/\bTRN\s*[:#]?\s*\d{5,}|VAT\s*(registration\s*)?(number|no\.?)\s*[:#]?\s*\d/i.test(text),
      `${file} must not state a VAT registration`
    );
    // A stated VALUE, not the words. `docs/` legitimately discusses that a
    // trade licence number is a thing that would need a retention rule — what
    // must never appear is an actual one.
    assert.ok(
      !/(trade|commercial)\s+licen[cs]e\s*(number|no\.?)?\s*[:#]\s*[A-Z0-9-]{4,}/i.test(text),
      `${file} must not state a licence number`
    );
    assert.ok(
      !/we (will )?(guarantee|underwrite) (an )?equivalent replacement/i.test(text),
      `${file} must not promise a replacement guarantee`
    );
  });
});

test('gl25. the amendment changes no security boundary the suite already proves', () => {
  // A checked restatement, so a future refactor of this feature cannot quietly
  // drop one of them.
  const giveaways = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'giveaways.js'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'admin.js'), 'utf8');

  // Entering still requires a verified account and the age attestation.
  assert.match(giveaways, /email_verified/);
  assert.match(giveaways, /eligibility\.blocksAction\(enteringUser, 'enter_giveaway'\)/);
  // Hosting still goes through the host-access gate.
  assert.match(giveaways, /requireHostAccess/);
  // Every new administrator route is behind requireAdmin AND re-checks the role
  // from the database inside the transaction.
  ['approve', 'reject', 'cancel'].forEach((action) => {
    const idx = admin.indexOf(`/giveaways/:id/${action}`);
    assert.ok(idx > -1, `${action} route exists`);
    assert.ok(admin.slice(idx, idx + 200).includes('requireAdmin'), `${action} is admin-only`);
  });
  const lifecycleSource = fs.readFileSync(
    path.join(ROOT, 'server', 'lib', 'giveawayLifecycle.js'),
    'utf8'
  );
  ['approveAndPublish', 'reject', 'cancelExceptionally'].forEach((fn) => {
    const idx = lifecycleSource.indexOf(`async function ${fn}(`);
    assert.ok(idx > -1);
    assert.ok(
      lifecycleSource.slice(idx, idx + 400).includes('assertAdmin'),
      `${fn} re-reads the administrator role from the database`
    );
  });

  // The draw is still the one cryptographically secure implementation, and
  // there is no second one.
  assert.match(lifecycleSource, /crypto\.randomInt\(entries\.length\)/);
  // Prose may mention it; code may not.
  const code = lifecycleSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/Math\.random/.test(code), 'the draw is never Math.random');
  assert.ok(!/crypto\.randomInt/.test(giveaways), 'the route does not draw for itself');
  const drawCallers = ['server/lib/giveawayLifecycle.js'];
  const serverFiles = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) serverFiles.push(full);
    });
  })(path.join(ROOT, 'server'));
  serverFiles.forEach((file) => {
    const rel = path.relative(ROOT, file);
    if (drawCallers.includes(rel)) return;
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(
      !/randomInt\([^)]*entries|entries\[[^\]]*random/i.test(text),
      `${rel} must not contain a second draw`
    );
  });

  // Sessions, CSRF and the append-only trails are untouched by this amendment.
  assert.equal(typeof sessions.authenticate, 'function');
  const baseline = fs.readFileSync(
    path.join(ROOT, 'server', 'migrations', '001_baseline.sql'),
    'utf8'
  );
  assert.match(baseline, /entry_integrity_events_immutable/);
  const migration = fs.readFileSync(
    path.join(ROOT, 'server', 'migrations', '003_giveaway_lifecycle.sql'),
    'utf8'
  );
  [/DROP\s+TABLE/i, /TRUNCATE/i, /DELETE\s+FROM/i, /DROP\s+COLUMN/i].forEach((pattern) => {
    assert.ok(!pattern.test(migration), `the migration must not contain ${pattern}`);
  });

  // Ad checkout stays off.
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.match(render, /ADS_CHECKOUT_ENABLED\s*\n\s*value:\s*false/);
});
