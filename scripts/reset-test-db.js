#!/usr/bin/env node
// Drops and recreates the test schema, then rebuilds it from server/db.js.
//
// Runs once, sequentially, as the first half of `npm test` — deliberately not
// per test file, because `node --test` runs files in parallel and a reset
// racing another file's fixtures would be worse than no reset at all. Doing it
// here means every suite starts from a known-empty schema instead of whatever
// the last (possibly crashed) run left behind.
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

async function main() {
  // DROP SCHEMA is the honest version of a reset: it takes tables, indexes,
  // constraints, extensions and any hand-made leftovers with it, so a stale
  // column from an abandoned branch can't survive into a fresh run.
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await init();
  console.log(`Test schema reset: ${target.describe}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
