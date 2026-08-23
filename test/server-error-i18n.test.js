// Every refusal the server can send has to exist in both languages.
//
// ---------------------------------------------------------------------------
// The half of the product that stays in one language
// ---------------------------------------------------------------------------
//
// A page can be translated completely and still speak English at the worst
// possible moment. The sentence a person reads after a form is rejected is not
// written on the page — it arrives in a JSON body, and no amount of data-i18n
// reaches it. So the Arabic experience holds until something goes wrong, and
// then reverts, which is when a reader is least able to cope with it.
//
// public/js/i18n/errors.js carries those sentences and api() looks them up. The
// weakness of that arrangement is obvious: the server and the dictionary are two
// files that must agree, and nothing about editing one reminds you of the other.
// A new validation message would simply be English forever, and no test would
// notice, because every existing test would still pass.
//
// This file is the thing that notices. It reads the error literals straight out
// of server/ and asserts each one has an entry.
//
// Pure: reads source, opens no connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// `res.status(400).json({ error: '…' })` and friends. Single-quoted literals
// only: a template literal is interpolating a value, and a sentence built at
// runtime is not a fixed string this could translate anyway.
const ERROR_LITERAL = /\berror:\s*'((?:\\.|[^'\\]){4,}?)'/g;

function serverErrorSentences() {
  const found = new Map();
  for (const file of walk(path.join(ROOT, 'server'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(ERROR_LITERAL)) {
      const text = m[1].replace(/\\'/g, "'").replace(/\s+/g, ' ').trim();
      // Machine-readable codes travel to the page as codes and are rendered by
      // the page, not shown raw. They are not sentences and need no translation.
      if (/^[A-Z][A-Z0-9_]*$/.test(text)) continue;
      if (!found.has(text)) found.set(text, path.relative(ROOT, file));
    }
  }
  return found;
}

function dictionaryBlock(src, lang) {
  const m = new RegExp(`\\n\\s*${lang}:\\s*\\{`).exec(src);
  assert.ok(m, `no ${lang} block in errors.js`);
  let depth = 0;
  let i = src.indexOf('{', m.index);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (!depth) break; }
  }
  const out = {};
  const re = /'([a-zA-Z0-9_.]+)':\s*(['"])((?:\\.|(?!\2).)*)\2/g;
  let entry;
  const block = src.slice(m.index, i);
  while ((entry = re.exec(block))) out[entry[1]] = entry[3].replace(/\\'/g, "'");
  return out;
}

const ERRORS_JS = fs.readFileSync(path.join(ROOT, 'public/js/i18n/errors.js'), 'utf8');
const EN = dictionaryBlock(ERRORS_JS, 'en');
const AR = dictionaryBlock(ERRORS_JS, 'ar');
const englishSentences = new Set(Object.values(EN).map((s) => s.replace(/\s+/g, ' ').trim()));

test('se1. every server error sentence has an Arabic translation', () => {
  const missing = [];
  for (const [sentence, file] of serverErrorSentences()) {
    if (!englishSentences.has(sentence)) missing.push(`${file}: "${sentence}"`);
  }

  assert.deepEqual(
    missing,
    [],
    `${missing.length} server error(s) have no entry in public/js/i18n/errors.js, so an Arabic`
    + ' reader is shown English at the moment something is refused. Add the sentence to both'
    + ` blocks there.\n  ${missing.join('\n  ')}`
  );
});

test('se2. the errors dictionary has no entry the server never sends', () => {
  // The other direction. An entry left behind after its message was reworded is
  // dead weight that looks like coverage — the lookup is by exact sentence, so a
  // stale entry translates nothing while making the file look complete.
  const live = new Set(serverErrorSentences().keys());
  const stale = Object.keys(EN).filter((k) => !live.has(EN[k].replace(/\s+/g, ' ').trim()));

  assert.deepEqual(
    stale,
    [],
    `entries in errors.js that no server error matches — reworded or removed upstream: ${stale.join(', ')}`
  );
});

test('se3. both languages are complete and actually differ', () => {
  const missingAr = Object.keys(EN).filter((k) => !(k in AR));
  const missingEn = Object.keys(AR).filter((k) => !(k in EN));
  assert.deepEqual(missingAr, [], `error keys with no Arabic: ${missingAr.join(', ')}`);
  assert.deepEqual(missingEn, [], `Arabic error keys with no English: ${missingEn.join(', ')}`);

  const arabic = /[\u0600-\u06FF]/;
  const notTranslated = Object.keys(AR).filter((k) => !arabic.test(AR[k]));
  assert.deepEqual(notTranslated, [], `error entries with no Arabic script: ${notTranslated.join(', ')}`);
});

test('se4. api() localises the error rather than throwing the server sentence', () => {
  // The dictionary is only worth having if the one place that receives these
  // sentences actually consults it.
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(app, /throw new Error\(localiseServerError\(/, 'api() no longer localises its error');
  assert.match(app, /function localiseServerError/, 'localiseServerError is gone');

  // And it must fall back to the server's own words, not to a generic apology
  // that hides what happened.
  const fn = app.slice(app.indexOf('function localiseServerError'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.match(body, /if \(!key\) return fallback;/, 'an unmapped error no longer falls back to the server message');
});

test('se5. every page that can call the API loads the errors dictionary', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const missing = pages.filter((f) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    return !html.includes('/js/i18n/errors.js');
  });
  assert.deepEqual(missing, [], `pages without the errors dictionary: ${missing.join(', ')}`);
});
