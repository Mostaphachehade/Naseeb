const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { api, pool, ensureInit } = require('../testHelpers');
const { DEFAULTS } = require('../server/lib/settings');

const createdUserIds = [];

before(async () => {
  await ensureInit();
});

after(async () => {
  // Reset any settings a test touched back to defaults so this run never
  // leaves the real site (this suite runs against whichever DB
  // DATABASE_URL resolves to, same as the rest of the suite) in a
  // different state than it found it.
  await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [Object.keys(DEFAULTS)]);
  if (createdUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

async function createVerifiedUser(tag, { admin = false } = {}) {
  const id = uuid();
  const email = `test-owner-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'correcthorse123';
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, email_verified, is_admin) VALUES ($1, $2, $3, $4, TRUE, $5)`,
    [id, `Owner Test ${tag}`, email, bcrypt.hashSync(password, 4), admin]
  );
  createdUserIds.push(id);
  const login = await api().post('/api/auth/login').send({ email, password });
  return { id, token: login.body.token };
}

test('a non-admin cannot read site settings', async () => {
  const user = await createVerifiedUser('nonadmin-read');
  const res = await api().get('/api/admin/settings').set('Authorization', `Bearer ${user.token}`);
  assert.equal(res.status, 403);
});

test('a non-admin cannot write site settings', async () => {
  const user = await createVerifiedUser('nonadmin-write');
  const res = await api()
    .patch('/api/admin/settings')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ ad_price_per_week_aed: '999' });
  assert.equal(res.status, 403);
});

test('an admin can read settings and gets the documented defaults', async () => {
  const admin = await createVerifiedUser('read-defaults', { admin: true });
  const res = await api().get('/api/admin/settings').set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ad_price_per_week_aed, DEFAULTS.ad_price_per_week_aed);
  assert.equal(res.body.maintenance_mode, DEFAULTS.maintenance_mode);
});

test('an admin can update a setting and it persists on re-read', async () => {
  const admin = await createVerifiedUser('write-persist', { admin: true });
  const patch = await api()
    .patch('/api/admin/settings')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ ad_price_per_week_aed: '750' });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.ad_price_per_week_aed, '750');

  const reread = await api().get('/api/admin/settings').set('Authorization', `Bearer ${admin.token}`);
  assert.equal(reread.body.ad_price_per_week_aed, '750');

  // And it's what the public ad-availability endpoint actually charges. Since
  // Phase 1.4 that endpoint reports the price in integer fils, with every
  // duration's total calculated server-side, so the page cannot display a
  // number that differs from the one Stripe is asked for.
  const availability = await api().get('/api/ads/availability');
  assert.equal(availability.body.pricePerWeekFils, 75000);
  assert.equal(availability.body.pricePerWeekDisplay, 'AED 750');
  assert.equal(availability.body.durations.find((d) => d.weeks === 2).totalFils, 150000);
});

test('settings updates reject an unknown key', async () => {
  const admin = await createVerifiedUser('unknown-key', { admin: true });
  const res = await api()
    .patch('/api/admin/settings')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ not_a_real_setting: 'x' });
  assert.equal(res.status, 400);
});

test('settings updates reject an invalid value for a known key', async () => {
  const admin = await createVerifiedUser('invalid-value', { admin: true });
  const res = await api()
    .patch('/api/admin/settings')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ maintenance_mode: 'not-a-boolean' });
  assert.equal(res.status, 400);
});

test('public /api/config exposes maintenance state with no auth, and no hosting price', async () => {
  const res = await api().get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.maintenance_mode, 'boolean');

  // The two hosting plan prices this endpoint used to publish priced plans that
  // were advertised and never built. Publishing a price for something nobody
  // can buy is the marketing claim, not the number — so the keys are gone
  // rather than zeroed, and the endpoint says what the model actually is.
  assert.equal(res.body.hosting_plan_standard_price_aed, undefined);
  assert.equal(res.body.hosting_plan_partner_price_aed, undefined);
  assert.equal(res.body.hosting_is_paid, false);
  assert.equal(res.body.hosting_access_model, 'private_beta_application');
});

test('the settings API refuses to store a hosting plan price at all', async () => {
  const admin = await createVerifiedUser('no-host-price', { admin: true });

  const res = await api()
    .patch('/api/admin/settings')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ hosting_plan_standard_price_aed: '250' });

  assert.equal(res.status, 400, 'a removed setting must not quietly come back');
  assert.match(res.body.error, /Unknown setting/i);

  const settings = await api().get('/api/admin/settings').set('Authorization', `Bearer ${admin.token}`);
  assert.equal(settings.body.hosting_plan_standard_price_aed, undefined);
  assert.equal(settings.body.hosting_plan_partner_price_aed, undefined);
});

test('a non-admin cannot read the revenue summary', async () => {
  const user = await createVerifiedUser('nonadmin-revenue');
  const res = await api().get('/api/admin/revenue').set('Authorization', `Bearer ${user.token}`);
  assert.equal(res.status, 403);
});

test('an admin can read the revenue summary with the documented shape', async () => {
  const admin = await createVerifiedUser('revenue-shape', { admin: true });
  const res = await api().get('/api/admin/revenue').set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.total_revenue_aed, 'number');
  assert.equal(typeof res.body.total_bookings, 'number');
  assert.ok(Array.isArray(res.body.by_month));
  assert.ok(Array.isArray(res.body.recent_bookings));
});
