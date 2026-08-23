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
  'create.https': 'A URL shape shown as a hint in a web-address field, same reason as advertise.https.',
  'owner.https': 'A URL shape shown as a hint in a web-address field, same reason as advertise.https.',
  'admin.https': 'A URL shape shown as a hint in a web-address field, same reason as advertise.https.',
  'admin.httpsTheAdvertiserS': 'An example web address for an advertiser link field. Typed in Latin script.',
  'terms.202608172': 'A machine-readable policy version identifier, not prose. Translating it would break the version it names.',
  'privacy.202608151': 'A machine-readable policy version identifier, same reason as terms.202608172.',
  'privacy.render': 'A provider trade name. Transliterating it would make the company harder to look up, not easier.',
  'privacy.resend': 'A provider trade name, same reason as privacy.render.',
  'privacy.stripe': 'A provider trade name, same reason as privacy.render.',
  'privacy.cloudinary': 'A provider trade name, same reason as privacy.render.',
  'privacy.googleAnalytics': 'A provider trade name, same reason as privacy.render.',
  'privacy.sentry': 'A provider trade name, same reason as privacy.render.',
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

// ---------------------------------------------------------------------------
// i18n8: visible text that no dictionary can reach
// ---------------------------------------------------------------------------
//
// The tests above compare the two dictionaries against each other. All of them
// pass on a page written entirely in untranslated English, because a sentence
// with no data-i18n is not a key, and a key is the only thing they can see.
//
// That is how the Arabic pages came to be "complete" and still render English:
// 132 text nodes across 15 pages carried no attribute at all. Some were whole
// paragraphs; most were the second half of a sentence whose <strong> lead-in was
// tagged and whose body was not, which is exactly the shape that survives a
// reading of the file.
//
// So this walks the markup with an element stack and asks a different question:
// is there any visible text whose nearest enclosing element cannot be
// translated? Text following a closing tag belongs to the element that contains
// it, not to the tag before it — attributing it to the wrong element is what
// made the first version of this check miss most of the 132.
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Text that is deliberately identical in both languages. Kept as an explicit
// list rather than a rule, so adding one is a decision somebody makes on
// purpose — the alternative is a pattern loose enough to excuse a real
// omission.
const UNTRANSLATED_TEXT = new Set([
  // The brand, in the header link on every page. A transliteration would be a
  // second name for the same product.
  'Naseeb',
]);

function visibleTextWithoutKeys(html) {
  const src = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<head[\s\S]*?<\/head>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  const orphans = [];
  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*?)\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const [full, tag, attrs, text] = m;
    if (text !== undefined) {
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (!trimmed || !/[A-Za-z]{2}/.test(trimmed)) continue;
      if (UNTRANSLATED_TEXT.has(trimmed)) continue;
      const parent = stack[stack.length - 1];
      // data-i18n replaces textContent; data-i18n-lines replaces the whole
      // element including the <br> between its lines.
      if (parent && /data-i18n(?:-lines)?\s*=/.test(parent.attrs)) continue;
      orphans.push(trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed);
      continue;
    }
    const name = tag.toLowerCase();
    if (full.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === name) { stack.length = i; break; }
      }
    } else if (!VOID_ELEMENTS.has(name) && !full.endsWith('/>')) {
      stack.push({ tag: name, attrs });
    }
  }
  return orphans;
}

test('i18n8: no page carries visible text that no dictionary can reach', () => {
  const offenders = [];
  for (const name of pages) {
    const orphans = visibleTextWithoutKeys(fs.readFileSync(path.join(PUBLIC, name), 'utf8'));
    orphans.forEach((o) => offenders.push(`${name}: ${o}`));
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} visible text node(s) have no data-i18n, so they render in English`
    + ' whatever language is selected. Wrap the run in <span data-i18n="…"> and add the key'
    + ' to both dictionaries — or, if it is genuinely the same in both languages, add it to'
    + ` UNTRANSLATED_TEXT above with a reason.\n  ${offenders.join('\n  ')}`
  );
});

test('i18n9: the language URL parameter is a dictionary key and nothing else', () => {
  // ?lang=ar exists so Arabic has an address — an hreflang alternate pointing
  // at a URL that renders English to everyone else is worse than none. But a
  // language parameter is also the classic shape of an open redirect, so the
  // value must reach a comparison and never a navigation.
  const fn = I18N.slice(I18N.indexOf('function langFromUrl'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);

  assert.ok(/LANGS\.indexOf\(requested\)/.test(body), 'langFromUrl does not check the value against LANGS');
  assert.ok(!/location\.(href|assign|replace)/.test(body), 'langFromUrl touches location');
  assert.ok(!/window\.open|innerHTML|document\.write/.test(body), 'langFromUrl reaches a sink');

  // The allowed set is the two languages and nothing else, so a third value
  // cannot be smuggled in by extending LANGS to include a URL or a path.
  const langs = /const LANGS = \[([^\]]*)\];/.exec(I18N);
  assert.ok(langs, 'LANGS is not declared');
  assert.deepEqual(
    langs[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    ['en', 'ar'],
    'LANGS holds something other than the two language codes'
  );

  // getLang must fall back rather than use an unknown stored value as a key.
  const getFn = I18N.slice(I18N.indexOf('function getLang'));
  const getBody = getFn.slice(0, getFn.indexOf('\n}') + 2);
  assert.ok(/LANGS\.indexOf\(lang\) === -1 \? 'en'/.test(getBody), 'getLang does not fall back for an unknown language');
});

// ---------------------------------------------------------------------------
// i18n10: a key a page cannot reach
// ---------------------------------------------------------------------------
//
// The dictionaries are one flat namespace at runtime, but a page only loads
// some of them. dashboard.js called t('pricing.browseOpenGiveaways') — a real
// key, correctly translated, in a file dashboard.html does not load. t() returns
// the key when it has no entry, so the dashboard rendered the literal text
// "pricing.browseOpenGiveaways" where a link label belonged.
//
// Every test above passed. The key exists, has both languages, contains Arabic
// script, and is not identical to its English. Parity between dictionaries says
// nothing about which dictionary a page has in front of it.
//
// So this resolves each page's keys against the dictionaries that page actually
// loads. Both directions of the failure are caught: a key that exists nowhere,
// and a key that exists in a file this page did not ask for.
const PAGE_DICT_FOR = (() => {
  const perFile = new Map();
  for (const f of pageDicts) {
    const src = fs.readFileSync(path.join(PAGE_DICT_DIR, f), 'utf8');
    perFile.set(f, new Set(Object.keys(mergeFrom(src, 'en', {}))));
  }
  return perFile;
})();

const CORE_KEYS = new Set(Object.keys(parseDict(blockFor('en'))));

test('i18n10: every key a page script uses is in a dictionary that page loads', () => {
  const offenders = [];

  for (const name of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');

    // The dictionaries this page pulls in, plus the shared core.
    const available = new Set(CORE_KEYS);
    for (const m of html.matchAll(/<script src="\/js\/i18n\/([^"]+)"><\/script>/g)) {
      const keys = PAGE_DICT_FOR.get(m[1]);
      if (keys) keys.forEach((k) => available.add(k));
    }

    // The scripts this page runs, plus any data-i18n in its own markup.
    const used = new Map();
    for (const m of html.matchAll(/data-i18n(?:-content)?="([^"]+)"/g)) {
      used.set(m[1], name);
    }
    // data-i18n-lines resolves to <key>Line1 and <key>Line2, not to <key>.
    // Resolving it as written would report a key the runtime never looks up.
    for (const m of html.matchAll(/data-i18n-lines="([^"]+)"/g)) {
      used.set(`${m[1]}Line1`, name);
      used.set(`${m[1]}Line2`, name);
    }
    for (const m of html.matchAll(/<script src="\/js\/pages\/([^"]+)"><\/script>/g)) {
      const scriptPath = path.join(PUBLIC, 'js', 'pages', m[1]);
      if (!fs.existsSync(scriptPath)) continue;
      const src = fs.readFileSync(scriptPath, 'utf8');
      // t('key') and t('key', {...}). A key built at runtime by concatenation
      // cannot be resolved statically and is skipped rather than guessed at —
      // the policy pages do that deliberately, with their own fallback.
      for (const m2 of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.set(m2[1], m[1]);
    }

    for (const [key, where] of used) {
      if (available.has(key)) continue;
      offenders.push(`${name}: ${key} (used in ${where})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} key(s) are used on a page whose dictionaries do not define them. t() returns`
    + ' the key itself in that case, so the literal key renders on screen. Either load the dictionary'
    + ` that has it, or add the key to one this page already loads.\n  ${offenders.join('\n  ')}`
  );
});
