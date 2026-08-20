// Single-use claim links.
//
// A winner gets an emailed link that proves they are the winner without making
// them sign in first. That link is a bearer credential, so it is treated like
// one: 256 bits of randomness, stored only as a hash, usable once, and expiring
// on its own.
//
// Storing the hash rather than the token means a database leak yields nothing
// usable — the same reason password hashes exist. The token itself lives in
// exactly two places: the email that was sent, and the URL the winner clicks.
// It is never written to a log, an analytics event, a Sentry payload, or any
// API response other than the one moment it is created.
const crypto = require('crypto');

// 32 bytes = 256 bits, as required. base64url so it survives being a URL
// parameter without escaping.
const TOKEN_BYTES = 32;

const DEFAULT_TTL_HOURS = 72;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// SHA-256 is the right tool here and bcrypt is not: this is a
// high-entropy random value, not a human-chosen password, so there is nothing
// for an attacker to guess and no need for a slow KDF. What matters is that the
// stored form is one-way, and that lookup is a single indexed comparison.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenTtlHours() {
  const configured = Number(process.env.CLAIM_TOKEN_TTL_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_HOURS;
}

function tokenExpiryFrom(now = new Date()) {
  return new Date(now.getTime() + tokenTtlHours() * 60 * 60 * 1000);
}

// Issued together so a caller cannot accidentally store the token instead of
// the hash: the plaintext is returned for the email and nothing else.
function issueToken() {
  const token = generateToken();
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: tokenExpiryFrom(),
  };
}

module.exports = {
  TOKEN_BYTES,
  DEFAULT_TTL_HOURS,
  generateToken,
  hashToken,
  tokenTtlHours,
  tokenExpiryFrom,
  issueToken,
};
