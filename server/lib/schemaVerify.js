// Proving a database actually matches the schema this code expects.
//
// ---------------------------------------------------------------------------
// Why "the tables exist" is not a check
// ---------------------------------------------------------------------------
//
// The first version of the migration ledger adopted any database that had a
// `users` table: it wrote a baseline row saying "this schema is already here"
// on the strength of one `to_regclass`. That is not verification, it is a
// guess with a paper trail — and the paper trail is the dangerous part, because
// afterwards nothing ever checks again. A database missing a column, a CHECK
// constraint or an append-only trigger would be recorded as fully migrated and
// would then fail at runtime, in production, on the one operation the missing
// object was protecting.
//
// So adoption now requires this: a read-only, object-by-object comparison
// against a committed snapshot of the expected schema. If anything is missing,
// altered or unverifiable, adoption refuses and writes nothing.
//
// Everything in this file is read-only. It creates nothing, alters nothing and
// needs no privilege beyond SELECT on the catalogue.
const crypto = require('crypto');

// The ledger's own table. `ensureLedger` creates and maintains it, not the
// baseline, so it exists on a migrated database and not on one the baseline has
// merely built — which would make the snapshot disagree with itself depending on
// which of the two produced it. Excluded from both capture and comparison; the
// ledger is what does the comparing, and it verifies its own table by using it.
const IGNORED_TABLES = new Set(['schema_migrations']);

// ---------------------------------------------------------------------------
// Data-dependent objects
// ---------------------------------------------------------------------------
//
// One expected object cannot be created unconditionally, and pretending
// otherwise would break the thing it protects.
//
// `ads_no_overlapping_slots` is an exclusion constraint over booked banner
// dates. On a database that already contains overlapping bookings written
// before it existed, PostgreSQL will not add it — and the right response is
// emphatically NOT to delete or move one of them: those are commercial records
// somebody may have paid for, and choosing a survivor automatically would
// destroy the wrong one about half the time.
//
// So its absence is reported SEPARATELY from a schema mismatch. A schema that
// is otherwise correct is still a correct schema; what it cannot do is take
// money for a slot it might double-sell, which is why `server/routes/ads.js`
// asks `isSlotProtectionActive()` before checkout and refuses without it.
//
// Absence with no overlapping data is a different matter — that is a genuinely
// unprotected database, and the migration command adds the constraint. See
// `migrations.adopt`, which refuses in that case.
const CONDITIONAL_OBJECTS = new Set([
  'exclusion_constraints:ads.ads_no_overlapping_slots',
  // Its backing index, created and dropped with it.
  'indexes:ads.ads_no_overlapping_slots',
]);

// Objects whose absence is a refusal rather than a note. Everything the schema
// carries is compared; this list is what makes a difference fatal.
const OBJECT_KINDS = [
  'tables',
  'columns',
  'primary_keys',
  'unique_constraints',
  'check_constraints',
  'foreign_keys',
  'exclusion_constraints',
  'indexes',
  'triggers',
  'functions',
  'extensions',
];

// ---------------------------------------------------------------------------
// Reading a schema
// ---------------------------------------------------------------------------

// Every query below is parameterised on the schema name and reads only
// catalogue tables. Ordering is explicit everywhere so two captures of the same
// schema produce byte-identical output — the fingerprint depends on it.
const QUERIES = {
  tables: `
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,

  // Type, nullability and default, because a column that exists with the wrong
  // type is a column that fails at the worst moment.
  columns: `
    SELECT table_name, column_name, data_type, is_nullable,
           COALESCE(column_default, '') AS column_default,
           COALESCE(character_maximum_length::text, '') AS max_length,
           COALESCE(numeric_precision::text, '') AS numeric_precision
      FROM information_schema.columns
     WHERE table_schema = $1
     ORDER BY table_name, column_name`,

  primary_keys: `
    SELECT c.relname AS table_name, con.conname,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND con.contype = 'p'
     ORDER BY c.relname, con.conname`,

  unique_constraints: `
    SELECT c.relname AS table_name, con.conname,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND con.contype = 'u'
     ORDER BY c.relname, con.conname`,

  check_constraints: `
    SELECT c.relname AS table_name, con.conname,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND con.contype = 'c'
     ORDER BY c.relname, con.conname`,

  // The definition string carries ON DELETE / ON UPDATE, which is the part that
  // matters: a foreign key that cascades where it should restrict silently
  // deletes audit history.
  foreign_keys: `
    SELECT c.relname AS table_name, con.conname,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND con.contype = 'f'
     ORDER BY c.relname, con.conname`,

  exclusion_constraints: `
    SELECT c.relname AS table_name, con.conname,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND con.contype = 'x'
     ORDER BY c.relname, con.conname`,

  indexes: `
    SELECT tablename AS table_name, indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = $1
     ORDER BY tablename, indexname`,

  // Append-only protection lives here. A trigger that is present but pointing at
  // a different function is not the same trigger.
  triggers: `
    SELECT c.relname AS table_name, t.tgname,
           pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND NOT t.tgisinternal
     ORDER BY c.relname, t.tgname`,

  functions: `
    SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1
     ORDER BY p.proname`,

  // Global rather than per-schema. The parameter is accepted and ignored so
  // every query in this map has the same signature.
  extensions: `
    SELECT extname FROM pg_extension WHERE $1::text IS NOT NULL ORDER BY extname`,
};

// Reads one schema in full. Read-only.
async function read(client, schema = 'public') {
  const snapshot = {};
  for (const kind of OBJECT_KINDS) {
    // eslint-disable-next-line no-await-in-loop -- a fixed list, ordered
    const result = await client.query(QUERIES[kind], [schema]);
    snapshot[kind] = result.rows
      .filter((row) => !IGNORED_TABLES.has(row.table_name))
      .map((row) => normalise(kind, row, schema));
  }
  return snapshot;
}

// Strips the schema qualifier out of definitions, so a snapshot taken from one
// database compares equal to another. Without it every definition would differ
// by the qualifier alone and the comparison would be useless.
function normalise(kind, row, schema) {
  const out = {};
  Object.entries(row).forEach(([key, value]) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (schema && schema !== 'public') {
      text = text.split(`${schema}.`).join('');
      text = text.split(`"${schema}".`).join('');
    } else {
      text = text.split('public.').join('');
      text = text.split('"public".').join('');
    }
    // pg_get_functiondef embeds the owning schema in a SET search_path or in
    // the CREATE line; the split above handles both.
    out[key] = text.trim();
  });
  return out;
}

// A stable identity for one object, used to match reference against target.
function keyFor(kind, row) {
  switch (kind) {
    case 'tables':
      return row.table_name;
    case 'columns':
      return `${row.table_name}.${row.column_name}`;
    case 'indexes':
      return `${row.table_name}.${row.indexname}`;
    case 'triggers':
      return `${row.table_name}.${row.tgname}`;
    case 'functions':
      return row.proname;
    case 'extensions':
      return row.extname;
    default:
      return `${row.table_name}.${row.conname}`;
  }
}

// The comparable content of one object — everything except its identity.
function definitionFor(kind, row) {
  switch (kind) {
    case 'tables':
    case 'extensions':
      return '';
    case 'columns':
      return `${row.data_type}|${row.is_nullable}|${row.column_default}|${row.max_length}|${row.numeric_precision}`;
    case 'indexes':
      return row.indexdef;
    default:
      return row.definition;
  }
}

// ---------------------------------------------------------------------------
// The expected schema
// ---------------------------------------------------------------------------
//
// A committed snapshot (`server/migrations/expected-schema.json`), generated by
// `npm run schema:snapshot` from a database freshly built by the baseline.
//
// The first attempt built the reference on the fly by running the baseline into
// a scratch schema in the same database. That does not work, and the reason is
// worth recording: the baseline's idempotence checks are name-only —
// `IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...')`. `conname` is
// not unique across schemas, so a check run inside a scratch schema sees the
// REAL schema's constraint, concludes the object exists, and then issues an
// ALTER against a table that does not have it yet. The migration fails on a
// database that is perfectly healthy.
//
// A committed snapshot avoids all of it: verification becomes a pure read of
// the catalogue compared against a file, needs no CREATE privilege, cannot
// perturb the database it is checking, and is identical every time. Its cost is
// that it must be regenerated when the schema changes — which a test enforces
// by comparing it against a live, freshly-built database.
const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'migrations', 'expected-schema.json');

function loadSnapshot(file = SNAPSHOT_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSnapshot(snapshot, file = SNAPSHOT_PATH) {
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

// Returns { ok, missing, altered, extra, summary }.
//
// `extra` is reported but is NOT a failure: a database may legitimately carry
// an index somebody added for a slow query, or a table from an older feature.
// Missing or altered objects are failures — those are the ones that make the
// running code wrong about its own storage.
function compare(reference, target) {
  const missing = [];
  const altered = [];
  const extra = [];
  // Expected, data-dependent, and absent. Not a schema failure — see
  // CONDITIONAL_OBJECTS — but never silently dropped either.
  const conditional = [];

  OBJECT_KINDS.forEach((kind) => {
    const referenceRows = new Map(
      (reference[kind] || []).map((row) => [keyFor(kind, row), definitionFor(kind, row)])
    );
    const targetRows = new Map(
      (target[kind] || []).map((row) => [keyFor(kind, row), definitionFor(kind, row)])
    );

    referenceRows.forEach((definition, key) => {
      if (!targetRows.has(key)) {
        if (CONDITIONAL_OBJECTS.has(`${kind}:${key}`)) conditional.push({ kind, object: key });
        else missing.push({ kind, object: key });
        return;
      }
      if (targetRows.get(key) !== definition) {
        // The definitions themselves are deliberately NOT included: a CHECK
        // definition can quote a value, and this string reaches a log.
        altered.push({ kind, object: key });
      }
    });

    targetRows.forEach((_definition, key) => {
      if (!referenceRows.has(key)) extra.push({ kind, object: key });
    });
  });

  return {
    ok: missing.length === 0 && altered.length === 0,
    missing,
    altered,
    extra,
    conditional,
    summary: {
      missing: missing.length,
      altered: altered.length,
      extra: extra.length,
      conditional: conditional.length,
    },
  };
}

// The whole operation: read the target and compare against the committed
// expectation. Read-only, and the only thing it needs is SELECT on the
// catalogue.
async function verifyAgainstSnapshot(client, { snapshot = loadSnapshot() } = {}) {
  const target = await read(client, 'public');
  return compare(snapshot, target);
}

// A short fingerprint of a schema, for recording alongside an adoption. Not a
// security property — a change-detection one.
function fingerprint(snapshot) {
  const canonical = OBJECT_KINDS.map((kind) =>
    (snapshot[kind] || [])
      .map((row) => `${kind}:${keyFor(kind, row)}:${definitionFor(kind, row)}`)
      .sort()
      .join('\n')
  ).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  OBJECT_KINDS,
  IGNORED_TABLES,
  CONDITIONAL_OBJECTS,
  SNAPSHOT_PATH,
  loadSnapshot,
  writeSnapshot,
  read,
  compare,
  verifyAgainstSnapshot,
  fingerprint,
  keyFor,
  definitionFor,
};
