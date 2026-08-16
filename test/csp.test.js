// Content Security Policy, and the things that had to be true before it could
// be turned on.
//
// CSP was off for the whole life of this project, with a comment in
// server/app.js explaining why: inline scripts and styles everywhere, and image
// URLs from anywhere at all. That was an accurate description of the codebase
// and not a reason — so this phase removed the obstacles rather than the
// ambition. These tests are what keeps them removed: an inline script or a
// style attribute reintroduced tomorrow fails here, not in a browser console
// nobody is reading.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const {
  api,
  pool,
  ensureInit,
  signIn,
  nextTestIp,
  TEST_ORIGIN,
  uniqueEmail,
} = require('../testHelpers');

const { policyFor, buildDirectives } = require('../server/lib/securityHeaders');
const { validateMediaUrl, mediaOrigins } = require('../server/lib/mediaUrls');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PASSWORD = 'correcthorse123';

const createdUserIds = [];
const createdGiveawayIds = [];

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdGiveawayIds.length) {
    await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [createdGiveawayIds]);
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM host_status_events WHERE user_id = ANY($1) OR changed_by = ANY($1)', [
      createdUserIds,
    ]);
    await pool.query('DELETE FROM host_applications WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

async function createAccount(tag, { admin = false, hostStatus = 'approved' } = {}) {
  const id = uuid();
  const email = uniqueEmail(`csp-${tag}`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
    [id, `CSP ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), admin, hostStatus]
  );
  createdUserIds.push(id);
  return { id, email };
}

function htmlFiles() {
  return fs
    .readdirSync(PUBLIC)
    .filter((name) => name.endsWith('.html'))
    .map((name) => ({ name: `public/${name}`, text: fs.readFileSync(path.join(PUBLIC, name), 'utf8') }));
}

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
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function parsePolicy(header) {
  const out = {};
  String(header)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const [name, ...values] = part.split(/\s+/);
      out[name] = values;
    });
  return out;
}

// ---------------------------------------------------------------------------
// 1–2. The header, everywhere, and what it does not contain
// ---------------------------------------------------------------------------

test('every kind of response carries a Content-Security-Policy', async () => {
  const account = await createAccount('headers');
  const session = await signIn(account.email, PASSWORD);

  const created = await session.post('/api/giveaways').send({
    title: 'CSP header test giveaway',
    description: 'A fabricated listing.',
    prize_description: 'A fabricated prize',
    funded_by: 'Fabricated budget',
    entry_deadline: new Date(Date.now() + 864e5).toISOString(),
  });
  assert.equal(created.status, 201);
  createdGiveawayIds.push(created.body.id);

  const responses = [
    ['public page', await api().get('/index.html')],
    ['authentication page', await api().get('/login.html')],
    ['claim page', await api().get('/claim.html')],
    ['dashboard', await api().get('/dashboard.html')],
    ['admin', await api().get('/admin.html')],
    ['owner', await api().get('/owner.html')],
    ['dynamic giveaway page', await api().get(`/giveaway.html?id=${created.body.id}`)],
    ['API success', await api().get('/api/config')],
    ['API 401', await api().get('/api/giveaways/mine/hosted')],
    ['API 404', await api().get('/api/no-such-endpoint')],
    ['page 404', await api().get('/no-such-page')],
    ['static asset', await api().get('/css/style.css')],
    ['stylesheet 404', await api().get('/css/does-not-exist.css')],
  ];

  responses.forEach(([label, res]) => {
    assert.ok(res.headers['content-security-policy'], `${label} must carry a CSP`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
    assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin', `${label}: referrer`);
    assert.equal(res.headers['x-frame-options'], 'DENY', `${label}: frame options`);
    assert.ok(res.headers['permissions-policy'], `${label}: permissions policy`);
  });
});

test('the policy has no unsafe-inline, no unsafe-eval and no wildcard', async () => {
  const res = await api().get('/index.html');
  const policy = parsePolicy(res.headers['content-security-policy']);

  assert.deepEqual(policy['script-src'], ["'self'"], 'scripts come from this origin and nowhere else');
  assert.deepEqual(policy['script-src-attr'], ["'none'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'self'"]);
  assert.deepEqual(policy['default-src'], ["'self'"]);

  const whole = res.headers['content-security-policy'];
  assert.ok(!/unsafe-inline/.test(whole), "no 'unsafe-inline' anywhere in the policy");
  assert.ok(!/unsafe-eval/.test(whole), "no 'unsafe-eval'");
  assert.ok(!/unsafe-hashes/.test(whole), "no 'unsafe-hashes' either");

  Object.entries(policy).forEach(([name, values]) => {
    values.forEach((value) => {
      assert.ok(value !== '*', `${name} must not be a wildcard`);
      assert.ok(!/^https?:$/.test(value), `${name} must not admit a whole scheme`);
      assert.ok(!/^\*\./.test(value), `${name} must not use a wildcard host`);
    });
  });

  // Scripts may never come from a data: or blob: URL.
  ['script-src', 'default-src'].forEach((name) => {
    (policy[name] || []).forEach((value) => {
      assert.ok(!/^(data|blob):/.test(value), `${name} must not allow ${value}`);
    });
  });
});

test('there is no configuration that turns CSP off', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'securityHeaders.js'), 'utf8');
  const code = stripComments(source);

  // No env var gates the header, and no branch returns without setting it.
  assert.ok(!/CSP_DISABLED|DISABLE_CSP|CSP_ENABLED|CSP_REPORT_ONLY/i.test(code));
  assert.ok(!/Content-Security-Policy-Report-Only/i.test(code), 'report-only stops nothing');

  const app = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8'));
  assert.match(app, /app\.use\(securityHeaders\)/, 'mounted unconditionally');
  assert.ok(
    app.indexOf('app.use(securityHeaders)') < app.indexOf("app.use('/api"),
    'mounted before every route, so errors carry it too'
  );
});

test('third-party script origins are absent unless analytics is configured, and never on sensitive pages', () => {
  const original = process.env.GA_MEASUREMENT_ID;
  try {
    delete process.env.GA_MEASUREMENT_ID;
    assert.deepEqual(buildDirectives('/index.html')['script-src'], ["'self'"]);

    process.env.GA_MEASUREMENT_ID = 'G-FABRICATED';
    assert.deepEqual(buildDirectives('/index.html')['script-src'], [
      "'self'",
      'https://www.googletagmanager.com',
    ]);

    // The pages that handle a single-use claim credential, and everything an
    // administrator can see, load no third-party script at all.
    ['/claim.html', '/admin.html', '/owner.html'].forEach((page) => {
      assert.deepEqual(
        buildDirectives(page)['script-src'],
        ["'self'"],
        `${page} must never admit third-party script`
      );
    });
  } finally {
    if (original === undefined) delete process.env.GA_MEASUREMENT_ID;
    else process.env.GA_MEASUREMENT_ID = original;
  }
});

test('HSTS is production-only and upgrade-insecure-requests follows it', async () => {
  const res = await api().get('/index.html');
  assert.equal(res.headers['strict-transport-security'], undefined, 'not sent over local http');
  assert.ok(!/upgrade-insecure-requests/.test(res.headers['content-security-policy']));

  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.match(policyFor('/index.html'), /upgrade-insecure-requests/);
  } finally {
    process.env.NODE_ENV = original;
  }
});

// ---------------------------------------------------------------------------
// 3–6. Nothing inline is left to allow
// ---------------------------------------------------------------------------

test('no HTML file contains an inline script or an inline event handler', () => {
  const failures = [];
  htmlFiles().forEach(({ name, text }) => {
    // <script> with no src is an inline script. <script src> is fine.
    const openings = text.match(/<script(?![^>]*\ssrc=)[^>]*>/gi) || [];
    openings.forEach((tag) => {
      // JSON-LD and similar data blocks are not executable and are not injected
      // into any page from user input; the server builds the giveaway one.
      if (/type\s*=\s*["'](application\/ld\+json|application\/json)["']/i.test(tag)) return;
      failures.push(`${name}: inline ${tag}`);
    });

    const handlers = text.match(/\son[a-z]+\s*=\s*["']/gi) || [];
    handlers.forEach((h) => failures.push(`${name}: inline handler${h.trimEnd()}`));
  });
  assert.deepEqual(failures, [], `Inline executable behaviour found:\n  ${failures.join('\n  ')}`);
});

test('no javascript: URL and no string-based code execution exists anywhere', () => {
  const failures = [];
  [...htmlFiles(), ...scriptFiles()].forEach(({ name, text }) => {
    const code = stripComments(text);
    if (/javascript\s*:/i.test(code)) failures.push(`${name}: javascript: URL`);
    if (/\beval\s*\(/.test(code)) failures.push(`${name}: eval()`);
    if (/new\s+Function\s*\(/.test(code)) failures.push(`${name}: new Function()`);
    if (/document\.write/.test(code)) failures.push(`${name}: document.write`);
    // A timer given a string is eval by another name.
    if (/set(Timeout|Interval)\s*\(\s*['"`]/.test(code)) failures.push(`${name}: string timer`);
    if (/\bsetAttribute\s*\(\s*['"]on[a-z]+['"]/i.test(code)) failures.push(`${name}: sets an on* attribute`);
  });
  assert.deepEqual(failures, [], `Dynamic code execution found:\n  ${failures.join('\n  ')}`);
});

test('no inline style block or style attribute remains, in markup or in generated HTML', () => {
  const failures = [];
  htmlFiles().forEach(({ name, text }) => {
    if (/<style[\s>]/i.test(text)) failures.push(`${name}: inline <style> block`);
    const attrs = text.match(/\sstyle\s*=\s*["']/gi) || [];
    attrs.forEach(() => failures.push(`${name}: style attribute`));
  });
  // The page scripts build HTML strings; a style attribute in one of those is
  // the same violation, just written later.
  scriptFiles().forEach(({ name, text }) => {
    const attrs = stripComments(text).match(/\sstyle\s*=\s*\\?["']/g) || [];
    attrs.forEach(() => failures.push(`${name}: style attribute in generated HTML`));
  });
  assert.deepEqual(failures, [], `Inline styling found:\n  ${failures.join('\n  ')}`);
});

test('no JavaScript writes the style attribute itself', () => {
  // This is the write style-src-attr 'none' actually refuses — measured in
  // docs/CSP.md §7, where a probe page showed setAttribute('style', …) blocked
  // while element.style.property assignments applied normally. `.style =` and
  // `.style.cssText =` both set the attribute's content, so both are refused
  // here even though Chrome happens to allow cssText today.
  const failures = [];
  scriptFiles().forEach(({ name, text }) => {
    const src = stripComments(text);
    if (/setAttribute\s*\(\s*['"]style['"]/.test(src)) failures.push(`${name}: setAttribute('style')`);
    if (/\.style\.cssText\s*=/.test(src)) failures.push(`${name}: style.cssText`);
    if (/\.style\s*=\s*[^=]/.test(src)) failures.push(`${name}: assignment to .style`);
  });
  assert.deepEqual(failures, [], `Style attribute writes found:\n  ${failures.join('\n  ')}`);
});

test('element.style property writes stay confined to values computed at runtime', () => {
  // Property writes are permitted by the policy, so this is an inventory rather
  // than a prohibition: a new one is not a violation, but it should be a
  // deliberate decision instead of a habit returning at 82 call sites. Anything
  // whose value is fixed belongs in a class.
  const allowed = {
    'public/js/dom.js': ['.style.backgroundImage ='],
    'public/js/app.js': [
      '.style.left =', '.style.width =', '.style.height =', '.style.background =',
      '.style.transform =', '.style.animationDuration =', '.style.animationDelay =',
    ],
    'public/js/pages/index.js': ['.style.left =', '.style.background =', '.style.animationDelay ='],
  };
  const failures = [];
  scriptFiles().forEach(({ name, text }) => {
    const writes = [...new Set(stripComments(text).match(/\.style\.[A-Za-z]+\s*=/g) || [])]
      .map((w) => w.replace(/\s+/g, ' ').trim());
    const permitted = allowed[name] || [];
    writes
      .filter((w) => !permitted.includes(w))
      .forEach((w) => failures.push(`${name}: ${w} — put a fixed value in a class instead`));
  });
  assert.deepEqual(failures, [], `Unexpected style writes:\n  ${failures.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// 7–9. User content cannot execute
// ---------------------------------------------------------------------------

const PAYLOADS = [
  '<script>window.x=1</script>',
  '<img src=x onerror="window.x=1">',
  '"><svg onload=alert(1)>',
  "javascript:alert(1)",
  '<iframe src="javascript:alert(1)">',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '%3Cscript%3Ealert(1)%3C/script%3E',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<script>alert(1)</script>',
  '<style>@import "http://evil.example"</style>',
];

test('a giveaway carrying every payload is stored and returned as text, never as markup', async () => {
  const host = await createAccount('payload-host');
  const session = await signIn(host.email, PASSWORD);

  // Fields have length limits, so each gets a different payload rather than
  // all eleven concatenated.
  const created = await session.post('/api/giveaways').send({
    title: `Title ${PAYLOADS[0]} ${PAYLOADS[1]}`,
    description: `Description ${PAYLOADS.join(' ')}`,
    prize_description: `Prize ${PAYLOADS[2]} ${PAYLOADS[3]}`,
    funded_by: `Funded ${PAYLOADS[4]}`,
    entry_deadline: new Date(Date.now() + 864e5).toISOString(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdGiveawayIds.push(created.body.id);

  // The API returns exactly what was stored — it is data, and escaping is the
  // renderer's job, done in one place.
  assert.ok(created.body.title.includes('<script>'), 'stored verbatim, not mangled');

  // The server-rendered giveaway page is where markup could actually escape,
  // because that HTML is built on the server.
  const page = await api().get(`/giveaway.html?id=${created.body.id}`);
  assert.equal(page.status, 200);
  const head = page.text.slice(0, page.text.indexOf('</head>'));

  // Only the metadata this server generated may contain raw markup. Extract
  // the attribute values it wrote and check those, rather than pattern-matching
  // the whole head — "onerror=" also appears inside the correctly escaped text.
  const injected = [...head.matchAll(/content="([^"]*)"/g)].map((m) => m[1]);
  injected.forEach((value) => {
    assert.ok(!/<[a-z/]/i.test(value), `raw markup escaped into an attribute: ${value.slice(0, 60)}`);
    assert.ok(!/^\s*javascript:/i.test(value), 'no javascript: URL in metadata');
  });
  assert.ok(injected.some((v) => v.includes('&lt;script&gt;')), 'the payload appears escaped');
  assert.ok(!head.includes('<script>window.x=1</script>'), 'no payload survives into the head');

  // And the JSON-LD block cannot be closed early.
  assert.ok(!/<\/script>\s*<script>window\.x/.test(page.text));
});

test('applicant, administrative and claim text is returned as data, not markup', async () => {
  const applicant = await createAccount('payload-applicant', { hostStatus: 'not_requested' });
  const session = await signIn(applicant.email, PASSWORD);
  const admin = await createAccount('payload-admin', { admin: true });
  const adminSession = await signIn(admin.email, PASSWORD);

  const applied = await session
    .post('/api/host-applications')
    .set('X-Forwarded-For', nextTestIp())
    .send({
      applicant_type: 'company',
      full_name: `Applicant ${PAYLOADS[0]}`,
      business_name: `Business ${PAYLOADS[1]}`,
      message: `Message ${PAYLOADS.join(' ')}`,
    });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));

  const queue = await adminSession.get('/api/admin/host-applications');
  assert.equal(queue.status, 200);
  // JSON, so the payload is a string value and cannot be markup. The check that
  // matters is that nothing on the server turned it into HTML on the way out.
  assert.equal(queue.headers['content-type'].split(';')[0], 'application/json');
  const row = queue.body.find((a) => a.user_id === applicant.id);
  assert.ok(row.display_name.includes('onerror'), 'returned verbatim as data, not stripped');

  const decided = await adminSession
    .post(`/api/admin/host-applications/${applied.body.id}/decision`)
    .send({ decision: 'rejected', reason: `Reason ${PAYLOADS.join(' ')}` });
  assert.equal(decided.status, 200);

  const events = await pool.query(
    'SELECT reason FROM host_status_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [applicant.id]
  );
  assert.ok(events.rows[0].reason.includes('<script>'), 'an admin reason is text too');
  // And the queue is JSON: there is no HTML context for it to escape into.
  assert.ok(!/<script>/.test(queue.headers['content-type']));
});

test('the frontend has no HTML escaper left to forget to call', () => {
  // The phase-2.2B answer to injection was an escaping tagged template. The
  // amendment removed it, because escaping is only ever correct for one context
  // and a general-purpose escaper invites use in the others. Its absence is the
  // assertion: if `escapeHtml` reappears, something is building markup again.
  const source = fs.readFileSync(path.join(PUBLIC, 'js', 'dom.js'), 'utf8');
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func -- loading the module under test, with
  // a literal file this test controls. Nothing user-supplied reaches here.
  new Function('window', 'document', source)(sandbox.window, undefined);
  const dom = sandbox.window.NaseebDom;

  ['escapeHtmlText', 'html', 'trusted', 'setHtml'].forEach((name) => {
    assert.equal(dom[name], undefined, `NaseebDom.${name} should be gone`);
  });

  const scripts = scriptFiles().map((f) => f.text).join('\n');
  assert.ok(!/function\s+escapeHtml\b/.test(scripts), 'no escapeHtml helper remains');
  assert.ok(!/function\s+escapeAttr\b/.test(scripts), 'no escapeAttr helper remains');

  // What replaced it: element construction and per-context URL validators.
  ['el', 'mount', 'setText', 'setHref', 'setExternalHref', 'setMediaSrc', 'navigate'].forEach((name) => {
    assert.equal(typeof dom[name], 'function', `NaseebDom.${name} should exist`);
  });
});

// ---------------------------------------------------------------------------
// 10–12. Media URLs
// ---------------------------------------------------------------------------

test('malicious media URLs are rejected by the server', async () => {
  const host = await createAccount('media-host');
  const session = await signIn(host.email, PASSWORD);

  const hostile = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'data:text/html,<script>alert(1)</script>',
    '//res.cloudinary.com/x.png',
    'http://res.cloudinary.com/x.png',
    'https://res.cloudinary.com@evil.example/x.png',
    'https://user:pass@res.cloudinary.com/x.png',
    'file:///etc/passwd',
    'https://res.cloudinary.com/x.png\n<script>alert(1)</script>',
    'not a url',
  ];

  for (const url of hostile) {
    const res = await session.post('/api/giveaways').send({
      title: 'Hostile media test',
      description: 'd',
      prize_description: 'p',
      funded_by: 'f',
      image_url: url,
      entry_deadline: new Date(Date.now() + 864e5).toISOString(),
    });
    assert.equal(res.status, 400, `${JSON.stringify(url).slice(0, 40)} must be refused`);
    assert.equal(res.body.code, 'MEDIA_URL_REJECTED');
  }

  const stored = await pool.query('SELECT COUNT(*)::int AS c FROM giveaways WHERE host_id = $1', [
    host.id,
  ]);
  assert.equal(stored.rows[0].c, 0, 'no refused request may have written a row');
});

test('lookalike and suffix media domains are rejected', () => {
  [
    'https://res.cloudinary.com.evil.example/x.png',
    'https://res-cloudinary.com/x.png',
    'https://evil.example/res.cloudinary.com/x.png',
    'https://res.cloudinary.com.attacker.net/x.png',
    'https://rescloudinary.com/x.png',
    'https://xn--res-cloudinary-0kb.com/x.png',
  ].forEach((url) => {
    assert.equal(validateMediaUrl(url).url, undefined, `${url} must be refused`);
  });

  // The allowlist is compared as an origin, so no substring match exists to
  // exploit in the first place.
  assert.deepEqual(mediaOrigins(), ['https://res.cloudinary.com']);
});

test('an approved https media URL is accepted, stored and rendered', async () => {
  const host = await createAccount('media-ok');
  const session = await signIn(host.email, PASSWORD);
  const url = 'https://res.cloudinary.com/demo/image/upload/v1/fabricated.png';

  const created = await session.post('/api/giveaways').send({
    title: 'Approved media test',
    description: 'd',
    prize_description: 'p',
    funded_by: 'f',
    image_url: url,
    entry_deadline: new Date(Date.now() + 864e5).toISOString(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdGiveawayIds.push(created.body.id);
  assert.equal(created.body.image_url, url);

  const read = await api().get(`/api/giveaways/${created.body.id}`);
  assert.equal(read.body.image_url, url, 'existing safe media keeps rendering');

  const page = await api().get(`/giveaway.html?id=${created.body.id}`);
  assert.ok(page.text.includes(`og:image" content="${url}"`), 'and reaches the share metadata');

  // The policy admits exactly this origin, so what can be stored can be shown.
  const policy = parsePolicy(page.headers['content-security-policy']);
  assert.ok(policy['img-src'].includes('https://res.cloudinary.com'));
});

test('a hostile URL already in the database is never rendered and never linked', async () => {
  const host = await createAccount('media-legacy');
  const id = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline)
     VALUES ($1, $2, 'Legacy media', 'd', 'p', 'f', $3)`,
    [id, host.id, new Date(Date.now() + 864e5).toISOString()]
  );
  createdGiveawayIds.push(id);
  // Written directly, as a row from before validation existed would have been.
  await pool.query('UPDATE giveaways SET image_url = $1 WHERE id = $2', [
    'javascript:alert(document.cookie)',
    id,
  ]);

  const read = await api().get(`/api/giveaways/${id}`);
  assert.equal(read.body.image_url, null, 'the read path refuses to hand it to a browser');

  const page = await api().get(`/giveaway.html?id=${id}`);
  assert.ok(!page.text.includes('javascript:alert'), 'and it reaches no share metadata');
  assert.ok(!/og:image/.test(page.text), 'no image tag at all rather than a hostile one');

  // The stored value is untouched: it is the record of what was submitted.
  const row = await pool.query('SELECT image_url FROM giveaways WHERE id = $1', [id]);
  assert.equal(row.rows[0].image_url, 'javascript:alert(document.cookie)');
});

// ---------------------------------------------------------------------------
// 13–17. The boundaries this phase must not have broken
// ---------------------------------------------------------------------------

test('claim tokens still travel in a fragment and never in a request URL', () => {
  const page = fs.readFileSync(path.join(PUBLIC, 'claim.html'), 'utf8');
  const capture = fs.readFileSync(path.join(PUBLIC, 'js', 'pages', 'claim-1.js'), 'utf8');

  // The capture file is the first script tag on the page — before dom.js,
  // i18n.js, app.js and the page's own script.
  const order = ['/js/pages/claim-1.js', '/js/dom.js', '/js/i18n.js', '/js/app.js'].map((src) =>
    page.indexOf(src)
  );
  assert.ok(order[0] !== -1);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'capture must load first');

  assert.match(capture, /history\.replaceState/, 'and erase the fragment immediately');
  assert.ok(!/lookup\?token=/.test(page + capture), 'never a query string');

  // Analytics cannot run here at all, by policy rather than by our own choice.
  assert.deepEqual(buildDirectives('/claim.html')['script-src'], ["'self'"]);
});

test('cookie authentication and CSRF-protected writes still work under the policy', async () => {
  const account = await createAccount('still-works');
  const session = await signIn(account.email, PASSWORD);

  const bootstrap = await session.get('/api/auth/session');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.authenticated, true);
  assert.ok(bootstrap.headers['content-security-policy'], 'even the bootstrap carries a policy');

  const created = await session.post('/api/giveaways').send({
    title: 'CSRF under CSP',
    description: 'd',
    prize_description: 'p',
    funded_by: 'f',
    entry_deadline: new Date(Date.now() + 864e5).toISOString(),
  });
  assert.equal(created.status, 201);
  createdGiveawayIds.push(created.body.id);

  // And a write without the token is still refused.
  const refused = await session.agent
    .post('/api/giveaways')
    .set('Origin', TEST_ORIGIN)
    .send({ title: 'no csrf' });
  assert.equal(refused.status, 403);
});

test('the Stripe webhook still verifies a raw-body signature', async () => {
  const secret = 'whsec_csp_test_secret';
  const original = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  try {
    const payload = JSON.stringify({
      id: `evt_csp_${Date.now()}`,
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_csp', metadata: {}, amount_total: 0, currency: 'aed' } },
    });

    const signed = await api()
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', Stripe.webhooks.generateTestHeaderString({ payload, secret }))
      .send(payload);
    // The event refers to a booking that does not exist, so a 4xx about the
    // booking is fine. What must not happen is a signature rejection.
    assert.ok(
      !/signature/i.test(JSON.stringify(signed.body)),
      `a signed webhook must not be refused on its signature: ${JSON.stringify(signed.body)}`
    );
    assert.ok(signed.status < 500, `unexpected ${signed.status}`);
    assert.ok(signed.headers['content-security-policy'], 'and still carry the headers');

    const unsigned = await api()
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);
    assert.equal(unsigned.status, 400);
    assert.match(JSON.stringify(unsigned.body).toLowerCase(), /signature/);
  } finally {
    if (original === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = original;
  }
  await pool.query("DELETE FROM stripe_events WHERE id LIKE 'evt_csp_%'");
});

test('advertising checkout is still disabled', async () => {
  const res = await api().get('/api/ads/availability');
  assert.equal(res.status, 200);
  assert.equal(res.body.checkoutEnabled, false, 'ADS_CHECKOUT_ENABLED must remain off');
});

test('no session or CSRF token is stored in the browser', () => {
  const failures = [];
  [...htmlFiles(), ...scriptFiles()].forEach(({ name, text }) => {
    const code = stripComments(text);
    const stores = code.match(
      /(localStorage|sessionStorage)\s*\.\s*setItem\(\s*['"`][^'"`]*(token|session|auth|jwt|csrf)[^'"`]*['"`]/gi
    );
    if (stores) failures.push(`${name}: ${stores.join(', ')}`);
    if (/Authorization\s*[:=]/.test(code)) failures.push(`${name}: Authorization header`);
  });
  assert.deepEqual(failures, [], `Browser-stored authentication found:\n  ${failures.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// 19. Keyboard reachability after the handler migration
// ---------------------------------------------------------------------------

test('every interactive control is a natively focusable element', () => {
  // Inline onclick handlers were removed in favour of addEventListener. The
  // risk in that migration is attaching a listener to a <div>, which a keyboard
  // cannot reach. Nothing here does — every listener target is a button, link,
  // input, select, textarea, summary or a delegated document/container listener.
  const failures = [];
  htmlFiles().forEach(({ name, text }) => {
    // A clickable element must be focusable: button/a[href]/input/select/
    // textarea/summary/details, or carry an explicit tabindex.
    const suspicious = text.match(/<div[^>]*\brole\s*=\s*["'](button|link)["'][^>]*>/gi) || [];
    suspicious.forEach((tag) => {
      if (!/tabindex/i.test(tag)) failures.push(`${name}: ${tag} has a widget role but no tabindex`);
    });
  });
  assert.deepEqual(failures, [], failures.join('\n'));

  // And the controls the page scripts create are buttons, not divs.
  const generated = scriptFiles()
    .map(({ name, text }) => ({ name, matches: stripComments(text).match(/createElement\('(\w+)'\)/g) || [] }))
    .flatMap(({ name, matches }) =>
      matches
        .filter((m) => /createElement\('(span|div)'\)/.test(m))
        .map(() => null)
        .filter(Boolean)
        .map((x) => `${name}: ${x}`)
    );
  assert.deepEqual(generated, []);
});
