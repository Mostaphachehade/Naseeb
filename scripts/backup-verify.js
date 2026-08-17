#!/usr/bin/env node
//
// Proving a backup by restoring it.
//
//   TEST_DATABASE_URL=... node scripts/backup-verify.js
//
// ---------------------------------------------------------------------------
// What this is, and what it is not
// ---------------------------------------------------------------------------
//
// It IS: a dump of the isolated test database, a restore into a second
// temporary test database, and a set of assertions that the restored copy is
// actually usable — row counts, critical constraints, append-only triggers, and
// an encrypted delivery payload that still decrypts with the test key.
//
// It is NOT: evidence about the production database. Nothing here touches Neon,
// reads a production credential, or verifies that provider-side backups exist.
// Those are owner actions and are documented as such in docs/OPERATIONS.md.
// **A backup is not proven until a restore succeeds**, and a restore of a
// fabricated test database proves the mechanism, not the data.
//
// Guarded three ways before it does anything: the same test-database guard the
// suite uses, an explicit name check, and a refusal to write a dump anywhere but
// a temporary directory it created.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { configureTestEnv } = require(path.join(ROOT, 'testEnv'));

// The guard runs first and throws on anything that is not an isolated test
// database — a remote host, a database whose name does not contain "test", a
// production-shaped credential.
configureTestEnv();

const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));

const SOURCE_URL = process.env.DATABASE_URL;

function fail(message) {
  process.stderr.write(`backup-verify: ${message}\n`);
  process.exit(1);
}

// Second guard, independent of testEnv. Deliberately duplicated: this script
// runs pg_dump and dropdb, and a single guard between it and a real database is
// one edit away from not being there.
function assertTestTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    fail('DATABASE_URL is not a URL. Refusing to run.');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) fail('the connection URL names no database. Refusing to run.');
  if (!/test/i.test(database)) {
    // The name, never the credentials.
    fail(`database "${database}" is not named like a test database. Refusing to run.`);
  }
  const host = parsed.hostname;
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  if (!local && process.env.ALLOW_REMOTE_TEST_DB !== 'yes') {
    fail(`host "${host}" is not local and ALLOW_REMOTE_TEST_DB is not set. Refusing to run.`);
  }
  return { parsed, database, host };
}

function run(bin, args, options = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

async function query(url, sql, params = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function main() {
  const { parsed, database } = assertTestTarget(SOURCE_URL);

  // The restore target: a fresh database beside the source, named so it cannot
  // be mistaken for anything and so the guard above would also accept it.
  const restoreName = `${database}_restore_${crypto.randomBytes(3).toString('hex')}`;
  const restoreUrl = new URL(SOURCE_URL);
  restoreUrl.pathname = `/${restoreName}`;

  // An admin connection for CREATE/DROP DATABASE, which cannot run inside the
  // database being created.
  const adminUrl = new URL(SOURCE_URL);
  adminUrl.pathname = '/postgres';

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'naseeb-backup-'));
  const dumpFile = path.join(workdir, 'backup.dump');

  const report = { source: database, restore: restoreName, checks: [] };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.ok = false;
  };
  report.ok = true;

  try {
    // --- 1. seed something worth restoring --------------------------------
    //
    // Fabricated, and written through the application's own encryption so the
    // ciphertext in the dump is a real one rather than a string that looks like
    // one.
    const seeded = await seedFabricatedData(SOURCE_URL);

    const before = await counts(SOURCE_URL);

    // --- 2. dump -----------------------------------------------------------
    run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dumpFile, SOURCE_URL]);
    const size = fs.statSync(dumpFile).size;
    check('dump produced', size > 0, `${size} bytes`);

    // --- 3. restore into a NEW database -----------------------------------
    await query(adminUrl.toString(), `CREATE DATABASE "${restoreName}"`);
    run('pg_restore', ['--no-owner', '--no-acl', '--dbname', restoreUrl.toString(), dumpFile]);

    // --- 4. row counts match ----------------------------------------------
    const after = await counts(restoreUrl.toString());
    const mismatched = Object.keys(before).filter((table) => before[table] !== after[table]);
    check(
      'row counts match',
      mismatched.length === 0,
      mismatched.length ? `differs: ${mismatched.join(', ')}` : `${Object.keys(before).length} tables`
    );

    // --- 5. critical constraints and triggers survived ---------------------
    const migrations = require(path.join(ROOT, 'server', 'lib', 'migrations'));
    const constraints = await query(
      restoreUrl.toString(),
      'SELECT conname FROM pg_constraint WHERE conname = ANY($1)',
      [migrations.CRITICAL_CONSTRAINTS.map((c) => c.name)]
    );
    check(
      'critical constraints restored',
      constraints.rowCount === migrations.CRITICAL_CONSTRAINTS.length,
      `${constraints.rowCount}/${migrations.CRITICAL_CONSTRAINTS.length}`
    );

    const triggers = await query(
      restoreUrl.toString(),
      'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1)',
      [migrations.CRITICAL_TRIGGERS.map((t) => t.name)]
    );
    check(
      'append-only triggers restored',
      triggers.rowCount === migrations.CRITICAL_TRIGGERS.length,
      `${triggers.rowCount}/${migrations.CRITICAL_TRIGGERS.length}`
    );

    // --- 6. append-only history is still append-only ----------------------
    //
    // A restored trigger that does not fire is a restored trigger that is not
    // there. Proven by trying.
    let refused = false;
    try {
      await query(restoreUrl.toString(), 'DELETE FROM privacy_requests');
    } catch (err) {
      refused = /cannot be deleted|never erased/i.test(String(err.message));
    }
    check('privacy requests still undeletable in the restore', refused);

    let eventsRefused = false;
    try {
      await query(restoreUrl.toString(), 'DELETE FROM entry_integrity_events');
    } catch (err) {
      eventsRefused = /append-only/i.test(String(err.message));
    }
    check('integrity history still append-only in the restore', eventsRefused);

    // --- 7. encrypted delivery details -------------------------------------
    //
    // Two assertions, and the first matters as much as the second: the stored
    // value must still be CIPHERTEXT (a backup containing plaintext addresses
    // is a different and much worse artefact), and it must still decrypt with
    // the key.
    const claim = await query(
      restoreUrl.toString(),
      'SELECT delivery_ciphertext, delivery_iv, delivery_tag, delivery_key_version FROM prize_claims WHERE id = $1',
      [seeded.claimId]
    );
    const row = claim.rows[0];
    check('encrypted claim restored', Boolean(row && row.delivery_ciphertext));

    if (row && row.delivery_ciphertext) {
      // Stored base64, so a string. Coerced rather than assumed to be a Buffer.
      const asText = String(row.delivery_ciphertext);
      check(
        'delivery details are still ciphertext',
        !asText.includes(seeded.deliveryMarker),
        'the fabricated address does not appear in the stored value'
      );

      const { decryptDeliveryDetails } = require(path.join(ROOT, 'server', 'lib', 'claimCrypto'));
      let decrypted = null;
      try {
        decrypted = decryptDeliveryDetails({
          ciphertext: row.delivery_ciphertext,
          iv: row.delivery_iv,
          tag: row.delivery_tag,
          keyVersion: row.delivery_key_version,
        });
      } catch (err) {
        decrypted = null;
      }
      check(
        'delivery details decrypt with the test key',
        Boolean(decrypted && JSON.stringify(decrypted).includes(seeded.deliveryMarker))
      );
    }

    // --- 8. the migration ledger came with it ------------------------------
    const ledger = await query(restoreUrl.toString(), 'SELECT id, applied_by FROM schema_migrations');
    check('migration ledger restored', ledger.rowCount > 0, `${ledger.rowCount} entries`);
  } finally {
    // --- cleanup, always ---------------------------------------------------
    await query(adminUrl.toString(), `DROP DATABASE IF EXISTS "${restoreName}" WITH (FORCE)`).catch(
      () => {}
    );
    fs.rmSync(workdir, { recursive: true, force: true });
  }

  // Counts and outcomes. No connection string, no row content, no address.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.stderr.write('backup-verify: at least one check failed. The backup is NOT proven.\n');
    process.exit(1);
  }
  process.stderr.write(
    'backup-verify: restore verified against fabricated test data. This proves the MECHANISM, not the production backup — see docs/OPERATIONS.md.\n'
  );
}

const COUNTED_TABLES = [
  'users',
  'giveaways',
  'entries',
  'prize_claims',
  'privacy_requests',
  'privacy_request_events',
  'entry_integrity_events',
  'email_change_requests',
  'email_change_notifications',
  'schema_migrations',
];

async function counts(url) {
  const out = {};
  for (const table of COUNTED_TABLES) {
    // eslint-disable-next-line no-await-in-loop -- a fixed short list
    const result = await query(url, `SELECT COUNT(*)::int AS n FROM "${table}"`).catch(() => null);
    out[table] = result ? result.rows[0].n : null;
  }
  return out;
}

// Fabricated. Every value here is invented for this script.
async function seedFabricatedData(url) {
  const { pool, init, BASELINE_SQL } = require(path.join(ROOT, 'server', 'db'));
  const migrations = require(path.join(ROOT, 'server', 'lib', 'migrations'));
  const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

  process.env.CLAIM_ENCRYPTION_KEY =
    process.env.CLAIM_ENCRYPTION_KEY || `v1:${crypto.randomBytes(32).toString('base64')}`;
  const { encryptDeliveryDetails } = require(path.join(ROOT, 'server', 'lib', 'claimCrypto'));

  await migrations.migrate(pool, { init, baselineSql: BASELINE_SQL, log: { log: () => {} } });

  const hostId = crypto.randomUUID();
  const winnerId = crypto.randomUUID();
  const giveawayId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const claimId = crypto.randomUUID();
  const deliveryMarker = `Fabricated Villa ${crypto.randomBytes(3).toString('hex')}`;

  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, host_status,
                        age_attestation_status, age_attestation_version)
     VALUES ($1,'Backup Host',$2,$3,TRUE,'approved','confirmed','2026-08-eligibility-18'),
            ($4,'Backup Winner',$5,$3,TRUE,'not_requested','confirmed','2026-08-eligibility-18')`,
    [hostId, `backup-host-${Date.now()}@example.com`, bcrypt.hashSync('correcthorse123', 4),
     winnerId, `backup-winner-${Date.now()}@example.com`]
  );
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, entry_deadline, status, funded_by)
     VALUES ($1,$2,'Backup giveaway','Fabricated','Fabricated prize', NOW() + interval '7 days','active','Self-funded')`,
    [giveawayId, hostId]
  );
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1,$2,$3,1)',
    [entryId, giveawayId, winnerId]
  );

  const encrypted = encryptDeliveryDetails({
    full_name: 'Backup Winner',
    phone: '+971500000000',
    address_line1: deliveryMarker,
    city: 'Fabricated City',
  });
  await pool.query(
    `INSERT INTO prize_claims (id, giveaway_id, winner_user_id, entry_id, status,
        delivery_ciphertext, delivery_iv, delivery_tag, delivery_key_version, consented_at, consent_version)
     VALUES ($1,$2,$3,$4,'preparing',$5,$6,$7,$8,NOW(),'fabricated-1')`,
    [claimId, giveawayId, winnerId, entryId,
     encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion]
  );

  await pool.query(
    `INSERT INTO privacy_requests (id, reference, user_id, request_type, status, user_message)
     VALUES ($1,$2,$3,'access','submitted','Fabricated backup-test request.')`,
    [crypto.randomUUID(), `PR-BK${crypto.randomBytes(3).toString('hex').toUpperCase()}`, winnerId]
  );
  await pool.query(
    `INSERT INTO entry_integrity_events
       (id, entry_id, giveaway_id, from_status, to_status, reason_code, actor_role)
     VALUES ($1,$2,$3,'eligible','eligible','review_routine_check','system')`,
    [crypto.randomUUID(), entryId, giveawayId]
  );

  await pool.end();
  return { claimId, deliveryMarker };
}

main().catch((err) => {
  // Message only — a pg error can quote a connection string.
  process.stderr.write(`backup-verify: failed (${err.code || 'error'})\n`);
  process.exit(1);
});
