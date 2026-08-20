// Phase 2.4A safety fix: a deployment that cannot send email must say so, and
// must not create state that email was supposed to complete.
//
// ---------------------------------------------------------------------------
// The claim this replaces
// ---------------------------------------------------------------------------
//
// Phase 2.4A classified `RESEND_API_KEY` as optional in production and wrote the
// consequence down: "no email is delivered at all; both outboxes retry
// forever." Both halves were wrong. Email verification, password recovery,
// claim invitations, email-change verification and the old-address security
// warning are the workflows, not extras — and nothing retries forever, because
// both outboxes have a finite attempt limit and a terminal `failed` state.
//
// So: production requires a working provider and a sender the provider will
// accept; the maintenance mode is explicit, temporary and refuses the actions it
// would break; and readiness reports a degraded category when mandatory
// notifications are not being delivered.
//
// Everything here runs against the isolated test database with fabricated data.
// No provider is contacted, no credential is read, and no address here belongs
// to anybody.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const { api, pool, ensureInit, uniqueEmail, signIn, closePool } = require('../testHelpers');

const emailDelivery = require('../server/lib/emailDelivery');
const appConfig = require('../server/lib/config');
const policies = require('../server/lib/policies');
const health = require('../server/routes/health');

const ROOT = path.join(__dirname, '..');
const created = { users: [] };

before(async () => {
  await ensureInit();
});

after(async () => {
  if (created.users.length) {
    await pool.query('DELETE FROM email_change_notifications WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM email_change_requests WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM session_families WHERE user_id = ANY($1)', [created.users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
  }
  await closePool();
});

// Restores every variable it touched, whatever the body does. A test that
// leaves NODE_ENV=production behind takes the rest of the suite with it.
function withEnv(overrides, fn) {
  const saved = {};
  Object.keys(overrides).forEach((key) => {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
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

// The same thing for an async body. Separate rather than shared, because the
// synchronous version restores in a `finally` that would run before an awaited
// body finished — which is the kind of bug that leaves NODE_ENV=production set
// for the rest of the suite.
async function withEnvA(overrides, fn) {
  const saved = {};
  Object.keys(overrides).forEach((key) => {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  });
  try {
    return await fn();
  } finally {
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

async function makeUser(tag) {
  const id = crypto.randomUUID();
  const email = uniqueEmail(`mail-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified,
                        age_attestation_status, age_attestation_version)
     VALUES ($1, $2, $3, $4, TRUE, 'confirmed', '2026-08-eligibility-18')`,
    [id, `Mail ${tag}`, email, bcrypt.hashSync('correcthorse123', 4)]
  );
  created.users.push(id);
  return { id, email };
}

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

test('ed1. production requires a working email provider, whatever the deployment state', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://fabricated@db.example.invalid:5432/naseeb_prod_fixture',
    APP_URL: 'https://fabricated.invalid',
    TRUSTED_PROXY_HOPS: '1',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    INTEGRITY_SIGNAL_SECRET: crypto.randomBytes(32).toString('hex'),
    CLAIM_ENCRYPTION_KEY: `v1:${crypto.randomBytes(32).toString('base64')}`,
    RESEND_API_KEY: undefined,
    EMAIL_FROM: undefined,
    EMAIL_DELIVERY_ENABLED: undefined,
  };

  // `private_beta` is the default production state and does NOT make email
  // optional. A beta with real accounts in it is a deployment where somebody
  // will need to recover a password.
  ['private_beta', 'staging', 'public_launch', undefined].forEach((state) => {
    withEnv({ ...base, DEPLOYMENT_STATE: state }, () => {
      const result = appConfig.validate();
      assert.equal(result.ok, false, `${state || 'unset'} must not run without email`);
      assert.ok(
        result.problems.some((p) => p.variable === 'RESEND_API_KEY'),
        `${state || 'unset'}: the provider is required`
      );
      assert.ok(
        result.problems.some((p) => p.variable === 'EMAIL_FROM'),
        `${state || 'unset'}: the sender is required`
      );
    });
  });

  // With both set to something the provider would accept, the email problems go
  // away — the requirement is real, not a permanent failure.
  withEnv(
    {
      ...base,
      RESEND_API_KEY: `re_${crypto.randomBytes(16).toString('hex')}`,
      EMAIL_FROM: 'Naseeb <hello@fabricated-sender.invalid>',
    },
    () => {
      const result = appConfig.validate();
      const emailProblems = result.problems.filter((p) =>
        ['RESEND_API_KEY', 'EMAIL_FROM'].includes(p.variable)
      );
      // `.invalid` is still refused as a domain that cannot receive mail, which
      // is the point of the sender check — so the remaining problem is the
      // domain, not the absence.
      assert.ok(
        emailProblems.every((p) => p.variable === 'EMAIL_FROM'),
        'the provider key is accepted'
      );
    }
  );
});

test('ed2. the sender address is validated by shape, and its value never leaves the check', () => {
  const cases = [
    ['', /is not set/],
    ['not-an-address', /not a valid email address/],
    ['noreply@resend.dev', /shared onboarding domain/],
    ['Naseeb <team@mail.resend.dev>', /shared onboarding domain/],
    ['hello@example.com', /reserved example domain/],
    // No TLD at all fails the shape check before the domain rules are reached,
    // which is the same refusal by a shorter route.
    ['hello@localhost', /not a valid email address/],
  ];

  cases.forEach(([value, pattern]) => {
    withEnv({ EMAIL_FROM: value || undefined }, () => {
      const problems = emailDelivery.senderProblems();
      assert.ok(problems.length > 0, `${value || '(unset)'} is rejected`);
      assert.ok(problems.some((p) => pattern.test(p)), `${value || '(unset)'}: ${problems.join(' ')}`);
      // The value is never echoed back. A validation message goes to a log.
      problems.forEach((p) => {
        if (value) assert.ok(!p.includes(value), 'the configured value is not printed');
      });
    });
  });

  ['hello@mynaseeb-fabricated.test', 'Naseeb Team <no-reply@mynaseeb-fabricated.test>'].forEach(
    (value) => {
      withEnv({ EMAIL_FROM: value }, () => {
        assert.deepEqual(emailDelivery.senderProblems(), [], `${value} is accepted`);
        assert.equal(emailDelivery.isSenderConfigured(), true);
      });
    }
  );
});

test('ed3. no provider call happens at startup, in this file or any other', () => {
  // A startup that pings the provider makes every boot depend on somebody
  // else's uptime and every slow response into a failed deploy. The check is
  // structural: nothing on the configuration or health path may reach out.
  const sources = [
    'server/lib/emailDelivery.js',
    'server/lib/config.js',
    'server/routes/health.js',
    'server/index.js',
  ].map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));

  sources.forEach(({ file, text }) => {
    assert.ok(!/require\(['"]resend['"]\)/.test(text), `${file} does not load the provider client`);
    assert.ok(!/api\.resend\.com/.test(text), `${file} does not call the provider`);
    assert.ok(!/\bfetch\s*\(/.test(text), `${file} makes no outbound request`);
  });

  assert.match(sources[0].text, /nothing here makes a\s*\/\/\s*network call/, 'and it says so');
});

test('ed4. the maintenance switch defaults safely and is refused at public launch', () => {
  // Unset, misspelled, empty, garbage — all mean "email is expected to work".
  // The default of a switch that stops email must never be "stopped".
  [undefined, '', '   ', 'ture', 'yes please', 'TRUE', '1'].forEach((value) => {
    withEnv({ EMAIL_DELIVERY_ENABLED: value }, () => {
      assert.equal(
        emailDelivery.isDeliveryEnabled(),
        true,
        `${JSON.stringify(value)} must not silently disable email`
      );
    });
  });

  ['false', 'FALSE', '0', 'no', 'off'].forEach((value) => {
    withEnv({ EMAIL_DELIVERY_ENABLED: value }, () => {
      assert.equal(emailDelivery.isDeliveryEnabled(), false, `${value} turns it off`);
      assert.equal(emailDelivery.canDeliver(), false);
      assert.equal(emailDelivery.unavailableReason(), 'maintenance');

      // And it is never a launch state.
      assert.ok(
        appConfig
          .launchBlockers()
          .some((b) => /EMAIL_DELIVERY_ENABLED is off/.test(b)),
        'the maintenance mode blocks public launch'
      );
    });
  });

  // It is a warning rather than a fatal problem, so the mode can actually be
  // used — but a loud one, because a deployment silently not sending email is
  // the failure this whole section exists to prevent.
  withEnv({ EMAIL_DELIVERY_ENABLED: 'false' }, () => {
    const result = appConfig.validate();
    assert.ok(
      result.warnings.some((w) => w.variable === 'EMAIL_DELIVERY_ENABLED'),
      'the mode is announced'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. No unusable state
// ---------------------------------------------------------------------------

test('ed5. signup, resend, reset and email change refuse BEFORE writing anything', async () => {
  const user = await makeUser('gate');
  const session = await signIn(user.email);

  const before = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM email_change_requests) AS changes,
            (SELECT COUNT(*)::int FROM email_change_notifications) AS notifications`
  );

  const wouldBeEmail = uniqueEmail('never-created');

  await withEnvA({ EMAIL_DELIVERY_ENABLED: 'false' }, async () => {
    const signup = await api()
      .post('/api/auth/signup')
      .send({
        name: 'Never Created',
        email: wouldBeEmail,
        password: 'correcthorse123',
        age_confirmed: true,
      });
    assert.equal(signup.status, 503);
    assert.equal(signup.body.code, 'EMAIL_DELIVERY_UNAVAILABLE');
    assert.equal(signup.body.reason, 'maintenance');
    assert.equal(signup.body.action, 'signup');
    assert.equal(signup.headers['retry-after'], '300');

    const resend = await session.post('/api/auth/resend-verification').send({});
    assert.equal(resend.status, 503);
    assert.equal(resend.body.code, 'EMAIL_DELIVERY_UNAVAILABLE');

    const reset = await api().post('/api/auth/forgot-password').send({ email: user.email });
    assert.equal(reset.status, 503);
    assert.equal(reset.body.code, 'EMAIL_DELIVERY_UNAVAILABLE');

    const change = await session.post('/api/account/email-change').send({
      password: 'correcthorse123',
      new_email: uniqueEmail('never-changed'),
    });
    assert.equal(change.status, 503);
    assert.equal(change.body.code, 'EMAIL_DELIVERY_UNAVAILABLE');
  });

  // Nothing was created. Not a half-made account whose address is now taken,
  // not a pending change that blocks the next attempt, not a reset token
  // sitting live in a row nobody asked for.
  const after = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM email_change_requests) AS changes,
            (SELECT COUNT(*)::int FROM email_change_notifications) AS notifications`
  );
  assert.deepEqual(after.rows[0], before.rows[0], 'no row of any kind was written');

  const orphan = await pool.query('SELECT id FROM users WHERE email = $1', [wouldBeEmail]);
  assert.equal(orphan.rowCount, 0, 'the address is still available to whoever wanted it');

  const token = await pool.query(
    'SELECT reset_token, verification_token FROM users WHERE id = $1',
    [user.id]
  );
  assert.equal(token.rows[0].reset_token, null, 'no live reset credential was minted');
});

test('ed6. an existing signed-in session is untouched by the maintenance mode', async () => {
  const user = await makeUser('session');
  const session = await signIn(user.email);

  await withEnvA({ EMAIL_DELIVERY_ENABLED: 'false' }, async () => {
    const me = await session.get('/api/auth/session');
    assert.equal(me.status, 200, 'still signed in');
    assert.equal(me.body.authenticated, true, 'the session is not cleared');
    assert.equal(me.body.user.id, user.id);

    // Reading the site keeps working — this mode pauses the actions that need
    // an email to reach somebody, not the platform.
    const giveaways = await api().get('/api/giveaways');
    assert.equal(giveaways.status, 200);

    // And the account page still works, including the parts that do not need
    // to send anything.
    const account = await session.get('/api/account/me');
    assert.equal(account.status, 200);
  });

  const afterwards = await session.get('/api/auth/session');
  assert.equal(afterwards.status, 200, 'and the session survives the mode being lifted');
  assert.equal(afterwards.body.authenticated, true);
});

test('ed7. a claim reissue is refused before it destroys the winner’s existing link', () => {
  // The route's first act is to invalidate every token the winner has. Doing
  // that into a deployment that cannot send replaces a link they might still
  // have with one that never arrives, which is strictly worse than nothing.
  const source = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'claims.js'), 'utf8');
  const reissue = source.slice(source.indexOf("router.post('/:id/admin/reissue'"));
  const gate = reissue.indexOf('refuseIfUndeliverable');
  const invalidate = reissue.indexOf('invalidateTokens');
  const begin = reissue.indexOf("client.query('BEGIN')");

  assert.ok(gate > -1, 'the reissue route is gated');
  assert.ok(gate < begin, 'and it refuses before opening a transaction');
  assert.ok(gate < invalidate, 'and long before it invalidates the existing tokens');

  // The draw is gated too, and rolls back rather than committing a winner who
  // can never be told they won.
  const giveaways = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'giveaways.js'), 'utf8');
  assert.match(giveaways, /refuseIfUndeliverable\(res, \{ action: 'draw_winner' \}\)/);
  assert.match(giveaways, /refuseIfUndeliverable[\s\S]{0,120}ROLLBACK/);
});

// ---------------------------------------------------------------------------
// 3. Readiness
// ---------------------------------------------------------------------------

test('ed8. readiness reports a generic degraded category, and nothing about the message', async () => {
  const healthy = await api().get('/readyz');
  assert.equal(healthy.status, 200, JSON.stringify(healthy.body));

  await withEnvA({ EMAIL_DELIVERY_ENABLED: 'false' }, async () => {
    const res = await api().get('/readyz');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body.failing, ['notifications']);

    // A category and nothing else. No recipient, no provider error, no subject,
    // no body, no variable name, no count.
    const rendered = JSON.stringify(res.body);
    ['@', 'resend', 'RESEND', 'EMAIL_FROM', 'maintenance', 'provider'].forEach((leak) => {
      assert.ok(!rendered.includes(leak), `readiness must not disclose ${leak}`);
    });
    assert.deepEqual(Object.keys(res.body).sort(), ['failing', 'status']);
  });

  const recovered = await api().get('/readyz');
  assert.equal(recovered.status, 200);
});

test('ed9. terminally failed notifications are not reported as healthy', async () => {
  const user = await makeUser('terminal');

  const health1 = await emailDelivery.notificationHealth(pool);
  assert.equal(health1.ok, true, JSON.stringify(health1));
  const baseline = health1.failed_recently;

  // Fabricated terminal failures. `failed` is the outbox's end state: attempts
  // are exhausted, nothing will retry it, and an administrator has to look.
  const ids = [];
  const changeIds = [];
  for (let i = 0; i < emailDelivery.TERMINAL_FAILURE_THRESHOLD; i += 1) {
    const id = crypto.randomUUID();
    const changeId = crypto.randomUUID();
    ids.push(id);
    changeIds.push(changeId);
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO email_change_requests
         (id, user_id, new_email, previous_email, status, expires_at)
       VALUES ($1, $2, $3, $4, 'cancelled', NOW() + INTERVAL '1 hour')`,
      [changeId, user.id, uniqueEmail(`terminal-${i}`), user.email]
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO email_change_notifications
         (id, user_id, change_id, kind, status, attempts, failed_at,
          last_error_category, idempotency_key)
       VALUES ($1, $2, $3, 'verification', 'failed', 6, NOW(), 'provider_error', $4)`,
      [id, user.id, changeId, `${changeId}:verification`]
    );
  }

  try {
    const degraded = await emailDelivery.notificationHealth(pool);
    assert.equal(degraded.ok, false, 'a cluster of terminal failures is not health');
    assert.equal(degraded.reason, 'delivery_failures');
    assert.ok(degraded.failed_recently >= baseline + emailDelivery.TERMINAL_FAILURE_THRESHOLD);

    const res = await api().get('/readyz');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body.failing, ['notifications']);
    // Still a category only — the count is an operator detail and goes to the
    // log, not to an unauthenticated response.
    assert.ok(!/\d/.test(JSON.stringify(res.body.failing)));
  } finally {
    await pool.query('DELETE FROM email_change_notifications WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM email_change_requests WHERE id = ANY($1)', [changeIds]);
  }

  const recovered = await emailDelivery.notificationHealth(pool);
  assert.equal(recovered.ok, true, 'and it clears when the failures do');
});

test('ed10. nothing retries forever — both outboxes have a finite limit and a terminal state', () => {
  const changeOutbox = require('../server/lib/emailChangeOutbox');
  assert.ok(Number.isInteger(changeOutbox.MAX_ATTEMPTS) && changeOutbox.MAX_ATTEMPTS > 0);
  assert.ok(changeOutbox.MAX_ATTEMPTS <= 20, 'the limit is finite and small');
  assert.equal(changeOutbox.STATUS.FAILED, 'failed', 'there is a terminal state');

  // The claim outbox is the older of the two and is bounded in its own module.
  const claimSource = fs.readFileSync(
    path.join(ROOT, 'server', 'lib', 'claimNotifications.js'),
    'utf8'
  );
  assert.match(claimSource, /MAX_ATTEMPTS/, 'the claim outbox has an attempt limit');
  assert.match(claimSource, /'failed'/, 'and a terminal failed state');

  // And the correction is written down where the wrong claim used to be.
  const delivery = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'emailDelivery.js'), 'utf8');
  assert.match(delivery, /"[Rr]etry forever" was also wrong/);
  assert.match(delivery, /Nothing retries indefinitely/);
});

// ---------------------------------------------------------------------------
// 4. Truthful private-beta identification
// ---------------------------------------------------------------------------

test('ed11. /api/config exposes the coarse state and no blocker detail', async () => {
  await withEnvA({ DEPLOYMENT_STATE: 'private_beta' }, async () => {
    const res = await api().get('/api/config');
    assert.equal(res.status, 200);

    assert.equal(res.body.deployment_state, 'private_beta');
    assert.equal(res.body.is_public_launch, false);
    assert.match(res.body.deployment_disclosure, /not a public launch/i);
    assert.match(res.body.deployment_disclosure, /drafts with no effective date/i);
    assert.equal(res.body.email_delivery_available, true);

    // The blockers name outstanding legal work and missing provider
    // configuration. An unauthenticated page does not get to enumerate either.
    const rendered = JSON.stringify(res.body);
    assert.ok(!/blocker/i.test(rendered), 'no blocker list is published');
    assert.ok(!/RESEND|SESSION_SECRET|DATABASE_URL|STRIPE|SENTRY/.test(rendered));
    assert.ok(!/counsel/i.test(rendered) || /reviewed by qualified/.test(rendered));

    // Nothing here CLAIMS the platform is approved or production-ready. The
    // disclosure uses both phrases, in the negative — "must not be described as
    // approved or production-ready" — which is the opposite of a claim, so the
    // check is that no positive assertion appears.
    assert.match(res.body.deployment_disclosure, /must not be described as approved or production-ready/);
    assert.match(res.body.deployment_disclosure, /nothing has been reviewed by qualified UAE counsel/);

    // Everything OUTSIDE that one sentence must be free of any approval
    // language at all — a claim smuggled into a policy field or a flag would
    // otherwise hide behind the disclosure's own use of the words.
    const withoutDisclosure = rendered.split(JSON.stringify(res.body.deployment_disclosure).slice(1, -1)).join('');
    [/approved/i, /production[- ]ready/i, /reviewed by/i, /effective/i].forEach((claim) => {
      const hit = withoutDisclosure.match(claim);
      // `isEffective` is a field name whose value is false, which is the
      // truthful negative — the check is that it is never true.
      if (hit && /effective/i.test(hit[0])) return;
      assert.ok(!hit, `no approval claim matching ${claim}`);
    });
    Object.values(res.body.policies).forEach((policy) => {
      assert.equal(policy.isEffective, false);
      assert.equal(policy.acceptable, false);
      assert.equal(policy.effectiveDate, null);
      assert.equal(policy.status, 'draft');
    });

    // Every launch blocker exists, and none of them is in the response.
    const blockers = appConfig.launchBlockers();
    assert.ok(blockers.length > 0, 'public launch is genuinely blocked');
    blockers.forEach((blocker) => {
      assert.ok(!rendered.includes(blocker), 'no blocker text is exposed');
    });
  });
});

test('ed12. public launch remains impossible while the policies are drafts', () => {
  Object.values(policies.POLICIES).forEach((policy) => {
    assert.notEqual(policy.status, policies.POLICY_STATUS.EFFECTIVE, `${policy.id} is a draft`);
    assert.equal(policy.effectiveDate, null, `${policy.id} has no effective date`);
  });

  withEnv({ DEPLOYMENT_STATE: 'public_launch' }, () => {
    const result = appConfig.validate();
    assert.equal(result.ok, false, 'public launch is refused');
    const stateProblems = result.problems.filter((p) => p.variable === 'DEPLOYMENT_STATE');
    assert.ok(stateProblems.length > 0);
    assert.ok(
      stateProblems.some((p) => /policy is "draft", not effective/.test(p.message)),
      JSON.stringify(stateProblems)
    );
    assert.ok(stateProblems.some((p) => /has no effective date/.test(p.message)));
  });

  // ...and it is not set anywhere that ships.
  const blueprint = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.ok(!/DEPLOYMENT_STATE[\s\S]{0,80}public_launch/.test(blueprint));
  assert.match(blueprint, /private_beta/);
});

test('ed13. every page is marked noindex until public launch, and says what it is', async () => {
  await withEnvA({ DEPLOYMENT_STATE: 'private_beta' }, async () => {
    for (const url of ['/', '/index.html', '/api/config', '/giveaways.html']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api().get(url);
      assert.ok(res.status < 500, `${url} answered`);
      assert.equal(
        res.headers['x-robots-tag'],
        'noindex, nofollow, noarchive',
        `${url} is not indexable`
      );
    }
  });

  // The banner is rendered from the same coarse state, is not dismissible, and
  // carries no blocker detail.
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const banner = appJs.slice(
    appJs.indexOf('async function renderDeploymentBanner'),
    appJs.indexOf('async function renderMaintenanceBanner')
  );
  assert.match(banner, /Private beta/);
  assert.match(banner, /config\.deployment_disclosure/);
  assert.ok(!/dismiss/i.test(banner), 'the disclosure cannot be dismissed');
  assert.ok(!/blocker/i.test(banner));
  assert.match(banner, /email_delivery_available === false/, 'and it says when email is paused');

  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'utilities.css'), 'utf8');
  assert.match(css, /\.deployment-banner/, 'the banner has a style, so it is actually visible');
});

test('ed14. readiness reports the deployment state truthfully and nothing else', async () => {
  await withEnvA({ DEPLOYMENT_STATE: 'private_beta' }, async () => {
    const res = await api().get('/readyz');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deployment, 'private_beta');
    assert.deepEqual(Object.keys(res.body).sort(), ['deployment', 'schema_version', 'status']);
  });

  // A checked list rather than an asserted one: these are the categories the
  // readiness endpoint may ever emit.
  const source = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'health.js'), 'utf8');
  const categories = [...source.matchAll(/failures\.push\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(categories)].sort(),
    ['configuration', 'database', 'notifications', 'schema']
  );
  assert.equal(typeof health.readinessChecks, 'function');
});
