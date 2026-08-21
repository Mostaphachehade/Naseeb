// Accessibility sweep: axe-core over every page, at desktop and mobile.
//
// ---------------------------------------------------------------------------
// What this proves, and what it does not
// ---------------------------------------------------------------------------
//
// axe-core finds a MINORITY of WCAG failures. Published estimates put automated
// coverage somewhere around a third of the success criteria, and the third it
// covers is the mechanical third: a missing label, a contrast ratio, a
// duplicated id. It cannot tell you whether the focus order makes sense, whether
// an error message is useful, or whether a keyboard user can actually finish the
// journey.
//
// So a green run here is a floor, not a conformance claim, and this file says so
// rather than letting a CI tick imply WCAG 2.2 AA. The manual keyboard and
// screen-reader checks that cover the rest — and what could not be verified —
// live in docs/ACCESSIBILITY.md.
//
// Every account is fabricated and every address is @example.test.
//
// Exit codes: 0 no serious or critical violations, 1 otherwise.
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

const AXE = fs.readFileSync(path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const PORT = Number(process.env.A11Y_PORT || 45041);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'a11y-rehearsal-password-123';
const OUT_DIR = path.join(ROOT, '.accessibility');

// The same Chromium the hostile-data harness finds. CI installs one pinned
// build; nothing here downloads a second.
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

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------
//
// `auth` names whose session the page is visited with. A page that redirects
// when signed out is not an accessibility result, it is a redirect, so the
// authenticated pages are visited authenticated.
const PAGES = [
  { file: '404.html', auth: null },
  { file: 'about.html', auth: null },
  { file: 'account.html', auth: 'member' },
  { file: 'admin.html', auth: 'admin' },
  { file: 'advertise.html', auth: null },
  { file: 'claim.html', auth: 'member' },
  { file: 'create.html', auth: 'member' },
  { file: 'dashboard.html', auth: 'member' },
  { file: 'forgot-password.html', auth: null },
  // Visited with a real published campaign. Without `?id=` this page fetches
  // /api/giveaways/undefined, 404s, and renders its error state — so sweeping
  // it bare was measuring the wrong page and calling the result coverage.
  { file: 'giveaway.html', auth: null, query: () => `?id=${encodeURIComponent(seeded.giveawayId)}` },
  { file: 'host-apply.html', auth: 'member' },
  { file: 'index.html', auth: null },
  { file: 'login.html', auth: null },
  { file: 'owner.html', auth: 'admin' },
  { file: 'partners.html', auth: null },
  { file: 'pricing.html', auth: null },
  { file: 'privacy.html', auth: null },
  { file: 'reset-password.html', auth: null },
  { file: 'signup.html', auth: null },
  { file: 'terms.html', auth: null },
  { file: 'verify-email-change.html', auth: null },
  { file: 'verify.html', auth: null },
  { file: 'winners.html', auth: null },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  // 390x844 is the iPhone 12/13/14 logical viewport, and the reflow criterion
  // (1.4.10) is about 320 CSS px at 400% zoom, which this approximates.
  { name: 'mobile', width: 390, height: 844 },
];

const made = { users: [], giveaways: [] };
const seeded = { giveawayId: null };

// A published campaign, so giveaway.html can be swept in the state a visitor
// actually sees rather than in its "no such giveaway" error state.
//
// Published through the API — submit, then approve — rather than by writing the
// row. The first version of this wrote it directly and was refused five times in
// a row: outcome coherence, prize governance, and finally
// giveaways_publication_approved, which requires approved_at and approved_by.
//
// That was the schema making a point worth taking. Publication is reachable ONLY
// through approval, by construction, and a seed that satisfies each constraint
// individually is imitating an approval rather than performing one — it would
// drift the moment a sixth rule appeared, and it would let this harness render a
// campaign the product itself would never publish. Going through the route costs
// two extra calls and cannot lie.
async function seedGiveawayViaApi(memberSession, adminSession) {
  const call = (session, method, url) => request(app)[method](url)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf)
    .set('X-Forwarded-For', '203.0.113.20');

  const attested = await call(memberSession, 'post', '/api/account/eligibility').send({ confirmed: true });
  if (attested.status !== 200) throw new Error(`attestation refused: ${attested.status}`);

  const submitted = await call(memberSession, 'post', '/api/giveaways').send({
    title: 'Accessibility sweep campaign (fabricated)',
    description: 'A fabricated campaign that exists only so the giveaway page can be measured in its real state.',
    prize_description: 'Two nights, fabricated partner hotel.',
    prize_category: 'luxury_stay_or_holiday',
    sponsor_name: 'Accessibility Sweep Partner (fabricated)',
    prize_supplied_by: 'Accessibility Sweep Partner (fabricated)',
    prize_retail_value_aed: 4000,
    naseeb_custody: 'provider_fulfils',
    fulfilment_method: 'Booking arranged by Naseeb with the provider.',
    funded_by: 'Accessibility Sweep Partner (fabricated)',
    max_entries_per_person: 1,
  });
  if (![200, 201].includes(submitted.status)) {
    throw new Error(`submission refused: ${submitted.status} ${JSON.stringify(submitted.body)}`);
  }
  const id = submitted.body.id || (submitted.body.giveaway && submitted.body.giveaway.id);
  if (!id) throw new Error('no giveaway id returned');
  made.giveaways.push(id);

  const approved = await call(adminSession, 'post', `/api/admin/giveaways/${id}/approve`).send({
    evidence_kind: 'booking_reference_held',
    evidence_reference: `A11Y-SWEEP-REF-${crypto.randomBytes(3).toString('hex')}`,
    review_notes: 'Accessibility sweep approval — fabricated prize, fabricated partner.',
  });
  if (![200, 201, 204].includes(approved.status)) {
    throw new Error(`approval refused: ${approved.status} ${JSON.stringify(approved.body)}`);
  }
  return id;
}


async function makeUser({ name, admin }) {
  const id = crypto.randomUUID();
  const email = `a11y-${name}-${crypto.randomBytes(3).toString('hex')}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, $2, $3, $4, TRUE, $5, 'approved')`,
    [id, `A11y ${name}`, email, hash, Boolean(admin)]
  );
  made.users.push(id);
  return { id, email };
}

// Returns the session in both shapes it is needed in: a cookie header for
// supertest calls, the CSRF token those calls must carry, and a Playwright
// cookie for the browser context.
async function sessionFor(email) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);

  const pairs = res.headers['set-cookie'].map((c) => c.split(';')[0]);
  const found = pairs.map((c) => c.split('=')).find(([k]) => k === SESSION_COOKIE);
  if (!found) throw new Error('no session cookie issued');
  const csrf = res.body && res.body.csrf_token;
  if (!csrf) throw new Error('login returned no CSRF token');

  return {
    cookie: pairs.join('; '),
    csrf,
    browserCookie: {
      name: SESSION_COOKIE, value: found.slice(1).join('='), domain: '127.0.0.1', path: '/',
    },
  };
}

async function cleanup() {
  if (!made.users.length) return;
  const u = made.users;
  const safe = async (sql) => { try { await pool.query(sql, [u]); } catch (err) {
    const m = String(err.message || err);
    if (!/relation .* does not exist/i.test(m)) process.stderr.write(`  cleanup warning: ${m}\n`);
  } };
  // The campaign is approved and published, so it carries lifecycle events.
  // Those are append-only and cannot be removed — see the rehearsal harness for
  // the same finding. Delete what can go, in dependency order.
  if (made.giveaways.length) {
    for (const sql of [
      'DELETE FROM entries WHERE giveaway_id = ANY($1)',
      'DELETE FROM giveaway_notifications WHERE giveaway_id = ANY($1)',
      'DELETE FROM giveaways WHERE id = ANY($1)',
    ]) {
      try {
        await pool.query(sql, [made.giveaways]);
      } catch (err) {
        process.stderr.write(`  cleanup warning: ${String(err.message || err)}\n`);
      }
    }
  }
  await safe('DELETE FROM sessions WHERE user_id = ANY($1)');
  await safe('DELETE FROM session_families WHERE user_id = ANY($1)');
  await safe('DELETE FROM policy_acceptances WHERE user_id = ANY($1)');
  await safe('DELETE FROM users WHERE id = ANY($1)');
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const member = await makeUser({ name: 'member', admin: false });
  const admin = await makeUser({ name: 'admin', admin: true });
  const sessions = {
    member: await sessionFor(member.email),
    admin: await sessionFor(admin.email),
  };
  seeded.giveawayId = await seedGiveawayViaApi(sessions.member, sessions.admin);

  const server = app.listen(PORT);
  const browser = await chromium.launch({
    executablePath: resolveChrome(),
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const results = [];
  let serious = 0;
  let moderateOrMinor = 0;

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        // Honour the reduced-motion preference in one of the two passes, so the
        // confetti and the promotional specks are exercised both ways.
        reducedMotion: viewport.name === 'mobile' ? 'reduce' : 'no-preference',
      });

      // axe goes in through addInitScript, NOT addScriptTag.
      //
      // addScriptTag appends a real <script> element, so the page's own Content
      // Security Policy governs it — and this site sends `script-src 'self'`,
      // which refused it outright. That refusal is the CSP working: an attacker
      // who can inject markup cannot run script either. The policy is not
      // relaxed, and no 'unsafe-inline' or hash is added to let a test tool in.
      //
      // addInitScript runs through the debugger channel before page scripts,
      // which is outside the document's CSP by construction. The page under test
      // is therefore observed with its real policy intact, which is the only
      // version worth measuring.
      await context.addInitScript({ content: AXE });

      for (const page of PAGES) {
        if (page.auth) await context.addCookies([sessions[page.auth].browserCookie]);
        const tab = await context.newPage();
        const consoleErrors = [];
        tab.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400)); });
        tab.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));

        try {
          await tab.goto(`${BASE}/${page.file}${page.query ? page.query() : ''}`, { waitUntil: 'networkidle', timeout: 20000 });
        } catch {
          await tab.goto(`${BASE}/${page.file}${page.query ? page.query() : ''}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }

        const run = await tab.evaluate(async () => {
          if (!window.axe) throw new Error("axe was not injected into this page");
          // WCAG 2.2 AA and the best-practice rules. `axe.run` resolves with
          // violations grouped by impact.
          const r = await window.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
          });
          return r.violations.map((v) => ({
            id: v.id, impact: v.impact, help: v.help,
            nodes: v.nodes.length,
            sample: v.nodes.slice(0, 2).map((n) => String(n.target).slice(0, 120)),
          }));
        });

        run.forEach((v) => {
          if (v.impact === 'serious' || v.impact === 'critical') serious += 1;
          else moderateOrMinor += 1;
        });

        results.push({ page: page.file, viewport: viewport.name, auth: page.auth, violations: run, consoleErrors });
        const mark = run.some((v) => ['serious', 'critical'].includes(v.impact)) ? 'FAIL' : (run.length ? 'warn' : 'ok  ');
        process.stderr.write(
          `  ${mark} ${viewport.name.padEnd(7)} ${page.file.padEnd(26)} ${run.length} violation(s)`
          + `${consoleErrors.length ? ` · ${consoleErrors.length} console error(s)` : ''}\n`
        );
        run.forEach((v) => process.stderr.write(`         ${String(v.impact).padEnd(8)} ${v.id} — ${v.help} (${v.nodes})\n`));

        await tab.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'axe-report.json'), `${JSON.stringify(results, null, 2)}\n`);

  // Aggregate by rule, because "37 violations" across 46 page-viewport pairs is
  // usually five rules repeated, and the rules are what get fixed.
  const byRule = new Map();
  results.forEach((r) => r.violations.forEach((v) => {
    const e = byRule.get(v.id) || { id: v.id, impact: v.impact, help: v.help, pages: new Set(), nodes: 0, samples: [] };
    e.pages.add(r.page); e.nodes += v.nodes;
    (v.sample || []).forEach((s2) => { if (!e.samples.includes(s2)) e.samples.push(s2); });
    byRule.set(v.id, e);
  }));

  process.stderr.write('\nBy rule\n\n');
  [...byRule.values()]
    .sort((a, b) => b.nodes - a.nodes)
    .forEach((e) => {
      process.stderr.write(
        `  ${String(e.impact).padEnd(8)} ${e.id.padEnd(30)} ${String(e.nodes).padStart(4)} node(s) across ${e.pages.size} page(s)\n`
      );
      process.stderr.write(`           pages: ${[...e.pages].sort().join(', ')}\n`);
      // The selectors are the whole point: a rule name says what is wrong, a
      // selector says where. Without these the report cannot be acted on.
      (e.samples || []).slice(0, 4).forEach((s) => process.stderr.write(`           at: ${s}\n`));
      process.stderr.write('\n');
    });

  // Distinct console errors, with counts. A total on its own is not evidence of
  // anything — "94 console errors" could be one bug on every page or ninety-four
  // different ones, and those need very different responses.
  const consoleByText = new Map();
  results.forEach((r) => r.consoleErrors.forEach((e) => {
    const entry = consoleByText.get(e) || { text: e, count: 0, pages: new Set() };
    entry.count += 1; entry.pages.add(r.page); consoleByText.set(e, entry);
  }));
  if (consoleByText.size) {
    process.stderr.write('\nConsole errors, distinct\n\n');
    [...consoleByText.values()]
      .sort((a, b) => b.count - a.count)
      .forEach((e) => process.stderr.write(
        `  ${String(e.count).padStart(3)}x on ${String(e.pages.size).padStart(2)} page(s)  ${e.text}\n`
      ));
  }

  const consoleTotal = results.reduce((n, r) => n + r.consoleErrors.length, 0);
  process.stderr.write(
    `\n  ${results.length} page-viewport pairs, ${serious} serious/critical, ${moderateOrMinor} moderate/minor,`
    + ` ${consoleTotal} console error(s).\n`
    + '  axe-core covers a minority of WCAG criteria. See docs/ACCESSIBILITY.md for the manual checks.\n\n'
  );

  process.stdout.write(`${JSON.stringify({
    suite: 'accessibility',
    ok: serious === 0,
    pairs: results.length,
    serious_or_critical: serious,
    moderate_or_minor: moderateOrMinor,
    console_errors: consoleTotal,
    rules: [...byRule.values()].map((e) => ({ id: e.id, impact: e.impact, nodes: e.nodes, pages: [...e.pages] })),
  }, null, 2)}\n`);

  return serious === 0;
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
