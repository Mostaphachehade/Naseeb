// Liveness and readiness.
//
// These answer two different questions and must not be conflated, which is the
// usual mistake:
//
//   /healthz   "is this process alive?"  — must NOT touch the database.
//   /readyz    "can this process safely serve traffic?" — must.
//
// The distinction is not pedantry. If liveness checks the database, a database
// outage makes every instance look dead, the platform restarts them all, and a
// recoverable incident becomes a restart loop that cannot recover because the
// thing it is waiting for is not the thing being restarted.
//
// ---------------------------------------------------------------------------
// What a public response may contain
// ---------------------------------------------------------------------------
//
// A health endpoint is unauthenticated by necessity — a load balancer cannot
// sign in. So it is also an information-disclosure surface, and it gets the
// same treatment as any other unauthenticated response:
//
//   no database host, no database name, no table or column names, no
//   constraint names, no connection string, no environment variable names or
//   values, no stack trace, no error message from a driver, no version of
//   anything a scanner could match against a CVE.
//
// What a failing readiness response says is a **category** — `database`,
// `schema`, `configuration` — which is enough for an operator to know where to
// look and useless to anybody enumerating the platform. The detail goes to the
// process log and to sanitised error reporting, where it is already protected.
const express = require('express');
const { pool } = require('../db');
const migrations = require('../lib/migrations');
const config = require('../lib/config');
const errorReporting = require('../lib/errorReporting');
const { BASELINE_SQL } = require('../db');

const router = express.Router();

// Short. A readiness probe that waits ten seconds for a hung database is a
// probe that keeps a broken instance in rotation for ten seconds.
const READINESS_TIMEOUT_MS = 2500;

// Flipped false by the shutdown coordinator before anything is torn down, so a
// load balancer stops sending traffic before the server stops accepting it.
let ready = true;
function setReady(value) {
  ready = Boolean(value);
}
function isReady() {
  return ready;
}

function noStore(res) {
  // A cached health response is a lie with a timestamp on it.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('X-Content-Type-Options', 'nosniff');
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

// Deliberately trivial. It answers "is the event loop running and is this
// process still the process we started" and nothing else. No database, no
// configuration read, no filesystem, no allocation worth measuring.
router.get('/healthz', (req, res) => {
  noStore(res);
  res.status(200).json({ status: 'alive' });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

// Read-only by construction. A health probe that writes is a health probe that
// fills a table, and one that creates a session is a health probe that leaves a
// trail of anonymous logins.
async function readinessChecks() {
  const failures = [];
  const detail = [];

  // 1. Configuration. Cheap, no I/O, and the most common reason a deploy is
  //    wrong. Only the category reaches the response; the variable names go to
  //    the log.
  const configuration = config.validate();
  if (!configuration.ok) {
    failures.push('configuration');
    detail.push(...configuration.problems.map((p) => `${p.variable} ${p.message}`));
  }

  // 2. Database connectivity, on a short leash.
  let dbUp = false;
  try {
    await withTimeout(pool.query('SELECT 1'), READINESS_TIMEOUT_MS, 'database');
    dbUp = true;
  } catch (err) {
    failures.push('database');
    // Not err.message: a pg connection error can contain the host, the user and
    // occasionally the password.
    detail.push('database is unreachable or did not answer in time');
  }

  // 3. Schema and critical protections. Only worth asking if the database
  //    answered — otherwise it is the same failure reported twice.
  if (dbUp) {
    try {
      const schema = await withTimeout(
        migrations.verify(pool, { baselineSql: BASELINE_SQL }),
        READINESS_TIMEOUT_MS,
        'schema'
      );
      if (!schema.ok) {
        failures.push('schema');
        detail.push(...schema.problems);
      }
    } catch (err) {
      failures.push('schema');
      detail.push('schema verification did not complete');
    }
  }

  return { failures, detail };
}

router.get('/readyz', async (req, res) => {
  noStore(res);

  // Set false by the shutdown coordinator. Reported before any work is done, so
  // a draining instance answers instantly rather than running three checks it
  // is about to stop caring about.
  if (!isReady()) {
    return res.status(503).json({ status: 'draining' });
  }

  let result;
  try {
    result = await readinessChecks();
  } catch (err) {
    errorReporting.reportError(err, { source: 'readiness' });
    return res.status(503).json({ status: 'not_ready', failing: ['internal'] });
  }

  if (result.failures.length) {
    // The detail goes here — a process log and the sanitised reporter — and
    // nowhere near the response body.
    console.error(
      `Readiness failing (${result.failures.join(', ')}):\n  - ${result.detail.join('\n  - ')}`
    );
    return res.status(503).json({
      status: 'not_ready',
      // Categories only. An operator knows where to look; a scanner learns
      // nothing about the schema, the host or the configuration.
      failing: [...new Set(result.failures)],
    });
  }

  return res.status(200).json({
    status: 'ready',
    // The schema version is deliberately included: it is the one piece of
    // information a deploy actually needs from this endpoint, it is a number
    // this repository publishes anyway, and it lets a rollout confirm that the
    // instance answering is the one it just shipped.
    schema_version: migrations.SCHEMA_VERSION,
    // Truthful about what this deployment is. A staging environment that
    // reports itself as a public launch is the failure this exists to prevent.
    deployment: config.deploymentState(),
  });
});

module.exports = { router, setReady, isReady, readinessChecks, READINESS_TIMEOUT_MS };
