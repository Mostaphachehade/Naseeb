// The pre-launch gate.
//
// ---------------------------------------------------------------------------
// What this protects
// ---------------------------------------------------------------------------
//
// The site is going to be publicly reachable before it is open for business.
// While the policies are drafts with no effective date, and while the winner
// fulfilment role model is unresolved, nothing a visitor does may create real
// operational state: no account, no campaign, no entry, no draw, no claim, no
// payment.
//
// `DEPLOYMENT_STATE` used to be informational — it chose an `X-Robots-Tag`, a
// banner and a line in `/readyz`, and gated no behaviour whatsoever. A
// deployment could describe itself as a private beta while accepting
// registrations and running draws. These tests exist so that cannot come back.
//
// Everything here runs against the isolated test database with fabricated data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const {
  api,
  pool,
  ensureInit,
  uniqueEmail,
  signIn,
  nextTestIp,
  seedGiveaway,
  FABRICATED_PRIZE,
  closePool,
} = require('../testHelpers');

const config = require('../server/lib/config');
const maintenance = require('../server/lib/maintenance');
const policies = require('../server/lib/policies');
const { FULFILMENT_ROLE_MODEL_RESOLVED } = require('../server/lib/claimStateMachine');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correcthorse123';
const created = { users: [], giveaways: [] };

before(async () => {
  await ensureInit();
});

after(async () => {
  if (created.giveaways.length) {
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

// Restores every variable it touched, whatever the body does.
async function withState(state, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DEPLOYMENT_STATE');
  const saved = process.env.DEPLOYMENT_STATE;
  if (state === undefined) delete process.env.DEPLOYMENT_STATE;
  else process.env.DEPLOYMENT_STATE = state;
  try {
    return await fn();
  } finally {
    if (had) process.env.DEPLOYMENT_STATE = saved;
    else delete process.env.DEPLOYMENT_STATE;
  }
}

async function makeUser(tag, { admin = false, hostStatus = 'approved' } = {}) {
  const id = crypto.randomUUID();
  const email = uniqueEmail(`pg-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status,
                        age_attestation_status, age_attestation_version)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, 'confirmed', '2026-08-eligibility-18')`,
    [id, `PG ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin, hostStatus]
  );
  created.users.push(id);
  return { id, email };
}

// ---------------------------------------------------------------------------
// 1. The state itself
// ---------------------------------------------------------------------------

test('pg1. a missing or misspelled DEPLOYMENT_STATE cannot start operations', () => {
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    // Unset, empty, whitespace, a typo, a plausible-looking invention — every
    // one of them resolves to the most restrictive state, not a permissive one.
    [undefined, '', '   ', 'PUBLIC_LAUNCH!', 'live', 'prod', 'public-launch', 'beta'].forEach(
      (value) => {
        const had = Object.prototype.hasOwnProperty.call(process.env, 'DEPLOYMENT_STATE');
        const saved = process.env.DEPLOYMENT_STATE;
        if (value === undefined) delete process.env.DEPLOYMENT_STATE;
        else process.env.DEPLOYMENT_STATE = value;
        try {
          assert.equal(
            config.deploymentState(),
            'pre_launch',
            `${JSON.stringify(value)} must not resolve to an operating state`
          );
          assert.equal(config.isPreLaunch(), true);
          assert.equal(config.operationsAllowed().ok, false);
          assert.equal(config.operationsAllowed().reason, 'pre_launch');
        } finally {
          if (had) process.env.DEPLOYMENT_STATE = saved;
          else delete process.env.DEPLOYMENT_STATE;
        }
      }
    );
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  }
});

test('pg2. no real-activity state can operate while a launch blocker stands', async () => {
  // Both policies are drafts, and the fulfilment role model is unresolved. So
  // even somebody who deliberately sets a real-activity state gets a refusal —
  // the gate is not a label, it is a check against facts.
  assert.equal(FULFILMENT_ROLE_MODEL_RESOLVED, false, 'the mismatch is recorded in code');
  assert.ok(
    config.launchBlockers().some((b) => /winner-fulfilment role model is unresolved/.test(b)),
    'and it is a launch blocker'
  );
  Object.values(policies.POLICIES).forEach((p) => {
    assert.equal(p.status, 'draft');
    assert.equal(p.effectiveDate, null);
  });

  for (const state of ['private_beta', 'public_launch']) {
    // eslint-disable-next-line no-await-in-loop
    await withState(state, async () => {
      const verdict = config.operationsAllowed();
      assert.equal(verdict.ok, false, `${state} must not operate`);
      assert.equal(verdict.reason, 'launch_blockers_outstanding');
    });
  }

  // And `pre_launch` refuses for the simpler reason.
  await withState('pre_launch', async () => {
    assert.equal(config.operationsAllowed().reason, 'pre_launch');
  });
});

// ---------------------------------------------------------------------------
// 2. Every operational entry point
// ---------------------------------------------------------------------------

test('pg3. pre-launch refuses registration, submission, entry, draw, publication and claim', async () => {
  // Built while operations ARE allowed, so the fixtures exist to be refused
  // against. The refusals below are the whole point.
  const host = await makeUser('gate-host');
  const admin = await makeUser('gate-admin', { admin: true });
  const entrant = await makeUser('gate-entrant');

  const giveawayId = await seedGiveaway({ hostId: host.id });
  created.giveaways.push(giveawayId);
  const pending = await seedGiveaway({ hostId: host.id, status: 'pending_approval' });
  created.giveaways.push(pending);
  const closed = await seedGiveaway({
    hostId: host.id,
    status: 'closed_pending_draw',
    closesAt: new Date(Date.now() - 60000),
  });
  created.giveaways.push(closed);

  const hostSession = await signIn(host.email, PASSWORD);
  const adminSession = await signIn(admin.email, PASSWORD);
  const entrantSession = await signIn(entrant.email, PASSWORD);

  const before = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM giveaways) AS giveaways,
            (SELECT COUNT(*)::int FROM entries) AS entries,
            (SELECT COUNT(*)::int FROM prize_claims) AS claims`
  );

  await withState('pre_launch', async () => {
    const attempts = [
      [
        'signup',
        await api().post('/api/auth/signup').set('X-Forwarded-For', nextTestIp()).send({
          name: 'Would Be Member',
          email: uniqueEmail('never-registered'),
          password: PASSWORD,
          age_confirmed: true,
        }),
      ],
      [
        'submit_giveaway',
        await hostSession.post('/api/giveaways').send({
          title: 'Would Be Campaign',
          description: 'd',
          prize_description: 'p',
          funded_by: 'f',
          ...FABRICATED_PRIZE,
        }),
      ],
      [
        'publish_giveaway',
        await adminSession.post(`/api/admin/giveaways/${pending}/approve`).send({
          review_notes: 'Fabricated fixture.',
          evidence_kind: 'purchase_receipt_sighted',
          evidence_reference: 'fixture-ref',
        }),
      ],
      [
        'enter_giveaway',
        await entrantSession
          .post(`/api/giveaways/${giveawayId}/enter`)
          .set('X-Forwarded-For', nextTestIp()),
      ],
      ['draw_winner', await hostSession.post(`/api/giveaways/${closed}/draw`).send({})],
      [
        'start_claim',
        await api()
          .post('/api/claims/redeem')
          .set('X-Forwarded-For', nextTestIp())
          .send({ token: 'fabricated-token', consent: true }),
      ],
    ];

    attempts.forEach(([action, res]) => {
      assert.equal(res.status, 503, `${action} must be refused, got ${res.status}`);
      assert.equal(res.body.code, 'NOT_OPEN_YET', `${action}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.deployment_state, 'pre_launch');
      assert.equal(res.body.action, action);
      // A category and a coarse state. Never the blocker list, which names
      // outstanding legal work and missing provider configuration.
      const rendered = JSON.stringify(res.body);
      assert.ok(!/blocker/i.test(rendered), `${action} must not enumerate blockers`);
      assert.ok(!/counsel|RESEND|SESSION_SECRET|DATABASE/i.test(rendered), action);
    });

    // The unattended worker refuses too. It would find nothing anyway — but
    // "would find nothing" is a fact about the data, and the gate is a fact
    // about the deployment.
    const job = await maintenance.JOBS.giveaway_lifecycle();
    assert.equal(job.skipped_reason, 'pre_launch');
    assert.equal(job.drawn, 0);
    assert.equal(job.closed, 0);
  });

  // Nothing was written. Not a half-made account, not a campaign, not an entry,
  // not a claim.
  const after = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM giveaways) AS giveaways,
            (SELECT COUNT(*)::int FROM entries) AS entries,
            (SELECT COUNT(*)::int FROM prize_claims) AS claims`
  );
  assert.deepEqual(after.rows[0], before.rows[0], 'a refused request writes nothing');

  // And the states it was refused from are unchanged.
  const still = await pool.query('SELECT status FROM giveaways WHERE id = ANY($1) ORDER BY status', [
    [giveawayId, pending, closed],
  ]);
  assert.deepEqual(still.rows.map((r) => r.status).sort(), [
    'active',
    'closed_pending_draw',
    'pending_approval',
  ]);
});

test('pg4. a draft policy can never be accepted, in any state', async () => {
  const member = await makeUser('policy-member', { hostStatus: 'not_requested' });
  const session = await signIn(member.email, PASSWORD);

  for (const state of [undefined, 'pre_launch', 'private_beta', 'public_launch', 'development']) {
    // eslint-disable-next-line no-await-in-loop
    await withState(state, async () => {
      for (const policyId of ['terms', 'privacy']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await session.post(`/api/account/policies/${policyId}/accept`).send({});
        assert.equal(res.status, 409, `${state}/${policyId} got ${res.status}`);
        assert.equal(res.body.code, 'POLICY_IS_DRAFT');
      }
    });
  }

  const recorded = await pool.query('SELECT COUNT(*)::int AS n FROM policy_acceptances WHERE user_id = $1', [
    member.id,
  ]);
  assert.equal(recorded.rows[0].n, 0, 'nothing was recorded against a draft');
});

test('pg5. advertiser checkout and payment stay off', async () => {
  const flags = require('../server/lib/featureFlags');
  assert.equal(flags.isAdsCheckoutEnabled(), false);

  const res = await api()
    .post('/api/ads/checkout')
    .set('X-Forwarded-For', nextTestIp())
    .send({ weeks: 1 });
  assert.ok([503, 401, 403, 400].includes(res.status), `got ${res.status}`);
  if (res.status === 503) {
    assert.ok(!/stripe/i.test(JSON.stringify(res.body)), 'no provider is named');
  }

  // Committed configuration pins it off rather than leaving it to a dashboard.
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.match(render, /ADS_CHECKOUT_ENABLED\s*\n\s*value:\s*false/);
});

// ---------------------------------------------------------------------------
// 3. What the site says about itself
// ---------------------------------------------------------------------------

test('pg6. the site says it is not open, and claims nothing it has not done', async () => {
  await withState('pre_launch', async () => {
    const res = await api().get('/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.deployment_state, 'pre_launch');
    assert.equal(res.body.is_public_launch, false);
    assert.equal(res.body.accepting_operations, false);
    assert.match(res.body.pre_launch_notice, /not open yet/i);
    assert.match(res.body.pre_launch_notice, /does not accept|nothing here accepts/i);

    // Still no blocker detail, no configuration, no secret.
    const rendered = JSON.stringify(res.body);
    assert.ok(!/blocker/i.test(rendered));
    assert.ok(!/RESEND|SESSION_SECRET|DATABASE_URL|STRIPE|SENTRY/.test(rendered));

    // And it is not indexable.
    const page = await api().get('/');
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
  });

  // The banner renders the notice, and cannot be dismissed.
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  assert.match(appJs, /accepting_operations === false/);
  assert.match(appJs, /Launching soon/);
  assert.match(appJs, /pre_launch: 'Not open yet'/);

  // No page claims Naseeb is licensed, registered, operating or approved, and
  // none states the fulfilment workflow as something already running.
  const pages = fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(ROOT, 'public', f));

  pages.forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    [
      /\bwe are (a )?(licensed|registered|VAT[- ]registered)\b/i,
      /\blegally approved\b/i,
      // Unambiguous assertions only. English is not worth parsing here: "Once
      // these terms have been approved by counsel…" is the honest future form
      // and any pattern loose enough to catch a false claim also catches that.
      // So the check is a short list of phrases that could only be untrue.
      /\bcounsel has (approved|signed off)\b/i,
      /\breviewed and approved by (qualified )?(UAE )?counsel\b/i,
      /\bthese terms are (now )?(in )?effect(ive)?\b/i,
      /\bNaseeb is (a )?(licensed|registered|VAT[- ]registered)\b/i,
      /\bwe (currently )?operate commercially\b/i,
      /\bNaseeb coordinates fulfilment\b/,
      /\bNaseeb is the winner-facing contact\b/,
    ].forEach((claim) => {
      assert.ok(!claim.test(text), `${path.basename(file)} must not claim ${claim}`);
    });
    assert.ok(!/chatle\.ent@outlook/i.test(text), `${path.basename(file)} must not publish a personal email`);
  });
});

test('pg7. readiness stays green in pre-launch and reports the state truthfully', async () => {
  await withState('pre_launch', async () => {
    const res = await api().get('/readyz');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deployment, 'pre_launch');
    // A deployment that is deliberately not operating is still HEALTHY. A
    // readiness probe that failed here would take the instance out of rotation
    // and the site would be down rather than closed.
    assert.equal(res.body.status, 'ready');
  });

  const live = await api().get('/healthz');
  assert.equal(live.status, 200);
});
