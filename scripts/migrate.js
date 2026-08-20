#!/usr/bin/env node
//
// The schema command. Explicit, never run by the web process.
//
//   node scripts/migrate.js status     what the ledger says, and what the schema is
//   node scripts/migrate.js verify     read-only comparison against the frozen baseline
//   node scripts/migrate.js up         execute pending migrations, then verify
//   node scripts/migrate.js adopt      record an ALREADY-MATCHING schema, after verifying it
//   node scripts/migrate.js adopt --dry-run
//
// ---------------------------------------------------------------------------
// Why this is a command and not a startup step
// ---------------------------------------------------------------------------
//
// A web process that migrates on boot will, sooner or later, boot against a
// database somebody did not expect — a restored copy, a rolled-back deploy, a
// staging URL pasted into the wrong environment — and change it. Worse, the
// first version of this ledger would ADOPT such a database: write a row saying
// "already migrated" because a `users` table existed, after which nothing ever
// checked again.
//
// So the web process verifies and fails readiness. Changing a schema is a thing
// a person runs, having read what it is about to do.
//
// Exit codes:
//   0  the requested operation succeeded
//   1  it failed, or verification failed
//   2  bad arguments
require('dotenv').config();

const path = require('path');
const ROOT = path.join(__dirname, '..');

const { pool } = require(path.join(ROOT, 'server', 'db'));
const migrations = require(path.join(ROOT, 'server', 'lib', 'migrations'));
const schemaVerify = require(path.join(ROOT, 'server', 'lib', 'schemaVerify'));
const { isSlotProtectionActive } = require(path.join(ROOT, 'server', 'db'));

function usage() {
  process.stderr.write(
    [
      'Usage: node scripts/migrate.js <status|verify|up|adopt> [--dry-run]',
      '',
      '  status   what the ledger records, and whether the schema matches',
      '  verify   read-only comparison against the frozen baseline (changes nothing)',
      '  up       execute pending migrations under an advisory lock, then verify',
      '  adopt    record an already-matching schema, ONLY after verifying it',
      '',
      'Nothing here runs automatically. The web process verifies and fails',
      'readiness rather than adopting or mutating a database on boot.',
      '',
    ].join('\n')
  );
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function status() {
  const applied = await withClient((client) => migrations.appliedMigrations(client));
  const verified = await migrations.verify(pool);
  const preLedger = await withClient((client) => migrations.looksPreLedger(client));
  const slotProtected = await isSlotProtectionActive();

  return {
    schema_version: migrations.SCHEMA_VERSION,
    ledger: applied.map((row) => ({
      id: row.id,
      applied_by: row.applied_by,
      applied_at: row.applied_at,
    })),
    known_migrations: migrations.orderedIds(),
    checksums: migrations.checksums(),
    ledger_ok: verified.ok,
    problems: verified.problems,
    pre_ledger_database: preLedger,
    slot_exclusion_constraint_active: slotProtected,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dryRun = args.includes('--dry-run');

  if (!command || !['status', 'verify', 'up', 'adopt'].includes(command)) {
    if (command) process.stderr.write(`migrate: unknown command ${command}\n\n`);
    usage();
    return 2;
  }

  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(await status(), null, 2)}\n`);
    return 0;
  }

  if (command === 'verify') {
    const comparison = await withClient((client) =>
      schemaVerify.verifyAgainstSnapshot(client)
    );
    const ledger = await migrations.verify(pool);
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_matches_expected: comparison.ok,
          summary: comparison.summary,
          // Object names only. A CHECK definition can quote a value.
          missing: comparison.missing,
          altered: comparison.altered,
          extra_objects: comparison.summary.extra,
          ledger_ok: ledger.ok,
          ledger_problems: ledger.problems,
        },
        null,
        2
      )}\n`
    );
    return comparison.ok && ledger.ok ? 0 : 1;
  }

  if (command === 'adopt') {
    const result = await migrations.adopt(pool, { dryRun });
    process.stdout.write(
      `${JSON.stringify(
        {
          adopted: result.adopted,
          ok: result.ok,
          reason: result.reason || null,
          summary: result.comparison ? result.comparison.summary : null,
          missing: result.comparison ? result.comparison.missing : [],
          altered: result.comparison ? result.comparison.altered : [],
        },
        null,
        2
      )}\n`
    );
    if (!result.ok) {
      process.stderr.write(
        'migrate: adoption refused. Nothing was written to the ledger. Run `migrate up` to bring an older database forward, or `migrate verify` to see what differs.\n'
      );
      return 1;
    }
    return 0;
  }

  // up
  //
  // `migrate` applies the data-dependent booking-overlap constraint itself, so
  // this only has to read the outcome for the report.
  const summary = await migrations.migrate(pool);
  const slotProtected = await isSlotProtectionActive();

  process.stdout.write(
    `${JSON.stringify(
      {
        applied: summary.applied,
        already_applied: summary.alreadyApplied,
        schema_version: summary.version,
        schema_verified: summary.verified,
        summary: summary.comparison ? summary.comparison.summary : null,
        missing: summary.comparison ? summary.comparison.missing : [],
        altered: summary.comparison ? summary.comparison.altered : [],
        slot_protection: summary.slotProtection,
        slot_exclusion_constraint_active: slotProtected,
      },
      null,
      2
    )}\n`
  );

  if (!summary.verified) {
    process.stderr.write(
      'migrate: the schema does not match the frozen baseline after migrating. Do not deploy against this database until it is resolved.\n'
    );
    return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    // Message only. A pg error can carry a connection string in its stack.
    process.stderr.write(`migrate: ${err.message}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
