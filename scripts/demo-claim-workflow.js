#!/usr/bin/env node
// End-to-end demonstration of the prize claim workflow, against the isolated
// test database. Every person, address and phone number here is invented.
//
//   node scripts/demo-claim-workflow.js
//
// Goes through the guard in testEnv.js, so it cannot touch production.
const { configureTestEnv } = require('../testEnv');

configureTestEnv();
process.env.CLAIM_ENCRYPTION_KEY = `v1:${require('crypto').randomBytes(32).toString('base64')}`;

const request = require('supertest');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const app = require('../server/app');
const { pool, init } = require('../server/db');
const claims = require('../server/lib/claims');
const { STATES } = require('../server/lib/claimStateMachine');

const api = () => request(app);

// The dev email logger prints whole HTML bodies, which would bury the
// demonstration. Emails still go through the real path — this only quietens the
// transcript. (Claim invitations are suppressed by the mailer itself: their
// body carries a working single-use link.)
const realLog = console.log;
const emailLog = [];
let quietEmails = false;
console.log = (...args) => {
  const line = args.join(' ');
  if (quietEmails && line.startsWith('[email:dev]')) {
    emailLog.push(line);
    return;
  }
  if (quietEmails && line.startsWith('<!DOCTYPE html>')) {
    emailLog.push(line);
    return;
  }
  realLog(...args);
};
quietEmails = true;
const FABRICATED_DELIVERY = {
  recipient_name: 'Layla Al-Fictional',
  phone: '+971 50 000 0000',
  address_line1: 'Villa 42, Nonexistent Street',
  address_line2: 'Imaginary District',
  city: 'Fictionville',
  emirate: 'Testopolis',
  notes: 'Invented note: call on arrival',
};

let step = 0;
function say(text) {
  step += 1;
  console.log(`\n${String(step).padStart(2, ' ')}. ${text}`);
}
function detail(text) {
  console.log(`    ${text}`);
}

async function makeUser(name, { admin = false } = {}) {
  const id = uuid();
  const email = `demo-${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}@example.com`;
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin)
     VALUES ($1, $2, $3, $4, TRUE, $5)`,
    [id, name, email, bcrypt.hashSync('correcthorse123', 4), admin]
  );
  const login = await api().post('/api/auth/login').send({ email, password: 'correcthorse123' });
  return { id, name, email, token: login.body.token };
}

async function main() {
  await init();

  const host = await makeUser('Fictional Roastery LLC');
  const winner = await makeUser('Layla Al-Fictional');
  const admin = await makeUser('Naseeb Admin', { admin: true });
  const stranger = await makeUser('Unrelated Person');

  const giveawayId = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Espresso machine giveaway (demo)', 'A fabricated demo giveaway',
             'One espresso machine', 'Marketing budget (fabricated)', $3, 'drawn')`,
    [giveawayId, host.id, new Date(Date.now() - 86400000).toISOString()]
  );
  const entryId = uuid();
  await pool.query(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)',
    [entryId, giveawayId, winner.id]
  );
  await pool.query('UPDATE giveaways SET winner_entry_id = $1 WHERE id = $2', [entryId, giveawayId]);

  say('A winner is drawn. A claim and a single-use link are created with it.');
  const client = await pool.connect();
  let claim;
  try {
    await client.query('BEGIN');
    claim = await claims.createClaimForDraw(client, {
      giveawayId,
      winnerUserId: winner.id,
      entryId,
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const stored = await pool.query('SELECT status, token_hash FROM prize_claims WHERE id = $1', [claim.id]);
  detail(`status                : ${stored.rows[0].status}`);
  detail(`token (emailed once)  : ${claim.token.slice(0, 8)}… (${claim.token.length} chars, shown truncated)`);
  detail(`stored in database    : ${stored.rows[0].token_hash.slice(0, 16)}… (SHA-256 hash only)`);

  say('Before the winner claims, the host is told nothing.');
  let hostView = await api()
    .get(`/api/claims/giveaway/${giveawayId}`)
    .set('Authorization', `Bearer ${host.token}`);
  detail(`host sees delivery    : available=${hostView.body.delivery.available} reason=${hostView.body.delivery.reason}`);

  say('An unrelated user cannot see the claim at all.');
  const strangerView = await api()
    .get(`/api/claims/giveaway/${giveawayId}`)
    .set('Authorization', `Bearer ${stranger.token}`);
  detail(`stranger              : HTTP ${strangerView.status} — ${strangerView.body.error}`);

  say('The winner opens the link. It shows the prize without consuming the token.');
  // POST with the token in the body — never a query string, which would write a
  // live single-use credential into every access log on the way in.
  const lookup = await api().post('/api/claims/lookup').send({ token: claim.token });
  detail(`prize                 : ${lookup.body.title} — ${lookup.body.prize_description}`);
  detail(`consent version       : ${lookup.body.consent_version}`);

  say('Declining consent stores nothing.');
  const declined = await api().post('/api/claims/redeem').send({
    token: claim.token,
    consent: false,
    consent_version: claims.CONSENT_VERSION,
    delivery: FABRICATED_DELIVERY,
  });
  const afterDecline = await pool.query(
    'SELECT status, delivery_ciphertext FROM prize_claims WHERE id = $1',
    [claim.id]
  );
  detail(`response              : HTTP ${declined.status} (${declined.body.code})`);
  detail(`stored details        : ${afterDecline.rows[0].delivery_ciphertext === null ? 'none' : 'SOMETHING WAS STORED'}`);

  say('The winner consents and submits fabricated delivery details.');
  const redeemed = await api().post('/api/claims/redeem').send({
    token: claim.token,
    consent: true,
    consent_version: claims.CONSENT_VERSION,
    delivery: FABRICATED_DELIVERY,
  });
  detail(`status                : ${redeemed.body.status}`);
  const encrypted = await pool.query(
    'SELECT delivery_ciphertext, delivery_iv, delivery_key_version, consent_version FROM prize_claims WHERE id = $1',
    [claim.id]
  );
  detail(`consent recorded      : ${encrypted.rows[0].consent_version}`);
  detail(`stored address        : ${encrypted.rows[0].delivery_ciphertext.slice(0, 24)}… (AES-256-GCM ciphertext)`);
  detail(`per-record IV         : ${encrypted.rows[0].delivery_iv} (key ${encrypted.rows[0].delivery_key_version})`);

  say('The same link cannot be used twice.');
  const replay = await api().post('/api/claims/redeem').send({
    token: claim.token,
    consent: true,
    consent_version: claims.CONSENT_VERSION,
    delivery: FABRICATED_DELIVERY,
  });
  detail(`replay                : HTTP ${replay.status} (${replay.body.code})`);

  say('Now, and only now, the host can see what they need to deliver.');
  hostView = await api()
    .get(`/api/claims/giveaway/${giveawayId}`)
    .set('Authorization', `Bearer ${host.token}`);
  const d = hostView.body.delivery.details;
  detail(`recipient             : ${d.recipient_name}`);
  detail(`address               : ${d.address_line1}, ${d.city}, ${d.emirate}`);
  detail(`winner account email  : ${JSON.stringify(hostView.body).includes(winner.email) ? 'DISCLOSED' : 'not disclosed'}`);

  const move = (actor, to, note) =>
    api()
      .post(`/api/claims/${claim.id}/transition`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ to, note });

  say('The host moves the prize along.');
  detail(`preparing_delivery    : HTTP ${(await move(host, STATES.PREPARING_DELIVERY)).status}`);
  detail(`shipped_or_arranged   : HTTP ${(await move(host, STATES.SHIPPED_OR_ARRANGED)).status}`);
  detail(`delivered_pending     : HTTP ${(await move(host, STATES.DELIVERED_PENDING_CONFIRMATION)).status}`);

  say('The host tries to declare it delivered. This is the whole point of the phase.');
  const hostFinal = await move(host, STATES.DELIVERED);
  detail(`host → delivered      : HTTP ${hostFinal.status} — ${hostFinal.body.error}`);
  const flag = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [giveawayId]);
  detail(`giveaway delivered?   : ${flag.rows[0].prize_delivered}`);

  say('The winner raises a dispute instead.');
  const disputed = await move(winner, STATES.DISPUTED, 'Box arrived empty (fabricated).');
  detail(`status                : ${disputed.body.status}`);

  say('It reaches the admin review queue — with no delivery details in it.');
  const queue = await api().get('/api/claims/admin/review').set('Authorization', `Bearer ${admin.token}`);
  const row = queue.body.find((r) => r.id === claim.id);
  detail(`queued                : ${row.title} (${row.status})`);
  detail(`address in queue?     : ${JSON.stringify(queue.body).includes(FABRICATED_DELIVERY.address_line1) ? 'LEAKED' : 'no'}`);

  say('Neither party can resolve their own dispute.');
  const hostResolve = await move(host, STATES.DELIVERED, 'we sorted it out');
  detail(`host → resolve        : HTTP ${hostResolve.status} — ${hostResolve.body.error}`);

  say('An admin resolves it, with a reason that is recorded.');
  const resolved = await move(admin, STATES.PREPARING_DELIVERY, 'Host to resend; courier confirmed loss (fabricated).');
  detail(`status                : ${resolved.body.status}`);

  say('Second attempt: host resends, winner confirms receipt.');
  detail(`shipped_or_arranged   : HTTP ${(await move(host, STATES.SHIPPED_OR_ARRANGED)).status}`);
  detail(`delivered_pending     : HTTP ${(await move(host, STATES.DELIVERED_PENDING_CONFIRMATION)).status}`);
  const confirmed = await move(winner, STATES.DELIVERED);
  detail(`winner → delivered    : HTTP ${confirmed.status} (${confirmed.body.status})`);
  const finalFlag = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [giveawayId]);
  detail(`giveaway delivered?   : ${finalFlag.rows[0].prize_delivered}`);

  say('The public page shows a coarse status and nothing else.');
  const publicView = await api().get(`/api/giveaways/${giveawayId}`);
  detail(`public claim_status   : ${publicView.body.claim_status}`);
  detail(`address in response?  : ${JSON.stringify(publicView.body).includes(FABRICATED_DELIVERY.address_line1) ? 'LEAKED' : 'no'}`);

  say('The full audit history survives, in order.');
  const history = await pool.query(
    'SELECT from_status, to_status, actor_role, note FROM prize_claim_events WHERE claim_id = $1 ORDER BY created_at',
    [claim.id]
  );
  history.rows.forEach((e) => {
    detail(`${String(e.from_status || '—').padEnd(30)} → ${String(e.to_status).padEnd(30)} by ${e.actor_role}${e.note ? ` (${e.note})` : ''}`);
  });

  say('Retention erases the address; the record of delivery survives.');
  await pool.query("UPDATE prize_claims SET delivered_at = NOW() - INTERVAL '400 days' WHERE id = $1", [claim.id]);
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
    const erased = await claims.eraseExpiredDeliveryDetails(cleanupClient, { days: 30 });
    await cleanupClient.query('COMMIT');
    detail(`records erased        : ${erased}`);
  } finally {
    cleanupClient.release();
  }
  const after = await pool.query(
    'SELECT delivery_ciphertext, delivery_erased_at, status, delivered_at FROM prize_claims WHERE id = $1',
    [claim.id]
  );
  detail(`ciphertext            : ${after.rows[0].delivery_ciphertext === null ? 'erased' : 'STILL PRESENT'}`);
  detail(`claim status          : ${after.rows[0].status} (delivered_at kept: ${Boolean(after.rows[0].delivered_at)})`);
  const survivingHistory = await pool.query(
    'SELECT COUNT(*)::int AS c FROM prize_claim_events WHERE claim_id = $1',
    [claim.id]
  );
  detail(`history entries kept  : ${survivingHistory.rows[0].c}`);

  const hostAfterErase = await api()
    .get(`/api/claims/giveaway/${giveawayId}`)
    .set('Authorization', `Bearer ${host.token}`);
  detail(`host sees delivery    : available=${hostAfterErase.body.delivery.available} reason=${hostAfterErase.body.delivery.reason}`);

  // Tidy up after the demonstration.
  await pool.query('DELETE FROM prize_claim_events WHERE claim_id = $1', [claim.id]);
  await pool.query('DELETE FROM prize_claims WHERE id = $1', [claim.id]);
  await pool.query('DELETE FROM entries WHERE giveaway_id = $1', [giveawayId]);
  await pool.query('DELETE FROM giveaways WHERE id = $1', [giveawayId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[host.id, winner.id, admin.id, stranger.id]]);

  say('Emails sent along the way — none carrying an address or phone number.');
  // Each dev log entry is a single call carrying the whole HTML body; only the
  // first line names the message.
  emailLog
    .filter((entry) => entry.startsWith('[email:dev]'))
    .forEach((entry) => detail(entry.split('\n')[0].replace('[email:dev] Would send ', '')));
  const allEmailText = emailLog.join('\n');
  detail(
    `address or phone in any email? : ${
      allEmailText.includes(FABRICATED_DELIVERY.address_line1) ||
      allEmailText.includes(FABRICATED_DELIVERY.phone)
        ? 'LEAKED'
        : 'no'
    }`
  );

  console.log('\nDemonstration complete. All data was fabricated and has been removed.\n');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
