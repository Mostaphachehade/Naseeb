// Regression coverage for the two race conditions found and fixed in
// server/routes/giveaways.js: concurrent entries handing out the same
// ticket number, and concurrent draws both picking (and emailing) a winner.
// Both routes now lock the giveaway row (SELECT ... FOR UPDATE) inside a
// transaction — these tests fire genuinely simultaneous requests to make
// sure that lock is actually doing its job, not just present in the code.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { api, pool, ensureInit } = require('./helpers');

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
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

// Inserted directly rather than via POST /api/auth/signup so tests don't
// depend on (or have to fake) the email verification flow.
async function createVerifiedUser(tag) {
  const id = uuid();
  const email = `test-race-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'correcthorse123';
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, TRUE)`,
    [id, `Race Test ${tag}`, email, bcrypt.hashSync(password, 4)]
  );
  createdUserIds.push(id);

  const login = await api().post('/api/auth/login').send({ email, password });
  return { id, token: login.body.token };
}

// Inserted directly (rather than via POST /api/giveaways) so the deadline
// can be set in the past, which the create route deliberately rejects.
async function createGiveaway(hostId, deadlineIso) {
  const id = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline)
     VALUES ($1, $2, 'Race condition test giveaway', 'desc', 'prize', 'test budget', $3)`,
    [id, hostId, deadlineIso]
  );
  createdGiveawayIds.push(id);
  return id;
}

test('two simultaneous entries get distinct ticket numbers, not a collision', async () => {
  const host = await createVerifiedUser('host-enter');
  const giveawayId = await createGiveaway(host.id, new Date(Date.now() + 5 * 60 * 1000).toISOString());

  const [entrantA, entrantB] = await Promise.all([
    createVerifiedUser('entrant-a'),
    createVerifiedUser('entrant-b'),
  ]);

  const [resA, resB] = await Promise.all([
    api().post(`/api/giveaways/${giveawayId}/enter`).set('Authorization', `Bearer ${entrantA.token}`).send(),
    api().post(`/api/giveaways/${giveawayId}/enter`).set('Authorization', `Bearer ${entrantB.token}`).send(),
  ]);

  assert.equal(resA.status, 201);
  assert.equal(resB.status, 201);
  const tickets = [resA.body.ticket_number, resB.body.ticket_number].sort();
  assert.deepEqual(tickets, [1, 2]);

  const count = await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [giveawayId]);
  assert.equal(count.rows[0].c, 2);
});

test('the same person entering twice at once only gets counted once', async () => {
  const host = await createVerifiedUser('host-dupe');
  const giveawayId = await createGiveaway(host.id, new Date(Date.now() + 5 * 60 * 1000).toISOString());
  const entrant = await createVerifiedUser('dupe-entrant');

  const [resA, resB] = await Promise.all([
    api().post(`/api/giveaways/${giveawayId}/enter`).set('Authorization', `Bearer ${entrant.token}`).send(),
    api().post(`/api/giveaways/${giveawayId}/enter`).set('Authorization', `Bearer ${entrant.token}`).send(),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  const count = await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [giveawayId]);
  assert.equal(count.rows[0].c, 1);
});

test('two simultaneous draws only let one succeed', async () => {
  const host = await createVerifiedUser('host-draw');
  const giveawayId = await createGiveaway(host.id, new Date(Date.now() - 60 * 1000).toISOString());

  const entrant = await createVerifiedUser('draw-entrant');
  await pool.query(
    `INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)`,
    [uuid(), giveawayId, entrant.id]
  );

  const [resA, resB] = await Promise.all([
    api().post(`/api/giveaways/${giveawayId}/draw`).set('Authorization', `Bearer ${host.token}`).send(),
    api().post(`/api/giveaways/${giveawayId}/draw`).set('Authorization', `Bearer ${host.token}`).send(),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 400]);

  const check = await pool.query('SELECT status, winner_entry_id FROM giveaways WHERE id = $1', [giveawayId]);
  assert.equal(check.rows[0].status, 'drawn');
  assert.ok(check.rows[0].winner_entry_id);
});

test('only the host can draw a winner', async () => {
  const host = await createVerifiedUser('host-authz');
  const stranger = await createVerifiedUser('stranger-authz');
  const giveawayId = await createGiveaway(host.id, new Date(Date.now() - 60 * 1000).toISOString());

  const entrant = await createVerifiedUser('authz-entrant');
  await pool.query(
    `INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)`,
    [uuid(), giveawayId, entrant.id]
  );

  const res = await api()
    .post(`/api/giveaways/${giveawayId}/draw`)
    .set('Authorization', `Bearer ${stranger.token}`)
    .send();

  assert.equal(res.status, 403);
});
