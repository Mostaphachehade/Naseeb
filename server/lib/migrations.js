// Proving that the running code and the database schema are the same vintage.
//
// ---------------------------------------------------------------------------
// What changed, and why the first version was not good enough
// ---------------------------------------------------------------------------
//
// The first ledger had two flaws that a checksum cannot paper over:
//
//   1. **The baseline was a file people edit.** It was `db.init()`'s template
//      literal, which every feature phase appended to. Checksumming that records
//      only that it changed again. The baseline is now
//      `server/migrations/001_baseline.sql`, frozen — future changes are `002`,
//      `003`, and nothing is ever added to `001`.
//
//   2. **Adoption was a guess.** A database with a `users` table was recorded as
//      fully migrated on the strength of one `to_regclass`. A database missing a
//      column, a CHECK or an append-only trigger would be marked done and then
//      fail at runtime on the one operation that object was protecting.
//      Adoption now requires an object-by-object verification against the frozen
//      baseline, it is an **explicit CLI action**, and on any difference it
//      refuses and writes no row.
//
// ---------------------------------------------------------------------------
// Two safe paths onto the ledger
// ---------------------------------------------------------------------------
//
//   **Verified adoption** — `node scripts/migrate.js adopt`
//   For a database whose schema already equals the baseline. Read-only
//   verification first; the ledger row is written only if every expected table,
//   column, type, nullability, default, key, index, foreign-key action, CHECK,
//   exclusion constraint, trigger, function and extension matches. It is
//   recorded as `adopted`, never as executed, because it was not executed.
//
//   **Baseline execution** — `node scripts/migrate.js up`
//   For an empty or older database. Runs the idempotent baseline under the
//   advisory lock, verifies the full schema afterwards, and records it as
//   `migrate` **only after verification passes**. A failure rolls back and
//   writes nothing: a partial migration must never be recorded as applied.
//
// **Web startup does neither.** It verifies and fails readiness. Silently
// adopting or mutating an unknown production database during a boot is exactly
// the behaviour this file exists to prevent.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const schemaVerify = require('./schemaVerify');

// Bumped when the expected schema changes. Readiness compares this to what the
// ledger says has actually been applied.
const SCHEMA_VERSION = '0003';

// Distinct from the claim-maintenance, ad-slot and per-job maintenance locks;
// none of them may contend.
const MIGRATION_LOCK_KEY = 918273645;

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ---------------------------------------------------------------------------
// The migrations
// ---------------------------------------------------------------------------
//
// Ordered by id, which is why they are numbered. `sqlFile` is read from disk and
// checksummed; a migration may instead supply `run` for something SQL cannot
// express, and is then checksummed from its source.
//
// **Nothing may be added to 001.** Its checksum is recorded in every deployed
// database, and changing it is a deliberate, breaking act.
const MIGRATIONS = [
  {
    id: '001_baseline',
    description:
      'The schema as it stood when the ledger was introduced. Frozen; idempotent; adopted rather than executed on a database that already matches it.',
    baseline: true,
    sqlFile: '001_baseline.sql',
  },
  {
    id: '002_schema_ledger',
    description:
      'Records that the ledger is live. Adds no table, column or constraint and touches no data.',
    sqlFile: '002_schema_ledger.sql',
  },
  {
    id: '003_giveaway_lifecycle',
    description:
      'Premium prize governance and the automatic giveaway lifecycle: publication, the 100-entry target, the 30-day deadline, append-only lifecycle history and durable entrant notices. Additive; drops nothing.',
    sqlFile: '003_giveaway_lifecycle.sql',
  },
];

// The critical objects readiness verifies by name. Named rather than counted: a
// count tells you something changed, a name tells you what.
const CRITICAL_CONSTRAINTS = [
  { name: 'giveaways_status_valid', table: 'giveaways', kind: 'check' },
  { name: 'giveaways_published_has_window', table: 'giveaways', kind: 'check' },
  { name: 'giveaways_outcome_coherent', table: 'giveaways', kind: 'check' },
  { name: 'giveaways_cancellation_valid', table: 'giveaways', kind: 'check' },
  { name: 'giveaways_prize_governed', table: 'giveaways', kind: 'check' },
  { name: 'privacy_requests_no_phantom_deletion', table: 'privacy_requests', kind: 'check' },
  { name: 'privacy_requests_closure_explained', table: 'privacy_requests', kind: 'check' },
  { name: 'privacy_requests_status_valid', table: 'privacy_requests', kind: 'check' },
  { name: 'users_age_attestation_valid', table: 'users', kind: 'check' },
  { name: 'email_change_status_valid', table: 'email_change_requests', kind: 'check' },
];

const CRITICAL_TRIGGERS = [
  { name: 'giveaway_lifecycle_events_immutable', table: 'giveaway_lifecycle_events' },
  { name: 'giveaway_notification_events_immutable', table: 'giveaway_notification_events' },
  { name: 'privacy_requests_no_delete', table: 'privacy_requests' },
  { name: 'privacy_request_events_immutable', table: 'privacy_request_events' },
  { name: 'privacy_request_executions_immutable', table: 'privacy_request_executions' },
  { name: 'entry_integrity_events_immutable', table: 'entry_integrity_events' },
  { name: 'entry_integrity_case_events_immutable', table: 'entry_integrity_case_events' },
  { name: 'email_change_notification_events_immutable', table: 'email_change_notification_events' },
];

function checksum(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function sqlFor(migration) {
  if (!migration.sqlFile) return null;
  return fs.readFileSync(path.join(MIGRATIONS_DIR, migration.sqlFile), 'utf8');
}

// A migration's checksum is over its own frozen content. The baseline's is the
// file, so editing the file is detected; a `run` migration's is its source.
function checksumFor(migration) {
  if (migration.sqlFile) return checksum(sqlFor(migration));
  return checksum(migration.run.toString());
}

// Every checksum, computed once. Useful for a report and for a test that adding
// a migration must not change the baseline's.
function checksums() {
  return Object.fromEntries(MIGRATIONS.map((m) => [m.id, checksumFor(m)]));
}

// Deterministic order, asserted rather than assumed: `MIGRATIONS` is applied in
// array order, and the array must be sorted by id.
function orderedIds() {
  return MIGRATIONS.map((m) => m.id);
}

function isOrdered() {
  const ids = orderedIds();
  return ids.every((id, i) => i === 0 || ids[i - 1] < id);
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      description TEXT,
      -- 'migrate'  this process executed it.
      -- 'adopted'  the schema already matched the baseline and was VERIFIED
      --            object by object before this row was written. Never written
      --            on the strength of a table existing.
      applied_by TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- The schema fingerprint at the moment of adoption, so a later question
      -- about what was verified has an answer.
      schema_fingerprint TEXT,
      note TEXT
    );
    ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS schema_fingerprint TEXT;
  `);
}

async function appliedMigrations(client) {
  await ensureLedger(client);
  const result = await client.query('SELECT * FROM schema_migrations ORDER BY id');
  return result.rows;
}

// Does this database predate the ledger? True when the core tables exist but no
// ledger row does.
//
// This is a QUESTION, not a decision. It used to be the whole of adoption; it is
// now only what tells the CLI which path to offer.
async function looksPreLedger(client) {
  await ensureLedger(client);
  const ledger = await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
  if (ledger.rows[0].n > 0) return false;
  const users = await client.query("SELECT to_regclass('public.users') IS NOT NULL AS present");
  return Boolean(users.rows[0].present);
}

// ---------------------------------------------------------------------------
// The one data-dependent object
// ---------------------------------------------------------------------------

// `ads_no_overlapping_slots` cannot be part of the frozen baseline: whether it
// can exist depends on the rows already in the table, and a migration that
// deleted or moved a paid booking to make room for a constraint would be
// destroying a commercial record to satisfy its own bookkeeping.
//
// So it is applied here, after the SQL, and its absence is reported rather than
// forced. Required lazily because `server/db.js` is what owns the decision and
// requiring it at module load would tie this file's load order to the pool's.
function slotConstraintModule() {
  // eslint-disable-next-line global-require -- see above
  return require('../db');
}

async function slotProtection(client) {
  const db = slotConstraintModule();
  const active = await db.isSlotProtectionActive(client);
  if (active) return { active: true, blockedByData: false, overlaps: 0 };
  const overlaps = await db.findOverlappingSlots(client);
  return { active: false, blockedByData: overlaps.length > 0, overlaps: overlaps.length };
}

// ---------------------------------------------------------------------------
// Verified adoption
// ---------------------------------------------------------------------------

// Explicit. Never called from web startup.
//
// Refuses — and writes nothing — unless the target schema matches the frozen
// baseline object for object. `dryRun` performs the same verification and
// reports, without touching the ledger.
async function adopt(pool, { dryRun = false, log = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureLedger(client);

    const existing = await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    if (existing.rows[0].n > 0) {
      return { ok: false, reason: 'ledger_not_empty', adopted: [] };
    }

    const users = await client.query("SELECT to_regclass('public.users') IS NOT NULL AS present");
    if (!users.rows[0].present) {
      return {
        ok: false,
        reason: 'database_is_empty',
        hint: 'Nothing to adopt. Run `migrate up` to execute the baseline.',
        adopted: [],
      };
    }

    const comparison = await schemaVerify.verifyAgainstSnapshot(client);
    if (!comparison.ok) {
      // Object NAMES only. A CHECK definition can quote a value, and this
      // reaches a log.
      log.error(
        `Adoption refused: the schema does not match the expected snapshot (${comparison.summary.missing} missing, ${comparison.summary.altered} altered).`
      );
      comparison.missing.slice(0, 40).forEach((m) => log.error(`  missing ${m.kind}: ${m.object}`));
      comparison.altered.slice(0, 40).forEach((m) => log.error(`  altered ${m.kind}: ${m.object}`));
      return { ok: false, reason: 'schema_mismatch', comparison, adopted: [] };
    }

    // The one data-dependent object. Absent because real bookings overlap is a
    // commercial conflict on an otherwise-correct schema, and adoption may
    // proceed with checkout gated. Absent for no reason at all is an
    // unprotected database, and adoption refuses so somebody runs `migrate up`
    // — which adds it — rather than recording the gap as verified.
    const slots = await slotProtection(client);
    if (comparison.conditional.length > 0 && !slots.blockedByData) {
      log.error(
        'Adoption refused: the booking-overlap protection is missing and there is no data conflict preventing it. Run `migrate up`, which adds it.'
      );
      return { ok: false, reason: 'slot_protection_missing', comparison, slots, adopted: [] };
    }

    if (dryRun) {
      return { ok: true, reason: 'dry_run', comparison, adopted: [] };
    }

    const target = await schemaVerify.read(client, 'public');
    const print = schemaVerify.fingerprint(target);

    // The baseline is adopted; anything after it is executed, because a
    // pre-ledger database cannot have run a migration that did not exist.
    await client.query(
      `INSERT INTO schema_migrations (id, checksum, description, applied_by, schema_fingerprint, note)
       VALUES ($1, $2, $3, 'adopted', $4, $5)`,
      [
        MIGRATIONS[0].id,
        checksumFor(MIGRATIONS[0]),
        MIGRATIONS[0].description,
        print,
        'Schema predates the ledger and was verified object by object against the frozen baseline before this row was written. Adopted, not executed.',
      ]
    );

    log.log(`Adopted ${MIGRATIONS[0].id} after full schema verification.`);
    return { ok: true, adopted: [MIGRATIONS[0].id], fingerprint: print, comparison, slots };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Baseline execution and forward migrations
// ---------------------------------------------------------------------------

// Explicit. Never called from web startup.
//
// Runs whatever has not been applied, under one advisory lock, verifying the
// schema after the baseline and recording a migration only once it has actually
// succeeded.
async function migrate(pool, { log = console } = {}) {
  if (!isOrdered()) {
    throw new Error('Migrations are not in ascending id order. Fix the list before running.');
  }

  const client = await pool.connect();
  const summary = { applied: [], alreadyApplied: [], version: SCHEMA_VERSION };

  try {
    // Blocking, not try-lock: a concurrent deploy should wait and then find the
    // work done, rather than starting a web process against a half-changed
    // schema.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureLedger(client);

    const applied = new Map(
      (await client.query('SELECT * FROM schema_migrations')).rows.map((r) => [r.id, r])
    );

    for (const migration of MIGRATIONS) {
      const expected = checksumFor(migration);
      const existing = applied.get(migration.id);

      if (existing) {
        if (existing.checksum !== expected) {
          throw new Error(
            `Migration ${migration.id} has changed since it was applied. The database records a different checksum than this code produces, so the running code and the schema disagree about what was applied. Resolve deliberately — never by editing the ledger.`
          );
        }
        summary.alreadyApplied.push(migration.id);
        continue;
      }

      // Each migration is its own transaction. PostgreSQL rolls DDL back, so a
      // failure part-way leaves the database as it was and — because the ledger
      // row is written inside the same transaction — records nothing.
      // eslint-disable-next-line no-await-in-loop -- migrations are ordered
      await client.query('BEGIN');
      try {
        const sql = migration.sqlFile ? sqlFor(migration) : null;
        // eslint-disable-next-line no-await-in-loop
        if (sql) await client.query(sql);
        // eslint-disable-next-line no-await-in-loop
        else await migration.run(client);

        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO schema_migrations (id, checksum, description, applied_by)
           VALUES ($1, $2, $3, 'migrate')`,
          [migration.id, expected, migration.description]
        );
        // eslint-disable-next-line no-await-in-loop
        await client.query('COMMIT');
        summary.applied.push(migration.id);
      } catch (err) {
        // eslint-disable-next-line no-await-in-loop
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${migration.id} failed and was rolled back. Nothing was recorded.`);
      }
    }

    // The data-dependent constraint, applied after the SQL and outside the
    // per-migration transactions. It inspects the existing bookings and refuses
    // to act when real ones overlap — no row is deleted, moved or released to
    // make it fit. See `ensureSlotExclusionConstraint`.
    const slotResult = await slotConstraintModule().ensureSlotExclusionConstraint(client);
    summary.slotProtection = slotResult.status;
    if (slotResult.status === 'blocked') {
      log.error(
        `Booking-overlap protection could NOT be applied: ${slotResult.overlaps.length} existing booking pair(s) overlap. Both sides of every pair have been left exactly as they were. Self-serve ad checkout stays disabled until somebody resolves them by hand.`
      );
    }

    // Verified AFTER everything, and outside the per-migration transactions, so
    // the answer describes the committed state.
    //
    // The baseline is idempotent, so an older database that was upgraded rather
    // than adopted must still end up equal to it. If it does not, the ledger has
    // already recorded the migration — so this is reported loudly and the caller
    // decides. It is deliberately not a silent pass.
    const comparison = await schemaVerify.verifyAgainstSnapshot(client);
    summary.verified = comparison.ok;
    summary.comparison = comparison;

    if (!comparison.ok) {
      log.error(
        `Schema verification FAILED after migrating (${comparison.summary.missing} missing, ${comparison.summary.altered} altered). The database is not what this code expects.`
      );
      comparison.missing.slice(0, 40).forEach((m) => log.error(`  missing ${m.kind}: ${m.object}`));
      comparison.altered.slice(0, 40).forEach((m) => log.error(`  altered ${m.kind}: ${m.object}`));
    }

    if (summary.applied.length) {
      log.log(`Schema migrations applied: ${summary.applied.join(', ')}.`);
    }
    return summary;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Verification, for readiness
// ---------------------------------------------------------------------------

// Read-only. Never mutates, never adopts, never migrates.
async function verify(pool) {
  const problems = [];

  const ledger = await pool
    .query('SELECT id, checksum, applied_by FROM schema_migrations')
    .catch(() => null);

  if (!ledger) {
    return {
      ok: false,
      version: SCHEMA_VERSION,
      problems: ['schema ledger is missing — run the migration command'],
      applied: [],
    };
  }

  const applied = new Map(ledger.rows.map((r) => [r.id, r]));

  MIGRATIONS.forEach((migration) => {
    const row = applied.get(migration.id);
    if (!row) {
      problems.push(`migration ${migration.id} has not been applied`);
      return;
    }
    if (row.checksum !== checksumFor(migration)) {
      problems.push(`migration ${migration.id} checksum mismatch`);
    }
  });

  // A ledger id this code does not know about means the database is NEWER than
  // the code — a rollback that left the schema ahead. Old code against a new
  // schema is the case nobody tested.
  ledger.rows.forEach((row) => {
    if (!MIGRATIONS.some((m) => m.id === row.id)) {
      problems.push(`database has unknown migration ${row.id} (schema is ahead of this code)`);
    }
  });

  const constraints = await pool.query(
    'SELECT conname FROM pg_constraint WHERE conname = ANY($1)',
    [CRITICAL_CONSTRAINTS.map((c) => c.name)]
  );
  const found = new Set(constraints.rows.map((r) => r.conname));
  CRITICAL_CONSTRAINTS.forEach((c) => {
    if (!found.has(c.name)) problems.push(`constraint ${c.name} is missing`);
  });

  const triggers = await pool.query(
    'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1)',
    [CRITICAL_TRIGGERS.map((t) => t.name)]
  );
  const foundTriggers = new Set(triggers.rows.map((r) => r.tgname));
  CRITICAL_TRIGGERS.forEach((t) => {
    if (!foundTriggers.has(t.name)) problems.push(`trigger ${t.name} is missing`);
  });

  return {
    ok: problems.length === 0,
    version: SCHEMA_VERSION,
    problems,
    applied: ledger.rows.map((r) => ({ id: r.id, applied_by: r.applied_by })),
  };
}

module.exports = {
  SCHEMA_VERSION,
  MIGRATION_LOCK_KEY,
  MIGRATIONS,
  MIGRATIONS_DIR,
  CRITICAL_CONSTRAINTS,
  CRITICAL_TRIGGERS,
  checksum,
  checksumFor,
  checksums,
  sqlFor,
  slotProtection,
  orderedIds,
  isOrdered,
  ensureLedger,
  appliedMigrations,
  looksPreLedger,
  adopt,
  migrate,
  verify,
};
