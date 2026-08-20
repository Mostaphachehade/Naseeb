// Must run before ./server/db is required — that module builds its Pool from
// process.env.DATABASE_URL at require time, so the guard has to have approved
// (and possibly rewritten) the target first. See testEnv.js.
const { configureTestEnv } = require('./testEnv');

configureTestEnv();

const request = require('supertest');
const app = require('./server/app');
const { pool, init } = require('./server/db');

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await init();
    initialized = true;
  }
}

// Tagged with a run-unique suffix so parallel/repeat test runs never collide
// on the UNIQUE(email) constraint, and so leftover rows (if a run crashes
// before cleanup) are easy to spot and hand-delete.
function uniqueEmail(tag = 'user') {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

// Sign-in is rate limited per IP and the suite signs in far more often than any
// one person would. A distinct forwarded address per attempt keeps the limiter
// doing its job for real callers instead of being switched off for the tests.
let ipCounter = 0;
function nextTestIp() {
  ipCounter += 1;
  return `10.99.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
}

const TEST_ORIGIN = process.env.APP_URL || 'http://localhost:3000';

// A signed-in browser, as far as the server is concerned.
//
// Authentication is an HttpOnly cookie now, so a test cannot hold a token and
// paste it into a header — it has to keep a cookie jar, which is what
// supertest's agent is. Every request also carries the two things a real
// browser sends: an Origin this site accepts, and the CSRF token the login
// response handed back.
function bindSession(agent, { csrf, user }) {
  const wrap = (method) => (path) => {
    const req = agent[method](path).set('Origin', TEST_ORIGIN);
    if (csrf) req.set('X-CSRF-Token', csrf);
    return req;
  };
  return {
    id: user ? user.id : null,
    user,
    csrf,
    agent,
    // The raw agent, for the handful of tests that deliberately omit the CSRF
    // header or the Origin to prove the refusal.
    raw: (method, path) => agent[method](path),
    get: wrap('get'),
    post: wrap('post'),
    patch: wrap('patch'),
    put: wrap('put'),
    delete: wrap('delete'),
  };
}

async function signIn(email, password = 'correcthorse123', { ip } = {}) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', ip || nextTestIp())
    .send({ email, password });
  if (res.status !== 200) {
    throw new Error(`sign-in failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return bindSession(agent, { csrf: res.body.csrf_token, user: res.body.user });
}

// ---------------------------------------------------------------------------
// Giveaways
// ---------------------------------------------------------------------------
//
// A campaign no longer publishes itself. `POST /api/giveaways` creates a
// SUBMISSION awaiting deliberate Naseeb approval, and approval is what sets the
// publication time, the 30-day closing deadline and the 100-entry target.
//
// Every test that needs a live campaign therefore needs two steps, so both live
// here rather than being copied into a dozen files where they would drift.
// Everything below is fabricated: no real sponsor, no real prize, no real value.

const crypto = require('crypto');

// The prize facts Naseeb reviews. A submission missing any of them is refused,
// which is the point — so the fixture supplies a complete, plausible one.
const FABRICATED_PRIZE = {
  prize_category: 'premium_electronics',
  sponsor_name: 'Fabricated Sponsor Ltd (test fixture)',
  prize_supplied_by: 'Fabricated Sponsor Ltd (test fixture)',
  prize_retail_value_aed: 4500,
  naseeb_custody: 'naseeb_holds',
  fulfilment_method: 'Collected from Naseeb, or couriered within the UAE (fabricated).',
  prize_restrictions: 'Fabricated fixture. No real restriction applies to a prize that does not exist.',
};

// A fabricated administrator, created once per process, used as the approving
// reviewer. Approval genuinely requires a named administrator — this is a real
// one in the test database, not a bypass of the check.
let fixtureAdminId = null;
async function fixtureAdmin() {
  if (fixtureAdminId) return fixtureAdminId;
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin,
                        age_attestation_status, age_attestation_version)
     VALUES ($1, 'Fixture Reviewer', $2,
             '$2a$04$fabricatedhashfabricatedhashfabricatedhashfabricated',
             TRUE, TRUE, 'confirmed', 'fixture')`,
    [id, `fixture-reviewer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`]
  );
  fixtureAdminId = id;
  return id;
}

// Submit a campaign over HTTP as a host, then approve it through the real
// lifecycle service. Returns the published campaign body.
async function publishGiveaway(session, overrides = {}) {
  const create = await session.post('/api/giveaways').send({
    title: 'Fabricated Giveaway',
    description: 'A fabricated listing for the test suite.',
    prize_description: 'A fabricated premium prize',
    funded_by: 'Fabricated marketing budget',
    ...FABRICATED_PRIZE,
    ...overrides,
  });
  if (create.status !== 201) {
    throw new Error(`giveaway submission failed (${create.status}): ${JSON.stringify(create.body)}`);
  }
  await approveGiveaway(create.body.id);
  const published = await pool.query('SELECT * FROM giveaways WHERE id = $1', [create.body.id]);
  return { ...create.body, ...published.rows[0] };
}

// Approve an existing submission through the real service, with a real
// administrator and real evidence fields. Nothing here bypasses a check.
async function approveGiveaway(giveawayId, options = {}) {
  // eslint-disable-next-line global-require -- test helper, load order matters
  const lifecycle = require('./server/lib/giveawayLifecycle');
  const adminId = options.actorUserId || (await fixtureAdmin());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await lifecycle.approveAndPublish(client, {
      giveawayId,
      actorUserId: adminId,
      reviewNotes: 'Fabricated fixture approval.',
      evidenceKind: 'prize_physically_inspected',
      evidenceReference: 'fixture-evidence-reference',
      ...options,
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A published campaign written straight to the database, for the tests that
// never go near HTTP. Governed and approved by the fixture administrator, so it
// looks exactly like one that went through the real route.
//
// `closesAt` is settable because several tests need a campaign whose deadline
// has already passed, which the route deliberately will not produce.
async function seedGiveaway({
  hostId,
  status = 'active',
  title = 'Fabricated Giveaway',
  closesAt = new Date(Date.now() + 30 * 86400000),
  winnerEntryId = null,
  entryTarget = 100,
  ...rest
} = {}) {
  const adminId = await fixtureAdmin();
  const id = rest.id || crypto.randomUUID();
  const closes = closesAt instanceof Date ? closesAt : new Date(closesAt);
  const closed = !['pending_approval', 'rejected', 'active'].includes(status);

  await pool.query(
    `INSERT INTO giveaways
       (id, host_id, title, description, prize_description, funded_by, entry_deadline,
        status, published_at, closes_at, entry_target,
        approved_at, approved_by, review_notes,
        prize_category, sponsor_name, prize_supplied_by, prize_retail_value_aed,
        naseeb_custody, fulfilment_method, prize_restrictions,
        prize_evidence_kind, prize_evidence_reference, prize_evidence_verified,
        prize_evidence_verified_at, prize_evidence_verified_by,
        prize_governance_version, submitted_at,
        entries_closed_at, entries_closed_reason, winner_entry_id, drawn_at, no_winner_reason)
     VALUES ($1, $2, $3, 'A fabricated listing for the test suite.', 'A fabricated premium prize',
             'Fabricated marketing budget', $4, $5, NOW() - INTERVAL '1 minute', $6, $7,
             NOW() - INTERVAL '1 minute', $8, 'Fabricated fixture approval.',
             $9, $10, $11, $12, $13, $14, $15,
             'prize_physically_inspected', 'fixture-evidence-reference', TRUE,
             NOW() - INTERVAL '1 minute', $8,
             1, NOW() - INTERVAL '2 minutes',
             $16, $17, $18, $19, $20)`,
    [
      id,
      hostId,
      title,
      closes.toISOString(),
      status,
      closes.toISOString(),
      entryTarget,
      adminId,
      FABRICATED_PRIZE.prize_category,
      FABRICATED_PRIZE.sponsor_name,
      FABRICATED_PRIZE.prize_supplied_by,
      FABRICATED_PRIZE.prize_retail_value_aed,
      FABRICATED_PRIZE.naseeb_custody,
      FABRICATED_PRIZE.fulfilment_method,
      FABRICATED_PRIZE.prize_restrictions,
      closed ? new Date().toISOString() : null,
      closed ? 'closing_deadline_reached' : null,
      winnerEntryId,
      status === 'drawn' ? new Date().toISOString() : null,
      status === 'closed_no_winner' ? 'no_entries_received' : null,
    ]
  );
  return id;
}

// Move a seeded campaign to `drawn`.
//
// Two steps rather than one, because the schema now refuses an incoherent
// outcome: `drawn` requires a winning entry and a draw time, so the entry has to
// exist before the campaign can claim it won. That is the constraint working.
async function markDrawn(giveawayId, winnerEntryId) {
  await pool.query(
    `UPDATE giveaways
        SET status = 'drawn', winner_entry_id = $2, drawn_at = NOW(),
            entries_closed_at = COALESCE(entries_closed_at, NOW()),
            entries_closed_reason = COALESCE(entries_closed_reason, 'closing_deadline_reached'),
            lifecycle_version = lifecycle_version + 1
      WHERE id = $1`,
    [giveawayId, winnerEntryId]
  );
}

// Close the pool, but drain the outboxes first.
//
// The entry and draw paths hand delivery to a background promise so the response
// does not wait on a provider. That promise takes a pool client — so a test file
// that ends the pool while one is in flight leaves a `connect()` waiting on a
// pool that will never serve it, and the process hangs at exit with every test
// already green. Settling first is the fix, and it belongs here rather than in
// twenty `after` hooks that would each have to remember it.
async function closePool() {
  // eslint-disable-next-line global-require -- test helper, load order matters
  await require('./server/lib/giveawayOutbox').settle();
  // eslint-disable-next-line global-require
  await require('./server/lib/emailChangeOutbox').settle();
  await pool.end();
}

// An unauthenticated caller that still looks like this site's own page — for
// posting to routes that do not need a session (signup, login, claim redeem).
function anon() {
  const agent = request.agent(app);
  return bindSession(agent, { csrf: null, user: null });
}

module.exports = {
  api: () => request(app),
  agent: () => request.agent(app),
  pool,
  ensureInit,
  uniqueEmail,
  signIn,
  anon,
  bindSession,
  nextTestIp,
  TEST_ORIGIN,
  FABRICATED_PRIZE,
  fixtureAdmin,
  publishGiveaway,
  approveGiveaway,
  seedGiveaway,
  markDrawn,
  closePool,
};
