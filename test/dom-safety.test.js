// DOM safety: the sinks that build the page, and the validators that decide
// where a URL may point.
//
// Phase 2.2B turned CSP on and replaced hand-escaping with an escaping tagged
// template. That left 76 places still producing markup at runtime from database
// values, which is a smaller version of the same bet: correct as long as every
// author remembers, in every context, forever. This amendment removed the bet.
// Nothing builds markup from data any more — elements are constructed, text is
// set as text, and every URL goes through a validator chosen for the place the
// URL is going.
//
// These tests hold that line in two ways at once. The static half fails if a
// markup sink or a raw URL assignment reappears in the source. The behavioural
// half exercises the validators against every payload family the amendment
// called out. Neither alone is enough: a regex over source code is easy to
// satisfy accidentally, and a passing validator says nothing about whether the
// page still calls it. The real-browser hostile-data run in
// test/browser-hostile-data.js closes the loop.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

const { api, pool, ensureInit, closePool } = require('../testHelpers');
const {
  validateMediaUrl,
  validateExternalLinkUrl,
  isSafeExternalLink,
} = require('../server/lib/mediaUrls');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const createdAdIds = [];

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdAdIds.length) {
    await pool.query('DELETE FROM ads WHERE id = ANY($1)', [createdAdIds]);
  }
  await closePool();
});

function scriptFiles() {
  const dirs = [path.join(PUBLIC, 'js'), path.join(PUBLIC, 'js', 'pages')];
  return dirs.flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => ({
        name: path.relative(ROOT, path.join(dir, name)),
        text: fs.readFileSync(path.join(dir, name), 'utf8'),
      }))
  );
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n');
}

// The one module allowed to touch attributes and the CSSOM directly. Everything
// else has to go through it.
const HELPER = 'public/js/dom.js';

// ---------------------------------------------------------------------------
// 1. Static guards — the sinks themselves
// ---------------------------------------------------------------------------

test('no page script constructs HTML at runtime', () => {
  const failures = [];
  scriptFiles().forEach(({ name, text }) => {
    const src = stripComments(text);
    [
      [/\.innerHTML\s*=/, 'innerHTML assignment'],
      [/\.innerHTML\b(?!\s*=)/, 'innerHTML read'],
      [/\.outerHTML/, 'outerHTML'],
      [/insertAdjacentHTML/, 'insertAdjacentHTML'],
      [/new\s+DOMParser|createContextualFragment/, 'HTML parsing API'],
      [/document\.write/, 'document.write'],
    ].forEach(([re, label]) => {
      if (re.test(src)) failures.push(`${name}: ${label}`);
    });
  });
  assert.deepEqual(
    failures,
    [],
    `HTML construction found — build elements instead:\n  ${failures.join('\n  ')}`
  );
});

test('the HTML files carry no inline handler, javascript: URL or style attribute', () => {
  const failures = [];
  fs.readdirSync(PUBLIC)
    .filter((name) => name.endsWith('.html'))
    .forEach((name) => {
      const text = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
      if (/\son[a-z]+\s*=/i.test(text)) failures.push(`${name}: inline event handler`);
      if (/javascript:/i.test(text)) failures.push(`${name}: javascript: URL`);
      if (/\sstyle\s*=\s*["']/i.test(text)) failures.push(`${name}: style attribute`);
      // Executable inline scripts only. `type="application/ld+json"` blocks are
      // structured data: the browser never executes them, CSP does not govern
      // them, and both of the ones here are static literals in the file.
      const inlineScripts = text.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
      inlineScripts.forEach((block) => {
        const openTag = block.slice(0, block.indexOf('>') + 1);
        if (/\bsrc\s*=/i.test(openTag)) return;
        if (/type\s*=\s*["']application\/ld\+json["']/i.test(openTag)) return;
        if (block.replace(/<\/?script[^>]*>/gi, '').trim()) {
          failures.push(`${name}: inline script body`);
        }
      });
    });
  assert.deepEqual(failures, [], `Inline behaviour found:\n  ${failures.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// 2. Static guards — URLs may only be set through the validating helpers
// ---------------------------------------------------------------------------

test('no script assigns href, src or action outside the validating helper', () => {
  const failures = [];
  scriptFiles()
    .filter(({ name }) => name !== HELPER)
    .forEach(({ name, text }) => {
      // The analytics tag is the single exception, and it has its own test
      // below pinning the exact expression — a fixed origin plus an encoded id
      // that had to match the shape of a measurement id to get this far.
      const src = stripComments(text).replace(
        /script\.src\s*=\s*\n?\s*'https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=' \+\s*\n?\s*encodeURIComponent\([^)]*\);/,
        ''
      );
      // `window.location.href = …` included: navigating is setting a URL, and a
      // redirect parameter is the classic way an attacker supplies one.
      [
        [/\.href\s*=[^=]/, 'href assignment — use setHref/navigate'],
        [/\.src\s*=[^=]/, 'src assignment — use setMediaSrc'],
        [/\.action\s*=[^=]/, 'action assignment — use setAction'],
        [/setAttribute\s*\(\s*['"](href|src|action|formaction|srcdoc|style|xlink:href)['"]/i, 'attribute setter'],
        [/location\s*\.\s*(replace|assign)\s*\(/, 'location.replace/assign — use navigate'],
      ].forEach(([re, label]) => {
        const match = src.match(re);
        if (match) failures.push(`${name}: ${label} (${match[0].trim()})`);
      });
    });
  assert.deepEqual(failures, [], `Unvalidated URL writes:\n  ${failures.join('\n  ')}`);
});

test('the analytics script src is built from a fixed origin and a checked id', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
  // The only script element this application creates. Its id is owner-supplied
  // configuration, so it is shape-checked and encoded rather than interpolated.
  assert.match(app, /\/\^G-\[A-Z0-9\]\{4,24\}\$\/i\.test/);
  assert.match(app, /'https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=' \+\s*encodeURIComponent/);
  assert.ok(
    !/script\.src\s*=\s*`/.test(app),
    'the script src must not be a template literal'
  );
});

// ---------------------------------------------------------------------------
// 3. Static guards — CSSOM writes
// ---------------------------------------------------------------------------

test('every CSSOM write takes a constant, a bounded number, or a validated URL', () => {
  // Property writes are permitted by the policy (docs/CSP.md §7), so this is an
  // inventory rather than a prohibition — but an inventory that fails when it
  // grows, because "one more style write" is how the habit comes back.
  const allowed = {
    // A validated media URL, quoted, with CSS metacharacters re-checked.
    'public/js/dom.js': ['.style.backgroundImage ='],
    // Confetti: Math.random() and a fixed colour list. No external input.
    'public/js/app.js': [
      '.style.left =', '.style.width =', '.style.height =', '.style.background =',
      '.style.transform =', '.style.animationDuration =', '.style.animationDelay =',
    ],
    // Homepage promo specks: same.
    'public/js/pages/index.js': ['.style.left =', '.style.background =', '.style.animationDelay ='],
  };

  const failures = [];
  scriptFiles().forEach(({ name, text }) => {
    const src = stripComments(text);
    const writes = [...new Set(src.match(/\.style\.[A-Za-z]+\s*=/g) || [])]
      .map((w) => w.replace(/\s+/g, ' ').trim());
    (allowed[name] ? writes.filter((w) => !allowed[name].includes(w)) : writes)
      .forEach((w) => failures.push(`${name}: ${w} — put a fixed value in a class instead`));

    if (/\.style\.cssText\s*=/.test(src)) failures.push(`${name}: style.cssText`);
    if (/\.style\.setProperty\s*\(/.test(src)) failures.push(`${name}: style.setProperty`);
    if (/\.style\s*=\s*[^=]/.test(src)) failures.push(`${name}: assignment to .style`);
  });
  assert.deepEqual(failures, [], `Unexpected CSSOM writes:\n  ${failures.join('\n  ')}`);
});

test('no CSSOM write is fed by a request, database or API value', () => {
  // The inventory above pins which properties are written. This pins what may
  // flow into them: a name that suggests external data next to a style write is
  // a failure even if the property is on the allowlist.
  const suspicious = /\.style\.[A-Za-z]+\s*=\s*[^;]*\b(data|state|config|result|row|claim|ad|user|giveaway|params|search|hash|response|res|json)\b/;
  const failures = [];
  scriptFiles()
    .filter(({ name }) => name !== HELPER)
    .forEach(({ name, text }) => {
      const match = stripComments(text).match(suspicious);
      if (match) failures.push(`${name}: ${match[0].trim()}`);
    });
  assert.deepEqual(failures, [], `External value flowing into CSSOM:\n  ${failures.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// 4. The client validators, exercised
// ---------------------------------------------------------------------------

function loadDom() {
  const source = fs.readFileSync(path.join(PUBLIC, 'js', 'dom.js'), 'utf8');
  const sandbox = { window: {} };
  // Loading only defines functions; no DOM access happens until one is called,
  // and only the pure validators are called here.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(sandbox.window, undefined);
  return sandbox.window.NaseebDom;
}

// Every family the amendment named, with the variants that make each one work.
const HOSTILE_URLS = {
  'javascript scheme': 'javascript:alert(1)',
  'javascript, mixed case': 'JaVaScRiPt:alert(1)',
  'javascript, embedded tab': 'java\tscript:alert(1)',
  'javascript, embedded newline': 'java\nscript:alert(1)',
  'javascript, leading control character': '\u0001javascript:alert(1)',
  'javascript, leading whitespace': '   javascript:alert(1)',
  'javascript, entity-encoded colon': 'javascript&#58;alert(1)',
  'javascript, percent-encoded colon': 'javascript%3Aalert(1)',
  'vbscript scheme': 'vbscript:msgbox(1)',
  'data html': 'data:text/html,<script>alert(1)</script>',
  'data svg': 'data:image/svg+xml,<svg onload=alert(1)>',
  'data base64 html': 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'file scheme': 'file:///etc/passwd',
  'blob scheme': 'blob:https://res.cloudinary.com/abc',
  'protocol relative': '//evil.example/x.png',
  'protocol relative, backslashes': '\\\\evil.example/x.png',
  'backslash path': '/\\evil.example',
  'embedded credentials': 'https://user:pass@res.cloudinary.com/x.png',
  'credential lookalike': 'https://res.cloudinary.com@evil.example/x.png',
  'malformed percent': 'https://res.cloudinary.com/%zz.png',
  'truncated percent': 'https://res.cloudinary.com/%4.png',
  'null byte': 'https://res.cloudinary.com/x.png\u0000',
};

const LOOKALIKE_ORIGINS = [
  'https://res.cloudinary.com.evil.example/x.png',
  'https://evilres.cloudinary.com/x.png',
  'https://res.cloudinary.com.co/x.png',
  'https://rescloudinary.com/x.png',
  'https://res.cloudinary.evil.com/x.png',
  'http://res.cloudinary.com/x.png',
];

test('safeMediaUrl rejects every hostile family and every lookalike origin', () => {
  const dom = loadDom();
  Object.entries(HOSTILE_URLS).forEach(([label, value]) => {
    assert.equal(dom.safeMediaUrl(value), null, `media: ${label} must be rejected`);
  });
  LOOKALIKE_ORIGINS.forEach((value) => {
    assert.equal(dom.safeMediaUrl(value), null, `media: ${value} must be rejected`);
  });
  assert.equal(
    dom.safeMediaUrl('https://res.cloudinary.com/demo/image/upload/sample.jpg'),
    'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  );
});

test('safeInternalUrl accepts only same-site paths', () => {
  const dom = loadDom();
  Object.entries(HOSTILE_URLS).forEach(([label, value]) => {
    assert.equal(dom.safeInternalUrl(value), null, `internal: ${label} must be rejected`);
  });
  [
    'https://naseeb.example/dashboard.html',
    'http://localhost:3000/admin.html',
    '//example.com/x',
    'dashboard.html',
    './dashboard.html',
    '/dashboard.html\u0000',
    '/dash board.html',
  ].forEach((value) => {
    assert.equal(dom.safeInternalUrl(value), null, `internal: ${value} must be rejected`);
  });
  assert.equal(dom.safeInternalUrl('/giveaway.html?id=abc'), '/giveaway.html?id=abc');
  assert.equal(dom.safeInternalUrl('/about.html#get-in-touch'), '/about.html#get-in-touch');
});

test('safeExternalLinkUrl accepts an advertiser site and nothing that is not one', () => {
  const dom = loadDom();
  Object.entries(HOSTILE_URLS).forEach(([label, value]) => {
    // http and https destinations on real hosts are the only survivors, so the
    // one case that is not hostile for this validator is the plain-http origin.
    if (label === 'protocol relative') return;
    assert.equal(dom.safeExternalLinkUrl(value), null, `external: ${label} must be rejected`);
  });
  assert.equal(dom.safeExternalLinkUrl('https://advertiser.example/landing'), 'https://advertiser.example/landing');
  assert.equal(dom.safeExternalLinkUrl('http://advertiser.example/'), 'http://advertiser.example/');
});

test('the checkout redirect accepts only Stripe hosted checkout', () => {
  const dom = loadDom();
  [
    'https://checkout.stripe.example/c/pay/abc',
    'https://checkout.stripe.com.evil.example/c/pay/abc',
    'https://evil.example/c/pay/abc',
    'http://checkout.stripe.com/c/pay/abc',
    'https://user:pass@checkout.stripe.com/c/pay/abc',
    'javascript:alert(1)',
  ].forEach((value) => {
    assert.equal(dom.safeExternalRedirectUrl(value), null, `${value} must be rejected`);
  });
  assert.equal(
    dom.safeExternalRedirectUrl('https://checkout.stripe.com/c/pay/cs_test_123'),
    'https://checkout.stripe.com/c/pay/cs_test_123'
  );
});

// ---------------------------------------------------------------------------
// 5. The server validators, and the read paths that use them
// ---------------------------------------------------------------------------

test('the server media validator refuses the same families as the browser one', () => {
  Object.entries(HOSTILE_URLS).forEach(([label, value]) => {
    assert.equal(validateMediaUrl(value).url, undefined, `server media: ${label} must be rejected`);
  });
  LOOKALIKE_ORIGINS.forEach((value) => {
    assert.equal(validateMediaUrl(value).url, undefined, `server media: ${value} must be rejected`);
  });
  assert.equal(
    validateMediaUrl('https://res.cloudinary.com/demo/image/upload/sample.jpg').url,
    'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  );
});

test('the server link validator refuses hostile destinations', () => {
  Object.entries(HOSTILE_URLS).forEach(([label, value]) => {
    if (label === 'protocol relative') return;
    assert.equal(validateExternalLinkUrl(value).url, undefined, `server link: ${label} must be rejected`);
  });
  assert.equal(validateExternalLinkUrl('https://advertiser.example/x').url, 'https://advertiser.example/x');
  assert.equal(isSafeExternalLink('javascript:alert(1)'), false);
  assert.equal(isSafeExternalLink('https://advertiser.example/x'), true);
});

test('the ad click-through refuses to redirect to a hostile stored destination', async () => {
  // A row written before this validation existed, inserted directly so the
  // create-time check cannot mask the read-time one.
  const id = randomUUID();
  createdAdIds.push(id);
  await pool.query(
    `INSERT INTO ads (id, business_name, image_url, target_url, media_type, active)
     VALUES ($1, 'Legacy advertiser', 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
             'javascript:alert(1)', 'image', TRUE)`,
    [id]
  );

  const res = await api().get(`/api/ads/${id}/click`);
  assert.equal(res.status, 400);
  assert.ok(!res.headers.location, 'no Location header may be sent for a rejected destination');

  const safeId = randomUUID();
  createdAdIds.push(safeId);
  await pool.query(
    `INSERT INTO ads (id, business_name, image_url, target_url, media_type, active)
     VALUES ($1, 'Real advertiser', 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
             'https://advertiser.example/landing', 'image', TRUE)`,
    [safeId]
  );
  const ok = await api().get(`/api/ads/${safeId}/click`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, 'https://advertiser.example/landing');
});
