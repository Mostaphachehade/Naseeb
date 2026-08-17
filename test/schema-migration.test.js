// Phase 2.4A safety fix: the frozen baseline, verified adoption, and what
// happens when this code meets a database it did not create.
//
// ---------------------------------------------------------------------------
// Why this file builds whole databases
// ---------------------------------------------------------------------------
//
// The migration tests that already exist (test/operations.test.js, op21-22b)
// check the ledger's arithmetic against the one shared test database: locking,
// checksums, idempotence. They cannot check the thing that actually goes wrong,
// which is a database that is not the shape this code expects — an older copy
// missing a table, a restore that lost a trigger, a schema with real commercial
// rows in it that block a constraint.
//
// So every scenario here gets its OWN throwaway database, created on the same
// isolated local server, dropped afterwards. Nothing touches the shared test
// schema, and nothing here can reach a hosted service: the connection is built
// from the already-guarded test URL, and the database names all contain "test".
//
// Every row in every fixture is fabricated. No production data, no real person,
// no real company, no real payment.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const { configureTestEnv } = require('../testEnv');

configureTestEnv();

const { Pool } = require('pg');
const migrations = require('../server/lib/migrations');
const schemaVerify = require('../server/lib/schemaVerify');
const {
  init,
  BASELINE_SQL,
  BASELINE_PATH,
  ensureSlotExclusionConstraint,
  isSlotProtectionActive,
  findOverlappingSlots,
  SLOT_CONSTRAINT_NAME,
} = require('../server/db');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Throwaway databases
// ---------------------------------------------------------------------------

// The guard in testEnv.js has already refused anything that is not an isolated
// local test database, so this connection string is safe to derive from.
const TARGET = new URL(process.env.DATABASE_URL);

function urlForDatabase(name) {
  const url = new URL(TARGET.toString());
  url.pathname = `/${name}`;
  return url.toString();
}

// The maintenance connection. CREATE DATABASE cannot run inside a transaction
// and cannot run against the database being dropped, so it gets its own.
let admin;
const fixtures = [];

function fixtureName(label) {
  // "test" in the name is not decoration: it is what every guard in this
  // repository keys on, and these are as disposable as a database gets.
  return `naseeb_fixture_test_${label}_${crypto.randomBytes(4).toString('hex')}`;
}

async function createFixture(label) {
  const name = fixtureName(label);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ connectionString: urlForDatabase(name), ssl: false, max: 4 });
  const fixture = { name, pool };
  fixtures.push(fixture);
  return fixture;
}

async function dropFixture(fixture) {
  await fixture.pool.end().catch(() => {});
  await admin
    .query(`DROP DATABASE IF EXISTS ${fixture.name} WITH (FORCE)`)
    .catch(async () => {
      // Older servers have no WITH (FORCE).
      await admin.query(`DROP DATABASE IF EXISTS ${fixture.name}`).catch(() => {});
    });
}

const silent = { log() {}, error() {} };

before(async () => {
  admin = new Pool({ connectionString: urlForDatabase('postgres'), ssl: false, max: 2 });
  await admin.query('SELECT 1');
});

after(async () => {
  for (const fixture of fixtures) {
    // eslint-disable-next-line no-await-in-loop -- teardown, deliberately serial
    await dropFixture(fixture);
  }
  await admin.end().catch(() => {});
});

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

// A database built by the baseline and then rewound to look pre-ledger: the
// schema is right, but nothing has ever recorded a migration. This is the shape
// of every database that existed before this ledger was written.
async function preLedgerMatching(label) {
  const fixture = await createFixture(label);
  // The FULL migration set, not the baseline alone: "correctly matching" means
  // matching what this code expects today, which is the baseline plus every
  // migration after it. Building from `init()` alone would model a database
  // that is behind, which is what `olderDatabase` is for.
  await migrations.migrate(fixture.pool, { log: silent });
  await fixture.pool.query('DROP TABLE IF EXISTS schema_migrations');
  return fixture;
}

// Tables that nothing else references, so dropping them models an older
// database honestly rather than cascading half the schema away.
const LATE_TABLES = [
  'email_change_notification_events',
  'email_change_notifications',
  'privacy_request_executions',
];

// Columns added by later phases. Dropping one takes its CHECK constraint with
// it, which is exactly what an older database looks like.
const LATE_COLUMNS = [
  ['users', 'age_attestation_status'],
  ['users', 'age_attestation_version'],
];

// An older database: the core is there, several later objects are not.
async function olderDatabase(label) {
  const fixture = await preLedgerMatching(label);
  for (const table of LATE_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    await fixture.pool.query(`DROP TABLE IF EXISTS ${table}`);
  }
  for (const [table, column] of LATE_COLUMNS) {
    // eslint-disable-next-line no-await-in-loop
    await fixture.pool.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`);
  }
  return fixture;
}

// Fabricated operating history: a giveaway, entries, a claim and append-only
// integrity events. Everything is invented; the point is that a migration must
// leave all of it exactly as it found it.
async function seedFabricatedHistory(pool) {
  const hostId = crypto.randomUUID();
  const giveawayId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, host_status)
     VALUES ($1,'Fabricated Host','fixture-host@example.com',
             '$2a$04$fabricatedhashfabricatedhashfabricatedhashfabricated',TRUE,'approved')`,
    [hostId]
  );

  const entrantIds = [];
  for (let i = 0; i < 5; i += 1) {
    const id = crypto.randomUUID();
    entrantIds.push(id);
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, email_verified)
       VALUES ($1, $2, $3, '$2a$04$fabricatedhashfabricatedhashfabricatedhashfabricated', TRUE)`,
      [id, `Fabricated Entrant ${i + 1}`, `fixture-entrant-${i + 1}@example.com`]
    );
  }

  // `prize_governance_version = 0` is the honest value for a fixture standing in
  // for a campaign published before curated prize governance existed. It is what
  // the migration writes for every pre-existing row, and it is what exempts such
  // a row from the approval and prize-standard CHECK constraints — which it
  // cannot satisfy, because no administrator ever approved it.
  //
  // Set only where the column exists: this same seed runs against a database
  // built by the baseline alone, which predates it.
  const governed = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='giveaways'
        AND column_name='prize_governance_version'`
  );
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description,
                            estimated_value_aed, funded_by, entry_deadline, status
                            ${governed.rows[0].n ? ', prize_governance_version, published_at, closes_at' : ''})
     VALUES ($1, $2, 'Fabricated Prize Draw', 'Fixture data. Not a real giveaway.',
             'A prize that does not exist', 1000, 'Fabricated Host',
             '2099-01-01T00:00:00.000Z', 'active'${
       governed.rows[0].n
         ? ", 0, TIMESTAMPTZ '2026-01-01 09:00:00+04', TIMESTAMPTZ '2099-01-01 00:00:00+00'"
         : ''
     })`,
    [giveawayId, hostId]
  );

  const entryIds = [];
  for (let i = 0; i < entrantIds.length; i += 1) {
    const id = crypto.randomUUID();
    entryIds.push(id);
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO entries (id, giveaway_id, user_id, ticket_number, created_at)
       VALUES ($1, $2, $3, $4, TIMESTAMPTZ '2026-01-01 09:00:00+04' + ($5 || ' minutes')::interval)`,
      [id, giveawayId, entrantIds[i], i + 1, String(i * 3)]
    );
  }

  // Append-only history. The trigger on this table refuses UPDATE and DELETE,
  // so if a migration disturbed it these rows could never be restored — which
  // is exactly why "it survived" has to be measured rather than assumed.
  await pool.query(
    `INSERT INTO entry_integrity_events
       (id, entry_id, giveaway_id, from_status, to_status, reason_code, actor_role,
        admin_notes, created_at)
     VALUES ($1, $2, $3, NULL, 'under_review', 'signal_recorded', 'system',
             NULL, TIMESTAMPTZ '2026-01-01 09:01:00+04'),
            ($4, $5, $3, 'under_review', 'eligible', 'reinstated_after_review', 'admin',
             'Fabricated fixture note: reviewed and reinstated.',
             TIMESTAMPTZ '2026-01-02 11:30:00+04')`,
    [crypto.randomUUID(), entryIds[0], giveawayId, crypto.randomUUID(), entryIds[1]]
  );

  return { hostId, entrantIds, giveawayId, entryIds };
}

// Two overlapping paid banner bookings, written before any constraint existed.
// These are the rows the exclusion constraint cannot be added over, and they
// must survive every path through this file untouched.
async function seedOverlappingAds(pool) {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ads (id, business_name, image_url, target_url, slot_status, paid,
                      payment_status, starts_at, ends_at)
     VALUES ($1,'Fabricated Advertiser A','https://example.com/a.png','https://example.com/a',
             'paid', TRUE, 'paid', DATE '2026-03-02', DATE '2026-03-15'),
            ($2,'Fabricated Advertiser B','https://example.com/b.png','https://example.com/b',
             'paid', TRUE, 'paid', DATE '2026-03-09', DATE '2026-03-22')`,
    [a, b]
  );
  return { a, b };
}

// A cheap semantic fingerprint of the fabricated rows, so "intact" is a
// measurement rather than a claim.
async function contentFingerprint(pool) {
  const rows = {};
  for (const table of ['users', 'giveaways', 'entries', 'entry_integrity_events', 'ads']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await pool.query(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest, COUNT(*)::int AS n
         FROM ${table} t`
    );
    rows[table] = { digest: result.rows[0].digest, n: result.rows[0].n };
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 1. The frozen baseline
// ---------------------------------------------------------------------------

test('sm1. the baseline is a frozen file, and editing it changes its checksum', () => {
  assert.ok(fs.existsSync(BASELINE_PATH), 'the baseline is a file on disk');
  assert.equal(path.basename(BASELINE_PATH), '001_baseline.sql');

  const onDisk = fs.readFileSync(BASELINE_PATH, 'utf8');
  assert.equal(onDisk, BASELINE_SQL, 'db.js runs the file, not a copy of it');
  assert.match(onDisk, /Do not edit this file/i, 'the file says so in its own header');

  // The recorded checksum is the hash of the file's contents, so any edit — a
  // new column, a comment, a stray newline — produces a different one.
  const recorded = migrations.checksumFor(migrations.MIGRATIONS[0]);
  assert.equal(recorded, migrations.checksum(onDisk));

  [
    `${onDisk}\nALTER TABLE users ADD COLUMN IF NOT EXISTS added_later TEXT;`,
    `${onDisk}\n-- a comment somebody added`,
    `${onDisk}\n`,
  ].forEach((edited) => {
    assert.notEqual(migrations.checksum(edited), recorded, 'an edited baseline is a different baseline');
  });
});

test('sm2. adding a migration does not alter the baseline checksum, and order is deterministic', () => {
  const before = migrations.checksums();
  const baselineChecksum = before['001_baseline'];

  const added = {
    id: '900_fabricated_for_this_test',
    description: 'Fabricated. Never executed.',
    run: async () => {},
  };
  migrations.MIGRATIONS.push(added);
  try {
    const after = migrations.checksums();
    assert.equal(after['001_baseline'], baselineChecksum, 'the baseline is untouched by a later migration');
    assert.equal(after['002_schema_ledger'], before['002_schema_ledger']);
    assert.equal(after['003_giveaway_lifecycle'], before['003_giveaway_lifecycle']);
    assert.ok(after['900_fabricated_for_this_test'], 'the new one is checksummed too');
    assert.equal(migrations.isOrdered(), true, 'ids stay in ascending order');
  } finally {
    migrations.MIGRATIONS.splice(migrations.MIGRATIONS.indexOf(added), 1);
  }

  // Order is asserted, not assumed: the runner applies array order and refuses
  // to run at all if the array is not sorted.
  assert.deepEqual(migrations.orderedIds(), [...migrations.orderedIds()].sort());
  assert.equal(migrations.isOrdered(), true);

  const outOfOrder = { id: '000_before_the_baseline', description: 'x', run: async () => {} };
  migrations.MIGRATIONS.push(outOfOrder);
  try {
    assert.equal(migrations.isOrdered(), false, 'an out-of-order list is detected');
  } finally {
    migrations.MIGRATIONS.splice(migrations.MIGRATIONS.indexOf(outOfOrder), 1);
  }
  assert.equal(migrations.isOrdered(), true, 'and the list is restored');
});

test('sm3. the committed schema snapshot matches a database the migrations just built', async () => {
  // This is what keeps `expected-schema.json` honest. If somebody changes the
  // baseline and forgets `npm run schema:snapshot`, adoption would be verifying
  // against yesterday's expectation — so the snapshot is compared against a
  // live, freshly-built database on every run.
  const fixture = await createFixture('snapshot');
  await migrations.migrate(fixture.pool, { log: silent });

  const client = await fixture.pool.connect();
  try {
    const comparison = await schemaVerify.verifyAgainstSnapshot(client);
    assert.equal(
      comparison.ok,
      true,
      `the committed snapshot is stale — run \`npm run schema:snapshot\`. missing=${JSON.stringify(comparison.missing)} altered=${JSON.stringify(comparison.altered)}`
    );
    assert.equal(comparison.summary.extra, 0, `unexpected objects: ${JSON.stringify(comparison.extra)}`);
    assert.equal(comparison.summary.conditional, 0, 'the slot constraint applies on a clean build');

    // The ledger's own table is not part of the compared schema — it is what
    // does the comparing, and including it would make the snapshot depend on
    // whether the ledger had run yet.
    assert.ok(
      !comparison.extra.some((row) => row.object.startsWith('schema_migrations')),
      'the ledger table is neither expected nor reported as extra'
    );

    // The snapshot must actually carry the objects the audit named, or a
    // comparison against it proves nothing.
    const snapshot = schemaVerify.loadSnapshot();
    assert.ok(snapshot.exclusion_constraints.length >= 1, 'the slot exclusion constraint is in the snapshot');
    assert.ok(
      snapshot.exclusion_constraints.some((row) => row.conname === SLOT_CONSTRAINT_NAME),
      'and it is the one that stops the banner slot being double-sold'
    );
    assert.ok(snapshot.triggers.length >= 6, 'the append-only triggers are in the snapshot');
    migrations.CRITICAL_TRIGGERS.forEach((t) => {
      assert.ok(
        snapshot.triggers.some((row) => row.tgname === t.name),
        `${t.name} is in the snapshot`
      );
    });
    migrations.CRITICAL_CONSTRAINTS.forEach((c) => {
      assert.ok(
        snapshot.check_constraints.some((row) => row.conname === c.name),
        `${c.name} is in the snapshot`
      );
    });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 2. An empty database
// ---------------------------------------------------------------------------

test('sm4. proof 1 — an empty database executes the baseline and verifies', async () => {
  const fixture = await createFixture('empty');

  // Nothing here yet.
  const before = await fixture.pool.query(
    "SELECT to_regclass('public.users') IS NOT NULL AS present"
  );
  assert.equal(before.rows[0].present, false);

  // Adoption refuses an empty database outright: there is nothing to adopt, and
  // recording a baseline against nothing is the exact mistake this replaced.
  const refused = await migrations.adopt(fixture.pool, { log: silent });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'database_is_empty');
  const ledgerAfterRefusal = await fixture.pool.query(
    'SELECT COUNT(*)::int AS n FROM schema_migrations'
  );
  assert.equal(ledgerAfterRefusal.rows[0].n, 0, 'a refusal writes no ledger row');

  const summary = await migrations.migrate(fixture.pool, { log: silent });
  assert.deepEqual(summary.applied, migrations.orderedIds());
  assert.equal(summary.verified, true, JSON.stringify(summary.comparison && summary.comparison.missing));

  // Including the data-dependent one: an empty table has nothing to conflict
  // with, so the booking-overlap constraint applies.
  assert.equal(summary.slotProtection, 'created');
  assert.equal(await isSlotProtectionActive(fixture.pool), true);

  const verified = await migrations.verify(fixture.pool);
  assert.equal(verified.ok, true, JSON.stringify(verified.problems));
  assert.ok(verified.applied.every((row) => row.applied_by === 'migrate'), 'executed, not adopted');
});

// ---------------------------------------------------------------------------
// 3. Verified adoption
// ---------------------------------------------------------------------------

test('sm5. proof 2 — an exactly-matching pre-ledger database may be explicitly adopted', async () => {
  const fixture = await preLedgerMatching('matching');
  const history = await seedFabricatedHistory(fixture.pool);

  assert.equal(
    await migrations.looksPreLedger(fixture.pool),
    true,
    'the fixture reads as pre-ledger: core tables present, ledger empty'
  );

  // A dry run verifies and reports without writing anything.
  const dry = await migrations.adopt(fixture.pool, { dryRun: true, log: silent });
  assert.equal(dry.ok, true, JSON.stringify(dry.comparison && dry.comparison.missing));
  assert.deepEqual(dry.adopted, []);
  const stillEmpty = await fixture.pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
  assert.equal(stillEmpty.rows[0].n, 0, 'a dry run writes no ledger row');

  const adopted = await migrations.adopt(fixture.pool, { log: silent });
  assert.equal(adopted.ok, true);
  assert.deepEqual(adopted.adopted, ['001_baseline']);
  assert.match(adopted.fingerprint, /^[0-9a-f]{64}$/, 'the verified schema is fingerprinted');

  const row = await fixture.pool.query('SELECT * FROM schema_migrations WHERE id = $1', [
    '001_baseline',
  ]);
  assert.equal(row.rows[0].applied_by, 'adopted', 'recorded as adopted, never as executed');
  assert.equal(row.rows[0].checksum, migrations.checksumFor(migrations.MIGRATIONS[0]));
  assert.equal(row.rows[0].schema_fingerprint, adopted.fingerprint);

  // Adopting twice is refused rather than duplicated.
  const again = await migrations.adopt(fixture.pool, { log: silent });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'ledger_not_empty');

  // The fabricated rows are still there, untouched by adoption — which reads
  // the catalogue and writes one row.
  const users = await fixture.pool.query('SELECT COUNT(*)::int AS n FROM users');
  assert.equal(users.rows[0].n, 6);
  const giveaway = await fixture.pool.query('SELECT title FROM giveaways WHERE id = $1', [
    history.giveawayId,
  ]);
  assert.equal(giveaway.rows[0].title, 'Fabricated Prize Draw');
});

test('sm6. proof 3 — an incomplete schema cannot be adopted, and no ledger row is written', async () => {
  const fixture = await olderDatabase('incomplete');

  const result = await migrations.adopt(fixture.pool, { log: silent });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_mismatch');
  assert.ok(result.comparison.missing.length > 0, 'the differences are enumerated');

  // The specific objects the fixture removed are named.
  const missingKeys = new Set(result.comparison.missing.map((m) => `${m.kind}:${m.object}`));
  LATE_TABLES.forEach((table) => {
    assert.ok(missingKeys.has(`tables:${table}`), `${table} is reported missing`);
  });
  LATE_COLUMNS.forEach(([table, column]) => {
    assert.ok(missingKeys.has(`columns:${table}.${column}`), `${table}.${column} is reported missing`);
  });

  const ledger = await fixture.pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
  assert.equal(ledger.rows[0].n, 0, 'a refused adoption writes NOTHING');

  // And a refusal names objects, never the contents of a CHECK — those can
  // quote a value, and this text reaches a log.
  const rendered = JSON.stringify(result.comparison.missing.concat(result.comparison.altered));
  assert.ok(!/CHECK\s*\(/i.test(rendered), 'no constraint definition is echoed');
});

test('sm7. proof 3b — an unprotected booking table and a weakened trigger are both refused', async () => {
  // Missing the booking-overlap constraint with NO data conflict: nothing
  // stopped it being created, so this database is simply unprotected. Adoption
  // refuses rather than recording the gap as verified — `migrate up` adds it.
  const noConstraint = await preLedgerMatching('noconstraint');
  await noConstraint.pool.query(
    `ALTER TABLE ads DROP CONSTRAINT IF EXISTS ${SLOT_CONSTRAINT_NAME}`
  );
  assert.equal(await isSlotProtectionActive(noConstraint.pool), false);

  const a = await migrations.adopt(noConstraint.pool, { log: silent });
  assert.equal(a.ok, false, 'a database that cannot enforce the booking slot is not adopted');
  assert.equal(a.reason, 'slot_protection_missing');
  assert.equal(a.slots.blockedByData, false, 'and there is no commercial reason for it to be absent');
  assert.ok(
    a.comparison.conditional.some((m) => m.object.endsWith(SLOT_CONSTRAINT_NAME)),
    'the constraint is reported as the data-dependent object it is'
  );
  assert.equal(
    (await noConstraint.pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n,
    0,
    'a refusal writes no ledger row'
  );

  // And the documented fix works.
  const upgraded = await migrations.migrate(noConstraint.pool, { log: silent });
  assert.equal(upgraded.slotProtection, 'created');
  assert.equal(await isSlotProtectionActive(noConstraint.pool), true);

  // A trigger that still exists by name but now fires on fewer events. This is
  // the failure a name-only check cannot see, and it is precisely how an
  // append-only guarantee is lost without anybody noticing: UPDATE is still
  // refused, DELETE quietly is not.
  const alteredTrigger = await preLedgerMatching('alteredtrigger');
  await alteredTrigger.pool.query(
    'DROP TRIGGER IF EXISTS privacy_request_events_immutable ON privacy_request_events'
  );
  await alteredTrigger.pool.query(`
    CREATE TRIGGER privacy_request_events_immutable
      BEFORE UPDATE ON privacy_request_events
      FOR EACH ROW EXECUTE FUNCTION integrity_audit_append_only()
  `);
  const b = await migrations.adopt(alteredTrigger.pool, { log: silent });
  assert.equal(b.ok, false, 'a weakened append-only trigger is not adopted');
  assert.equal(b.reason, 'schema_mismatch');
  assert.ok(
    b.comparison.altered.some((m) => m.object.endsWith('privacy_request_events_immutable')),
    'the trigger is reported as ALTERED, not as present'
  );
  assert.equal(
    (await alteredTrigger.pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n,
    0
  );

  // The baseline restores it, because it drops and recreates the trigger
  // unconditionally rather than checking whether one exists by that name.
  await migrations.migrate(alteredTrigger.pool, { log: silent });
  const repaired = await migrations.verify(alteredTrigger.pool);
  assert.equal(repaired.ok, true, JSON.stringify(repaired.problems));
});

// ---------------------------------------------------------------------------
// 4. Upgrading an older database
// ---------------------------------------------------------------------------

test('sm8. proofs 4, 5, 6 — an older database upgrades, and every fabricated row survives', async () => {
  const fixture = await olderDatabase('upgrade');
  const history = await seedFabricatedHistory(fixture.pool);

  // What the database held before the migration ran.
  const before = await contentFingerprint(fixture.pool);
  assert.equal(before.users.n, 6);
  assert.equal(before.entries.n, 5);
  assert.equal(before.entry_integrity_events.n, 2);

  const summary = await migrations.migrate(fixture.pool, { log: silent });
  assert.deepEqual(summary.applied, migrations.orderedIds());
  assert.equal(
    summary.verified,
    true,
    `upgrade left the schema wrong: ${JSON.stringify(summary.comparison && summary.comparison.missing)}`
  );

  // Proof 4: the objects the older database lacked are now there.
  for (const table of LATE_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const present = await fixture.pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [
      `public.${table}`,
    ]);
    assert.equal(present.rows[0].present, true, `${table} was created by the upgrade`);
  }
  for (const [table, column] of LATE_COLUMNS) {
    // eslint-disable-next-line no-await-in-loop
    const present = await fixture.pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]
    );
    assert.equal(present.rows[0].n, 1, `${table}.${column} was restored by the upgrade`);
  }

  // Proof 5: the pre-existing rows are semantically identical. The users digest
  // is expected to move — the upgrade adds a column to that table, which is the
  // whole point — so it is checked column by column instead.
  const after = await contentFingerprint(fixture.pool);
  ['entries', 'entry_integrity_events'].forEach((table) => {
    assert.equal(after[table].digest, before[table].digest, `${table} is byte-for-byte unchanged`);
    assert.equal(after[table].n, before[table].n);
  });

  // `giveaways` and `users` both gain columns in this upgrade, so their whole-row
  // digests are EXPECTED to move — that is what a migration does. They are
  // checked semantically instead: every value the fixture wrote is still the
  // value it wrote, and the new columns carry defaults rather than guesses.
  assert.equal(after.giveaways.n, before.giveaways.n, 'no campaign was added or lost');
  const campaign = await fixture.pool.query(
    `SELECT title, description, prize_description, estimated_value_aed, funded_by,
            entry_deadline, status, host_id, published_at, closes_at,
            prize_governance_version, submitted_at
       FROM giveaways WHERE id = $1`,
    [history.giveawayId]
  );
  const row = campaign.rows[0];
  assert.equal(row.title, 'Fabricated Prize Draw');
  assert.equal(row.prize_description, 'A prize that does not exist');
  assert.equal(row.funded_by, 'Fabricated Host');
  assert.equal(row.status, 'active', 'the campaign was not moved to another state');
  assert.equal(row.host_id, history.hostId);
  assert.equal(Number(row.estimated_value_aed), 1000);
  assert.equal(row.entry_deadline, '2099-01-01T00:00:00.000Z', 'its deadline was NOT recalculated');
  assert.equal(
    new Date(row.closes_at).toISOString(),
    '2099-01-01T00:00:00.000Z',
    'and was not silently extended or shortened'
  );
  assert.equal(
    row.prize_governance_version,
    0,
    'a campaign published before the prize standard is recorded as such, not as approved'
  );
  assert.ok(row.submitted_at, 'the backfill filled the new column rather than leaving it null');
  assert.equal(after.users.n, before.users.n, 'no user was added or lost');
  const names = await fixture.pool.query(
    'SELECT id, name, email, password_hash, host_status FROM users ORDER BY email'
  );
  assert.deepEqual(
    names.rows.map((r) => r.email),
    [
      'fixture-entrant-1@example.com',
      'fixture-entrant-2@example.com',
      'fixture-entrant-3@example.com',
      'fixture-entrant-4@example.com',
      'fixture-entrant-5@example.com',
      'fixture-host@example.com',
    ]
  );
  assert.equal(names.rows[5].name, 'Fabricated Host');
  assert.equal(names.rows[5].host_status, 'approved', 'host approval survived');

  // The new column arrived with a safe default rather than a guess about
  // somebody's age. `unknown` is the honest value: these accounts predate the
  // attestation and nobody has asked them.
  const attestation = await fixture.pool.query(
    'SELECT DISTINCT age_attestation_status FROM users'
  );
  assert.deepEqual(attestation.rows.map((r) => r.age_attestation_status), ['unknown']);

  // Proof 6: append-only history survived, and is still append-only.
  const events = await fixture.pool.query(
    'SELECT to_status, reason_code FROM entry_integrity_events WHERE giveaway_id = $1 ORDER BY created_at',
    [history.giveawayId]
  );
  assert.equal(events.rowCount, 2);
  assert.deepEqual(events.rows.map((r) => r.to_status), ['under_review', 'eligible']);
  await assert.rejects(
    () =>
      fixture.pool.query(
        "UPDATE entry_integrity_events SET to_status = 'rewritten' WHERE giveaway_id = $1",
        [history.giveawayId]
      ),
    /append-only/i,
    'the restored trigger still refuses to let history be rewritten'
  );
  await assert.rejects(
    () =>
      fixture.pool.query('DELETE FROM entry_integrity_events WHERE giveaway_id = $1', [
        history.giveawayId,
      ]),
    /append-only/i,
    'and refuses to let it be deleted'
  );

  const verified = await migrations.verify(fixture.pool);
  assert.equal(verified.ok, true, JSON.stringify(verified.problems));
});

// ---------------------------------------------------------------------------
// 5. Overlapping commercial records
// ---------------------------------------------------------------------------

test('sm9. proofs 7, 8 — overlapping ads block the constraint, and nothing is resolved for you', async () => {
  const fixture = await createFixture('overlap');

  // Built WITHOUT the exclusion constraint, then given two overlapping paid
  // bookings — a database written before any of this protection existed.
  await fixture.pool.query(BASELINE_SQL);
  const ids = await seedOverlappingAds(fixture.pool);

  const overlaps = await findOverlappingSlots(fixture.pool);
  assert.equal(overlaps.length, 1, 'the pair is detected');

  // The whole migration runs, not just the constraint step: the point is that a
  // commercial conflict does not stop a database being brought forward, and
  // does not get resolved on the way past either.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let summary;
  try {
    summary = await migrations.migrate(fixture.pool, {
      log: { log() {}, error: (m) => errors.push(m) },
    });
  } finally {
    console.error = realError;
  }

  // Proof 7: the constraint cannot be applied...
  assert.equal(summary.slotProtection, 'blocked');
  assert.equal(await isSlotProtectionActive(fixture.pool), false);

  // ...but the rest of the schema is correct and recorded, so the platform is
  // not held hostage to a booking dispute.
  assert.deepEqual(summary.applied, migrations.orderedIds());
  assert.equal(summary.verified, true, JSON.stringify(summary.comparison.missing));
  // The constraint and the GiST index that backs it: reported, not hidden.
  assert.deepEqual(
    summary.comparison.conditional.map((c) => `${c.kind}:${c.object}`).sort(),
    ['exclusion_constraints:ads.ads_no_overlapping_slots', 'indexes:ads.ads_no_overlapping_slots']
  );
  assert.equal((await migrations.verify(fixture.pool)).ok, true);

  // ...and therefore checkout is not ready. That gate is the same function the
  // ads route calls before it will take money.
  const adsRoute = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'ads.js'), 'utf8');
  assert.match(adsRoute, /isSlotProtectionActive/, 'the checkout route asks this same question');

  // Proof 8: both bookings are exactly where they were. Nothing deleted,
  // nothing moved, nothing quietly released.
  const rows = await fixture.pool.query(
    'SELECT id, business_name, slot_status, starts_at, ends_at, slot_released_at FROM ads ORDER BY starts_at'
  );
  assert.equal(rows.rowCount, 2, 'both bookings survive');
  assert.deepEqual(rows.rows.map((r) => r.id), [ids.a, ids.b]);
  rows.rows.forEach((row) => {
    assert.equal(row.slot_status, 'paid', 'neither was released');
    assert.equal(row.slot_released_at, null, 'neither was marked released');
  });

  // The operator is told which pairs, by id and date — and nothing else. Whose
  // booking it is does not belong in a server log.
  const logged = errors.join('\n');
  assert.match(logged, /Cannot add ads_no_overlapping_slots/);
  assert.match(logged, new RegExp(ids.a));
  assert.ok(!/Fabricated Advertiser/.test(logged), 'no advertiser is named in the log');
  assert.match(logged, /left untouched/i);
  assert.match(logged, /left exactly as they were/i);

  // Adoption of such a database is allowed — the schema is right, the conflict
  // is commercial — and it says so rather than pretending the slot is guarded.
  await fixture.pool.query('DELETE FROM schema_migrations');
  const adopted = await migrations.adopt(fixture.pool, { log: silent });
  assert.equal(adopted.ok, true, 'a commercial conflict does not make a correct schema unadoptable');
  assert.equal(adopted.slots.active, false);
  assert.equal(adopted.slots.blockedByData, true);
  assert.equal(adopted.slots.overlaps, 1);

  // Resolving one side by hand — the documented manual step — lets it apply,
  // and even then nothing was deleted.
  await fixture.pool.query(
    `UPDATE ads SET slot_status='released', slot_released_at=NOW(),
            slot_release_reason='Fabricated fixture: resolved by hand for this test.'
      WHERE id = $1`,
    [ids.b]
  );
  const applied = await ensureSlotExclusionConstraint(fixture.pool);
  assert.equal(applied.status, 'created');
  assert.equal(await isSlotProtectionActive(fixture.pool), true);
  assert.equal((await fixture.pool.query('SELECT COUNT(*)::int AS n FROM ads')).rows[0].n, 2);
});

// ---------------------------------------------------------------------------
// 6. Partial migrations and concurrency
// ---------------------------------------------------------------------------

test('sm10. proof 9 — a migration that fails part-way records nothing and leaves nothing behind', async () => {
  const fixture = await createFixture('partial');
  await migrations.migrate(fixture.pool, { log: silent });

  // A fabricated migration that creates a table and then fails. PostgreSQL
  // rolls DDL back, and the ledger row is written inside the same transaction,
  // so both must disappear together.
  const failing = {
    id: '900_fabricated_partial_failure',
    description: 'Fabricated. Creates a table, then fails deliberately.',
    run: async (client) => {
      await client.query('CREATE TABLE fabricated_half_built (id TEXT PRIMARY KEY)');
      await client.query('SELECT 1 / 0');
    },
  };

  migrations.MIGRATIONS.push(failing);
  try {
    await assert.rejects(
      () => migrations.migrate(fixture.pool, { log: silent }),
      /failed and was rolled back\. Nothing was recorded/
    );

    const table = await fixture.pool.query(
      "SELECT to_regclass('public.fabricated_half_built') IS NOT NULL AS present"
    );
    assert.equal(table.rows[0].present, false, 'the half-built table was rolled back');

    const ledger = await fixture.pool.query(
      'SELECT id FROM schema_migrations WHERE id = $1',
      [failing.id]
    );
    assert.equal(ledger.rowCount, 0, 'a partial migration writes NO ledger success');

    // Readiness stays failing while it is outstanding, rather than passing
    // because the earlier migrations are recorded.
    const verified = await migrations.verify(fixture.pool);
    assert.equal(verified.ok, false);
    assert.ok(verified.problems.some((p) => p.includes(failing.id)));
  } finally {
    migrations.MIGRATIONS.splice(migrations.MIGRATIONS.indexOf(failing), 1);
  }

  // With the fabricated migration gone, the database is healthy again — the
  // failure left no residue.
  const restored = await migrations.verify(fixture.pool);
  assert.equal(restored.ok, true, JSON.stringify(restored.problems));
});

test('sm11. proof 10 — concurrent migration attempts apply exactly once', async () => {
  const fixture = await createFixture('concurrent');

  const [a, b, c] = await Promise.all([
    migrations.migrate(fixture.pool, { log: silent }),
    migrations.migrate(fixture.pool, { log: silent }),
    migrations.migrate(fixture.pool, { log: silent }),
  ]);

  const appliedCounts = [a, b, c].map((s) => s.applied.length);
  assert.equal(
    appliedCounts.filter((n) => n > 0).length,
    1,
    `exactly one attempt did the work, got ${JSON.stringify(appliedCounts)}`
  );
  const winner = [a, b, c].find((s) => s.applied.length > 0);
  assert.deepEqual(winner.applied, migrations.orderedIds());

  const ledger = await fixture.pool.query('SELECT id FROM schema_migrations ORDER BY id');
  assert.deepEqual(ledger.rows.map((r) => r.id), migrations.orderedIds());
  assert.equal(ledger.rowCount, migrations.orderedIds().length, 'no migration is recorded twice');

  const verified = await migrations.verify(fixture.pool);
  assert.equal(verified.ok, true, JSON.stringify(verified.problems));
});

// ---------------------------------------------------------------------------
// 7. What the web process may and may not do
// ---------------------------------------------------------------------------

test('sm12. proof 11 — web startup never adopts and never migrates', () => {
  const startup = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');

  [startup, app].forEach((source) => {
    assert.ok(!/migrations\.migrate\s*\(/.test(source), 'startup does not run migrations');
    assert.ok(!/migrations\.adopt\s*\(/.test(source), 'startup does not adopt');
  });

  // It verifies, which is the whole of its permitted involvement.
  assert.match(startup, /migrations\.verify\s*\(/, 'startup verifies');

  // And nothing else in the server tree calls either, either.
  const serverFiles = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) serverFiles.push(full);
    });
  })(path.join(ROOT, 'server'));

  serverFiles
    .filter((file) => path.basename(file) !== 'migrations.js')
    .forEach((file) => {
      const source = fs.readFileSync(file, 'utf8');
      assert.ok(
        !/migrations\.(migrate|adopt)\s*\(/.test(source),
        `${path.relative(ROOT, file)} must not migrate or adopt`
      );
    });

  // The commands exist, and they are commands.
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  ['status', 'verify', 'up', 'adopt'].forEach((command) => {
    assert.ok(cli.includes(`'${command}'`), `the CLI offers ${command}`);
  });
  assert.match(cli, /--dry-run/);
});

test('sm13. proof 12 — readiness fails until migration or adoption is explicitly completed', async () => {
  const fixture = await preLedgerMatching('readiness');

  // A perfectly correct schema with no ledger at all. The database is fine;
  // nothing has RECORDED that it is fine, and readiness must say so rather than
  // assume — which is the whole difference between this and the version that
  // adopted anything with a `users` table.
  const noLedger = await migrations.verify(fixture.pool);
  assert.equal(noLedger.ok, false, 'an unrecorded schema is not ready');
  assert.deepEqual(noLedger.problems, ['schema ledger is missing — run the migration command']);

  // The ledger table exists but is empty — a database somebody pointed the CLI
  // at and then stopped. Still not ready, and now it can name what is missing.
  const client = await fixture.pool.connect();
  try {
    await migrations.ensureLedger(client);
  } finally {
    client.release();
  }
  const beforeAnything = await migrations.verify(fixture.pool);
  assert.equal(beforeAnything.ok, false, 'an empty ledger is not ready either');
  migrations.orderedIds().forEach((id) => {
    assert.ok(
      beforeAnything.problems.some((p) => p.includes(`${id} has not been applied`)),
      `${id} is reported as unapplied`
    );
  });

  // Adoption alone covers the baseline; the later migration still has to run.
  const adopted = await migrations.adopt(fixture.pool, { log: silent });
  assert.equal(adopted.ok, true);
  const afterAdopt = await migrations.verify(fixture.pool);
  assert.equal(afterAdopt.ok, false, 'adoption of the baseline is not the whole ledger');
  assert.ok(afterAdopt.problems.every((p) => !/001_baseline/.test(p)));

  const summary = await migrations.migrate(fixture.pool, { log: silent });
  assert.deepEqual(summary.applied, migrations.orderedIds().slice(1));
  assert.deepEqual(summary.alreadyApplied, ['001_baseline']);

  const ready = await migrations.verify(fixture.pool);
  assert.equal(ready.ok, true, JSON.stringify(ready.problems));

  // Losing the ledger — a restore from a dump taken before it existed, a
  // hand-run DROP — puts readiness straight back to failing.
  await fixture.pool.query('DROP TABLE schema_migrations');
  const lost = await migrations.verify(fixture.pool);
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.problems, ['schema ledger is missing — run the migration command']);
});
