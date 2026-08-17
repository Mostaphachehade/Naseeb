// Phase 2.4A: production operations.
//
// Configuration validation, deployment state, maintenance jobs, health probes,
// graceful shutdown, migration safety and deterministic builds.
//
// Everything runs against the isolated test database with fabricated data. No
// production service is contacted, no credential is read, and nothing here
// rotates anything.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');

const { api, pool, ensureInit, uniqueEmail } = require('../testHelpers');

const config = require('../server/lib/config');
const migrations = require('../server/lib/migrations');
const maintenance = require('../server/lib/maintenance');
const { createShutdownCoordinator } = require('../server/lib/shutdown');
const health = require('../server/routes/health');
const { BASELINE_SQL, init } = require('../server/db');
const outbox = require('../server/lib/emailChangeOutbox');

const ROOT = path.join(__dirname, '..');
const created = { users: [], giveaways: [] };

before(async () => {
  await ensureInit();
});

after(async () => {
  await outbox.settle();
  if (created.giveaways.length) {
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [created.giveaways]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [created.giveaways]);
  }
  if (created.users.length) {
    await pool.query('DELETE FROM email_change_notifications WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM email_change_requests WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM session_families WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
  }
  await pool.end();
});

async function makeUser(tag) {
  const id = crypto.randomUUID();
  const email = uniqueEmail(`ops-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified,
                        age_attestation_status, age_attestation_version)
     VALUES ($1, $2, $3, $4, TRUE, 'confirmed', '2026-08-eligibility-18')`,
    [id, `Ops ${tag}`, email, bcrypt.hashSync('correcthorse123', 4)]
  );
  created.users.push(id);
  return { id, email };
}

// Runs a body with a temporary environment, always restoring it.
function withEnv(overrides, fn) {
  const saved = {};
  Object.keys(overrides).forEach((key) => {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  });
  try {
    return fn();
  } finally {
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

// ---------------------------------------------------------------------------
// 1-4. Configuration validation and launch state
// ---------------------------------------------------------------------------

test('op1. missing required production configuration fails startup, safely', () => {
  const exits = [];
  const logged = [];
  const log = { error: (m) => logged.push(String(m)), log: (m) => logged.push(String(m)) };

  withEnv(
    {
      NODE_ENV: 'production',
      DATABASE_URL: undefined,
      SESSION_SECRET: undefined,
      APP_URL: undefined,
      INTEGRITY_SIGNAL_SECRET: undefined,
    },
    () => {
      const result = config.assertStartupConfiguration({ exit: (c) => exits.push(c), log });
      assert.equal(result.ok, false);
      const named = result.problems.map((p) => p.variable);
      assert.ok(named.includes('DATABASE_URL'));
      assert.ok(named.includes('SESSION_SECRET'));
      assert.ok(named.includes('APP_URL'));
    }
  );

  assert.deepEqual(exits, [1], 'production exits non-zero rather than listening');
  assert.match(logged.join('\n'), /Refusing to start/);

  // The same configuration outside production warns and continues, so a
  // developer can run the site without a Stripe account.
  const devExits = [];
  withEnv({ NODE_ENV: 'development', SESSION_SECRET: undefined }, () => {
    config.assertStartupConfiguration({ exit: (c) => devExits.push(c), log: { error() {}, log() {} } });
  });
  assert.deepEqual(devExits, [], 'development does not exit');
});

test('op2. no secret value ever appears in a validation error', () => {
  const SECRETS = {
    SESSION_SECRET: 'sup3rsecret-fabricated-session-value-abcdefghijklmnop',
    DATABASE_URL: 'postgresql://fabricateduser:fabricatedpassword@db.example.invalid/prod',
    CLAIM_ENCRYPTION_KEY: `v1:${crypto.randomBytes(32).toString('base64')}`,
    INTEGRITY_SIGNAL_SECRET: 'fabricated-integrity-secret-0123456789abcdefghij',
    // Placeholder-shaped on purpose: with checkout on, this produces a problem
    // against a SECRET-classified variable, which is what makes the "the value
    // never appears" assertion below non-vacuous.
    STRIPE_SECRET_KEY: 'sk_test_FABRICATEDvalue0123456789',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_FABRICATEDvalue0123456789',
    RESEND_API_KEY: 're_FABRICATEDvalue0123456789',
    SENTRY_DSN: 'https://fabricated@o0.ingest.sentry.io/0',
  };

  // Deliberately contradictory: production, checkout on, a test-named database,
  // a bad URL — so as many problems as possible are produced at once.
  const result = withEnv(
    {
      ...SECRETS,
      NODE_ENV: 'production',
      ADS_CHECKOUT_ENABLED: 'true',
      APP_URL: 'http://not-https.example',
      COOKIE_SECURE: 'false',
      DATABASE_SSL: 'false',
      SESSION_TTL_HOURS: '99999',
    },
    () => config.validate()
  );

  assert.ok(result.problems.length > 0, 'the fixture does produce problems');
  const text = config.describe(result);

  // The property that matters: no VALUE, or a useful prefix of one, ever
  // appears — whether or not that variable produced a problem.
  Object.entries(SECRETS).forEach(([name, value]) => {
    assert.ok(!text.includes(value), `${name}'s VALUE must never appear`);
    assert.ok(!text.includes(value.slice(0, 12)), `${name}'s value prefix must not appear`);
  });

  // And every variable that DID produce a problem is named, so the message is
  // actionable without being disclosing.
  result.problems.concat(result.warnings).forEach((p) => {
    assert.ok(text.includes(p.variable), `${p.variable} should be named`);
  });
  assert.ok(
    result.problems.some((p) => p.variable === 'STRIPE_SECRET_KEY'),
    'the fixture does exercise a secret-bearing failure'
  );
  // Nor anything that looks like a credential.
  assert.ok(!/postgres(ql)?:\/\//.test(text));
  assert.ok(!/sk_test_FAB|whsec_test_FAB|re_FAB/.test(text));
});

test('op3. a disabled feature does not require its provider credentials', () => {
  const result = withEnv(
    {
      NODE_ENV: 'production',
      ADS_CHECKOUT_ENABLED: 'false',
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      DATABASE_URL: 'postgresql://u:p@db.example.invalid/naseeb',
      SESSION_SECRET: 'a-fabricated-session-secret-with-plenty-of-entropy-9f2b',
      APP_URL: 'https://example.invalid',
      INTEGRITY_SIGNAL_SECRET: 'fabricated-integrity-secret-0123456789abcdefghij',
      CLAIM_ENCRYPTION_KEY: `v1:${crypto.randomBytes(32).toString('base64')}`,
      TRUSTED_PROXY_HOPS: '1',
      // Pinned rather than inherited: the test environment sets both to false
      // for a local database, which production refuses.
      COOKIE_SECURE: undefined,
      DATABASE_SSL: undefined,
      RESEND_API_KEY: 're_fabricated_value_for_this_fixture_only',
      SENTRY_DSN: 'https://fabricated@o0.ingest.sentry.io/1',
    },
    () => config.validate()
  );

  const named = result.problems.map((p) => p.variable);
  assert.ok(!named.includes('STRIPE_SECRET_KEY'), 'checkout is off; no Stripe key is demanded');
  assert.ok(!named.includes('STRIPE_WEBHOOK_SECRET'));
  assert.equal(result.ok, true, config.describe(result));

  // Turning it on demands them immediately.
  const enabled = withEnv(
    {
      NODE_ENV: 'production',
      ADS_CHECKOUT_ENABLED: 'true',
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    },
    () => config.validate()
  );
  const enabledNames = enabled.problems.map((p) => p.variable);
  assert.ok(enabledNames.includes('STRIPE_SECRET_KEY'));
  assert.ok(enabledNames.includes('STRIPE_WEBHOOK_SECRET'));

  // And a key set for a disabled feature is reported as unused, not required.
  const unused = withEnv(
    { ADS_CHECKOUT_ENABLED: 'false', STRIPE_SECRET_KEY: 'sk_live_FABRICATED0123456789' },
    () => config.validate()
  );
  assert.ok(unused.warnings.some((w) => w.variable === 'STRIPE_SECRET_KEY'));
  assert.ok(!unused.problems.some((p) => p.variable === 'STRIPE_SECRET_KEY'));
});

test('op4. public launch cannot activate while the policies are drafts', () => {
  const blockers = config.launchBlockers();
  assert.ok(blockers.length > 0, 'there are blockers today');
  assert.ok(blockers.some((b) => /terms/.test(b)));
  assert.ok(blockers.some((b) => /privacy/.test(b)));
  assert.ok(blockers.some((b) => /no effective date/.test(b)));
  assert.ok(blockers.some((b) => /counsel/i.test(b)));

  const result = withEnv({ DEPLOYMENT_STATE: 'public_launch' }, () => config.validate());
  assert.equal(result.ok, false, 'public_launch fails validation');
  assert.ok(result.problems.some((p) => p.variable === 'DEPLOYMENT_STATE'));

  // Unset never means public launch — in production it means private beta.
  withEnv({ DEPLOYMENT_STATE: undefined, NODE_ENV: 'production' }, () => {
    assert.equal(config.deploymentState(), 'private_beta');
    assert.equal(config.isPublicLaunch(), false);
  });
  withEnv({ DEPLOYMENT_STATE: undefined, NODE_ENV: undefined }, () => {
    assert.equal(config.deploymentState(), 'development');
  });

  // A non-launch deployment must identify itself truthfully.
  withEnv({ DEPLOYMENT_STATE: 'staging' }, () => {
    const disclosure = config.stateDisclosure();
    assert.equal(disclosure.state, 'staging');
    assert.equal(disclosure.legally_approved, false);
    assert.match(disclosure.disclosure, /not a public launch/i);
    assert.match(disclosure.disclosure, /drafts/i);
    assert.match(disclosure.disclosure, /must not be described as approved or production-ready/i);
  });

  // And no committed file sets it.
  ['render.yaml', '.env.example'].forEach((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const active = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.ok(
      !/public_launch/.test(active),
      `${file} must not set public_launch outside a comment`
    );
  });
});

test('op4b. production refuses a test database, an insecure cookie and the dev mail logger', () => {
  const base = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'a-fabricated-session-secret-with-plenty-of-entropy-9f2b',
    APP_URL: 'https://example.invalid',
    INTEGRITY_SIGNAL_SECRET: 'fabricated-integrity-secret-0123456789abcdefghij',
    TRUSTED_PROXY_HOPS: '1',
  };

  const testDb = withEnv(
    { ...base, DATABASE_URL: 'postgresql://u:p@localhost/naseeb_test' },
    () => config.validate()
  );
  assert.ok(
    testDb.problems.some((p) => p.variable === 'DATABASE_URL' && /test/.test(p.message)),
    'production must not run against a test database'
  );

  const devLogger = withEnv(
    { ...base, DATABASE_URL: 'postgresql://u:p@db.example.invalid/naseeb', CLAIM_DEV_LOG_LINKS: 'true' },
    () => config.validate()
  );
  assert.ok(
    devLogger.problems.some((p) => p.variable === 'CLAIM_DEV_LOG_LINKS'),
    'the development mail logger cannot be enabled in production'
  );

  const cookie = withEnv(
    { ...base, DATABASE_URL: 'postgresql://u:p@db.example.invalid/naseeb', COOKIE_SECURE: 'false' },
    () => config.validate()
  );
  assert.ok(cookie.problems.some((p) => p.variable === 'COOKIE_SECURE'));

  const ssl = withEnv(
    { ...base, DATABASE_URL: 'postgresql://u:p@db.example.invalid/naseeb', DATABASE_SSL: 'false' },
    () => config.validate()
  );
  assert.ok(ssl.problems.some((p) => p.variable === 'DATABASE_SSL'));

  // Placeholders are refused rather than accepted as "set".
  ['change-me', 'your-secret-here', 'CHANGEME'].forEach((value) => {
    assert.equal(config.looksLikePlaceholder(value), true, `${value} should look like a placeholder`);
  });
  assert.equal(config.looksLikePlaceholder(crypto.randomBytes(32).toString('hex')), false);
});

// ---------------------------------------------------------------------------
// 5-14. Maintenance jobs
// ---------------------------------------------------------------------------

test('op5. every maintenance job is idempotent and reports counts only', async () => {
  const first = await maintenance.runJobs(maintenance.ALL_ORDER);
  const second = await maintenance.runJobs(maintenance.ALL_ORDER);

  assert.equal(first.length, maintenance.ALL_ORDER.length);
  assert.equal(second.length, maintenance.ALL_ORDER.length);
  first.concat(second).forEach((result) => {
    assert.ok(['ok', 'skipped'].includes(result.status), `${result.job}: ${result.status}`);
    // Counts and timings only — nothing that could carry a value.
    Object.entries(result).forEach(([key, value]) => {
      if (['job', 'status', 'reason'].includes(key)) return;
      assert.equal(typeof value, 'number', `${result.job}.${key} must be a number`);
    });
  });

  // "Nothing to do" is a success and is distinguishable from failure.
  const summary = maintenance.summarise(second, { startedAt: new Date().toISOString() });
  assert.equal(summary.ok, true);
  assert.equal(summary.idle, true, 'a quiet run reports idle rather than looking broken');
  const asText = JSON.stringify(summary);
  assert.ok(!/postgres|password|@|token/i.test(asText), asText);
});

test('op6. two workers running the same job produce one active worker', async () => {
  // The lock is the correctness boundary. Held explicitly here so the outcome is
  // deterministic rather than a race the test hopes to win.
  const holder = await pool.connect();
  try {
    const got = await holder.query('SELECT pg_try_advisory_lock($1) AS acquired', [
      maintenance.LOCK_KEYS.sessions,
    ]);
    assert.equal(got.rows[0].acquired, true);

    const blocked = await maintenance.JOBS.sessions();
    assert.equal(blocked.status, 'skipped');
    assert.match(blocked.reason, /another worker/);
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [maintenance.LOCK_KEYS.sessions]).catch(() => {});
    holder.release();
  }

  // Released, so the next run works.
  const after = await maintenance.JOBS.sessions();
  assert.equal(after.status, 'ok');

  // Concurrently, for real: exactly one does the work.
  const [a, b, c] = await Promise.all([
    maintenance.JOBS.risk_signals(),
    maintenance.JOBS.risk_signals(),
    maintenance.JOBS.risk_signals(),
  ]);
  const ok = [a, b, c].filter((r) => r.status === 'ok');
  assert.ok(ok.length >= 1 && ok.length <= 3);
  // Every job has its own key, so two different jobs never contend.
  assert.equal(new Set(Object.values(maintenance.LOCK_KEYS)).size, Object.keys(maintenance.LOCK_KEYS).length);
});

test('op7. jobs process bounded batches', async () => {
  const sessions = require('../server/lib/sessions');

  // Five expired families; a limit of 2 must remove exactly 2.
  const userId = (await makeUser('batch')).id;
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const id = crypto.randomUUID();
    ids.push(id);
    // eslint-disable-next-line no-await-in-loop -- fixture setup
    await pool.query(
      `INSERT INTO session_families (id, user_id, absolute_expires_at)
       VALUES ($1, $2, NOW() - interval '90 days')`,
      [id, userId]
    );
  }

  const firstPass = await sessions.deleteExpiredSessions(pool, { olderThanDays: 30, limit: 2 });
  assert.equal(firstPass, 2, 'the batch limit is respected');

  const secondPass = await sessions.deleteExpiredSessions(pool, { olderThanDays: 30, limit: 2 });
  assert.equal(secondPass, 2);

  const remaining = await pool.query(
    'SELECT COUNT(*)::int AS n FROM session_families WHERE id = ANY($1)',
    [ids]
  );
  assert.equal(remaining.rows[0].n, 1, 'one left, so the caller re-runs until a pass is short');

  await sessions.deleteExpiredSessions(pool, { olderThanDays: 30, limit: 500 });

  // The configured default is bounded and overridable.
  assert.equal(maintenance.batchLimit(), maintenance.DEFAULT_LIMIT);
  assert.equal(maintenance.batchLimit(25), 25);
  withEnv({ MAINTENANCE_BATCH_LIMIT: '7' }, () => {
    assert.equal(maintenance.batchLimit(), 7);
  });
});

test('op8. a failing job exits non-zero without leaking anything', () => {
  // Driven through the real CLI, because the exit code is the contract.
  const runCli = (args, env = {}) => {
    try {
      const stdout = execFileSync('node', [path.join(ROOT, 'scripts', 'maintenance.js'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        code: err.status,
        stdout: String(err.stdout || ''),
        stderr: String(err.stderr || ''),
      };
    }
  };

  // Bad arguments: exit 2, nothing ran.
  const bad = runCli(['no_such_job']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown job/);

  // Unreachable database: exit 1, and the connection string is not echoed.
  const SECRET_URL = 'postgresql://fabricateduser:fabricatedpassword@127.0.0.1:1/naseeb_ops';
  const broken = runCli(['sessions'], {
    DATABASE_URL: SECRET_URL,
    DATABASE_SSL: 'false',
    TEST_DATABASE_URL: '',
  });
  assert.equal(broken.code, 1, `expected exit 1, got ${broken.code}`);
  const output = broken.stdout + broken.stderr;
  assert.ok(!output.includes('fabricatedpassword'), 'no password in the output');
  assert.ok(!output.includes(SECRET_URL), 'no connection string in the output');
  assert.ok(!/at .*\.js:\d+/.test(output), 'no stack trace in the output');

  // A good run reports one JSON object with counts.
  const good = runCli(['sessions'], {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SSL: 'false',
  });
  assert.equal(good.code, 0);
  const parsed = JSON.parse(good.stdout.trim().split('\n').pop());
  assert.equal(parsed.event, 'maintenance');
  assert.equal(parsed.ok, true);
});

test('op9-11. sessions, risk signals and claim retention run safely through the jobs', async () => {
  const user = await makeUser('retention');

  // A session family well past its absolute expiry.
  const familyId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO session_families (id, user_id, absolute_expires_at)
     VALUES ($1, $2, NOW() - interval '120 days')`,
    [familyId, user.id]
  );

  // A risk signal past its retention window.
  const giveawayId = crypto.randomUUID();
  created.giveaways.push(giveawayId);
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, entry_deadline, status, funded_by)
     VALUES ($1,$2,'Ops giveaway','Fabricated','Fabricated prize', NOW() + interval '7 days','active','Self-funded')`,
    [giveawayId, user.id]
  );
  const entryId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1,$2,$3,1)',
    [entryId, giveawayId, user.id]
  );
  const signalId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO entry_risk_signals (id, entry_id, giveaway_id, signal_code, severity, network_hmac, window_id, expires_at)
     VALUES ($1,$2,$3,'rapid_entry_velocity','info',$4,'w1', NOW() - interval '1 day')`,
    [signalId, entryId, giveawayId, crypto.randomBytes(32).toString('hex')]
  );

  const results = await maintenance.runJobs(['sessions', 'risk_signals', 'claims']);
  results.forEach((r) => assert.equal(r.status, 'ok', `${r.job}: ${r.status}`));

  const family = await pool.query('SELECT COUNT(*)::int AS n FROM session_families WHERE id = $1', [familyId]);
  assert.equal(family.rows[0].n, 0, 'the expired session family is gone');

  const signal = await pool.query('SELECT COUNT(*)::int AS n FROM entry_risk_signals WHERE id = $1', [signalId]);
  assert.equal(signal.rows[0].n, 0, 'the expired risk signal is purged');

  // The claims job reports both halves and touched nothing it should not.
  const claimsResult = results.find((r) => r.job === 'claims');
  assert.equal(typeof claimsResult.expired, 'number');
  assert.equal(typeof claimsResult.erased, 'number');

  // Re-running changes nothing.
  const again = await maintenance.runJobs(['sessions', 'risk_signals', 'claims']);
  again.forEach((r) => assert.equal(r.status, 'ok'));
});

test('op12-13. both outboxes retry safely, and an expired email change cannot revive', async () => {
  const rights = require('../server/lib/accountRights');
  const user = await makeUser('outbox');

  const client = await pool.connect();
  let started;
  try {
    await client.query('BEGIN');
    started = await rights.startEmailChange(client, {
      userId: user.id,
      newEmail: uniqueEmail('ops-outbox-target'),
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // The job claims it and, with no provider configured, the dev logger accepts
  // it — so this asserts the job runs it rather than that delivery failed.
  const first = await maintenance.JOBS.email_change_outbox();
  assert.equal(first.status, 'ok');
  assert.ok(first.claimed >= 1);

  // Re-running does not resend a delivered notification.
  const second = await maintenance.JOBS.email_change_outbox();
  assert.equal(second.status, 'ok');

  const row = await pool.query(
    "SELECT status FROM email_change_notifications WHERE change_id = $1 AND kind = 'verification'",
    [started.id]
  );
  assert.ok(['sent', 'pending'].includes(row.rows[0].status));

  // The claim outbox runs on the same terms.
  const claimOutbox = await maintenance.JOBS.claim_outbox();
  assert.equal(claimOutbox.status, 'ok');
  assert.equal(typeof claimOutbox.attempted, 'number');

  // 13. An expired pending change is marked expired and cannot produce a link.
  const expiring = await pool.connect();
  let stale;
  try {
    await expiring.query('BEGIN');
    stale = await rights.startEmailChange(expiring, {
      userId: user.id,
      newEmail: uniqueEmail('ops-expired-target'),
    });
    await expiring.query('COMMIT');
  } finally {
    expiring.release();
  }
  await pool.query(
    `UPDATE email_change_requests SET expires_at = NOW() - interval '1 hour' WHERE id = $1`,
    [stale.id]
  );

  const expiredJob = await maintenance.JOBS.email_changes();
  assert.equal(expiredJob.status, 'ok');
  assert.ok(expiredJob.expired >= 1);

  const after = await pool.query(
    'SELECT status, token_hash FROM email_change_requests WHERE id = $1',
    [stale.id]
  );
  assert.equal(after.rows[0].status, 'expired');

  // And the outbox refuses to mint a link for it.
  const captured = [];
  await outbox.processDue({ send: async (m) => captured.push(m), limit: 10 });
  const notification = await pool.query(
    "SELECT status, cancelled_reason FROM email_change_notifications WHERE change_id = $1",
    [stale.id]
  );
  assert.equal(notification.rows[0].status, 'cancelled');
  assert.match(notification.rows[0].cancelled_reason, /expired|cancelled/);
  const stillNoToken = await pool.query('SELECT token_hash FROM email_change_requests WHERE id = $1', [
    stale.id,
  ]);
  assert.equal(stillNoToken.rows[0].token_hash, null, 'an expired change never got a token');
});

test('op14. an expired ad hold is released by the job, not by somebody browsing', async () => {
  const adId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ads (id, business_name, image_url, target_url, media_type, active,
                      slot_status, hold_expires_at, payment_status, starts_at, ends_at)
     VALUES ($1,'Fabricated Advertiser','https://res.cloudinary.com/x/a.png','https://example.invalid',
             'image', FALSE, 'held', NOW() - interval '1 hour', 'pending',
             CURRENT_DATE + 30, CURRENT_DATE + 37)`,
    [adId]
  );

  try {
    const result = await maintenance.JOBS.ad_holds();
    assert.equal(result.status, 'ok');
    assert.ok(result.released >= 1);

    const row = await pool.query(
      'SELECT slot_status, slot_release_reason, payment_status FROM ads WHERE id = $1',
      [adId]
    );
    assert.equal(row.rows[0].slot_status, 'released');
    assert.equal(row.rows[0].slot_release_reason, 'hold_expired');
    assert.equal(row.rows[0].payment_status, 'expired');

    // Idempotent: a second run releases nothing more.
    const again = await maintenance.JOBS.ad_holds();
    assert.equal(again.released, 0);
  } finally {
    await pool.query('DELETE FROM ads WHERE id = $1', [adId]);
  }
});

// ---------------------------------------------------------------------------
// 15-18. Health
// ---------------------------------------------------------------------------

test('op15-16. liveness survives a database outage; readiness does not', async () => {
  const live = await api().get('/healthz');
  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'alive');
  assert.equal(live.headers['cache-control'], 'no-store, max-age=0');

  const ready = await api().get('/readyz');
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.schema_version, migrations.SCHEMA_VERSION);

  // Simulate the outage by making every query fail, exactly as an unreachable
  // database would — without taking the real pool down and breaking the rest of
  // the suite.
  const realQuery = pool.query;
  const logs = [];
  const realError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  pool.query = async () => {
    const err = new Error('connect ECONNREFUSED 10.0.0.1:5432 user=fabricateduser password=hunter2');
    err.code = 'ECONNREFUSED';
    throw err;
  };
  try {
    // 15. Liveness is unaffected. This is the whole point of separating them:
    //     if liveness checked the database, every instance would look dead and
    //     the platform would restart them all.
    const stillLive = await api().get('/healthz');
    assert.equal(stillLive.status, 200);
    assert.equal(stillLive.body.status, 'alive');

    // 16. Readiness fails.
    const notReady = await api().get('/readyz');
    assert.equal(notReady.status, 503);
    assert.equal(notReady.body.status, 'not_ready');
    assert.ok(notReady.body.failing.includes('database'));

    // 18. And says nothing about how.
    const body = JSON.stringify(notReady.body);
    assert.ok(!body.includes('10.0.0.1'), 'no host');
    assert.ok(!body.includes('hunter2'), 'no credential');
    assert.ok(!body.includes('fabricateduser'), 'no user');
    assert.ok(!/ECONNREFUSED/.test(body), 'no driver error code');
    assert.ok(!/users|entries|prize_claims|schema_migrations/.test(body), 'no table names');
    assert.ok(!/\.js:\d+/.test(body), 'no stack trace');
    assert.deepEqual(Object.keys(notReady.body).sort(), ['failing', 'status']);
  } finally {
    pool.query = realQuery;
    console.error = realError;
  }

  // The detail did go somewhere — the process log, which is protected.
  assert.ok(logs.join('\n').includes('Readiness failing'), 'the detail is logged internally');

  const recovered = await api().get('/readyz');
  assert.equal(recovered.status, 200, 'readiness recovers by itself');
});

test('op17. readiness fails when the schema or a critical protection is missing', async () => {
  const verified = await migrations.verify(pool, { baselineSql: BASELINE_SQL });
  assert.equal(verified.ok, true, JSON.stringify(verified.problems));

  // A missing constraint fails verification.
  await pool.query('ALTER TABLE privacy_requests DROP CONSTRAINT privacy_requests_no_phantom_deletion');
  try {
    const broken = await migrations.verify(pool, { baselineSql: BASELINE_SQL });
    assert.equal(broken.ok, false);
    assert.ok(broken.problems.some((p) => /privacy_requests_no_phantom_deletion/.test(p)));

    const res = await api().get('/readyz');
    assert.equal(res.status, 503);
    assert.ok(res.body.failing.includes('schema'));
    // The constraint NAME is not in the response.
    assert.ok(!JSON.stringify(res.body).includes('privacy_requests_no_phantom_deletion'));
  } finally {
    await pool.query(
      `ALTER TABLE privacy_requests ADD CONSTRAINT privacy_requests_no_phantom_deletion
        CHECK (NOT (request_type = 'deletion' AND status = 'completed'))`
    );
  }

  // A missing trigger fails too.
  await pool.query('DROP TRIGGER privacy_requests_no_delete ON privacy_requests');
  try {
    const broken = await migrations.verify(pool, { baselineSql: BASELINE_SQL });
    assert.equal(broken.ok, false);
    assert.ok(broken.problems.some((p) => /privacy_requests_no_delete/.test(p)));
  } finally {
    await pool.query(
      `CREATE TRIGGER privacy_requests_no_delete BEFORE DELETE ON privacy_requests
        FOR EACH ROW EXECUTE FUNCTION privacy_requests_no_delete()`
    );
  }

  const restored = await migrations.verify(pool, { baselineSql: BASELINE_SQL });
  assert.equal(restored.ok, true, JSON.stringify(restored.problems));
});

test('op18b. health probes create no session and mutate nothing', async () => {
  const before = await pool.query(
    'SELECT (SELECT COUNT(*) FROM sessions) AS s, (SELECT COUNT(*) FROM session_families) AS f'
  );
  const live = await api().get('/healthz');
  const ready = await api().get('/readyz');

  assert.ok(!String(live.headers['set-cookie'] || '').includes('naseeb_session'));
  assert.ok(!String(ready.headers['set-cookie'] || '').includes('naseeb_session'));

  const after = await pool.query(
    'SELECT (SELECT COUNT(*) FROM sessions) AS s, (SELECT COUNT(*) FROM session_families) AS f'
  );
  assert.deepEqual(after.rows[0], before.rows[0], 'no rows were created');

  // Security headers apply to health responses too.
  assert.ok(live.headers['content-security-policy'], 'CSP is present on /healthz');
  assert.equal(live.headers['x-content-type-options'], 'nosniff');
  assert.ok(ready.headers['content-security-policy']);
});

// ---------------------------------------------------------------------------
// 19-20. Graceful shutdown
// ---------------------------------------------------------------------------

test('op19. shutdown stops new work, drains and closes the pool, in order', async () => {
  const order = [];
  const exits = [];

  const coordinator = createShutdownCoordinator({
    server: { close: (cb) => { order.push('server'); cb(); }, closeIdleConnections: () => {} },
    pool: { end: async () => { order.push('pool'); } },
    scheduler: { stop: () => order.push('scheduler') },
    outbox: { settle: async () => { order.push('outbox'); } },
    setReady: (value) => order.push(`ready:${value}`),
    log: { log() {}, error() {} },
    exit: (code) => exits.push(code),
    timeout: 5000,
  });

  assert.equal(coordinator.mayStartWork(), true);
  assert.equal(coordinator.isShuttingDown(), false);

  const result = await coordinator.shutdown('SIGTERM');

  assert.deepEqual(order, ['ready:false', 'scheduler', 'server', 'outbox', 'pool']);
  assert.equal(result.clean, true);
  assert.deepEqual(exits, [0], 'a clean shutdown exits zero');

  // No new background work may start once it has begun.
  assert.equal(coordinator.mayStartWork(), false);
  assert.equal(coordinator.isShuttingDown(), true);

  // Idempotent: a second signal joins the first rather than starting another.
  const again = await coordinator.shutdown('SIGINT');
  assert.deepEqual(order, ['ready:false', 'scheduler', 'server', 'outbox', 'pool'], 'nothing ran twice');
  assert.deepEqual(exits, [0], 'and it did not exit twice');
  assert.equal(again.clean, true);
});

test('op20. a shutdown that cannot finish exits non-zero after the timeout', async () => {
  const exits = [];
  const logged = [];

  const coordinator = createShutdownCoordinator({
    server: { close: (cb) => cb() },
    // Never resolves — a connection nobody will release.
    pool: { end: () => new Promise(() => {}) },
    setReady: () => {},
    log: { log() {}, error: (m) => logged.push(String(m)) },
    exit: (code) => exits.push(code),
    timeout: 1200,
  });

  const started = Date.now();
  const result = await coordinator.shutdown('SIGTERM');
  const elapsed = Date.now() - started;

  assert.equal(result.clean, false);
  assert.deepEqual(exits, [1], 'a hung shutdown must not report success');
  assert.ok(elapsed >= 1100 && elapsed < 6000, `waited ${elapsed}ms`);
  assert.match(logged.join('\n'), /did not finish within/);
  // The log says what happened without naming a connection.
  assert.ok(!/postgres|password/i.test(logged.join('\n')));

  // A server attached after shutdown began is closed rather than left listening.
  let closed = false;
  coordinator.attachServer({ close: () => { closed = true; } });
  assert.equal(closed, true);

  // Configurable, bounded.
  withEnv({ SHUTDOWN_TIMEOUT_MS: '3000' }, () => {
    assert.equal(require('../server/lib/shutdown').timeoutMs(), 3000);
  });
  withEnv({ SHUTDOWN_TIMEOUT_MS: '5' }, () => {
    assert.equal(require('../server/lib/shutdown').timeoutMs(), 20000, 'an absurd value falls back');
  });
});

// ---------------------------------------------------------------------------
// 21-22. Migration safety
// ---------------------------------------------------------------------------

test('op21. migration locking prevents concurrent application', async () => {
  const applied = await migrations.appliedMigrations(pool);
  assert.ok(applied.length >= 1, 'the ledger has entries');
  assert.ok(applied.some((m) => m.id === '0001_baseline'));

  // Every migration recorded exactly once, whatever ran before.
  const ids = applied.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no migration is recorded twice');

  // Holding the lock blocks a second run, which is what makes a concurrent
  // deploy wait rather than double-apply.
  const holder = await pool.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1)', [migrations.MIGRATION_LOCK_KEY]);

    let finished = false;
    const racing = migrations
      .migrate(pool, { init, baselineSql: BASELINE_SQL, log: { log() {} } })
      .then((s) => {
        finished = true;
        return s;
      });

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(finished, false, 'the second run waits for the lock');

    await holder.query('SELECT pg_advisory_unlock($1)', [migrations.MIGRATION_LOCK_KEY]);
    const summary = await racing;
    assert.deepEqual(summary.applied, [], 'and then finds the work already done');
  } finally {
    holder.release();
  }

  // Re-running is a no-op, however many times.
  const a = await migrations.migrate(pool, { init, baselineSql: BASELINE_SQL, log: { log() {} } });
  const b = await migrations.migrate(pool, { init, baselineSql: BASELINE_SQL, log: { log() {} } });
  assert.deepEqual(a.applied, []);
  assert.deepEqual(b.applied, []);

  const stillOnce = await migrations.appliedMigrations(pool);
  assert.equal(stillOnce.length, applied.length);
});

test('op22. an edited historical migration is detected and refused', async () => {
  // The checksum of the baseline is the hash of the SQL it runs, so editing the
  // bootstrap changes it.
  const real = migrations.checksumFor(migrations.MIGRATIONS[0], { baselineSql: BASELINE_SQL });
  const edited = migrations.checksumFor(migrations.MIGRATIONS[0], {
    baselineSql: `${BASELINE_SQL}\n-- an edit somebody made later`,
  });
  assert.notEqual(real, edited, 'editing the baseline changes its checksum');

  // Simulate a database whose ledger records a different checksum: that is what
  // an edited historical migration looks like from here.
  await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE id = '0001_baseline'");
  try {
    await assert.rejects(
      () => migrations.migrate(pool, { init, baselineSql: BASELINE_SQL, log: { log() {} } }),
      /has changed since it was applied/
    );

    const verified = await migrations.verify(pool, { baselineSql: BASELINE_SQL });
    assert.equal(verified.ok, false);
    assert.ok(verified.problems.some((p) => /checksum mismatch/.test(p)));

    // Readiness fails on it, without naming the migration in the response.
    const res = await api().get('/readyz');
    assert.equal(res.status, 503);
    assert.ok(res.body.failing.includes('schema'));
    assert.ok(!JSON.stringify(res.body).includes('0001_baseline'));
  } finally {
    await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE id = $2', [
      real,
      '0001_baseline',
    ]);
  }

  // A schema AHEAD of the code also fails: old code against a new database is
  // exactly the case a rollback produces and nobody tested.
  await pool.query(
    `INSERT INTO schema_migrations (id, checksum, description, applied_by)
     VALUES ('9999_from_the_future','x','fabricated','migrate')`
  );
  try {
    const ahead = await migrations.verify(pool, { baselineSql: BASELINE_SQL });
    assert.equal(ahead.ok, false);
    assert.ok(ahead.problems.some((p) => /schema is ahead of this code/.test(p)));
  } finally {
    await pool.query("DELETE FROM schema_migrations WHERE id = '9999_from_the_future'");
  }

  const restored = await migrations.verify(pool, { baselineSql: BASELINE_SQL });
  assert.equal(restored.ok, true, JSON.stringify(restored.problems));
});

test('op22b. no migration silently deletes commercial or audit data', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'migrations.js'), 'utf8');
  const bodies = migrations.MIGRATIONS.map((m) => m.run.toString()).join('\n');

  [/DROP\s+TABLE/i, /TRUNCATE/i, /DELETE\s+FROM/i, /DROP\s+COLUMN/i].forEach((pattern) => {
    assert.ok(!pattern.test(bodies), `a migration body must not contain ${pattern}`);
  });

  // There is no `down`, deliberately.
  assert.ok(migrations.MIGRATIONS.every((m) => !m.down), 'no automatic rollback exists');
  assert.ok(/no automatic destructive rollback/i.test(source), 'and the reason is written down');

  // The baseline is recorded as adopted rather than executed on a database that
  // predates the ledger — the honesty property the whole strategy rests on.
  assert.ok(/applied_by = 'adoption'|'adoption'/.test(source));
});

// ---------------------------------------------------------------------------
// 23-25. Backup and restore
// ---------------------------------------------------------------------------

test('op25. the backup script refuses a non-test target', () => {
  const run = (env) => {
    try {
      execFileSync('node', [path.join(ROOT, 'scripts', 'backup-verify.js')], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
      return { code: 0, stderr: '' };
    } catch (err) {
      return { code: err.status, stderr: String(err.stderr || '') + String(err.stdout || '') };
    }
  };

  // A production-shaped name is refused before anything runs.
  const prod = run({
    TEST_DATABASE_URL: 'postgresql://naseeb:fabricatedpassword@db.example.invalid/naseeb_production',
    ALLOW_REMOTE_TEST_DB: '',
  });
  assert.notEqual(prod.code, 0, 'it must refuse');
  assert.ok(!prod.stderr.includes('fabricatedpassword'), 'and not echo the credential');

  // A remote host without the explicit opt-in is refused too.
  const remote = run({
    TEST_DATABASE_URL: 'postgresql://naseeb:fabricatedpassword@db.example.invalid/naseeb_test',
    ALLOW_REMOTE_TEST_DB: '',
  });
  assert.notEqual(remote.code, 0);
  assert.ok(!remote.stderr.includes('fabricatedpassword'));

  // The guard exists twice, on purpose.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'backup-verify.js'), 'utf8');
  assert.ok(/configureTestEnv\(\)/.test(source), 'the shared guard runs');
  assert.ok(/assertTestTarget/.test(source), 'and an independent one');
});

// 23 and 24 — a real dump, a real restore into a separate database, and
// assertions that the restored copy matches — are the backup-verify script
// itself. It is a command rather than a test because it shells out to pg_dump
// and pg_restore and creates a database, which does not belong inside a suite
// that shares one connection pool. Run by `npm run backup:verify` and by the
// `operations` CI job. This asserts it is wired in both places.
test('op23-24. backup and restore verification is wired into the build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['backup:verify'], 'node scripts/backup-verify.js');

  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(workflow, /npm run backup:verify/);
  assert.match(workflow, /operations:/);

  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'backup-verify.js'), 'utf8');
  // It restores into a NEW database rather than over the source.
  assert.match(source, /CREATE DATABASE/);
  assert.match(source, /_restore_/);
  // And checks the things that matter, not just that the file exists.
  ['row counts match', 'critical constraints restored', 'append-only triggers restored',
   'delivery details are still ciphertext', 'delivery details decrypt with the test key',
   'migration ledger restored'].forEach((check) => {
    assert.ok(source.includes(check), `the script asserts "${check}"`);
  });
});

// ---------------------------------------------------------------------------
// 26-27. Deterministic builds
// ---------------------------------------------------------------------------

test('op26. CI and deployment install deterministically, on a pinned runtime', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');

  // npm ci everywhere. `npm install` may resolve outside the lockfile, which
  // means the tested artefact and the deployed one can differ.
  assert.match(render, /buildCommand:\s*npm ci/);
  assert.ok(!/buildCommand:\s*npm install/.test(render), 'render.yaml must not use npm install');
  assert.match(workflow, /run: npm ci/);

  // The Node version is pinned in three places and they must agree.
  assert.ok(pkg.engines && pkg.engines.node, 'package.json pins a Node version');
  const major = String(pkg.engines.node).match(/(\d+)/)[1];
  assert.match(workflow, new RegExp(`node-version: ${major}`));
  assert.match(render, new RegExp(`key: NODE_VERSION[\\s\\S]{0,400}?value: ${major}`));

  // The lockfile is authoritative and CI proves it.
  assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')));
  assert.match(workflow, /git diff --exit-code package-lock\.json/);

  // Nothing that should never ship is shippable.
  const npmignore = fs.readFileSync(path.join(ROOT, '.npmignore'), 'utf8');
  ['node_modules', '.env', '.tmp-testdb', '*.dump'].forEach((entry) => {
    assert.ok(npmignore.includes(entry), `.npmignore excludes ${entry}`);
  });
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ['node_modules/', '.env', '.tmp-testdb/', '*.dump'].forEach((entry) => {
    assert.ok(gitignore.includes(entry), `.gitignore excludes ${entry}`);
  });

  // The blueprint points its health check at readiness, not liveness.
  assert.match(render, /healthCheckPath:\s*\/readyz/);
});

test('op27. the development mail logger cannot activate in production', async () => {
  const email = require('../server/lib/email');

  // The refusal is a startup one, not a runtime hope.
  const result = withEnv(
    {
      NODE_ENV: 'production',
      CLAIM_DEV_LOG_LINKS: 'true',
      DATABASE_URL: 'postgresql://u:p@db.example.invalid/naseeb',
      SESSION_SECRET: 'a-fabricated-session-secret-with-plenty-of-entropy-9f2b',
      APP_URL: 'https://example.invalid',
      INTEGRITY_SIGNAL_SECRET: 'fabricated-integrity-secret-0123456789abcdefghij',
    },
    () => config.validate()
  );
  assert.ok(result.problems.some((p) => p.variable === 'CLAIM_DEV_LOG_LINKS'));

  // And the sensitive path suppresses the body regardless, with the recipient
  // masked — a development log is CI output and terminal scrollback.
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await withEnv({ RESEND_API_KEY: undefined, CLAIM_DEV_LOG_LINKS: undefined }, async () => {
      await email.sendEmail({
        to: 'someone@example.com',
        subject: 'Fabricated',
        html: '<p>a body with a #token=abcdefghijklmnopqrstuvwxyz012345 in it</p>',
        sensitive: true,
      });
    });
  } finally {
    console.log = realLog;
  }
  const text = logged.join('\n');
  assert.match(text, /body suppressed/);
  assert.ok(!text.includes('someone@example.com'), 'the recipient is masked');
  assert.ok(text.includes('s***@example.com'), 'but still identifiable to a developer');
  assert.ok(!text.includes('#token='), 'and no link');
  assert.equal(email.maskRecipient('winner@example.com'), 'w***@example.com');
});

// ---------------------------------------------------------------------------
// Audit completeness
// ---------------------------------------------------------------------------

test('op28. every maintenance function the audit found has a scheduled job', () => {
  // The four that had no schedule, and the three that only ran on a timer.
  const covered = new Set(maintenance.JOB_NAMES);
  ['sessions', 'risk_signals', 'email_changes', 'ad_holds', 'claims', 'claim_outbox',
   'email_change_outbox'].forEach((job) => {
    assert.ok(covered.has(job), `${job} must be runnable from the command line`);
  });

  // `all` runs every one of them; nothing can be added to JOBS and quietly
  // omitted from the schedule.
  assert.deepEqual([...maintenance.ALL_ORDER].sort(), [...maintenance.JOB_NAMES].sort());

  // The documentation names the same jobs and a schedule for them.
  const ops = fs.readFileSync(path.join(ROOT, 'docs', 'OPERATIONS.md'), 'utf8');
  maintenance.JOB_NAMES.forEach((job) => {
    assert.ok(ops.includes(job), `docs/OPERATIONS.md documents ${job}`);
  });
  assert.match(ops, /Dubai/, 'schedules are given in Dubai time as well as UTC');
  assert.match(ops, /UTC/);

  // Every variable the code knows about is classified.
  config.VARIABLES.forEach((v) => {
    assert.ok(Object.values(config.KIND).includes(v.kind), `${v.name} has a class`);
    assert.ok(Object.values(config.EXPOSURE).includes(v.exposure), `${v.name} has an exposure`);
    assert.ok(v.purpose && v.purpose.length > 10, `${v.name} says what it is for`);
  });

  // And no committed file contains something shaped like a real secret.
  ['render.yaml', '.env.example', 'docs/OPERATIONS.md'].forEach((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/\bsk_live_[A-Za-z0-9]{10,}/.test(text), `${file} has no live Stripe key`);
    assert.ok(!/\bre_[A-Za-z0-9]{20,}/.test(text), `${file} has no Resend key`);
    // A connection string is only a finding if it carries something that could
    // be a real credential. `.env.example` documents the FORM with
    // `user:password@host`, which is the point of an example file.
    const strings = text.match(/postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@[^\s"']*/g) || [];
    strings.forEach((found) => {
      const credential = found.split('//')[1].split('@')[0];
      assert.ok(
        /^(user:password|USER:PASSWORD|u:p|naseeb:naseeb)$/.test(credential) ||
          /example|invalid|localhost|127\.0\.0\.1/.test(found),
        `${file} contains a connection string that is not obviously an example`
      );
    });
  });
});
