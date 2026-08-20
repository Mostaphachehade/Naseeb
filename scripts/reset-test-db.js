#!/usr/bin/env node
// Drops and recreates the test schema, then rebuilds it from server/db.js.
//
// Runs once, sequentially, as the first half of `npm test`, so every suite
// starts from a known-empty schema instead of whatever the last (possibly
// crashed) run left behind.
//
// The test files themselves also run one at a time (--test-concurrency=1).
// They share a single database, and running them in parallel made assertions
// depend on what other files happened to be doing: global row counts moved
// under COUNT(*) checks, one file's settings changes altered another's prices
// mid-request, and the slot locks introduced in Phase 1.3 (an advisory lock,
// and a brief ACCESS EXCLUSIVE while the migration tests drop and restore the
// exclusion constraint) blocked whole files at a time. Serial execution costs a
// couple of seconds and removes the entire class of failure.
//
// The same guard as the test suite applies: this cannot point at production.
const { configureTestEnv } = require('../testEnv');

let target;
try {
  target = configureTestEnv();
} catch (err) {
  // The guard's message is the whole point of the failure — a stack trace
  // above it just buries the instructions for fixing it.
  if (err.name === 'TestDatabaseGuardError') {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// Required after configureTestEnv(), which is what points DATABASE_URL at the
// approved test database — server/db.js builds its Pool at require time.
const { pool, init } = require('../server/db');
const migrations = require('../server/lib/migrations');

async function main() {
  // DROP SCHEMA is the honest version of a reset: it takes tables, indexes,
  // constraints, extensions and any hand-made leftovers with it, so a stale
  // column from an abandoned branch can't survive into a fresh run.
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');

  // The test reset is DELIBERATELY NOT the production migration path: it drops
  // the schema, which nothing in production may ever do. It then runs the same
  // migrations so the ledger exists and readiness can be exercised — without
  // that, every readiness test would fail on "migration not applied" and the
  // suite would be testing a state no deployment is ever in.
  //
  // `migrate` here is only ever pointed at the isolated test database: the guard
  // above has already refused anything else.
  const summary = await migrations.migrate(pool, {
    log: { log: () => {}, error: console.error },
  });
  await init();
  console.log(
    `Test schema reset: ${target.describe} (migrations ${summary.applied.join(', ') || 'none'}, verified ${summary.verified})`
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
