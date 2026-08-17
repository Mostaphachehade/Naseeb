const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// node-postgres parses DATE columns (OID 1082) into a JS Date at local
// midnight, then anything that later serializes it (JSON.stringify, our own
// .toISOString() calls) renders in UTC — on a server whose local timezone
// isn't UTC, that silently shifts the date by a day. Returning the raw
// 'YYYY-MM-DD' string instead sidesteps the whole class of bug; every DATE
// value in this app (ads.starts_at/ends_at) is meant to be a calendar day,
// never a specific instant, so there's no timezone to lose here.
types.setTypeParser(1082, (val) => val);

// Postgres connection. Works with any hosted Postgres (Neon, Supabase, Render
// Postgres, etc). Most hosted providers require SSL but use certificates that
// Node doesn't automatically trust, hence rejectUnauthorized: false below.
//
// DATABASE_SSL decides, and the host is only sniffed as a fallback for
// existing deployments that don't set it. The previous version tested the
// connection string for the literal substring 'localhost', which meant an
// otherwise identical local database addressed as 127.0.0.1 was handed an SSL
// config it couldn't honour and failed with "The server does not support SSL
// connections" — a confusing failure for anyone pointing the test suite at a
// local cluster.
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

function isLocalDatabase(connectionString) {
  if (!connectionString) return false;
  try {
    return LOCAL_DB_HOSTS.has(new URL(connectionString).hostname);
  } catch {
    return connectionString.includes('localhost');
  }
}

function sslConfig() {
  const explicit = (process.env.DATABASE_SSL || '').toLowerCase();
  if (explicit === 'false' || explicit === 'disable' || explicit === '0') return false;
  if (explicit === 'true' || explicit === 'require' || explicit === '1') {
    return { rejectUnauthorized: false };
  }
  return isLocalDatabase(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});

// The baseline schema lives in server/migrations/001_baseline.sql, FROZEN.
//
// It used to be a template literal here that every feature phase appended to.
// That is fine for a bootstrap and useless as a historical migration: a checksum
// over a file somebody keeps editing records only that it changed again. The
// content is now a file nobody edits, and its SHA-256 is what the ledger holds.
//
// Read once at require time and cached. It is part of the deployed artefact, so
// re-reading it per call would buy nothing.
const BASELINE_PATH = path.join(__dirname, 'migrations', '001_baseline.sql');
const BASELINE_SQL = fs.readFileSync(BASELINE_PATH, 'utf8');

// Runs the baseline. Takes an optional client so the migration runner can
// execute it inside its own connection; defaults to the pool for db:init and
// for the test reset path.
async function init(client = pool) {
  await client.query(BASELINE_SQL);

  // Separate from the batch above because it has to inspect existing data and
  // decide whether the constraint can be applied at all — see the function.
  //
  // `client`, not `pool`: the fabricated pre-ledger fixtures build whole
  // throwaway databases through this function, and sending the constraint to the
  // module-level pool would apply it to the wrong database entirely.
  await ensureSlotExclusionConstraint(client);
}

const SLOT_CONSTRAINT_NAME = 'ads_no_overlapping_slots';

// Pairs of bookings that both occupy the slot on overlapping dates.
//
// Under the current code this should always come back empty — allocation holds
// an advisory lock and the exclusion constraint refuses overlaps outright. It
// exists for the one moment that isn't covered by either: the migration that
// adds the constraint, running against data written before any of this existed.
//
// Returns identifiers and dates only. Which company booked what is not
// something to write into a server log.
async function findOverlappingSlots(client = pool) {
  const result = await client.query(
    `SELECT a.id AS booking_a, b.id AS booking_b,
            a.starts_at AS a_starts, a.ends_at AS a_ends,
            b.starts_at AS b_starts, b.ends_at AS b_ends
       FROM ads a
       JOIN ads b ON a.id < b.id
      WHERE a.slot_status IN ('held', 'paid')
        AND b.slot_status IN ('held', 'paid')
        AND a.starts_at IS NOT NULL AND a.ends_at IS NOT NULL
        AND b.starts_at IS NOT NULL AND b.ends_at IS NOT NULL
        AND daterange(a.starts_at, a.ends_at, '[]') && daterange(b.starts_at, b.ends_at, '[]')
      ORDER BY a.starts_at`
  );
  return result.rows;
}

// Adds the exclusion constraint that makes double-selling the banner slot
// impossible at the storage layer.
//
// Idempotent: checks pg_constraint first, so a redeploy against a database that
// already has it does nothing. Uses only core PostgreSQL — a GiST exclusion
// constraint over a daterange needs no extension and no superuser, so it
// applies cleanly on Neon, Supabase, Render Postgres or a plain server.
//
// If historical overlapping bookings already exist, the ALTER would fail. That
// data is not this function's to fix: those are real bookings that real
// advertisers may have paid for, and picking a winner automatically would
// destroy a commercial record and quite possibly the wrong one. It reports them
// and leaves both the rows and the decision alone. The application still starts;
// it is simply unprotected until someone resolves the conflict, which is a
// better outcome than refusing to boot the whole site.
//
// DEFERRABLE INITIALLY IMMEDIATE: behaves immediately in normal use, but lets a
// transaction opt into deferring it — which is how the migration's own tests
// stage overlapping rows without dropping the constraint for everyone else.
async function ensureSlotExclusionConstraint(client = pool) {
  const existing = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = 'ads'::regclass`,
    [SLOT_CONSTRAINT_NAME]
  );
  if (existing.rowCount > 0) {
    return { status: 'present' };
  }

  const overlaps = await findOverlappingSlots(client);
  if (overlaps.length > 0) {
    console.error(
      `Cannot add ${SLOT_CONSTRAINT_NAME}: ${overlaps.length} existing booking pair(s) already ` +
        'overlap. These are real commercial records and have been left untouched — no booking ' +
        'has been deleted, moved or overwritten. Resolve them by hand: for one side of each ' +
        'pair, set slot_status to released along with slot_released_at and a slot_release_reason ' +
        '(the reason is what stops this migration re-claiming the slot on the next deploy), then ' +
        'restart to apply the constraint. Self-serve ad checkout cannot be enabled until it ' +
        'applies. Overlapping pairs (booking ids and dates):'
    );
    overlaps.forEach((row) => {
      console.error(
        `  ${row.booking_a} [${row.a_starts} .. ${row.a_ends}] overlaps ` +
          `${row.booking_b} [${row.b_starts} .. ${row.b_ends}]`
      );
    });
    return { status: 'blocked', overlaps };
  }

  await client.query(
    `ALTER TABLE ads ADD CONSTRAINT ${SLOT_CONSTRAINT_NAME}
       EXCLUDE USING gist (daterange(starts_at, ends_at, '[]') WITH &&)
       WHERE (slot_status IN ('held', 'paid') AND starts_at IS NOT NULL AND ends_at IS NOT NULL)
       DEFERRABLE INITIALLY IMMEDIATE`
  );
  return { status: 'created' };
}

// Is the database actually enforcing non-overlapping bookings right now?
//
// Asked of the database every time it matters rather than remembered from
// startup, because "the constraint was there an hour ago" is not the same claim
// as "the constraint is there". A dropped constraint, a restored-from-backup
// database, a migration that reported 'blocked', or a connection that cannot be
// queried at all must all read as unprotected.
//
// Any failure answers false. This gate exists to stop money being taken for
// dates that might be double-sold, so the only safe response to "I could not
// check" is to behave as though the answer were no.
async function isSlotProtectionActive(client = pool) {
  try {
    const result = await client.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'ads'::regclass AND contype = 'x'`,
      [SLOT_CONSTRAINT_NAME]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error('Could not verify booking overlap protection:', err.message);
    return false;
  }
}

module.exports = {
  pool,
  init,
  BASELINE_SQL,
  BASELINE_PATH,
  findOverlappingSlots,
  ensureSlotExclusionConstraint,
  isSlotProtectionActive,
  SLOT_CONSTRAINT_NAME,
};
