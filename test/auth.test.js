const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, pool, ensureInit, uniqueEmail } = require('./helpers');

const createdUserIds = [];

before(async () => {
  await ensureInit();
});

after(async () => {
  if (createdUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

test('signup creates an account and returns a token', async () => {
  const email = uniqueEmail('signup');
  const res = await api()
    .post('/api/auth/signup')
    .send({ name: 'Test User', email, password: 'correcthorse123' });

  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, email);
  assert.equal(res.body.user.email_verified, false);
  createdUserIds.push(res.body.user.id);
});

test('signup rejects a duplicate email', async () => {
  const email = uniqueEmail('dupe');
  const first = await api()
    .post('/api/auth/signup')
    .send({ name: 'A', email, password: 'correcthorse123' });
  createdUserIds.push(first.body.user.id);

  const second = await api()
    .post('/api/auth/signup')
    .send({ name: 'B', email, password: 'anotherpassword123' });

  assert.equal(second.status, 409);
});

test('signup rejects a password under 8 characters', async () => {
  const res = await api()
    .post('/api/auth/signup')
    .send({ name: 'A', email: uniqueEmail('shortpw'), password: '1234567' });

  assert.equal(res.status, 400);
});

test('signup rejects an invalid email address', async () => {
  const res = await api()
    .post('/api/auth/signup')
    .send({ name: 'A', email: 'not-an-email', password: 'correcthorse123' });

  assert.equal(res.status, 400);
});

test('login succeeds with correct credentials', async () => {
  const email = uniqueEmail('login');
  const password = 'correcthorse123';
  const signup = await api().post('/api/auth/signup').send({ name: 'Login Test', email, password });
  createdUserIds.push(signup.body.user.id);

  const res = await api().post('/api/auth/login').send({ email, password });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, email);
});

test('login rejects an incorrect password', async () => {
  const email = uniqueEmail('wrongpw');
  const signup = await api()
    .post('/api/auth/signup')
    .send({ name: 'X', email, password: 'correcthorse123' });
  createdUserIds.push(signup.body.user.id);

  const res = await api().post('/api/auth/login').send({ email, password: 'wrongpassword' });

  assert.equal(res.status, 401);
});

test('login rejects an email with no account', async () => {
  const res = await api()
    .post('/api/auth/login')
    .send({ email: uniqueEmail('nosuchaccount'), password: 'correcthorse123' });

  assert.equal(res.status, 401);
});

test('a protected route rejects a request with no token', async () => {
  const res = await api().get('/api/giveaways/mine/hosted');
  assert.equal(res.status, 401);
});

test('a protected route rejects a garbage token', async () => {
  const res = await api()
    .get('/api/giveaways/mine/hosted')
    .set('Authorization', 'Bearer not-a-real-token');
  assert.equal(res.status, 401);
});
