#!/usr/bin/env node
//
// Inventories every DOM sink in public/js, so the count in docs/DOM_SINKS.md is
// something anyone can reproduce rather than something they have to believe.
//
//   node scripts/dom-sink-inventory.js          # table
//   node scripts/dom-sink-inventory.js --json   # machine-readable
//
// This reports; it does not judge. test/dom-safety.test.js is what fails when a
// forbidden sink appears — a reporting script nobody runs is not a control.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_ROOT = path.join(ROOT, 'public', 'js');

// Categories, in the order the audit brief asked for them.
const PATTERNS = [
  ['innerHTML', /\.innerHTML\s*=/],
  ['innerHTML-read', /\.innerHTML\b(?!\s*=)/],
  ['outerHTML', /\.outerHTML/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['html-parser', /new\s+DOMParser|createContextualFragment|document\.write/],
  ['attribute-setter', /setAttribute\s*\(/],
  // `=(?!=)` rather than `=[^=]`, so an assignment whose value starts on the
  // next line is still counted. The analytics tag is written that way, and an
  // inventory that quietly misses the one script src on the site would be worse
  // than no inventory at all.
  ['href-assign', /\.href\s*=(?!=)/],
  ['src-assign', /\.src\s*=(?!=)/],
  ['action-assign', /\.action\s*=(?!=)/],
  ['cssom-write', /\.style\.[A-Za-z]+\s*=/],
  ['cssom-attribute', /\.style\.cssText\s*=|\.style\s*=[^=]|setAttribute\s*\(\s*['"]style/],
  ['identifier-assign', /\.(id|name)\s*=[^=]/],
];

function stripComments(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(dir, entry.name))
      : entry.name.endsWith('.js')
        ? [path.join(dir, entry.name)]
        : []
  );
}

const rows = [];
for (const file of files(JS_ROOT)) {
  const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
  let fn = '(top level)';
  lines.forEach((line, i) => {
    const named = line.match(
      /(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\()|([A-Za-z0-9_$]+)\s*[:=]\s*(?:async\s*)?function)/
    );
    if (named) fn = named[1] || named[2] || named[3];
    for (const [kind, re] of PATTERNS) {
      if (re.test(line)) {
        rows.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          fn,
          kind,
          code: line.trim().slice(0, 110),
        });
      }
    }
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: rows.length, rows }, null, 2));
} else {
  const counts = {};
  rows.forEach((r) => { counts[r.kind] = (counts[r.kind] || 0) + 1; });
  console.log(`${rows.length} sinks\n`);
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([kind, n]) => console.log(`${String(n).padStart(4)}  ${kind}`));
  console.log('');
  rows.forEach((r) => {
    console.log(`${r.file}:${r.line}  [${r.kind}]  ${r.fn}\n      ${r.code}`);
  });
}
