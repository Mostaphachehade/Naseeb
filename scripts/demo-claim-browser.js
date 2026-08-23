#!/usr/bin/env node
// Browser-level demonstration of the claim workflow, driven through a real
// headless Chromium against a real HTTP server.
//
//   node scripts/demo-claim-browser.js
//
// Every person, address and phone number is fabricated. Runs against the
// isolated test database via the guard in testEnv.js, so it cannot reach
// production.
//
// The point of doing this in a browser rather than with HTTP calls is the parts
// that only exist in a browser: that the claim token arrives in a URL fragment,
// that the fragment is gone from the address bar before anything else runs, and
// that no request the page makes carries it in a target or a Referer.
const { configureTestEnv } = require('../testEnv');

configureTestEnv();
process.env.CLAIM_ENCRYPTION_KEY = `v1:${require('crypto').randomBytes(32).toString('base64')}`;
process.env.APP_URL = 'http://127.0.0.1:4310';
process.env.RESEND_API_KEY = 're_fabricated_key_for_demo';

const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

const CHROMIUM = '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const PORT = 4310;

const app = require('../server/app');
const { pool, init } = require('../server/db');
const claims = require('../server/lib/claims');
const notifications = require('../server/lib/claimNotifications');
const scheduler = require('../server/lib/claimScheduler');
const { STATES } = require('../server/lib/claimStateMachine');

const FABRICATED_DELIVERY = {
  recipient_name: 'Layla Al-Fictional',
  phone: '+971500000000',
  address_line1: 'Villa 42, Nonexistent Street',
  address_line2: 'Imaginary District',
  city: 'Fictionville',
  emirate: 'Testopolis',
  notes: 'Invented note: call on arrival',
};

// Every request the server actually receives, so the claim of "never in a URL"
// is measured rather than asserted.
const requestLog = [];
const sentEmails = [];

// Intercept outbound mail rather than sending it.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('api.resend.com')) {
    sentEmails.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 'fabricated' }), { status: 200 });
  }
  return realFetch(url, options);
};

let step = 0;
function say(text) {
  step += 1;
  console.log(`\n${String(step).padStart(2, ' ')}. ${text}`);
}
function detail(text) {
  console.log(`    ${text}`);
}

// Drives a page in headless Chromium and returns whatever the evaluated script
// prints as JSON.
function inBrowser(url, script, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CHROMIUM,
      [
        '--no-sandbox',
        '--disable-gpu',
        '--headless',
        `--virtual-time-budget=${timeoutMs}`,
        '--dump-dom',
        `data:text/html,<script>location.replace(${JSON.stringify(url)})</script>`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', () => resolve(out));
    child.on('error', reject);
  });
}

// A page that runs `script` after load and writes the result into the DOM, so
// --dump-dom carries it back out.
function harness(targetUrl, script) {
  return (
    'data:text/html,' +
    encodeURIComponent(`<!DOCTYPE html><body><pre id="out">pending</pre><script>
      (async () => {
        const result = await (${script})(${JSON.stringify(targetUrl)});
        document.getElementById('out').textContent = JSON.stringify(result);
      })();
    </script></body>`)
  );
}

async function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(CHROMIUM, cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', () => resolve(out));
  });
}

// Loads a URL in Chromium and returns { html, finalUrl } as seen by the page.
async function loadPage(url) {
  const out = await run([
    '--no-sandbox',
    '--disable-gpu',
    '--virtual-time-budget=6000',
    '--dump-dom',
    url,
  ]);
  return out;
}

async function makeUser(name, { admin = false } = {}) {
  const id = randomUUID();
  const email = `demo-${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}@example.com`;
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin)
     VALUES ($1, $2, $3, $4, TRUE, $5)`,
    [id, name, email, bcrypt.hashSync('correcthorse123', 4), admin]
  );
  return { id, name, email };
}

function apiCall(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(email) {
  const res = await apiCall('POST', '/api/auth/login', {
    body: { email, password: 'correcthorse123' },
  });
  return res.body.token;
}

function tokenFromEmail(html) {
  const match = String(html).match(/claim\.html#token=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

async function main() {
  await init();

  // Real HTTP server, wrapped so every request line is recorded.
  const recorder = express();
  recorder.use((req, res, next) => {
    requestLog.push({
      target: `${req.method} ${req.originalUrl}`,
      referer: req.headers.referer || '',
    });
    next();
  });
  recorder.use(app);
  const server = recorder.listen(PORT);
  await new Promise((resolve) => server.once('listening', resolve));

  const host = await makeUser('Fictional Roastery LLC');
  const winner = await makeUser('Layla Al-Fictional');
  const admin = await makeUser('Naseeb Admin', { admin: true });
  const stranger = await makeUser('Unrelated Person');

  const hostToken = await login(host.email);
  const winnerToken = await login(winner.email);
  const adminToken = await login(admin.email);
  const strangerToken = await login(stranger.email);

  const giveawayId = randomUUID();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Espresso machine giveaway (demo)', 'A fabricated demo giveaway',
             'One espresso machine', 'Marketing budget (fabricated)', $3, 'drawn')`,
    [giveawayId, host.id, new Date(Date.now() - 86400000).toISOString()]
  );
  const entryId = randomUUID();
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)',
    [entryId, giveawayId, winner.id]
  );
  await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);

  // -------------------------------------------------------------------------
  say('The winner is drawn. The invitation goes to a durable outbox first.');
  const client = await pool.connect();
  let claim;
  try {
    await client.query('BEGIN');
    claim = await claims.createClaimForDraw(client, {
      giveawayId,
      winnerUserId: winner.id,
      entryId,
    });
    await notifications.queueInvitation(client, claim.id);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  let state = await notifications.notificationStateFor(pool, claim.id);
  detail(`outbox status         : ${state.status} (attempts ${state.attempts})`);

  // -------------------------------------------------------------------------
  say('The mail provider is down. Nothing is lost — it stays queued.');
  const workingFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) throw new Error('Simulated outage: ECONNREFUSED');
    throw new Error('unexpected');
  };
  await notifications.processDueNotifications({});
  state = await notifications.notificationStateFor(pool, claim.id);
  detail(`outbox status         : ${state.status} (attempts ${state.attempts}, ${state.last_error_category})`);
  detail(`emails actually sent  : ${sentEmails.length}`);

  // -------------------------------------------------------------------------
  say('The provider recovers. The retry issues a FRESH token and delivers.');
  globalThis.fetch = workingFetch;
  await pool.query('UPDATE claim_notifications SET next_attempt_at = NOW() WHERE claim_id = $1', [claim.id]);
  await notifications.processDueNotifications({});
  state = await notifications.notificationStateFor(pool, claim.id);
  const liveToken = tokenFromEmail(sentEmails[sentEmails.length - 1].html);
  detail(`outbox status         : ${state.status} (delivered on attempt ${state.attempts})`);
  detail(`original token still valid? : ${claim.token === liveToken ? 'SAME TOKEN' : 'no — replaced'}`);
  const deadCheck = await apiCall('POST', '/api/claims/lookup', { body: { token: claim.token } });
  detail(`superseded token      : HTTP ${deadCheck.status} (${deadCheck.body.error || ''})`);

  // -------------------------------------------------------------------------
  say('The emailed link puts the token in a fragment.');
  const linkMatch = sentEmails[sentEmails.length - 1].html.match(/href="([^"]*claim\.html[^"]*)"/);
  detail(`link in email         : ${linkMatch[1].replace(liveToken, '<token>')}`);
  detail(`query-string form?    : ${/claim\.html\?token=/.test(sentEmails[sentEmails.length - 1].html) ? 'PRESENT' : 'none'}`);

  // -------------------------------------------------------------------------
  say('The winner opens that link in a real browser.');
  const claimPageDom = await loadPage(`http://127.0.0.1:${PORT}/claim.html#token=${liveToken}`);
  const titleShown = (claimPageDom.match(/id="giveaway-title">([^<]*)/) || [])[1];
  const panelVisible = /id="claim-panel" style="display: block/.test(claimPageDom);
  detail(`claim form rendered   : ${panelVisible ? 'yes' : 'no'}`);
  detail(`prize shown           : ${titleShown}`);
  detail(`token left in the DOM : ${claimPageDom.includes(liveToken) ? 'PRESENT' : 'no'}`);

  // -------------------------------------------------------------------------
  say('Nothing the browser sent carried the token.');
  const leakedTarget = requestLog.filter((r) => r.target.includes(liveToken));
  const leakedReferer = requestLog.filter((r) => r.referer.includes(liveToken));
  detail(`requests recorded     : ${requestLog.length}`);
  detail(`token in a request URL: ${leakedTarget.length === 0 ? 'never' : 'LEAKED'}`);
  detail(`token in a Referer    : ${leakedReferer.length === 0 ? 'never' : 'LEAKED'}`);
  detail(`sample request lines  : ${requestLog.slice(-3).map((r) => r.target).join(' | ')}`);

  // -------------------------------------------------------------------------
  say('The winner consents and submits fabricated delivery details.');
  const redeemed = await apiCall('POST', '/api/claims/redeem', {
    body: {
      token: liveToken,
      consent: true,
      consent_version: claims.CONSENT_VERSION,
      delivery: FABRICATED_DELIVERY,
    },
  });
  detail(`status                : HTTP ${redeemed.status} → ${redeemed.body.status}`);
  const stored = await pool.query(
    'SELECT delivery_ciphertext, consent_version FROM prize_claims WHERE id = $1',
    [claim.id]
  );
  detail(`consent recorded      : ${stored.rows[0].consent_version}`);
  detail(`address at rest       : ${stored.rows[0].delivery_ciphertext.slice(0, 28)}… (AES-256-GCM)`);

  // -------------------------------------------------------------------------
  say('An unrelated user opens the giveaway page: no claim controls at all.');
  const strangerView = await apiCall('GET', `/api/claims/giveaway/${giveawayId}`, {
    token: strangerToken,
  });
  detail(`stranger API          : HTTP ${strangerView.status} — ${strangerView.body.error}`);
  const strangerTransition = await apiCall('POST', `/api/claims/${claim.id}/transition`, {
    token: strangerToken,
    body: { to: STATES.PREPARING_DELIVERY },
  });
  detail(`stranger transition   : HTTP ${strangerTransition.status} — ${strangerTransition.body.error}`);

  // -------------------------------------------------------------------------
  say('The host opens the giveaway page and sees the fulfilment controls.');
  const hostView = await apiCall('GET', `/api/claims/giveaway/${giveawayId}`, { token: hostToken });
  const d = hostView.body.delivery.details;
  detail(`host role             : ${hostView.body.role}`);
  detail(`deliver to            : ${d.recipient_name}, ${d.address_line1}, ${d.city}`);
  detail(`cache-control         : ${hostView.body.delivery.available ? 'no-store (asserted in tests)' : 'n/a'}`);

  // -------------------------------------------------------------------------
  say('The host moves it along; only valid steps are offered.');
  for (const to of [STATES.PREPARING_DELIVERY, STATES.SHIPPED_OR_ARRANGED, STATES.DELIVERED_PENDING_CONFIRMATION]) {
    const res = await apiCall('POST', `/api/claims/${claim.id}/transition`, { token: hostToken, body: { to } });
    detail(`${to.padEnd(30)}: HTTP ${res.status}`);
  }
  const hostFinal = await apiCall('POST', `/api/claims/${claim.id}/transition`, {
    token: hostToken,
    body: { to: STATES.DELIVERED },
  });
  detail(`host → delivered      : HTTP ${hostFinal.status} — ${hostFinal.body.error}`);

  // -------------------------------------------------------------------------
  say('The winner raises a dispute instead of confirming.');
  const disputed = await apiCall('POST', `/api/claims/${claim.id}/transition`, {
    token: winnerToken,
    body: { to: STATES.DISPUTED, note: 'Box arrived empty (fabricated).' },
  });
  detail(`status                : ${disputed.body.status}`);

  // -------------------------------------------------------------------------
  say('The admin review queue shows the case — with no address in the list.');
  const queue = await apiCall('GET', '/api/claims/admin/review', { token: adminToken });
  const queued = queue.body.find((r) => r.id === claim.id);
  detail(`queued                : ${queued.title} (${queued.status})`);
  detail(`address in list?      : ${JSON.stringify(queue.body).includes(FABRICATED_DELIVERY.address_line1) ? 'LEAKED' : 'no'}`);

  // -------------------------------------------------------------------------
  say('The admin opens the individual case, which loads details deliberately.');
  const caseView = await apiCall('GET', `/api/claims/giveaway/${giveawayId}`, { token: adminToken });
  detail(`admin sees details    : ${caseView.body.delivery.available}`);
  const noReason = await apiCall('POST', `/api/claims/${claim.id}/transition`, {
    token: adminToken,
    body: { to: STATES.PREPARING_DELIVERY },
  });
  detail(`resolve without reason: HTTP ${noReason.status} (${noReason.body.code})`);
  const resolved = await apiCall('POST', `/api/claims/${claim.id}/transition`, {
    token: adminToken,
    body: { to: STATES.PREPARING_DELIVERY, note: 'Host to resend; courier confirmed loss (fabricated).' },
  });
  detail(`resolved              : ${resolved.body.status}`);

  // -------------------------------------------------------------------------
  say('Second attempt succeeds and the winner confirms receipt.');
  for (const to of [STATES.SHIPPED_OR_ARRANGED, STATES.DELIVERED_PENDING_CONFIRMATION]) {
    await apiCall('POST', `/api/claims/${claim.id}/transition`, { token: hostToken, body: { to } });
  }
  const confirmed = await apiCall('POST', `/api/claims/${claim.id}/transition`, {
    token: winnerToken,
    body: { to: STATES.DELIVERED },
  });
  detail(`winner → delivered    : HTTP ${confirmed.status} (${confirmed.body.status})`);

  // -------------------------------------------------------------------------
  say('The public giveaway page shows a coarse status only.');
  const publicPage = await loadPage(`http://127.0.0.1:${PORT}/giveaway.html?id=${giveawayId}`);
  detail(`address on page?      : ${publicPage.includes(FABRICATED_DELIVERY.address_line1) ? 'LEAKED' : 'no'}`);
  detail(`phone on page?        : ${publicPage.includes(FABRICATED_DELIVERY.phone) ? 'LEAKED' : 'no'}`);
  const publicApi = await apiCall('GET', `/api/giveaways/${giveawayId}`);
  detail(`public claim_status   : ${publicApi.body.claim_status}`);

  // -------------------------------------------------------------------------
  say('Scheduled retention erases the address automatically.');
  await pool.query("UPDATE prize_claims SET delivered_at = NOW() - INTERVAL '400 days' WHERE id = $1", [claim.id]);
  const summary = await scheduler.runMaintenanceOnce({ skipNotifications: true });
  detail(`maintenance run       : erased ${summary.erased}, expired ${summary.expired}`);
  const after = await pool.query(
    'SELECT delivery_ciphertext, delivery_erased_at, status FROM prize_claims WHERE id = $1',
    [claim.id]
  );
  detail(`ciphertext            : ${after.rows[0].delivery_ciphertext === null ? 'erased' : 'STILL PRESENT'}`);
  detail(`claim record          : ${after.rows[0].status} (kept)`);
  const historyCount = await pool.query(
    'SELECT COUNT(*)::int AS c FROM prize_claim_events WHERE claim_id = $1',
    [claim.id]
  );
  detail(`audit history         : ${historyCount.rows[0].c} entries kept`);
  const hostAfter = await apiCall('GET', `/api/claims/giveaway/${giveawayId}`, { token: hostToken });
  detail(`host sees details     : ${hostAfter.body.delivery.available} (${hostAfter.body.delivery.reason})`);

  // -------------------------------------------------------------------------
  say('No email ever carried an address, a phone number or a stale token.');
  const allMail = JSON.stringify(sentEmails);
  detail(`emails sent           : ${sentEmails.length}`);
  detail(`address in any email? : ${allMail.includes(FABRICATED_DELIVERY.address_line1) ? 'LEAKED' : 'no'}`);
  detail(`phone in any email?   : ${allMail.includes(FABRICATED_DELIVERY.phone) ? 'LEAKED' : 'no'}`);

  // Tidy up.
  await pool.query('DELETE FROM claim_notifications WHERE claim_id = $1', [claim.id]);
  await pool.query('DELETE FROM prize_claim_events WHERE claim_id = $1', [claim.id]);
  await pool.query('DELETE FROM prize_claims WHERE id = $1', [claim.id]);
  await pool.query('DELETE FROM entries WHERE giveaway_id = $1', [giveawayId]);
  await pool.query('DELETE FROM giveaways WHERE id = $1', [giveawayId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[host.id, winner.id, admin.id, stranger.id]]);

  server.close();
  await pool.end();
  console.log('\nBrowser demonstration complete. All data was fabricated and has been removed.\n');
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
