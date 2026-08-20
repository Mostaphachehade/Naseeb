// Line endings must not change a migration's identity, or a function's.
//
// ---------------------------------------------------------------------------
// The failure this file exists to prevent
// ---------------------------------------------------------------------------
//
// A Windows checkout with `core.autocrlf=true` writes the migration .sql files
// to disk with CRLF. Git stores them with LF. The same commit therefore had two
// byte forms, and both of the places that turn migration text into an identity
// were reading the working-tree form:
//
//   * `checksumFor` hashed CRLF bytes, so the ledger recorded a checksum no
//     Linux checkout of the same commit could ever reproduce. The mismatch
//     protection then fired on a difference that was not a difference.
//
//   * a `$function$ ... $function$` body was sent to PostgreSQL with its CRLF
//     intact and stored that way, so `pg_get_functiondef` read CRLF back while
//     the committed snapshot held LF, and schema verification reported an
//     unchanged function as `altered`.
//
// Both were observed against a real database. Everything below is pure — no
// database, no network — because the defect is in text handling, not in SQL.
//
// Every fixture here is fabricated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { toLf } = require('../server/lib/canonicalText');
const migrations = require('../server/lib/migrations');
const schemaVerify = require('../server/lib/schemaVerify');

// The canonical checksums, as published in docs/RELEASE_CANDIDATE.md §3. These
// are the LF values — the ones a Linux checkout and CI produce. Hard-coded on
// purpose: if a change to the loader moves them, that is the regression.
const CANONICAL = {
  '001_baseline': 'f7616d437748cda3f5d2dd0c38a5cd2aab9f84a510d125f51d66b467f1cb4095',
  '002_schema_ledger': 'afb145463640beee28be97a93fa4c2384c9cebf69280f2e0bd64458590991a4f',
  '003_giveaway_lifecycle': '8499d4e2d1773f38ad9853d9e13420de06638791422e76b62fdc43a69988813a',
};

// ---------------------------------------------------------------------------
// The canonicaliser itself
// ---------------------------------------------------------------------------

test('le1: toLf folds CRLF and lone CR, and leaves LF alone', () => {
  assert.equal(toLf('a\r\nb'), 'a\nb');
  assert.equal(toLf('a\rb'), 'a\nb');
  assert.equal(toLf('a\nb'), 'a\nb');
  assert.equal(toLf('a\r\n\r\nb'), 'a\n\nb');
  assert.equal(toLf(null), '');
  assert.equal(toLf(undefined), '');
});

test('le2: toLf folds line endings and NOTHING else', () => {
  // Indentation, trailing spaces and blank lines all stay significant. A
  // normaliser that ate them would hide real edits.
  assert.equal(toLf('  a  \n\n  b'), '  a  \n\n  b');
  assert.notEqual(toLf('a b'), toLf('a  b'));
  assert.notEqual(toLf('a\nb'), toLf('a\n b'));
});

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

test('le3: LF and CRLF copies of one migration checksum identically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naseeb-eol-'));
  try {
    const body = '-- fabricated\nCREATE TABLE IF NOT EXISTS le_demo (id TEXT PRIMARY KEY);\n';

    fs.writeFileSync(path.join(dir, 'lf.sql'), body);
    fs.writeFileSync(path.join(dir, 'crlf.sql'), body.replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(dir, 'cr.sql'), body.replace(/\n/g, '\r'));

    // The raw bytes genuinely differ — otherwise this test proves nothing.
    const rawLf = fs.readFileSync(path.join(dir, 'lf.sql'), 'utf8');
    const rawCrlf = fs.readFileSync(path.join(dir, 'crlf.sql'), 'utf8');
    assert.notEqual(rawLf, rawCrlf, 'fixture is not actually CRLF');
    assert.notEqual(migrations.checksum(rawLf), migrations.checksum(rawCrlf));

    // Through the loader they are one migration.
    const lf = migrations.sqlFor({ sqlFile: 'lf.sql' }, dir);
    const crlf = migrations.sqlFor({ sqlFile: 'crlf.sql' }, dir);
    const cr = migrations.sqlFor({ sqlFile: 'cr.sql' }, dir);

    assert.equal(migrations.checksum(lf), migrations.checksum(crlf));
    assert.equal(migrations.checksum(lf), migrations.checksum(cr));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('le4: the real migrations still checksum to their canonical values', () => {
  const actual = migrations.checksums();
  Object.entries(CANONICAL).forEach(([id, expected]) => {
    assert.equal(actual[id], expected, `${id} checksum moved away from the documented value`);
  });
});

test('le5: canonical checksums hold regardless of how this tree was checked out', () => {
  // The point of the fix: the value must not depend on the bytes on disk. If
  // the working tree happens to be CRLF (a Windows checkout), the checksums
  // above still had to match — which le4 just asserted. This asserts the
  // mechanism directly, from whichever form is actually present.
  migrations.MIGRATIONS.filter((m) => m.sqlFile).forEach((m) => {
    const onDisk = fs.readFileSync(path.join(migrations.MIGRATIONS_DIR, m.sqlFile), 'utf8');
    assert.equal(migrations.checksumFor(m), migrations.checksum(toLf(onDisk)));
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test('le6: CRLF migration text is canonicalised before it can be executed', () => {
  // `migrate` executes exactly what `sqlFor` returns, so this is the boundary:
  // if nothing with a CR can leave sqlFor, nothing with a CR reaches
  // client.query, and no CRLF function body can be stored.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naseeb-eol-'));
  try {
    const crlf =
      'CREATE OR REPLACE FUNCTION le_demo_fn() RETURNS trigger\r\n'
      + 'LANGUAGE plpgsql AS $function$\r\n  BEGIN\r\n    RETURN NEW;\r\n  END;\r\n$function$;\r\n';
    fs.writeFileSync(path.join(dir, 'crlf.sql'), crlf);

    const loaded = migrations.sqlFor({ sqlFile: 'crlf.sql' }, dir);
    assert.ok(!/\r/.test(loaded), 'sqlFor returned text still containing a carriage return');
    assert.equal(loaded, toLf(crlf));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // And the shipped migrations, as they stand in this working tree.
  migrations.MIGRATIONS.filter((m) => m.sqlFile).forEach((m) => {
    assert.ok(!/\r/.test(migrations.sqlFor(m)), `${m.id} would execute with a carriage return`);
  });
});

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

const FN_BODY_LF =
  'CREATE OR REPLACE FUNCTION integrity_audit_append_only()\n RETURNS trigger\n'
  + ' LANGUAGE plpgsql\nAS $function$\n    BEGIN\n'
  + "      RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;\n"
  + '    END;\n    $function$';

function snapshotWith(definition) {
  return { functions: [{ proname: 'integrity_audit_append_only', definition }] };
}

test('le7: a function differing only by CRLF verifies as unchanged', () => {
  const reference = snapshotWith(FN_BODY_LF);
  const live = snapshotWith(FN_BODY_LF.replace(/\n/g, '\r\n'));

  const result = schemaVerify.compare(reference, live);
  assert.equal(result.altered.length, 0, 'a line-ending-only difference was reported as altered');
  assert.equal(result.missing.length, 0);
});

test('le8: a real semantic difference still fails verification', () => {
  const reference = snapshotWith(FN_BODY_LF);

  // Same shape, different behaviour — the exception is gone. Delivered with
  // CRLF as well, so the canonicaliser cannot be what rescues it.
  const tampered = FN_BODY_LF
    .replace("RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;", 'RETURN NEW;')
    .replace(/\n/g, '\r\n');

  const result = schemaVerify.compare(reference, snapshotWith(tampered));
  assert.equal(result.altered.length, 1, 'a substantive change was not detected');
  assert.equal(result.altered[0].object, 'integrity_audit_append_only');
});

test('le9: whitespace changes other than line endings still fail verification', () => {
  const reference = snapshotWith(FN_BODY_LF);
  const reindented = snapshotWith(FN_BODY_LF.replace('    BEGIN', '        BEGIN'));

  const result = schemaVerify.compare(reference, reindented);
  assert.equal(result.altered.length, 1, 'the comparison was weakened beyond line endings');
});

test('le10: a missing object is still missing, and an extra one still extra', () => {
  const reference = snapshotWith(FN_BODY_LF);

  assert.equal(schemaVerify.compare(reference, { functions: [] }).missing.length, 1);
  assert.equal(
    schemaVerify.compare({ functions: [] }, reference).extra.length,
    1,
    'extra-object reporting was lost'
  );
});

// ---------------------------------------------------------------------------
// The ledger's protection, and the checkout
// ---------------------------------------------------------------------------

test('le11: the ledger mismatch protection is intact', () => {
  // Canonicalising must not have turned the checksum into something that
  // ignores edits. Any change to the content — one character, one statement —
  // must still move it, which is what makes a mismatch detectable.
  const base = 'CREATE TABLE IF NOT EXISTS le_demo (id TEXT PRIMARY KEY);\n';

  assert.notEqual(migrations.checksum(base), migrations.checksum(`${base}-- edited\n`));
  assert.notEqual(
    migrations.checksum(base),
    migrations.checksum(base.replace('TEXT', 'UUID')),
    'a type change did not move the checksum'
  );

  // And the ledger compares a stored checksum against a freshly computed one,
  // so an edited migration is still caught.
  const stored = migrations.checksumFor(migrations.MIGRATIONS[0]);
  assert.equal(stored, CANONICAL['001_baseline']);
  assert.notEqual(stored, migrations.checksum(`${migrations.sqlFor(migrations.MIGRATIONS[0])}\n-- tampered`));
});

test('le12: .gitattributes pins SQL files to LF', () => {
  const file = path.join(__dirname, '..', '.gitattributes');
  assert.ok(fs.existsSync(file), '.gitattributes is missing');

  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  assert.ok(
    lines.some((l) => /^\*\.sql\s+.*\btext\b.*\beol=lf\b/.test(l)),
    '.gitattributes does not pin *.sql to eol=lf'
  );
});
