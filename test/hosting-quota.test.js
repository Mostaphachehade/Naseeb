// Regression coverage for "the owner always has unlimited hosting access."
// There's no hosting quota enforced today (see the comment above POST /
// in server/routes/giveaways.js) — this test exists so that if a real
// quota is ever added, it fails loudly the moment it accidentally catches
// an admin account, instead of that guarantee silently breaking.
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
    await pool.query('DELETE FROM giveaways WHERE id = ANY($1)', [createdGiveawayIds]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

async function createVerifiedUser(tag, { admin = false } = {}) {
  const id = uuid();
  const email = `test-hosting-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'correcthorse123';
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin) VALUES ($1, $2, $3, $4, TRUE, $5)`,
    [id, `Hosting Test ${tag}`, email, bcrypt.hashSync(password, 4), admin]
  );
  createdUserIds.push(id);

  const login = await api().post('/api/auth/login').send({ email, password });
  return { id, token: login.body.token };
}

function giveawayPayload(n) {
  return {
    title: `Hosting quota test giveaway ${n}`,
    description: 'desc',
    prize_description: 'prize',
    funded_by: 'test budget',
    entry_deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

test('an admin account can host well beyond any of the advertised plan caps with no rejection', async () => {
  const admin = await createVerifiedUser('admin', { admin: true });

  // The most restrictive advertised plan (pricing.html "Pilot") is a single
  // giveaway — six in a row, all succeeding, is well past any plan cap that
  // exists in the marketing copy today.
  for (let i = 0; i < 6; i++) {
    const res = await api()
      .post('/api/giveaways')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(giveawayPayload(i));
    assert.equal(res.status, 201, `expected giveaway ${i} to be created, got ${res.status}: ${JSON.stringify(res.body)}`);
    createdGiveawayIds.push(res.body.id);
  }
});

test('a regular verified account can also host multiple giveaways (no quota exists for anyone yet)', async () => {
  const host = await createVerifiedUser('regular');

  for (let i = 0; i < 3; i++) {
    const res = await api()
      .post('/api/giveaways')
      .set('Authorization', `Bearer ${host.token}`)
      .send(giveawayPayload(`regular-${i}`));
    assert.equal(res.status, 201);
    createdGiveawayIds.push(res.body.id);
  }
});
