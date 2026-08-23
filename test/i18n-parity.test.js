// The dictionary and the page must say the same thing.
//
// ---------------------------------------------------------------------------
// The failure this file exists to prevent
// ---------------------------------------------------------------------------
//
// `applyI18n()` sets `node.textContent = t(key)` for every `[data-i18n]`
// element, so the dictionary ALWAYS wins. The text sitting in the HTML is a
// fallback for the moment before the script runs, and nothing else.
//
// index.html's hero paragraph was edited to describe the premium-prize model —
// reviewed prizes, free entry, closure at 100 entries or 30 days. The dictionary
// still said giveaways were "funded by the people running them". Every visitor
// to the live site read the old sentence, because the dictionary overwrote the
// new one on load. The HTML looked right in review, in diff, and in the
// repository, and was wrong in the browser.
//
// That is a bad failure mode: the source of truth is invisible to whoever is
// reading the page source. This file makes the two agree, or fails.
//
// Pure: no database, no browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const I18N = fs.readFileSync(path.join(PUBLIC, 'js', 'i18n.js'), 'utf8');

// Parse the two dictionaries out of the source. Deliberately textual rather
// than importing: the module touches localStorage and document at load, neither
// of which exists here, and a parser that can read the committed file is also
// what a reviewer does.
function blockFor(lang) {
  const start = I18N.indexOf(`\n  ${lang}: {`);
  assert.ok(start > -1, `no ${lang} block in i18n.js`);
  let depth = 0;
  let i = I18N.indexOf('{', start);
  for (; i < I18N.length; i += 1) {
    if (I18N[i] === '{') depth += 1;
    else if (I18N[i] === '}') { depth -= 1; if (!depth) return I18N.slice(start, i); }
  }
  throw new Error(`unterminated ${lang} block`);
}

function parseDict(block) {
  const out = {};
  const re = /'([a-zA-Z0-9_.]+)':\s*(['"])((?:\\.|(?!\2).)*)\2/g;
  let m;
  while ((m = re.exec(block))) {
    out[m[1]] = m[3].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  return out;
}

// Per-page dictionaries live in public/js/i18n/*.js and call register({en, ar}).
// They are part of the same namespace, so parity has to be judged across all of
// them together — a key defined in a page dictionary is not "missing", and a key
// translated there must still have both languages.
const PAGE_DICT_DIR = path.join(PUBLIC, 'js', 'i18n');
const pageDicts = fs.existsSync(PAGE_DICT_DIR)
  ? fs.readdirSync(PAGE_DICT_DIR).filter((f) => f.endsWith('.js')).sort()
  : [];

function mergeFrom(source, lang, into) {
  // Indentation differs between i18n.js (two spaces inside TRANSLATIONS) and a
  // page dictionary (two spaces inside register({...})). Match either rather
  // than assuming, because a matcher that silently finds nothing would report
  // every page key as missing — which is exactly what it did.
  const m = source.match(new RegExp(`\\n\\s*${lang}:\\s*\\{`));
  if (!m) return into;
  const start = m.index;
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (!depth) break; }
  }
  return Object.assign(into, parseDict(source.slice(start, i)));
}

const EN = parseDict(blockFor('en'));
const AR = parseDict(blockFor('ar'));
pageDicts.forEach((f) => {
  const src = fs.readFileSync(path.join(PAGE_DICT_DIR, f), 'utf8');
  mergeFrom(src, 'en', EN);
  mergeFrom(src, 'ar', AR);
});
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).sort();

const normalise = (s) => String(s).replace(/\s+/g, ' ').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim();

test('i18n1: every English key has an Arabic counterpart, and vice versa', () => {
  const missingAr = Object.keys(EN).filter((k) => !(k in AR));
  const orphanAr = Object.keys(AR).filter((k) => !(k in EN));
  assert.deepEqual(missingAr, [], `keys with no Arabic: ${missingAr.join(', ')}`);
  assert.deepEqual(orphanAr, [], `Arabic keys with no English: ${orphanAr.join(', ')}`);
  assert.ok(Object.keys(EN).length > 0, 'the English dictionary is empty');
});

// Keys whose Arabic is DELIBERATELY identical to the English.
//
// An explicit list, not a length heuristic. Every entry needs a reason, and
// adding one is a decision somebody makes and a reviewer can see — which is the
// point: the alternative is loosening the test until untranslated strings slip
// through unnoticed.
//
// Mirrored in the untranslated allowlist in docs/ARABIC_RTL.md.
const INTENTIONALLY_UNTRANSLATED = {
  'advertise.https': 'A URL shape shown as a hint in a web-address field. Rendering "https" in Arabic would be a worse hint.',
  'advertise.httpsYourBusinessSite': 'An example web address. Addresses are typed in Latin script; a translated example would not be typeable.',
};

test('i18n2: no Arabic entry is left as its English source', () => {
  // A key copied across untranslated renders as English inside an Arabic
  // sentence, which is the failure this catches.
  const suspicious = Object.keys(EN).filter((k) => {
    if (k in INTENTIONALLY_UNTRANSLATED) return false;
    const en = normalise(EN[k]);
    const ar = normalise(AR[k]);
    if (!en || !ar) return false;
    if (en.length < 12) return false;
    return en === ar;
  });
  assert.deepEqual(suspicious, [],
    `Arabic identical to English. Translate it, or add it to INTENTIONALLY_UNTRANSLATED with a reason: ${suspicious.join(', ')}`);
});

test('i18n2b: every allowlisted key still exists and is still identical', () => {
  // An allowlist that outlives its entries is how an exception becomes a hole.
  // If a key is translated later, or removed, it must leave the list.
  const stale = Object.keys(INTENTIONALLY_UNTRANSLATED).filter((k) => {
    if (!(k in EN) || !(k in AR)) return true;          // gone
    return normalise(EN[k]) !== normalise(AR[k]);        // now translated
  });
  assert.deepEqual(stale, [],
    `allowlisted keys that are no longer untranslated or no longer exist: ${stale.join(', ')}`);
});

test('i18n3: every Arabic entry actually contains Arabic script', () => {
  const arabic = /[؀-ۿ]/;
  const notArabic = Object.keys(AR).filter((k) => {
    // The same allowlist governs this check. A key that is deliberately not
    // translated will not contain Arabic script, and exempting it here rather
    // than in a second list keeps one place to look.
    if (k in INTENTIONALLY_UNTRANSLATED) return false;
    const v = String(AR[k]);
    // Entries that are purely a placeholder, a number or punctuation are fine.
    if (!/[A-Za-z؀-ۿ]/.test(v)) return false;
    return !arabic.test(v);
  });
  assert.deepEqual(notArabic, [], `Arabic entries with no Arabic script: ${notArabic.join(', ')}`);
});

test('i18n4: the HTML fallback text matches the English dictionary', () => {
  // The whole point. applyI18n overwrites textContent, so a disagreement means
  // the committed HTML is not what a visitor reads.
  const drift = [];
  pages.forEach((page) => {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const re = /<([a-z0-9]+)[^>]*\bdata-i18n="([^"]+)"[^>]*>([^<]*)</gi;
    let m;
    while ((m = re.exec(html))) {
      const key = m[2];
      const inHtml = normalise(m[3]);
      if (!inHtml) continue;              // empty element, nothing to disagree with
      assert.ok(key in EN, `${page}: data-i18n="${key}" has no dictionary entry`);
      if (normalise(EN[key]) !== inHtml) {
        drift.push(`${page} [${key}]\n     html: ${inHtml.slice(0, 90)}\n     dict: ${normalise(EN[key]).slice(0, 90)}`);
      }
    }
  });
  assert.deepEqual(drift, [], `HTML disagrees with the dictionary — the dictionary is what renders:\n  ${drift.join('\n  ')}`);
});

test('i18n5: every data-i18n-attr target is an attribute a person reads', () => {
  // The walker only writes placeholder, aria-label, title and alt. Anything
  // else in the markup would silently do nothing, and a dictionary entry that
  // silently does nothing is worse than a missing one.
  const allowed = new Set(['placeholder', 'aria-label', 'title', 'alt']);
  const bad = [];
  pages.forEach((page) => {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const re = /data-i18n-attr="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      m[1].split(';').forEach((pair) => {
        const [attr, key] = pair.split(':').map((s) => s && s.trim());
        if (!attr || !key) return;
        if (!allowed.has(attr)) bad.push(`${page}: ${attr} is not translatable`);
        else if (!(key in EN)) bad.push(`${page}: data-i18n-attr key "${key}" has no dictionary entry`);
      });
    }
  });
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('i18n6: the language switch cannot navigate anywhere', () => {
  // setLang must only persist a choice and reload. A version that read a
  // redirect parameter, or assigned location.href, would be an open-redirect
  // waiting to be found.
  const fn = I18N.slice(I18N.indexOf('function setLang'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.ok(/location\.reload\(\)/.test(body), 'setLang no longer reloads');
  assert.ok(!/location\.href\s*=/.test(body), 'setLang assigns location.href');
  assert.ok(!/location\.assign|location\.replace|window\.open/.test(body), 'setLang navigates');
  assert.ok(!/redirect|returnTo|next=/i.test(body), 'setLang reads a redirect parameter');
  // And it must refuse a language it does not have.
  assert.ok(/!==\s*'en'\s*&&.*!==\s*'ar'/.test(body), 'setLang accepts an arbitrary language value');
});

test('i18n7: bidi isolation strips embedded control characters', () => {
  // isolate() wraps a value so its direction cannot leak into the sentence
  // around it. If hostile input could carry its own isolate or override
  // characters, it could open a run this never closes and reorder the rest of
  // the page — so they are removed before wrapping.
  // FSI and PDI are declared as module constants, so assert on the declarations
  // and on isolate() using them — checking the function body alone would look
  // in the wrong place and pass for the wrong reason.
  assert.ok(/const FSI = '⁨'/.test(I18N), 'FSI (U+2068) is not declared');
  assert.ok(/const PDI = '⁩'/.test(I18N), 'PDI (U+2069) is not declared');

  const fn = I18N.slice(I18N.indexOf('function isolate'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.ok(/FSI\s*\+/.test(body) && /\+\s*PDI/.test(body), 'isolate does not wrap the value in FSI/PDI');
  assert.ok(/\.replace\(/.test(body), 'isolate does not strip existing control characters');
  // The stripped set must cover the isolates and the legacy embedding and
  // override characters; an override left in place can still reorder a line.
  assert.ok(/⁦-⁩/.test(body), 'isolate does not strip U+2066..U+2069');
  assert.ok(/‪-‮/.test(body), 'isolate does not strip U+202A..U+202E');
});
