// The deadline a member sees must be the deadline the worker enforces.
//
// ---------------------------------------------------------------------------
// What went wrong, and what "one deadline" now means
// ---------------------------------------------------------------------------
//
// A campaign carries its closing time twice:
//
//   closes_at      timestamptz. THE AUTHORITY. The maintenance worker selects
//                  on it (`closes_at <= NOW()`), and entry acceptance compares
//                  against it.
//   entry_deadline text. The mirror the pages, the API, the admin table, the
//                  data export and the outbox all render.
//
// The giveaway rehearsal moved entry_deadline into the past and the campaign
// stayed open forever, advertising a deadline that had passed. Nothing in the
// application does that — approval writes both in one statement — but nothing
// stopped it either, and a campaign that shows one deadline and enforces
// another is a fairness problem, not a display bug.
//
// So the two are now derived from a single scalar in the one statement that
// writes them, and this file asserts the property rather than the mechanism:
// whatever a member is shown is what the worker will act on.
//
// Pure where it can be. The database-backed assertions live in
// test/giveaway-lifecycle.test.js, which already builds real campaigns.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIFECYCLE = fs.readFileSync(path.join(ROOT, 'server/lib/giveawayLifecycle.js'), 'utf8');
const MAINTENANCE = fs.readFileSync(path.join(ROOT, 'server/lib/maintenance.js'), 'utf8');
const GIVEAWAY_ROUTE = fs.readFileSync(path.join(ROOT, 'server/routes/giveaways.js'), 'utf8');

test('dl1: the entry window is one calendar month, not a day count', () => {
  // "One calendar month" is the approved rule. Thirty days is a different rule
  // that happens to coincide four times a year, and the copy had been written
  // to match the code rather than the rule.
  assert.match(LIFECYCLE, /const ENTRY_WINDOW = "INTERVAL '1 month'"/,
    'the entry window is no longer one calendar month');
  assert.ok(!/INTERVAL '\d+ days'/.test(LIFECYCLE.slice(LIFECYCLE.indexOf('function closesAtSql'), LIFECYCLE.indexOf('function closesAtSql') + 300)),
    'closesAtSql still uses a day interval');
});

test('dl2: both deadline columns are written from one scalar', () => {
  // The failure this prevents: two evaluations of the same expression, correct
  // only because NOW() happens to be transaction-stable. One scalar, joined in,
  // cannot disagree with itself.
  const approve = LIFECYCLE.slice(LIFECYCLE.indexOf('async function approveAndPublish'));
  const stmt = approve.slice(0, approve.indexOf('WHERE id = $1') + 20);

  assert.match(stmt, /closes_at = deadline\.at/, 'closes_at is not taken from the shared scalar');
  assert.match(stmt, /entry_deadline = to_char\(deadline\.at/, 'entry_deadline is not derived from the shared scalar');
  assert.match(stmt, /FROM \(SELECT .* AS at\) AS deadline/, 'the shared scalar is not joined in');

  // And the deadline expression must be interpolated exactly once. This reads
  // source, where the interval arrives as `${closesAtSql()}` rather than as the
  // literal word INTERVAL — counting the latter would find nothing and pass for
  // the wrong reason.
  const calls = (stmt.match(/closesAtSql\(\)/g) || []).length;
  assert.equal(calls, 1, `closesAtSql() is interpolated ${calls} times; it must be interpolated once`);
});

test('dl3: closure and entry acceptance both read closes_at, never the mirror', () => {
  // If either ever read entry_deadline, the text mirror would become
  // load-bearing and a formatting change would become a fairness change.
  const due = MAINTENANCE.slice(MAINTENANCE.indexOf('const due = await client.query'));
  const query = due.slice(0, 400);
  assert.match(query, /closes_at IS NOT NULL AND closes_at <= NOW\(\)/,
    'the maintenance worker no longer selects on closes_at');
  assert.ok(!/entry_deadline/.test(query), 'the maintenance worker reads the text mirror');

  assert.match(GIVEAWAY_ROUTE, /\$1::timestamptz <= NOW\(\) AS passed'[\s\S]{0,80}giveaway\.closes_at/,
    'entry acceptance no longer compares against closes_at');
});

test('dl4: nothing writes entry_deadline without deriving it', () => {
  // Every write of the mirror in server/ must be a to_char of the authority.
  // A bare assignment is how the two drift apart.
  const offenders = [];
  ['server/lib', 'server/routes'].forEach((dir) => {
    const base = path.join(ROOT, dir);
    fs.readdirSync(base).filter((f) => f.endsWith('.js')).forEach((f) => {
      const src = fs.readFileSync(path.join(base, f), 'utf8');
      const re = /entry_deadline\s*=\s*([^,\n]+)/g;
      let m;
      while ((m = re.exec(src))) {
        const rhs = m[1].trim();
        if (/^to_char\(/.test(rhs)) continue;            // derived: fine
        if (/^\$\d+$/.test(rhs)) continue;               // parameter in the submission insert
        offenders.push(`${dir}/${f}: entry_deadline = ${rhs.slice(0, 60)}`);
      }
    });
  });
  assert.deepEqual(offenders, [], `entry_deadline written without derivation:\n  ${offenders.join('\n  ')}`);
});

test('dl5: an unpublished submission has no deadline in either column', () => {
  // Before approval there is no deadline to show or enforce, and inventing one
  // would put a countdown on a campaign nobody has approved.
  const insert = GIVEAWAY_ROUTE.slice(GIVEAWAY_ROUTE.indexOf('INSERT INTO giveaways'));
  const region = insert.slice(0, 2600);
  assert.match(region, /Kept in step with `closes_at` from approval onwards/,
    'the submission insert no longer explains its empty deadline');
  assert.ok(!/closes_at/.test(region.slice(0, region.indexOf('VALUES'))),
    'the submission insert writes closes_at before approval');
});

test('dl6: the approved rule is stated once and the public copy matches it', () => {
  // The wording and the rule must be the same sentence. This asserts the copy
  // does not promise a day count the code does not enforce.
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const offenders = [];
  pages.forEach((p) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', p), 'utf8');
    // Strip the sections that legitimately discuss retention periods in days.
    // privacy.html legitimately discusses retention periods measured in days;
    // that is a different subject from the entry window.
    if (p === 'privacy.html') return;
    if (/30[- ]day|exactly 30 (?:calendar )?days|30 days/i.test(html)) {
      offenders.push(p);
    }
  });
  assert.deepEqual(offenders, [], `pages still promise a 30-day entry window: ${offenders.join(', ')}`);

  // And the dictionaries, which are what a visitor actually reads. applyI18n()
  // overwrites the text in the HTML, so a page could be clean here and still
  // render "٣٠ يومًا" from an entry nothing above inspects — the same class of
  // failure as the stale hero.lede, in the language nobody on this project can
  // proofread by eye.
  const dictDir = path.join(ROOT, 'public', 'js', 'i18n');
  const dictFiles = ['../i18n.js', ...fs.readdirSync(dictDir).filter((f) => f.endsWith('.js'))];
  const dictOffenders = [];
  dictFiles.forEach((f) => {
    // privacy.js and admin.js measure retention and a reporting window in days;
    // neither is the entry deadline.
    if (f === 'privacy.js' || f === 'admin.js') return;
    const src = fs.readFileSync(path.join(dictDir, f), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (/30[- ]day|30 days|٣٠ يوم|30 يوم/i.test(line)) {
        dictOffenders.push(`${f === '../i18n.js' ? 'i18n.js' : f}:${i + 1}`);
      }
    });
  });
  assert.deepEqual(
    dictOffenders,
    [],
    'dictionary entries promise a 30-day entry window in text that overwrites the page:'
    + ` ${dictOffenders.join(', ')}`
  );

  // And the page scripts, which is where this actually was.
  //
  // create.js told a host, on the screen shown immediately after they submitted
  // a prize, that "it runs for 30 days". The code has enforced one calendar
  // month since this file was written. The markup was clean, the dictionaries
  // were clean, and the sentence a host read at the one moment they were paying
  // attention was wrong — because it was built in JavaScript and nothing here
  // looked there.
  const scriptDir = path.join(ROOT, 'public', 'js', 'pages');
  const scriptOffenders = [];
  fs.readdirSync(scriptDir).filter((f) => f.endsWith('.js')).forEach((f) => {
    // owner.js reports advertising revenue over a rolling 30-day window, which
    // is a reporting period and not the entry deadline.
    if (f === 'owner.js') return;
    fs.readFileSync(path.join(scriptDir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/30[- ]day|30 days|٣٠ يوم/i.test(line)) scriptOffenders.push(`${f}:${i + 1}`);
    });
  });
  assert.deepEqual(
    scriptOffenders,
    [],
    `page scripts promise a 30-day entry window: ${scriptOffenders.join(', ')}`
  );
});
