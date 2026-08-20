#!/usr/bin/env node
//
// Regenerates server/migrations/expected-schema.json from a database built by
// the migrations.
//
//   TEST_DATABASE_URL=... node scripts/schema-snapshot.js
//
// The snapshot is what `migrate verify` and `migrate adopt` compare a database
// against. It is committed, so a schema change is visible in a diff — and a
// test asserts the committed file matches a freshly-built database, so it
// cannot silently rot.
//
// Refuses anything that is not an isolated test database: this reads a schema
// and writes a file, and there is no reason to point it at production.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { configureTestEnv } = require(path.join(ROOT, 'testEnv'));
configureTestEnv();

const { pool } = require(path.join(ROOT, 'server', 'db'));
const schemaVerify = require(path.join(ROOT, 'server', 'lib', 'schemaVerify'));

(async () => {
  const client = await pool.connect();
  try {
    const snapshot = await schemaVerify.read(client, 'public');
    schemaVerify.writeSnapshot(snapshot);
    const counts = Object.fromEntries(
      schemaVerify.OBJECT_KINDS.map((kind) => [kind, snapshot[kind].length])
    );
    process.stdout.write(`${JSON.stringify({ written: schemaVerify.SNAPSHOT_PATH, counts }, null, 2)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  process.stderr.write(`schema-snapshot: ${err.message}\n`);
  process.exit(1);
});
