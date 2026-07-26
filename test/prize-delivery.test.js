const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { api, pool, ensureInit } = require('../testHelpers');

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

async function createVerifiedUser(tag) {
  const id = uuid();
  const email = `test-delivery-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'correcthorse123';
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, TRUE)`,
    [id, `Delivery Test ${tag}`, email, bcrypt.hashSync(password, 4)]
  );
  createdUserIds.push(id);
  const login = await api().post('/api/auth/login').send({ email, password });
  return { id, token: login.body.token };
}

async function createDrawnGiveaway(hostId, winnerId) {
  const id = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline, status)
     VALUES ($1, $2, 'Delivery test giveaway', 'desc', 'prize', 'test budget', $3, 'active')`,
    [id, hostId, new Date(Date.now() - 60 * 1000).toISOString()]
  );
  createdGiveawayIds.push(id);
  const entryId = uuid();
  await pool.query(
    `INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, 1)`,
    [entryId, id, winnerId]
  );
  await pool.query(`UPDATE giveaways SET status = 'drawn', winner_entry_id = $1 WHERE id = $2`, [entryId, id]);
  return id;
}

test('host can confirm prize delivery after a draw', async () => {
  const host = await createVerifiedUser('host');
  const winner = await createVerifiedUser('winner');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);

  const res = await api()
    .post(`/api/giveaways/${giveawayId}/confirm-delivery`)
    .set('Authorization', `Bearer ${host.token}`)
    .send();

  assert.equal(res.status, 200);
  assert.equal(res.body.prize_delivered, true);
  assert.ok(res.body.prize_delivered_at);

  const check = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [giveawayId]);
  assert.equal(check.rows[0].prize_delivered, true);
});

test('only the host can confirm delivery', async () => {
  const host = await createVerifiedUser('host2');
  const winner = await createVerifiedUser('winner2');
  const stranger = await createVerifiedUser('stranger2');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);

  const res = await api()
    .post(`/api/giveaways/${giveawayId}/confirm-delivery`)
    .set('Authorization', `Bearer ${stranger.token}`)
    .send();

  assert.equal(res.status, 403);
  const check = await pool.query('SELECT prize_delivered FROM giveaways WHERE id = $1', [giveawayId]);
  assert.equal(check.rows[0].prize_delivered, false);
});

test('delivery cannot be confirmed before a winner is drawn', async () => {
  const host = await createVerifiedUser('host3');
  const id = uuid();
  await pool.query(
    `INSERT INTO giveaways (id, host_id, title, description, prize_description, funded_by, entry_deadline)
     VALUES ($1, $2, 'Undrawn delivery test', 'desc', 'prize', 'test budget', $3)`,
    [id, host.id, new Date(Date.now() + 5 * 60 * 1000).toISOString()]
  );
  createdGiveawayIds.push(id);

  const res = await api()
    .post(`/api/giveaways/${id}/confirm-delivery`)
    .set('Authorization', `Bearer ${host.token}`)
    .send();

  assert.equal(res.status, 400);
});

test('confirming delivery twice is idempotent, not an error', async () => {
  const host = await createVerifiedUser('host4');
  const winner = await createVerifiedUser('winner4');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);

  const first = await api()
    .post(`/api/giveaways/${giveawayId}/confirm-delivery`)
    .set('Authorization', `Bearer ${host.token}`)
    .send();
  const second = await api()
    .post(`/api/giveaways/${giveawayId}/confirm-delivery`)
    .set('Authorization', `Bearer ${host.token}`)
    .send();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.prize_delivered_at, second.body.prize_delivered_at);
});

test('drawn giveaway with delivery status appears correctly on the public winners endpoint', async () => {
  const host = await createVerifiedUser('host5');
  const winner = await createVerifiedUser('winner5');
  const giveawayId = await createDrawnGiveaway(host.id, winner.id);
  await api().post(`/api/giveaways/${giveawayId}/confirm-delivery`).set('Authorization', `Bearer ${host.token}`).send();

  const res = await api().get('/api/giveaways/winners/all?pageSize=48');
  const found = res.body.items.find((i) => i.id === giveawayId);
  assert.ok(found, 'giveaway should appear in the public winners list');
  assert.equal(found.prize_delivered, true);
});
