#!/usr/bin/env node
//
// The scheduled-maintenance entry point.
//
//   node scripts/maintenance.js all
//   node scripts/maintenance.js sessions risk_signals
//   node scripts/maintenance.js --list
//   node scripts/maintenance.js all --limit 200
//
// Exists because every cleanup this platform needs was previously running on an
// in-process timer, on a route somebody happened to visit, or on nothing at
// all. A retention policy that depends on traffic is not a retention policy,
// and on a plan where the web service sleeps, an in-process timer stops with it.
//
// Contract, so a scheduler can rely on it:
//
//   exit 0   the run completed. Includes "there was nothing to do".
//   exit 1   at least one job failed. The failure is named; its cause is a
//            category, never a row, an address or a connection string.
//   exit 2   the arguments were wrong. Nothing ran.
//
// Output is one JSON object per run on stdout — counts and durations only —
// so a log aggregator can alert on `ok:false` without anything sensitive ever
// having been printed. Human-readable text goes to stderr.
//
// SIGTERM finishes the batch in flight and stops. It does not kill a
// transaction mid-write.
require('dotenv').config();

const path = require('path');
const ROOT = path.join(__dirname, '..');

const { pool } = require(path.join(ROOT, 'server', 'db'));
const maintenance = require(path.join(ROOT, 'server', 'lib', 'maintenance'));
const emailChangeOutbox = require(path.join(ROOT, 'server', 'lib', 'emailChangeOutbox'));
const errorReporting = require(path.join(ROOT, 'server', 'lib', 'errorReporting'));
const config = require(path.join(ROOT, 'server', 'lib', 'config'));

function usage() {
  process.stderr.write(
    [
      'Usage: node scripts/maintenance.js <job|all> [job...] [--limit N]',
      '',
      'Jobs:',
      ...maintenance.JOB_NAMES.map((n) => `  ${n}`),
      '  all   runs every job, in the documented order',
      '',
      'Exit codes: 0 ran (including nothing to do), 1 a job failed, 2 bad arguments.',
      '',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const names = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') return { list: true };
    if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) return { error: '--limit needs a positive number' };
      options.limit = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
    if (arg === 'all') {
      names.push(...maintenance.ALL_ORDER);
      continue;
    }
    if (!maintenance.JOB_NAMES.includes(arg)) return { error: `unknown job ${arg}` };
    names.push(arg);
  }
  if (!names.length) return { error: 'no job named' };
  // De-duplicated, order preserved: `all sessions` should not run sessions twice.
  return { names: [...new Set(names)], options };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.list) {
    process.stdout.write(`${JSON.stringify({ jobs: maintenance.JOB_NAMES }, null, 2)}\n`);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`maintenance: ${parsed.error}\n\n`);
    usage();
    return 2;
  }

  // The same validator the web process uses. A maintenance job that cannot
  // reach the database is a job that should say so rather than throwing a
  // connection error with a URL in it — but it deliberately does NOT require
  // the web-only configuration, because a cron container has no reason to hold
  // a Stripe key.
  const configuration = config.validate();
  const fatal = configuration.problems.filter((p) => p.variable === 'DATABASE_URL');
  if (fatal.length) {
    process.stderr.write(`maintenance: ${fatal.map((p) => `${p.variable} ${p.message}`).join('; ')}\n`);
    return 1;
  }

  const startedAt = new Date().toISOString();
  maintenance.resetStop();

  const onSignal = (signal) => {
    process.stderr.write(`maintenance: ${signal} received; finishing the current batch and stopping.\n`);
    maintenance.requestStop();
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));

  const results = [];
  let failed = false;

  for (const name of parsed.names) {
    if (maintenance.stopRequested()) {
      results.push({ job: name, status: 'skipped', reason: 'shutdown requested' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential
      const result = await maintenance.JOBS[name](parsed.options);
      results.push(result);
    } catch (err) {
      failed = true;
      // A category and the job name. Never the message from the database, which
      // routinely quotes a value back — and never the connection string.
      const category = /timeout|ETIMEDOUT/i.test(String(err && err.message))
        ? 'timeout'
        : /ECONNREFUSED|ENOTFOUND|connection/i.test(String(err && err.message))
          ? 'connection'
          : 'error';
      results.push({ job: name, status: 'error', category });
      errorReporting.reportError(err, { job: name, source: 'maintenance' });
    }
  }

  // Any drain the outbox started in the background belongs to this process.
  await emailChangeOutbox.settle();

  const summary = maintenance.summarise(results, { startedAt });
  summary.ok = summary.ok && !failed;
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  return failed ? 1 : 0;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    // The last-resort path. Still a category, still no value.
    process.stderr.write('maintenance: unexpected failure\n');
    errorReporting.reportError(err, { source: 'maintenance', phase: 'toplevel' });
    await pool.end().catch(() => {});
    process.exit(1);
  });
