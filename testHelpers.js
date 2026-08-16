// Must run before ./server/db is required — that module builds its Pool from
// process.env.DATABASE_URL at require time, so the guard has to have approved
// (and possibly rewritten) the target first. See testEnv.js.
const { configureTestEnv } = require('./testEnv');

configureTestEnv();

const request = require('supertest');
const app = require('./server/app');
const { pool, init } = require('./server/db');

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

// Sign-in is rate limited per IP and the suite signs in far more often than any
// one person would. A distinct forwarded address per attempt keeps the limiter
// doing its job for real callers instead of being switched off for the tests.
let ipCounter = 0;
function nextTestIp() {
  ipCounter += 1;
  return `10.99.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
}

const TEST_ORIGIN = process.env.APP_URL || 'http://localhost:3000';

// A signed-in browser, as far as the server is concerned.
//
// Authentication is an HttpOnly cookie now, so a test cannot hold a token and
// paste it into a header — it has to keep a cookie jar, which is what
// supertest's agent is. Every request also carries the two things a real
// browser sends: an Origin this site accepts, and the CSRF token the login
// response handed back.
function bindSession(agent, { csrf, user }) {
  const wrap = (method) => (path) => {
    const req = agent[method](path).set('Origin', TEST_ORIGIN);
    if (csrf) req.set('X-CSRF-Token', csrf);
    return req;
  };
  return {
    id: user ? user.id : null,
    user,
    csrf,
    agent,
    // The raw agent, for the handful of tests that deliberately omit the CSRF
    // header or the Origin to prove the refusal.
    raw: (method, path) => agent[method](path),
    get: wrap('get'),
    post: wrap('post'),
    patch: wrap('patch'),
    put: wrap('put'),
    delete: wrap('delete'),
  };
}

async function signIn(email, password = 'correcthorse123', { ip } = {}) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', TEST_ORIGIN)
    .set('X-Forwarded-For', ip || nextTestIp())
    .send({ email, password });
  if (res.status !== 200) {
    throw new Error(`sign-in failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return bindSession(agent, { csrf: res.body.csrf_token, user: res.body.user });
}

// An unauthenticated caller that still looks like this site's own page — for
// posting to routes that do not need a session (signup, login, claim redeem).
function anon() {
  const agent = request.agent(app);
  return bindSession(agent, { csrf: null, user: null });
}

module.exports = {
  api: () => request(app),
  agent: () => request.agent(app),
  pool,
  ensureInit,
  uniqueEmail,
  signIn,
  anon,
  bindSession,
  nextTestIp,
  TEST_ORIGIN,
};
