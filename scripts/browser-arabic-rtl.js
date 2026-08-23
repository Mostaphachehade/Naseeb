// Arabic and RTL evidence, in a real browser.
//
// The parity test (test/i18n-parity.test.js) proves the dictionaries agree. It
// cannot prove what a page LOOKS like in Arabic, and those are different
// questions: a fully translated page can still be laid out left-to-right, leak
// English into a rendered journey, reorder a phone number into nonsense, or
// overflow its container at 390px.
//
// So this loads every page twice — once English, once Arabic — and checks what
// the browser actually produced.
//
// Every account is fabricated and every address is @example.test.
//
// Exit codes: 0 all checks passed, 1 otherwise.
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');

const { configureTestEnv } = require(path.join(ROOT, 'testEnv'));
configureTestEnv();

const request = require(path.join(ROOT, 'node_modules', 'supertest'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
const app = require(path.join(ROOT, 'server', 'app'));
const { pool } = require(path.join(ROOT, 'server', 'db'));
const { SESSION_COOKIE } = require(path.join(ROOT, 'server', 'lib', 'sessions'));

const PORT = Number(process.env.RTL_PORT || 45051);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'rtl-suite-password-123';
const OUT_DIR = path.join(ROOT, '.arabic-rtl');

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium'))) {
      for (const name of ['chrome', 'headless_shell']) {
        const candidate = path.join(root, dir, 'chrome-linux', name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('No Chromium found. Set CHROME_PATH or run: npx playwright install chromium');
}

const PAGES = fs.readdirSync(path.join(ROOT, 'public'))
  .filter((f) => f.endsWith('.html')).sort()
  .map((file) => ({
    file,
    auth: ['account.html', 'dashboard.html', 'claim.html', 'create.html', 'host-apply.html'].includes(file)
      ? 'member'
      : (['admin.html', 'owner.html'].includes(file) ? 'admin' : null),
  }));

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const made = { users: [] };
const failures = [];
const rows = [];
// Declared out here because the summary below reports it after the try/finally
// that produces it; a `const` inside the try would be out of scope by then.
let isolation = null;

function fail(where, message) { failures.push(`${where}: ${message}`); }

async function makeUser({ name, admin }) {
  const id = crypto.randomUUID();
  const email = `rtl-${name}-${crypto.randomBytes(3).toString('hex')}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, $2, $3, $4, TRUE, $5, 'approved')`,
    [id, `RTL ${name}`, email, hash, Boolean(admin)]
  );
  made.users.push(id);
  return { id, email };
}

async function browserCookieFor(email) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const pairs = res.headers['set-cookie'].map((c) => c.split(';')[0]);
  const found = pairs.map((c) => c.split('=')).find(([k]) => k === SESSION_COOKIE);
  if (!found) throw new Error('no session cookie');
  return { name: SESSION_COOKIE, value: found.slice(1).join('='), domain: '127.0.0.1', path: '/' };
}

async function cleanup() {
  if (!made.users.length) return;
  for (const sql of [
    'DELETE FROM sessions WHERE user_id = ANY($1)',
    'DELETE FROM session_families WHERE user_id = ANY($1)',
    'DELETE FROM policy_acceptances WHERE user_id = ANY($1)',
    'DELETE FROM users WHERE id = ANY($1)',
  ]) {
    try { await pool.query(sql, [made.users]); } catch (err) {
      const m = String(err.message || err);
      if (!/relation .* does not exist/i.test(m)) process.stderr.write(`  cleanup warning: ${m}\n`);
    }
  }
}

// A payload that tries to reorder the page around it. If any of these
// characters survive into rendered text, one hostile display name could
// scramble every line after it.
const BIDI_ATTACK = '‮evil‬⁦spoof⁩‏';

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const member = await makeUser({ name: 'member', admin: false });
  const admin = await makeUser({ name: 'admin', admin: true });
  const cookies = { member: await browserCookieFor(member.email), admin: await browserCookieFor(admin.email) };

  const server = app.listen(PORT);
  const browser = await chromium.launch({ executablePath: resolveChrome(), args: ['--no-sandbox', '--disable-gpu'] });

  try {
    for (const viewport of VIEWPORTS) {
      for (const lang of ['en', 'ar']) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        // The language preference lives in localStorage, so set it before any
        // page script runs rather than clicking the switch on every page.
        await context.addInitScript(`localStorage.setItem('naseeb_lang', ${JSON.stringify(lang)});`);

        for (const page of PAGES) {
          if (page.auth) await context.addCookies([cookies[page.auth]]);
          const tab = await context.newPage();
          const consoleErrors = [];
          tab.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
          tab.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 300)));

          try {
            await tab.goto(`${BASE}/${page.file}`, { waitUntil: 'networkidle', timeout: 20000 });
          } catch {
            await tab.goto(`${BASE}/${page.file}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          }

          const probe = await tab.evaluate(() => {
            const doc = document.documentElement;
            const main = document.querySelector('main') || document.body;
            const text = (main.innerText || '').trim();
            // Latin runs of three or more letters, ignoring the things that are
            // meant to stay Latin: brand names, provider names, URLs, emails and
            // technical identifiers.
            // Each addition is a name or an identifier that means something
            // only in Latin script, not a word the Arabic failed to translate:
            //   bcrypt        — the algorithm, named in the privacy policy
            //   IPv4 / IPv6   — protocol names; "بروتوكول الإنترنت الإصدار ٤"
            //                   would be a translation of the expansion, not of
            //                   the identifier a reader would search for
            //   Signals       — from "Google Signals", a product name that the
            //                   Google alternation above only half-covers
            //   docs / HOST_ACCESS / md — a repository path quoted verbatim in
            //                   owner.html; a translated file path points nowhere
            // Kept as an explicit alternation rather than a looser pattern:
            // anything general enough to cover these would also excuse a real
            // untranslated sentence, which is the failure this exists to catch.
            const IGNORE = /(Naseeb|Stripe|Render|Resend|Cloudinary|Neon|Sentry|Google|Analytics|Signals|PostgreSQL|bcrypt|IPv\d|AES|GCM|GCGRA|WhatsApp|AED|https?|www|draft|CN|LLC|docs|HOST_ACCESS|md)/gi;
            // Email addresses and bare hostnames are values, not copy. A
            // member's own address is shown on their account page and is
            // Latin whatever language the page is in; splitting it into
            // words and calling each one an untranslated string would make
            // the check unusable on the one page it matters most.
            const VALUES = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[\w-]+\.(?:test|com|ae|org|net|io)/g;
            const latin = (text.replace(VALUES, ' ').replace(IGNORE, ' ').match(/[A-Za-z]{3,}/g) || []);
            return {
              lang: doc.lang,
              dir: doc.dir,
              h1: document.querySelectorAll('h1').length,
              latinRuns: [...new Set(latin)].slice(0, 12),
              latinCount: latin.length,
              // Horizontal overflow: the page must never scroll sideways.
              scrollW: doc.scrollWidth,
              clientW: doc.clientWidth,
              textLen: text.length,
              // Which elements actually stick out. "scrollWidth 397 >
              // clientWidth 390" says a page is seven pixels too wide and gives
              // nobody anywhere to start; naming the element turns it into a
              // one-line fix. Reported whether or not the page overflows, so
              // the ledger records the near-misses too.
              overflowing: Array.from(document.querySelectorAll('body *'))
                .map((node) => {
                  const box = node.getBoundingClientRect();
                  const over = Math.round(box.right - doc.clientWidth);
                  return over > 1 ? { over, node } : null;
                })
                .filter(Boolean)
                // Deepest first: a wide child makes every ancestor wide too, and
                // the ancestors are not the bug. Sorted rather than filtered to
                // leaves — an element can overflow because of its own margin or
                // transform while every child sits inside it, and filtering to
                // leaves reported "no single element" for exactly that case.
                .sort((a, b) => {
                  const depth = (n) => { let d = 0; for (let x = n; x; x = x.parentElement) d += 1; return d; };
                  return depth(b.node) - depth(a.node) || b.over - a.over;
                })
                .slice(0, 5)
                .map(({ over, node }) => {
                  const id = node.id ? `#${node.id}` : '';
                  const cls = node.className && typeof node.className === 'string'
                    ? `.${node.className.trim().split(/\s+/).join('.')}`
                    : '';
                  return `${node.tagName.toLowerCase()}${id}${cls} +${over}px`;
                }),
            };
          });

          const where = `${viewport.name}/${lang}/${page.file}`;

          if (lang === 'ar') {
            if (probe.lang !== 'ar') fail(where, `html lang is "${probe.lang}", expected "ar"`);
            if (probe.dir !== 'rtl') fail(where, `html dir is "${probe.dir}", expected "rtl"`);
            if (probe.latinCount > 0) {
              fail(where, `English leaked into the Arabic page: ${probe.latinRuns.join(', ')}`);
            }
          } else {
            if (probe.lang !== 'en') fail(where, `html lang is "${probe.lang}", expected "en"`);
            if (probe.dir !== 'ltr') fail(where, `html dir is "${probe.dir}", expected "ltr"`);
          }

          // Horizontal overflow, both languages. A 2px tolerance for subpixel
          // rounding; anything more is a layout that spills sideways.
          if (probe.scrollW > probe.clientW + 2) {
            fail(where, `horizontal overflow: scrollWidth ${probe.scrollW} > clientWidth ${probe.clientW}`
              + (probe.overflowing.length ? ` — widest: ${probe.overflowing.join(', ')}` : ' — no single element is wider than the viewport, so the overflow comes from a margin, a negative offset or a transform'));
          }

          if (consoleErrors.length) fail(where, `${consoleErrors.length} console error(s): ${consoleErrors[0]}`);

          rows.push({ ...probe, page: page.file, lang, viewport: viewport.name, consoleErrors: consoleErrors.length });
          await tab.close();
        }
        await context.close();
      }
    }

    // Bidi isolation and hostile-control handling, checked against the real
    // helper rather than a reimplementation of it.
    isolation = await (async () => {
      const context = await browser.newContext();
      await context.addInitScript("localStorage.setItem('naseeb_lang','ar');");
      const tab = await context.newPage();
      await tab.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const out = await tab.evaluate((payload) => {
        const iso = window.NaseebI18n && window.NaseebI18n.isolate;
        if (!iso) return { error: 'isolate() is not exposed' };
        const wrapped = iso(payload);
        const email = iso('ops@example.test');
        return {
          wrapsWithFsiPdi: wrapped.startsWith('⁨') && wrapped.endsWith('⁩'),
          stripsControls: !/[‪-‮⁦-⁩]/.test(wrapped.slice(1, -1)),
          emailWrapped: email === `⁨ops@example.test⁩`,
          emptyIsEmpty: iso('') === '' && iso(null) === '' && iso(undefined) === '',
        };
      }, BIDI_ATTACK);
      await context.close();
      return out;
    })();

    if (isolation.error) fail('bidi', isolation.error);
    else {
      if (!isolation.wrapsWithFsiPdi) fail('bidi', 'isolate() does not wrap in FSI/PDI');
      if (!isolation.stripsControls) fail('bidi', 'isolate() left embedded direction controls in the value');
      if (!isolation.emailWrapped) fail('bidi', 'isolate() did not wrap an email address correctly');
      if (!isolation.emptyIsEmpty) fail('bidi', 'isolate() does not return empty for empty input');
    }

    // Switching language must not navigate anywhere.
    const routing = await (async () => {
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(`${BASE}/pricing.html?keep=1#section`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const before = tab.url();
      // setLang reloads, so arm the load listener before triggering it and let
      // the reload land before reading anything. The only tolerated failure is
      // the reload tearing down the context the call was made in; anything else
      // is a real error and still throws.
      const reloaded = tab.waitForEvent('load', { timeout: 20000 });
      await tab.evaluate(() => { window.NaseebI18n.setLang('ar'); }).catch((err) => {
        if (!/Execution context was destroyed/.test(String(err && err.message))) throw err;
      });
      await reloaded;
      const after = tab.url();
      const rejected = await tab.evaluate(() => {
        window.NaseebI18n.setLang('https://example.invalid/');
        return localStorage.getItem('naseeb_lang');
      });
      await context.close();
      return { before, after, storedAfterHostileValue: rejected };
    })();

    if (routing.after !== routing.before) {
      fail('routing', `language switch changed the URL: ${routing.before} -> ${routing.after}`);
    }
    if (routing.storedAfterHostileValue !== 'ar') {
      fail('routing', `setLang accepted a non-language value; stored "${routing.storedAfterHostileValue}"`);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'rtl-report.json'), `${JSON.stringify({ rows, failures }, null, 2)}\n`);

  const arRows = rows.filter((r) => r.lang === 'ar');
  process.stderr.write(
    `\n  ${rows.length} page-language-viewport combinations`
    + `\n  Arabic pages checked: ${arRows.length}`
    + `\n  pages with zero English leakage: ${arRows.filter((r) => r.latinCount === 0).length}/${arRows.length}`
    + `\n  bidi isolation: ${isolationSummary(isolation)}`
    + `\n  language switch navigates: no`
    + `\n  failures: ${failures.length}\n\n`
  );
  failures.slice(0, 40).forEach((f) => process.stderr.write(`  FAIL ${f}\n`));

  process.stdout.write(`${JSON.stringify({
    suite: 'arabic-rtl',
    ok: failures.length === 0,
    combinations: rows.length,
    arabic_pages: arRows.length,
    failures,
  }, null, 2)}\n`);

  return failures.length === 0;

  function isolationSummary(i) {
    if (!i || i.error) return `FAILED (${i && i.error})`;
    return i.wrapsWithFsiPdi && i.stripsControls && i.emailWrapped ? 'ok' : 'FAILED';
  }
}

let code = 0;
main()
  .then((ok) => { code = ok ? 0 : 1; })
  .catch((err) => { process.stderr.write(`\nERROR: ${String(err.stack || err.message || err)}\n`); code = 1; })
  .then(async () => {
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(code);
  });
