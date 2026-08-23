// Certificate verification for the database connection must not change without
// somebody deciding that it should.
//
// ---------------------------------------------------------------------------
// The warning this file exists because of
// ---------------------------------------------------------------------------
//
// pg-connection-string prints, on every boot whose DATABASE_URL carries an
// sslmode:
//
//   SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are
//   treated as aliases for 'verify-full'. In the next major version
//   (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt
//   standard libpq semantics, which have weaker security guarantees.
//
// Read carefully, that is not a complaint about the present. Today those three
// modes are the STRONGEST setting: the certificate chain and the hostname are
// both verified. The warning is about the future, where 'require' will mean
// "encrypt, verify nothing" — the mode that protects against a passive
// eavesdropper and not against anyone able to answer in the database's place.
//
// So the dangerous moment is not a deployment. It is `npm update`. A dependency
// bump would silently turn certificate verification off, with no code change to
// review, no configuration to notice and no test to fail. That is the whole
// reason for this file: the flip becomes a red build instead of a quiet one.
//
// ---------------------------------------------------------------------------
// The second thing that had to be pinned
// ---------------------------------------------------------------------------
//
// server/db.js computes an `ssl` option from DATABASE_SSL and passes it to the
// Pool. That option does not merge with an sslmode in the connection string —
// it is replaced by it. A URL ending `?sslmode=require` discards
// `rejectUnauthorized: false` entirely and verifies the certificate instead.
//
// Which is fine, and stronger than the code appears to ask for, and completely
// invisible from reading server/db.js alone. Both halves are asserted below so
// that the effective posture is written down somewhere it can be checked,
// rather than inferred from two libraries' precedence rules.
//
// Nothing here opens a connection. Every assertion is against the configuration
// pg resolves before any socket exists, so this file needs no database, no
// credentials and no network — and it therefore runs in the plain `test` job.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { describeSslPosture, sslModeInUrl } = require('../server/db');

// A syntactically valid connection string pointing at a host that does not
// exist. Never connected to; only parsed.
const HOST = 'postgres://user:pw@db.invalid.test:5432/naseeb';

// pg resolves the ssl option and the connection string together and stores the
// outcome on the client. Reading it is the only way to see which one won.
function resolvedSsl(url, ssl) {
  const config = ssl === undefined
    ? { connectionString: url }
    : { connectionString: url, ssl };
  return new Client(config).connectionParameters.ssl;
}

test('tls1. an sslmode in the connection string replaces the ssl option rather than merging with it', () => {
  const withMode = resolvedSsl(`${HOST}?sslmode=require`, { rejectUnauthorized: false });

  assert.deepEqual(
    withMode,
    {},
    'sslmode in the URL no longer overrides the explicit ssl option. server/db.js documents'
    + ' the opposite precedence and its rejectUnauthorized: false is now reachable in'
    + ' deployments that pin an sslmode — re-read that comment before changing this test.'
  );
});

test('tls2. with no sslmode in the URL, the DATABASE_SSL-derived option is what applies', () => {
  assert.deepEqual(resolvedSsl(HOST, { rejectUnauthorized: false }), { rejectUnauthorized: false });
  assert.equal(resolvedSsl(HOST), false, 'no sslmode and no ssl option must not silently enable TLS');
});

test('tls3. sslmode=require still verifies the certificate', () => {
  const ssl = resolvedSsl(`${HOST}?sslmode=require`);

  // `{}` means "TLS on, defaults apply", and the Node TLS default is
  // rejectUnauthorized: true. An explicit false here would be the downgrade.
  assert.notEqual(ssl, false, 'sslmode=require must not resolve to plaintext');
  assert.notEqual(
    ssl && ssl.rejectUnauthorized,
    false,
    'sslmode=require now skips certificate verification. This is the pg v9 semantics change'
    + ' the startup warning predicts: every deployment whose DATABASE_URL says sslmode=require'
    + ' has lost certificate verification. Pin sslmode=verify-full in the deployed URL before'
    + ' accepting this upgrade.'
  );
});

test('tls4. verify-full means the same thing before and after the semantics change', () => {
  const ssl = resolvedSsl(`${HOST}?sslmode=verify-full`);

  assert.notEqual(ssl, false);
  assert.notEqual(ssl && ssl.rejectUnauthorized, false);
});

test('tls5. the posture helper names the modes that will change meaning', () => {
  for (const mode of ['prefer', 'require', 'verify-ca', 'REQUIRE']) {
    const posture = describeSslPosture(`${HOST}?sslmode=${mode}`);
    assert.equal(posture.mode, mode);
    assert.equal(posture.source, 'connection string');
    assert.equal(posture.stableAcrossUpgrade, false, `${mode} must be reported as unstable`);
  }

  for (const mode of ['verify-full', 'disable', 'no-verify']) {
    assert.equal(
      describeSslPosture(`${HOST}?sslmode=${mode}`).stableAcrossUpgrade,
      true,
      `${mode} means one thing in both versions and must not be warned about`
    );
  }

  const noMode = describeSslPosture(HOST);
  assert.equal(noMode.mode, null);
  assert.equal(noMode.source, 'DATABASE_SSL');
  assert.equal(noMode.stableAcrossUpgrade, true);
});

test('tls6. the mode is found even in a connection string the URL parser rejects', () => {
  // libpq-style key/value strings and URLs with unescaped characters in the
  // password both throw in `new URL`. Falling back to no-mode-found would make
  // the warning silently stop firing for exactly the deployments most likely to
  // have hand-edited their connection string.
  assert.equal(sslModeInUrl('postgres://user:p@ss word@db.invalid.test/x?sslmode=require'), 'require');
  assert.equal(sslModeInUrl('host=db.invalid.test dbname=x sslmode=require'), null);
  assert.equal(sslModeInUrl(''), null);
  assert.equal(sslModeInUrl(undefined), null);
});

test('tls7. the posture report carries no credentials', () => {
  const secretish = 'postgres://admin:hunter2@db.invalid.test:5432/naseeb?sslmode=require';
  const report = JSON.stringify(describeSslPosture(secretish));

  // The startup warning interpolates this object, so anything it carries ends
  // up in the deploy log.
  assert.ok(!report.includes('hunter2'), 'the posture report must never carry the password');
  assert.ok(!report.includes('admin'), 'the posture report must never carry the username');
  assert.ok(!report.includes('db.invalid.test'), 'the posture report must never carry the host');
});
