#!/usr/bin/env node
//
// Run the full suite N times and make any failure identify itself.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// One run out of eleven, during the Phase 2.4A amendment, reported 543 pass /
// 1 fail. The name of the failing test was not captured, and eight subsequent
// runs were green — so the defect was real, unexplained, and invisible.
//
// A green suite is not evidence that a flake is gone; it is evidence that it did
// not fire this time. What closes the gap is a runner that records enough, every
// time, that the NEXT failure explains itself without anybody having to be
// watching: the exact test, the file and line, the duration, the process exit
// code, whether the run hung, and whether it left handles open.
//
// Usage:
//   node scripts/test-repeat.js [runs] [--keep] [--bail]
//
//     runs     how many complete suite runs (default 10)
//     --keep   keep every run's TAP log, not only the failing ones
//     --bail   stop at the first failing run
//
// Exit code 0 only if every run passed with a zero exit code.
//
// Nothing here touches a production service. It shells out to the same
// `npm test` the release gate uses, which resets the isolated test database
// first and refuses anything that is not one.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a))) || 10;
const keepAll = args.includes('--keep');
const bail = args.includes('--bail');

// Logs go outside the repository. A failing TAP log can contain fabricated test
// email addresses, and it is not something to leave in a working tree where it
// could be committed by accident.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naseeb-test-repeat-'));

// A run that has not finished in this long is a hang, not a slow run. The suite
// takes ~40s; ten minutes is far beyond any legitimate variance, and reporting
// "timed out" is more useful than waiting forever.
const RUN_TIMEOUT_MS = Number(process.env.TEST_REPEAT_TIMEOUT_MS) || 600000;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// The TAP a failing subtest emits carries the location, the duration and the
// assertion. All of it is pulled out, because "which test" without "where" and
// "how long" is the situation this script exists to end.
function parseFailures(tap) {
  const failures = [];
  const lines = tap.split('\n');

  lines.forEach((line, i) => {
    const m = line.match(/^\s*not ok (\d+) - (.*)$/);
    if (!m) return;

    const detail = { number: Number(m[1]), name: m[2].trim() };
    // The YAML block that follows, up to the closing `...`.
    for (let j = i + 1; j < lines.length && j < i + 60; j += 1) {
      const l = lines[j];
      if (/^\s*\.\.\.\s*$/.test(l)) break;
      const loc = l.match(/^\s*location:\s*'(.+)'\s*$/);
      if (loc) detail.location = loc[1];
      const dur = l.match(/^\s*duration_ms:\s*([\d.]+)\s*$/);
      if (dur) detail.duration_ms = Number(dur[1]);
      const type = l.match(/^\s*failureType:\s*'(.+)'\s*$/);
      if (type) detail.failureType = type[1];
      const code = l.match(/^\s*code:\s*'(.+)'\s*$/);
      if (code) detail.code = code[1];
      const err = l.match(/^\s*error:\s*(.*)$/);
      if (err && !detail.error) detail.error = err[1].replace(/^['"]|['"]$/g, '').trim();
    }
    failures.push(detail);
  });

  // A file-level failure (a hook that threw, a file that could not load) shows up
  // as `not ok N - /abs/path/file.test.js`. Those are the ones that used to be
  // reported as an anonymous "1 fail".
  return failures;
}

function parseTotals(tap) {
  const grab = (key) => {
    const m = tap.match(new RegExp(`^# ${key} (\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const dur = tap.match(/^# duration_ms ([\d.]+)/m);
  return {
    tests: grab('tests'),
    pass: grab('pass'),
    fail: grab('fail'),
    cancelled: grab('cancelled'),
    duration_ms: dur ? Number(dur[1]) : null,
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const results = [];
let failed = 0;

for (let run = 1; run <= runs; run += 1) {
  const started = Date.now();
  const proc = spawnSync('npm', ['test'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''}`.trim() },
  });

  const wall = Date.now() - started;
  const tap = `${proc.stdout || ''}\n${proc.stderr || ''}`;
  const totals = parseTotals(tap);
  const failures = parseFailures(tap);
  const timedOut = proc.signal === 'SIGTERM' && wall >= RUN_TIMEOUT_MS - 1000;

  const ok = proc.status === 0 && totals.fail === 0 && !timedOut;
  if (!ok) failed += 1;

  // The log is kept whenever the run was not clean, so the evidence outlives the
  // terminal scrollback.
  let logPath = null;
  if (!ok || keepAll) {
    logPath = path.join(logDir, `run-${String(run).padStart(3, '0')}.tap`);
    fs.writeFileSync(logPath, tap);
  }

  const record = {
    run,
    ok,
    exit_code: proc.status,
    signal: proc.signal || null,
    timed_out: timedOut,
    wall_ms: wall,
    ...totals,
    failures,
    log: logPath,
  };
  results.push(record);

  const summary = ok
    ? `run ${run}/${runs}  PASS  ${totals.pass}/${totals.tests}  ${Math.round(wall / 1000)}s  exit ${proc.status}`
    : `run ${run}/${runs}  FAIL  pass=${totals.pass} fail=${totals.fail} exit=${proc.status}` +
      `${proc.signal ? ` signal=${proc.signal}` : ''}${timedOut ? ' TIMED OUT' : ''}  ${Math.round(wall / 1000)}s`;
  process.stdout.write(`${summary}\n`);

  failures.forEach((f) => {
    process.stdout.write(
      `      ✗ ${f.name}\n` +
        `        at ${f.location || 'unknown'}` +
        `${f.duration_ms !== undefined ? `  (${f.duration_ms}ms)` : ''}` +
        `${f.failureType ? `  ${f.failureType}` : ''}\n` +
        `${f.error ? `        ${f.error.slice(0, 200)}\n` : ''}`
    );
  });
  if (logPath) process.stdout.write(`      log: ${logPath}\n`);

  if (!ok && bail) break;
}

const clean = results.filter((r) => r.ok).length;
process.stdout.write(
  `\n${clean}/${results.length} runs green` +
    `${failed ? `, ${failed} FAILED` : ''}` +
    `${results.some((r) => r.log) ? `\nlogs: ${logDir}` : ''}\n`
);

// A machine-readable record, for pasting into a report without transcribing.
process.stdout.write(
  `${JSON.stringify(
    {
      runs: results.length,
      green: clean,
      failed,
      per_run: results.map((r) => ({
        run: r.run,
        ok: r.ok,
        exit_code: r.exit_code,
        pass: r.pass,
        fail: r.fail,
        duration_ms: r.duration_ms,
        wall_ms: r.wall_ms,
        failures: r.failures.map((f) => ({ name: f.name, location: f.location })),
      })),
    },
    null,
    2
  )}\n`
);

process.exit(failed === 0 ? 0 : 1);
