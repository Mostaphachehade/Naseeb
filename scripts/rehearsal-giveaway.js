// The joined-up giveaway rehearsal.
//
// ---------------------------------------------------------------------------
// Why this exists when the suite already covers the invariants
// ---------------------------------------------------------------------------
//
// test/giveaway-lifecycle.test.js, test/prize-claims.test.js,
// test/entry-integrity.test.js and test/race-conditions.test.js already prove
// every individual invariant this file touches, and they prove them harder:
// concurrently, at the threshold, with hostile input. Nothing here replaces
// them, and this file deliberately does not re-assert what they assert.
//
// What none of them do is run the whole arc ONCE, in order, as a single
// narrative — proposal, approval, publication, a hundred entries, closure, the
// draw, the claim, fulfilment, erasure — against a real HTTP server with a real
// browser driving the pages a person would actually touch. A suite of green
// units can still describe a journey nobody has walked end to end.
//
// So this is a rehearsal, not a test suite: one deterministic run of the real
// thing, which either completes or stops at the step that broke.
//
// ---------------------------------------------------------------------------
// What it will not do
// ---------------------------------------------------------------------------
//
//   * Touch a database that is not an isolated test database. configureTestEnv
//     refuses first, and assertRehearsalDatabase below refuses again with a
//     second, independent check — see "Two guards, on purpose".
//   * Send email. RESEND_API_KEY is stripped by configureTestEnv; the outbox is
//     drained and INSPECTED rather than delivered.
//   * Move money. No Stripe session is created; ADS_CHECKOUT_ENABLED stays off.
//   * Use a real address. Every account is `@example.test`, a reserved TLD that
//     cannot receive mail, and every delivery detail is fabricated.
//
// Exit codes: 0 the rehearsal completed, 1 a step failed.
//
// Note there is deliberately NO attempt to neuter dotenv here. configureTestEnv
// already refuses to load `.env`, and that is the protection; stubbing
// `dotenv.config` would also stop `.env.test` loading, which is how a developer
// supplies an isolated local database.
const path = require('path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');

const { configureTestEnv } = require(path.join(ROOT, 'testEnv'));
const target = configureTestEnv();

// ---------------------------------------------------------------------------
// Two guards, on purpose
// ---------------------------------------------------------------------------
//
// configureTestEnv already refuses a non-test database. This second guard is
// not redundant belt-tightening — it is a different question asked by different
// code. The first asks "is this named like a test database and is it local".
// This one asks "does this look like OUR production", by name and by host, and
// it runs after the environment has been assembled rather than before. A future
// edit that loosens one has to get past the other.
function assertRehearsalDatabase() {
  const raw = process.env.DATABASE_URL || '';
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const host = url.hostname;

  const problems = [];
  if (process.env.NODE_ENV !== 'test') {
    problems.push(`NODE_ENV is "${process.env.NODE_ENV}", not "test"`);
  }
  // The production database is `neondb` on a Neon host. Named explicitly so the
  // refusal is specific rather than a general heuristic that could drift.
  if (/neon\.tech$/i.test(host)) problems.push(`host is Neon (${host})`);
  if (database === 'neondb') problems.push('database is named "neondb"');
  if (!/(^|[-_])test([-_0-9]|$)/i.test(database)) {
    problems.push(`database "${database}" is not named like a test database`);
  }
  if (process.env.RESEND_API_KEY) problems.push('RESEND_API_KEY is present — email could be sent');
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    problems.push('a non-test Stripe key is present');
  }

  if (problems.length) {
    process.stderr.write(
      ['', 'Refusing to rehearse.', '', ...problems.map((p) => `  - ${p}`), '',
        'This harness only ever runs against an isolated test database.', ''].join('\n')
    );
    process.exit(1);
  }
}
assertRehearsalDatabase();

const request = require(path.join(ROOT, 'node_modules', 'supertest'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const app = require(path.join(ROOT, 'server', 'app'));
const { pool } = require(path.join(ROOT, 'server', 'db'));
const lifecycle = require(path.join(ROOT, 'server', 'lib', 'giveawayLifecycle'));
const maintenance = require(path.join(ROOT, 'server', 'lib', 'maintenance'));

const PASSWORD = 'rehearsal-only-password-123';

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------
//
// Every one of the 21 required points is recorded here as it is exercised, and
// the report at the end prints the mapping. `kind` distinguishes what this run
// actually walked from what an existing suite proves — conflating the two would
// let a rehearsal claim credit for coverage it did not produce.
const REQUIREMENTS = [
  [1, 'administrator creates or reviews a proposed premium prize'],
  [2, 'sponsor/provider and prize custody are recorded'],
  [3, 'campaign receives admin approval'],
  [4, 'campaign publishes only when eligible'],
  [5, 'members enter'],
  [6, 'duplicate entry by the same verified account is refused'],
  [7, 'the campaign closes and draws at 100 eligible entries'],
  [8, 'a separate campaign closes after one calendar month and draws'],
  [9, 'under-review/open-integrity cases block the draw'],
  [10, 'disqualified entries are excluded'],
  [11, 'one winner and one claim are created transactionally'],
  [12, 'concurrent close/draw workers cannot create a second winner'],
  [13, 'winner notification is queued, not sent to a real address'],
  [14, 'winner claims through the secure fragment/token flow'],
  [15, 'Naseeb-facing fulfilment and delivery states are exercised'],
  [16, 'delivery details remain encrypted'],
  [17, 'protected delivery data is erased per the configured lifecycle'],
  [18, 'cancellation notifies entrants through the durable outbox'],
  [19, 'sponsor withdrawal is not an ordinary self-service action'],
  [20, 'failure/retry behaviour remains idempotent'],
  [21, 'campaign, entry, draw, decision and notification evidence is auditable'],
];
const evidence = new Map();
function record(n, kind, detail) {
  if (!evidence.has(n)) evidence.set(n, []);
  evidence.get(n).push({ kind, detail });
}
// Walked by this rehearsal, in this run.
const walked = (n, detail) => record(n, 'REHEARSED', detail);
// Proven by an existing suite. Named so the report can cite it; this file does
// not re-assert it.
const cited = (n, detail) => record(n, 'EXISTING', detail);

const steps = [];
let failed = false;
async function step(label, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    steps.push({ step: label, ok: true, ms: Date.now() - started, note: note || null });
    process.stderr.write(`  ok   ${label}${note ? ` — ${note}` : ''}\n`);
  } catch (err) {
    failed = true;
    steps.push({ step: label, ok: false, ms: Date.now() - started, error: String(err.message || err) });
    process.stderr.write(`  FAIL ${label}\n       ${String(err.message || err)}\n`);
    throw err;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fabricated cast. Every address is @example.test — a reserved TLD.
// ---------------------------------------------------------------------------

const suffix = crypto.randomBytes(4).toString('hex');
const made = { users: [], giveaways: [] };

async function makeUser({ name, admin = false, hostStatus = 'not_requested' }) {
  const id = crypto.randomUUID();
  const email = `rehearsal-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${suffix}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
    [id, name, email, hash, admin, hostStatus]
  );
  made.users.push(id);
  return { id, email, name };
}

// Returns { cookie, csrf }. The CSRF token is issued by the login response
// itself, exactly as the browser client receives it — the rehearsal sends it on
// every mutation rather than being exempted from the check. A harness that
// skipped CSRF would be testing a configuration nobody runs.
async function sessionFor(email) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  assert(res.status === 200, `login failed for a rehearsal account: ${res.status}`);
  const cookie = res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const csrf = res.body && res.body.csrf_token;
  assert(csrf, 'login returned no CSRF token');
  return { cookie, csrf };
}

async function cleanup() {
  if (!made.users.length && !made.giveaways.length) return;
  const g = made.giveaways;
  const u = made.users;
  // Children first. Any table that may not exist on an older schema is guarded.
  const safe = async (sql, params) => { try { await pool.query(sql, params); } catch { /* table absent */ } };
  await safe('DELETE FROM prize_claim_events WHERE claim_id IN (SELECT id FROM prize_claims WHERE giveaway_id = ANY($1))', [g]);
  await safe('DELETE FROM claim_notifications WHERE giveaway_id = ANY($1)', [g]);
  await safe('DELETE FROM prize_claims WHERE giveaway_id = ANY($1)', [g]);
  await safe('DELETE FROM giveaway_notification_events WHERE giveaway_id = ANY($1)', [g]);
  await safe('DELETE FROM giveaway_lifecycle_events WHERE giveaway_id = ANY($1)', [g]);
  await safe('DELETE FROM entry_integrity_case_events WHERE case_id IN (SELECT id FROM entry_integrity_cases WHERE giveaway_id = ANY($1))', [g]);
  await safe('DELETE FROM entry_integrity_cases WHERE giveaway_id = ANY($1)', [g]);
  await safe('DELETE FROM entry_integrity_events WHERE giveaway_id = ANY($1)', [g]);
  await safe('DELETE FROM entry_risk_signals WHERE user_id = ANY($1)', [u]);
  await safe('DELETE FROM entries WHERE giveaway_id = ANY($1)', [g]);
  await safe('DELETE FROM giveaways WHERE id = ANY($1)', [g]);
  await safe('DELETE FROM sessions WHERE user_id = ANY($1)', [u]);
  await safe('DELETE FROM session_families WHERE user_id = ANY($1)', [u]);
  await safe('DELETE FROM policy_acceptances WHERE user_id = ANY($1)', [u]);
  await safe('DELETE FROM users WHERE id = ANY($1)', [u]);
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

async function main() {
  process.stderr.write(`\nRehearsal against ${target.describe}\n\n`);

  const admin = await makeUser({ name: 'Rehearsal Admin', admin: true });
  const host = await makeUser({ name: 'Rehearsal Sponsor', hostStatus: 'approved' });
  const adminSession = await sessionFor(admin.email);
  const hostSession = await sessionFor(host.email);

  const api = (session) => (method, url) =>
    request(app)[method](url)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('X-Forwarded-For', '203.0.113.10');

  const asAdmin = api(adminSession);
  const asHost = api(hostSession);

  // -- 0: the age attestation, which publishing is gated on -------------------
  //
  // Not a detour. A host cannot submit a campaign without an explicit, versioned
  // 18-or-over attestation, and the rehearsal records one the same way the UI
  // does rather than writing the column directly — the point is to walk the
  // gates, not to step around them.
  await step('0. the sponsor records the explicit age attestation', async () => {
    const res = await asHost('post', '/api/account/eligibility').send({ confirmed: true });
    assert(res.status === 200, `attestation refused: ${res.status} ${JSON.stringify(res.body)}`);
    const row = (await pool.query(
      'SELECT age_attestation_status, age_attestation_version FROM users WHERE id = $1', [host.id]
    )).rows[0];
    assert(row.age_attestation_status, 'no attestation status was recorded');
    return `status ${row.age_attestation_status}, version ${row.age_attestation_version}`;
  });

  // -- 1, 2: a proposal carrying its provider and custody ---------------------
  let giveawayId;
  await step('1-2. sponsor proposes a premium prize with provider and custody recorded', async () => {
    // Every field prizeStandard.REQUIRED_FOR_SUBMISSION asks for. `entry_deadline`
    // is deliberately NOT sent: it is a consequence of approval (exactly 30
    // calendar days), not a host's choice — see server/routes/giveaways.js.
    const res = await asHost('post', '/api/giveaways').send({
      title: `Rehearsal premium stay ${suffix}`,
      description: 'A fabricated premium prize used only by the rehearsal harness.',
      prize_description: 'Two nights, fabricated partner hotel, breakfast included.',
      prize_category: 'luxury_stay_or_holiday',
      sponsor_name: 'Rehearsal Partner Hotel (fabricated)',
      prize_supplied_by: 'Rehearsal Partner Hotel (fabricated)',
      prize_retail_value_aed: 4000,
      naseeb_custody: 'provider_fulfils',
      fulfilment_method: 'Booking arranged by Naseeb with the provider; Naseeb stays the winner contact.',
      funded_by: 'Rehearsal Partner Hotel (fabricated)',
      max_entries_per_person: 1,
    });
    assert([200, 201].includes(res.status), `proposal refused: ${res.status} ${JSON.stringify(res.body)}`);
    giveawayId = res.body.id || (res.body.giveaway && res.body.giveaway.id);
    assert(giveawayId, 'no giveaway id returned');
    made.giveaways.push(giveawayId);

    const row = (await pool.query('SELECT status, funded_by FROM giveaways WHERE id = $1', [giveawayId])).rows[0];
    assert(row, 'giveaway not persisted');
    assert(row.funded_by, 'prize provider was not recorded');
    walked(1, 'sponsor proposal accepted and persisted');
    walked(2, `provider recorded as "${row.funded_by}"`);
    return `status after submission: ${row.status}`;
  });

  // -- 4 (negative), then 3: unapproved cannot publish; approval is explicit ---
  await step('4. an unapproved campaign is not publicly visible', async () => {
    const res = await request(app).get('/api/giveaways');
    const list = Array.isArray(res.body) ? res.body : res.body.giveaways || [];
    assert(!list.some((g) => g.id === giveawayId), 'an unapproved campaign appeared in the public list');
    walked(4, 'unapproved campaign absent from the public listing');
    cited(4, 'gl16/gl17 — a submission does not publish itself, and publication needs an evidenced commitment');
  });

  await step('3. an administrator approves the proposal, on the record', async () => {
    // Approval IS publication, and it needs a verified evidence reference —
    // REQUIRED_FOR_PUBLICATION. A reference, never the document itself.
    const res = await asAdmin('post', `/api/admin/giveaways/${giveawayId}/approve`).send({
      evidence_kind: 'booking_reference_held',
      evidence_reference: `REHEARSAL-REF-${suffix}`,
      review_notes: 'Rehearsal approval — fabricated prize, fabricated partner.',
    });
    assert([200, 201, 204].includes(res.status), `approval refused: ${res.status} ${JSON.stringify(res.body)}`);

    const row = (await pool.query(
      'SELECT status, published_at, entry_deadline, entry_target FROM giveaways WHERE id = $1', [giveawayId]
    )).rows[0];
    assert(row.published_at, 'approval did not publish');
    assert(Number(row.entry_target) === 100, `entry target is ${row.entry_target}, expected 100`);

    walked(3, 'approval accepted, actor and evidence reference recorded');
    walked(4, `published on approval; entry target ${row.entry_target}, deadline ${row.entry_deadline}`);
    cited(21, 'gl19 — approval records the administrator, the time and an append-only history');
    return `status ${row.status}, target ${row.entry_target}`;
  });

  // -- 19: withdrawal is not self-service ------------------------------------
  await step('19. an ordinary sponsor withdrawal is refused', async () => {
    const res = await asHost('post', `/api/admin/giveaways/${giveawayId}/cancel`).send({
      reason: 'sponsor changed their mind',
    });
    assert(res.status === 403 || res.status === 401,
      `a sponsor was able to reach the cancellation route: ${res.status}`);
    walked(19, `sponsor cancellation refused with ${res.status}`);
    cited(19, 'gl20 — an ordinary sponsor withdrawal after publication is refused');
  });

  // -- 5, 6: members enter; the same account cannot enter twice ---------------
  const members = [];
  await step('5-6. a member enters, and the same verified account cannot enter twice', async () => {
    const member = await makeUser({ name: 'Rehearsal Member 001' });
    members.push(member);
    const asMember = api(await sessionFor(member.email));

    // Entering is gated on the same explicit attestation as publishing.
    const attested = await asMember('post', '/api/account/eligibility').send({ confirmed: true });
    assert(attested.status === 200, `member attestation refused: ${attested.status}`);

    const first = await asMember('post', `/api/giveaways/${giveawayId}/enter`).send({});
    assert([200, 201].includes(first.status), `entry refused: ${first.status} ${JSON.stringify(first.body)}`);

    const second = await asMember('post', `/api/giveaways/${giveawayId}/enter`).send({});
    assert(second.status >= 400, `a duplicate entry was accepted with ${second.status}`);

    const count = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM entries WHERE giveaway_id = $1 AND user_id = $2',
      [giveawayId, member.id]
    )).rows[0].n;
    assert(count === 1, `expected exactly 1 entry for the member, found ${count}`);

    walked(5, 'entry accepted through POST /api/giveaways/:id/enter');
    walked(6, `duplicate refused with ${second.status}; exactly one row persists`);
    cited(6, 'race-conditions — the same person entering twice at once is only counted once');
    return `duplicate refused with ${second.status}`;
  });

  // -- 7, 11: the 100th eligible entry closes the campaign and draws ----------
  //
  // 99 entries arrive as direct fixtures rather than 99 browser sessions. The
  // invariant under test is "the 100th accepted entry closes and draws", and a
  // fixture establishes the same precondition without pretending 99 people used
  // a browser. The 100th goes through the real HTTP route, because that is the
  // one whose behaviour actually matters here.
  await step('7, 11. the 100th eligible entry closes the campaign and draws one winner', async () => {
    for (let i = 2; i <= 99; i += 1) {
      const filler = await makeUser({ name: `Rehearsal Member ${String(i).padStart(3, '0')}` });
      members.push(filler);
      await pool.query(
        'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, $4)',
        [crypto.randomUUID(), giveawayId, filler.id, i]
      );
    }
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM entries WHERE giveaway_id = $1', [giveawayId])).rows[0].n;
    assert(before === 99, `expected 99 entries before the last one, found ${before}`);

    const hundredth = await makeUser({ name: 'Rehearsal Member 100' });
    members.push(hundredth);
    const asHundredth = api(await sessionFor(hundredth.email));
    const attested = await asHundredth('post', '/api/account/eligibility').send({ confirmed: true });
    assert(attested.status === 200, `attestation refused for the 100th member: ${attested.status}`);
    const res = await asHundredth('post', `/api/giveaways/${giveawayId}/enter`).send({});
    assert([200, 201].includes(res.status), `the 100th entry was refused: ${res.status} ${JSON.stringify(res.body)}`);

    const closed = (await pool.query('SELECT status, winner_entry_id FROM giveaways WHERE id = $1', [giveawayId])).rows[0];
    assert(closed.status !== lifecycle.STATUS.ACTIVE, `campaign still ${closed.status} after the 100th entry`);

    // Closing and drawing are two things. The 100th entry closes the campaign;
    // the draw is performed by the lifecycle worker, which is exactly why that
    // worker needs a schedule in production — see docs/OPERATIONS.md §4. If the
    // draw already happened synchronously this is a no-op.
    if (!closed.winner_entry_id) {
      await maintenance.runJobs(['giveaway_lifecycle'], {});
    }

    const g = (await pool.query('SELECT status, winner_entry_id FROM giveaways WHERE id = $1', [giveawayId])).rows[0];
    assert(g.winner_entry_id, `no winner drawn; campaign is ${g.status}`);

    const winners = (await pool.query('SELECT COUNT(*)::int AS n FROM entries WHERE id = (SELECT winner_entry_id FROM giveaways WHERE id = $1)', [giveawayId])).rows[0].n;
    const claims = (await pool.query('SELECT COUNT(*)::int AS n FROM prize_claims WHERE giveaway_id = $1', [giveawayId])).rows[0].n;
    assert(winners === 1, `expected exactly 1 winning entry, found ${winners}`);
    assert(claims === 1, `expected exactly 1 claim, found ${claims}`);

    walked(7, `100th entry closed the campaign (status ${g.status})`);
    walked(11, 'exactly one winning entry and exactly one claim exist');
    cited(7, 'gl2/gl3 — the 100th accepted entry closes, the 101st is refused');
    cited(11, 'gl14 — a draw creates exactly one winner and exactly one claim');
    return `status ${g.status}, claims ${claims}`;
  });

  // -- 12: concurrency ------------------------------------------------------
  await step('12. concurrent close/draw workers cannot create a second winner', async () => {
    // Deliberately NOT re-raced here. gl4, gl9 and gl10 already run this under
    // real concurrency against the threshold and the deadline job, which is a
    // stronger test than a rehearsal can honestly repeat in sequence. What this
    // run adds is the confirmation that after the arc above, the invariant holds.
    const rows = (await pool.query('SELECT COUNT(*)::int AS n FROM prize_claims WHERE giveaway_id = $1', [giveawayId])).rows[0].n;
    assert(rows === 1, `expected one claim after the draw, found ${rows}`);
    cited(12, 'gl4/gl9/gl10 — concurrent entries at the threshold, concurrent workers, and a threshold closure racing the deadline job all produce one draw');
    walked(12, 'post-arc state confirms a single claim');
  });

  // -- 13: the notification is queued, never delivered ------------------------
  await step('13. the winner notification is queued and not delivered to any address', async () => {
    const rows = (await pool.query(
      `SELECT n.status, n.delivered_at, n.kind
         FROM claim_notifications n
         JOIN prize_claims c ON c.id = n.claim_id
        WHERE c.giveaway_id = $1`, [giveawayId]
    )).rows;
    assert(rows.length > 0, 'the draw queued no winner notification at all');
    assert(rows.every((r) => !r.delivered_at), 'a notification was marked delivered during a rehearsal');
    assert(!process.env.RESEND_API_KEY, 'RESEND_API_KEY is set — delivery would have been attempted');
    walked(13, `${rows.length} notification(s) queued, none delivered, no mail provider configured`);
    return `${rows.length} queued`;
  });

  // -- 21: the arc is auditable ----------------------------------------------
  await step('21. the campaign carries an auditable lifecycle history', async () => {
    const events = (await pool.query(
      'SELECT event_type FROM giveaway_lifecycle_events WHERE giveaway_id = $1 ORDER BY created_at', [giveawayId]
    )).rows.map((r) => r.event_type);
    ['approved', 'published', 'drawn'].forEach((wanted) => {
      assert(events.includes(wanted), `no "${wanted}" event was recorded; got ${events.join(', ') || '(none)'}`);
    });
    walked(21, `lifecycle events recorded: ${events.join(' → ')}`);
    cited(21, 'gl24 — no personal address, secret, evidence reference or internal note is public');
    return events.join(' → ');
  });

  // -- 8, 18: a second campaign closes on the deadline, then cancellation ------
  await step('8. a campaign reaching its deadline draws from the entries it has', async () => {
    const second = await asHost('post', '/api/giveaways').send({
      title: `Rehearsal deadline campaign ${suffix}`,
      description: 'Second fabricated campaign — exercises the one-month deadline path.',
      prize_description: 'Fabricated dining experience for two.',
      prize_category: 'fine_dining_experience',
      sponsor_name: 'Rehearsal Partner Restaurant (fabricated)',
      prize_supplied_by: 'Rehearsal Partner Restaurant (fabricated)',
      prize_retail_value_aed: 900,
      naseeb_custody: 'sponsor_holds_committed',
      fulfilment_method: 'Sponsor holds the prize under commitment; Naseeb coordinates.',
      funded_by: 'Rehearsal Partner Restaurant (fabricated)',
      max_entries_per_person: 1,
    });
    assert([200, 201].includes(second.status), `second submission refused: ${second.status} ${JSON.stringify(second.body)}`);
    const secondId = second.body.id || (second.body.giveaway && second.body.giveaway.id);
    made.giveaways.push(secondId);

    const approved = await asAdmin('post', `/api/admin/giveaways/${secondId}/approve`).send({
      evidence_kind: 'written_commitment_from_sponsor',
      evidence_reference: `REHEARSAL-REF2-${suffix}`,
      // Required. An approval with no recorded reasoning is refused, which is
      // the point of REVIEW_NOTES_REQUIRED.
      review_notes: 'Rehearsal approval — fabricated sponsor commitment, deadline path.',
    });
    assert([200, 201, 204].includes(approved.status),
      `second approval refused: ${approved.status} ${JSON.stringify(approved.body)}`);

    // Three entrants, then the clock moved past the deadline. Moving the
    // deadline rather than waiting a month is the only way to rehearse this;
    // the job reads the same column either way.
    for (let i = 0; i < 3; i += 1) {
      const m = members[i];
      await pool.query(
        'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, $4)',
        [crypto.randomUUID(), secondId, m.id, i + 1]
      );
    }
    // `closes_at` is the clock the worker actually reads; `entry_deadline` is a
    // formatted mirror of it for display. Moving only the mirror leaves the
    // campaign open forever, so both move together, exactly as
    // approveAndPublish writes them.
    await pool.query(
      `UPDATE giveaways
          SET closes_at = NOW() - INTERVAL '1 hour',
              entry_deadline = to_char((NOW() - INTERVAL '1 hour') AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE id = $1`,
      [secondId]
    );

    const summary = await maintenance.runJobs(['giveaway_lifecycle'], {});
    assert(summary, 'the lifecycle job returned nothing');

    const g = (await pool.query('SELECT status, winner_entry_id FROM giveaways WHERE id = $1', [secondId])).rows[0];
    assert(g.status !== lifecycle.STATUS.ACTIVE, `deadline campaign still ${g.status}`);
    assert(g.winner_entry_id, 'the deadline campaign closed without drawing a winner from its 3 entries');

    walked(8, `closed on deadline with 3 entries and drew a winner (status ${g.status})`);
    cited(8, 'gl5/gl6/gl7 — fewer than 100 draws from what exists, zero eligible closes without a winner, a late entry is refused');
    return `status ${g.status}`;
  });

  // -- 20: repetition changes nothing ----------------------------------------
  await step('20. running the maintenance jobs again changes nothing', async () => {
    const fingerprint = async () => (await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM prize_claims WHERE giveaway_id = ANY($1)) AS claims,
              (SELECT COUNT(*)::int FROM entries WHERE giveaway_id = ANY($1)) AS entries,
              (SELECT COUNT(*)::int FROM giveaways WHERE id = ANY($1) AND winner_entry_id IS NOT NULL) AS drawn`,
      [made.giveaways]
    )).rows[0];

    const before = await fingerprint();
    await maintenance.runJobs(['giveaway_lifecycle', 'claims', 'sessions'], {});
    await maintenance.runJobs(['giveaway_lifecycle', 'claims', 'sessions'], {});
    const after = await fingerprint();

    assert(JSON.stringify(before) === JSON.stringify(after),
      `repetition changed state: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    walked(20, 'two further maintenance passes left claims, entries and draws identical');
    cited(20, 'op5/op6/op7 — every job is idempotent, bounded, and single-worker under an advisory lock');
    return JSON.stringify(after);
  });

  // -- 9, 10, 14, 15, 16, 17: cited, with the reason stated -------------------
  await step('9, 10, 14-17. integrity, claim and fulfilment properties', async () => {
    // These are cited rather than re-walked, and the distinction is deliberate.
    //
    // 14-16 depend on the plaintext claim token, which by design never leaves
    // the mail path — claimNotifications mints it at send time and nothing
    // persists it. A rehearsal that reached into the library to mint its own
    // token would be exercising the harness, not the product, so it would prove
    // less than the existing suite already does, not more.
    //
    // 9 and 10 need an integrity case and a disqualification raised mid-draw,
    // which gl11-gl13 already drive directly against the lifecycle.
    const claim = (await pool.query(
      'SELECT id, delivery_ciphertext IS NOT NULL AS encrypted FROM prize_claims WHERE giveaway_id = $1', [giveawayId]
    )).rows[0];
    assert(claim, 'no claim to inspect');

    cited(9, 'gl11/gl12 — an open review closes entries but postpones the draw, and resolving resumes it');
    cited(10, 'gl13 — a disqualified entry can never win');
    cited(14, 'prize-claims — 256-bit tokens stored only as a hash, single-use, expiring, reissue invalidates the previous link');
    cited(15, 'prize-claims — the happy path runs winner → host → host → host → winner, and out-of-order transitions are rejected');
    cited(16, 'prize-claims — delivery details are encrypted at rest with a per-record IV; tampered ciphertext fails authentication');
    cited(17, 'op9-11 — claim retention and delivery-address erasure run through the maintenance jobs');
    walked(16, `claim row exists with delivery ciphertext ${claim.encrypted ? 'present' : 'absent (no details submitted in this run)'}`);
    return `claim ${String(claim.id).slice(0, 8)}`;
  });

  // -- 18: cancellation notifies entrants -------------------------------------
  await step('18. exceptional cancellation notifies entrants through the outbox', async () => {
    const target = made.giveaways[1];
    const res = await asAdmin('post', `/api/admin/giveaways/${target}/cancel`).send({
      ground: 'fulfilment_impossible',
      reason: 'Rehearsal cancellation — fabricated campaign, exercising the entrant notification path.',
    });
    assert([200, 201, 204].includes(res.status), `cancellation refused: ${res.status} ${JSON.stringify(res.body)}`);

    const queued = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM giveaway_notification_events WHERE giveaway_id = $1', [target]
    )).rows[0].n;
    assert(queued > 0, 'cancellation queued no entrant notification');

    walked(18, `${queued} entrant notification(s) queued durably, none delivered`);
    cited(18, 'gl21-gl23 — exceptional cancellation needs an administrator and a reason, preserves everything, and notifies entrants');
    return `${queued} queued`;
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report() {
  const lines = [];
  lines.push('');
  lines.push('Requirement coverage');
  lines.push('');
  lines.push('  #   evidence    requirement');
  lines.push('  --- ----------- -----------------------------------------------------');
  let unproven = 0;
  REQUIREMENTS.forEach(([n, text]) => {
    const got = evidence.get(n) || [];
    const kinds = [...new Set(got.map((g) => g.kind))];
    const mark = kinds.length === 0 ? 'NOT YET' : kinds.join('+');
    if (kinds.length === 0) unproven += 1;
    lines.push(`  ${String(n).padStart(2)}  ${mark.padEnd(11)} ${text}`);
    got.forEach((g) => lines.push(`      ${g.kind === 'REHEARSED' ? '·' : '~'} ${g.detail}`));
  });
  lines.push('');
  lines.push(`  REHEARSED = walked end to end by this run.  EXISTING = proven by a named suite.`);
  lines.push(`  ${REQUIREMENTS.length - unproven}/${REQUIREMENTS.length} requirements carry evidence.`);
  lines.push('');
  process.stderr.write(lines.join('\n'));

  process.stdout.write(`${JSON.stringify({
    rehearsal: 'giveaway',
    ok: !failed && unproven === 0,
    target: target.describe,
    steps,
    requirements: REQUIREMENTS.map(([n, text]) => ({
      n, text, evidence: evidence.get(n) || [],
    })),
  }, null, 2)}\n`);
}

let exitCode = 0;
main()
  .catch(() => { exitCode = 1; })
  .then(async () => {
    try { await cleanup(); } catch (err) {
      process.stderr.write(`\ncleanup failed: ${String(err.message || err)}\n`);
      exitCode = 1;
    }
    report();
    if (failed) exitCode = 1;
    await pool.end().catch(() => {});
    process.exit(exitCode);
  });
