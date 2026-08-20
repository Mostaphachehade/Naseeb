// One canonical form for text that is checksummed or compared.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// A migration file checked out on Windows with `core.autocrlf=true` arrives on
// disk with CRLF line endings. Git stores it with LF, so the same commit
// produces two different byte streams depending on which machine checked it
// out. Two consequences followed, and both were observed against a real
// database:
//
//   1. `checksumFor` hashed the working-tree bytes, so the ledger recorded a
//      Windows-only checksum. The identical commit on Linux then hashed to a
//      different value and the ledger reported a mismatch — the protection
//      firing on a difference that is not a difference.
//
//   2. A `$function$ ... $function$` body carries its line endings into the
//      database verbatim. `pg_get_functiondef` read them back with CRLF, the
//      committed snapshot held LF, and schema verification reported the
//      function as `altered` when the two were byte-identical apart from the
//      line endings.
//
// Canonicalising to LF at the two points where text is turned into a checksum
// or a comparison removes both, without weakening either check: every
// substantive difference — a changed statement, a renamed object, an edited
// function body — still produces different text.
//
// This is deliberately NOT a general-purpose whitespace normaliser. It folds
// line endings and nothing else. Trailing spaces, indentation and blank lines
// all remain significant, because a change to any of them is a change somebody
// made to the file.

// CRLF and lone CR both become LF. Lone CR is included because a file that has
// been through an old Mac-era editor, or a partially converted one, can carry
// it, and a checksum that depends on which of the three forms is present is the
// bug this function exists to remove.
function toLf(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

module.exports = { toLf };
