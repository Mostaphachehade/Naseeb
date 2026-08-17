// Proving that the running code and the database schema are the same vintage.
//
// ---------------------------------------------------------------------------
// What was here before, and why it needed something
// ---------------------------------------------------------------------------
//
// `db.init()` is one large idempotent bootstrap: CREATE TABLE IF NOT EXISTS,
// ADD COLUMN IF NOT EXISTS, DO $$ blocks that add a constraint when it is
// absent. It runs on every boot, under an advisory lock, and it works.
//
// What it cannot do is answer a question that matters during a deploy: **is the
// database this process is talking to the one this code expects?** A rollback
// to an older release leaves new columns in place and old code running against
// them — usually fine, occasionally not. A half-finished deploy leaves a
// constraint missing with nothing recording that fact. And an idempotent script
// that somebody edits produces a different schema on a fresh database than on
// an existing one, silently, forever.
//
// ---------------------------------------------------------------------------
// The baseline strategy, stated plainly
// ---------------------------------------------------------------------------
//
// Rewriting 1,400 lines of accumulated DDL into an ordered migration history
// would be inventing a past that did not happen. Every existing database got
// its schema from `init()`, not from a numbered sequence, and a ledger claiming
// otherwise would be a lie told by the thing whose whole job is to be trusted.
//
// So:
//
//   * **0001_baseline** IS `db.init()`. It is checksummed by hashing the SQL
//     text `init()` executes. It is idempotent by construction and safe to
//     re-run.
//
//   * An **existing** database is ADOPTED: the ledger records the baseline with
//     `applied_by = 'adoption'` and a note saying the schema predates the
//     ledger. It is not marked as having been executed, because it was not.
//
//   * A **fresh** database records `applied_by = 'migrate'`.
//
//   * Everything after the baseline is an ordinary numbered migration: ordered,
//     idempotent, checksummed, applied once.
//
// Adoption is detectable and honest. `SELECT applied_by FROM schema_migrations`
// tells you which databases were adopted and which were built.
//
// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------
//
//   * **Concurrent deploys cannot double-apply.** One advisory lock around the
//     whole run; a second process waits, then finds the work done.
//   * **An edited historical migration is detected.** The checksum recorded at
//     application time is compared on every check. A mismatch is a hard failure,
//     not a warning: it means the code and the database disagree about what was
//     applied and nobody can tell which is right.
//   * **No automatic destructive rollback.** There is no `down`. Reversing a
//     migration is a new migration, written deliberately.
//   * **Nothing deletes commercial or audit data.** Enforced by review and by a
//     test that greps every migration body for a destructive verb.
const crypto = require('crypto');

// Bumped when the expected schema changes. Readiness compares this to what the
// ledger says has actually been applied.
const SCHEMA_VERSION = '0002';

// Distinct from the claim-maintenance and ad-slot locks; the three must never
// contend.
const MIGRATION_LOCK_KEY = 918273645;

// ---------------------------------------------------------------------------
// The migrations
// ---------------------------------------------------------------------------
//
// `sql` may be a string or a function taking a client. The baseline is a
// function because its body lives in db.js.
//
// A migration must be idempotent: it may run against a database where it has
// already had its effect (an adopted one, most obviously) and must succeed.
const MIGRATIONS = [
  {
    id: '0001_baseline',
    description:
      'The schema as built by db.init(). Idempotent bootstrap; adopted rather than executed on a database that predates the ledger.',
    baseline: true,
    // Checksummed from the SQL init() runs, so an edit to the bootstrap is
    // visible here rather than silently producing two different schemas.
    run: async (client, { init }) => init(client),
  },
  {
    id: '0002_operational_readiness',
    description:
      'Constraint verification support for the readiness probe. Adds no columns and touches no data.',
    run: async (client) => {
      // Deliberately a no-op DDL that records the ledger is live. Everything it
      // would have created already exists in the baseline; the migration exists
      // so the ordered path is exercised by a real second entry rather than
      // being theoretical until the first schema change needs it.
      await client.query('SELECT 1');
    },
  },
];

// The critical constraints readiness verifies. Named rather than counted: a
// count tells you something changed, a name tells you what.
const CRITICAL_CONSTRAINTS = [
  { name: 'privacy_requests_no_phantom_deletion', table: 'privacy_requests', kind: 'check' },
  { name: 'privacy_requests_closure_explained', table: 'privacy_requests', kind: 'check' },
  { name: 'privacy_requests_status_valid', table: 'privacy_requests', kind: 'check' },
  { name: 'users_age_attestation_valid', table: 'users', kind: 'check' },
  { name: 'email_change_status_valid', table: 'email_change_requests', kind: 'check' },
];

const CRITICAL_TRIGGERS = [
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

// The baseline's checksum comes from the SQL text db.js executes, so editing
// the bootstrap changes it. Everything else is hashed from its own source.
function checksumFor(migration, { baselineSql = '' } = {}) {
  if (migration.baseline) return checksum(baselineSql);
  return checksum(migration.run.toString());
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      description TEXT,
      -- 'migrate' when this process ran it; 'adoption' when the schema already
      -- existed and the ledger was written to describe reality rather than to
      -- claim the migration executed.
      applied_by TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note TEXT
    );
  `);
}

async function appliedMigrations(client) {
  await ensureLedger(client);
  const result = await client.query('SELECT * FROM schema_migrations ORDER BY id');
  return result.rows;
}

// Does this database predate the ledger? True when the core tables exist but no
// ledger row does — which is exactly the adoption case.
async function looksAdopted(client) {
  const ledger = await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
  if (ledger.rows[0].n > 0) return false;
  const users = await client.query(
    "SELECT to_regclass('public.users') IS NOT NULL AS present"
  );
  return Boolean(users.rows[0].present);
}

// Runs whatever has not been applied, under one advisory lock.
//
// `init` is injected rather than required, so this module does not depend on
// db.js and db.js can depend on it.
async function migrate(pool, { init, baselineSql = '', log = console } = {}) {
  const client = await pool.connect();
  const summary = { applied: [], adopted: [], alreadyApplied: [], version: SCHEMA_VERSION };

  try {
    // Blocking, not try-lock: a concurrent deploy should wait and then find the
    // work already done, rather than starting a web process against a schema
    // that is still being changed.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureLedger(client);

    const adopting = await looksAdopted(client);
    const applied = new Map(
      (await client.query('SELECT * FROM schema_migrations')).rows.map((r) => [r.id, r])
    );

    for (const migration of MIGRATIONS) {
      const expected = checksumFor(migration, { baselineSql });
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

      if (adopting && migration.baseline) {
        // The schema is already here. Record that, and say how it got here.
        // eslint-disable-next-line no-await-in-loop -- ordered by definition
        await client.query(
          `INSERT INTO schema_migrations (id, checksum, description, applied_by, note)
           VALUES ($1, $2, $3, 'adoption', $4)`,
          [
            migration.id,
            expected,
            migration.description,
            'Schema predates the migration ledger. Recorded as adopted, not executed: db.init() built this database before the ledger existed.',
          ]
        );
        summary.adopted.push(migration.id);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- migrations are ordered
      await migration.run(client, { init });
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO schema_migrations (id, checksum, description, applied_by)
         VALUES ($1, $2, $3, 'migrate')`,
        [migration.id, expected, migration.description]
      );
      summary.applied.push(migration.id);
    }

    if (summary.applied.length) {
      log.log(`Schema migrations applied: ${summary.applied.join(', ')}.`);
    }
    if (summary.adopted.length) {
      log.log(
        `Schema adopted into the migration ledger: ${summary.adopted.join(', ')}. Recorded as adopted rather than executed.`
      );
    }

    return summary;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Read-only. Used by readiness, which must never mutate anything.
//
// Returns a structured verdict with no table content and no configuration
// detail — the caller decides how much of it reaches a response.
async function verify(pool, { baselineSql = '' } = {}) {
  const problems = [];

  const ledger = await pool
    .query('SELECT id, checksum, applied_by FROM schema_migrations')
    .catch(() => null);

  if (!ledger) {
    return {
      ok: false,
      version: SCHEMA_VERSION,
      problems: ['schema ledger is missing'],
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
    if (row.checksum !== checksumFor(migration, { baselineSql })) {
      problems.push(`migration ${migration.id} checksum mismatch`);
    }
  });

  // An id in the database that this code does not know about means the database
  // is NEWER than the code — a rollback that left the schema ahead. Worth
  // failing on: old code against a new schema is exactly the case nobody tested.
  ledger.rows.forEach((row) => {
    if (!MIGRATIONS.some((m) => m.id === row.id)) {
      problems.push(`database has unknown migration ${row.id} (schema is ahead of this code)`);
    }
  });

  // Critical constraints and triggers, by name.
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
  CRITICAL_CONSTRAINTS,
  CRITICAL_TRIGGERS,
  checksum,
  checksumFor,
  ensureLedger,
  appliedMigrations,
  looksAdopted,
  migrate,
  verify,
};
