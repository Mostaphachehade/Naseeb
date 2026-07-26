require('dotenv').config();
const request = require('supertest');
const app = require('../server/app');
const { pool, init } = require('../server/db');

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await init();
    initialized = true;
  }
}

// Tagged with a run-unique suffix so parallel/repeat test runs never collide
// on the UNIQUE(email) constraint, and so leftover rows (if a run crashes
// before cleanup) are easy to spot and hand-delete.
function uniqueEmail(tag = 'user') {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

module.exports = {
  api: () => request(app),
  pool,
  ensureInit,
  uniqueEmail,
};
