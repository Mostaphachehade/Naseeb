const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { sendEmail, escapeHtmlForEmail } = require('../lib/email');
const sessions = require('../lib/sessions');
const eligibility = require('../lib/eligibility');
const { tokenForFamily } = require('../lib/csrf');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// What the browser is told about itself. Never contains the session token —
// that lives only in the HttpOnly cookie, where the page's JavaScript cannot
// reach it, which is the entire point of this phase.
function accountView(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: Boolean(user.is_admin),
    email_verified: Boolean(user.email_verified),
  };
}

// Signs a user in: a brand new session, a fresh cookie, and a CSRF token in the
// body for the page to hold in memory.
//
// Session fixation is prevented by construction rather than by a check. This
// never looks at, adopts or extends whatever session cookie the browser
// arrived with — it mints a new random token with a new database row, and the
// Set-Cookie overwrites whatever was there. An attacker who plants a known
// cookie value in a victim's browser has planted a value that stops being
// meaningful the moment the victim signs in.
async function establishSession(res, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await sessions.createSession(client, { userId: user.id });
    await client.query('COMMIT');

    sessions.setSessionCookie(res, session.token, session.expiresAt);
    res.set('Cache-Control', 'no-store');

    return {
      user: accountView(user),
      csrf_token: tokenForFamily(session.familyId),
      session_expires_at: new Date(session.expiresAt).toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function sendVerificationEmail(user, token) {
  const link = `${APP_URL}/verify.html?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your email for Naseeb',
    html: `<p>Hi ${escapeHtmlForEmail(user.name)},</p><p>Confirm your email to enter and host giveaways on Naseeb:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`,
  });
}

router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password, age_confirmed: ageConfirmed } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are all required.' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Name must be 100 characters or fewer.' });
    }
    if (!EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    // bcrypt silently ignores bytes past 72 — cap input so two long passwords
    // sharing a 72-byte prefix can't collide on the same hash.
    if (password.length > 72) {
      return res.status(400).json({ error: 'Password must be 72 characters or fewer.' });
    }
    // Explicit, and only `true` counts. A missing field, a string, or anything
    // truthy-but-not-true is a box that was not ticked — and the box is not
    // pre-ticked on the form either. This is a self-declaration: no date of
    // birth is asked for and no document is collected.
    if (ageConfirmed !== true) {
      return res.status(400).json({
        error: eligibility.WORDING + ' Please confirm this to create an account.',
        code: 'AGE_ATTESTATION_REQUIRED',
      });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const id = uuid();
    const password_hash = bcrypt.hashSync(password, 10);
    const verificationToken = generateToken();
    const verificationExpires = new Date(Date.now() + VERIFY_TTL_MS);
    const cleanEmail = email.toLowerCase().trim();
    await pool.query(
      `INSERT INTO users
         (id, name, email, password_hash, email_verified, verification_token, verification_token_expires,
          age_attestation_status, age_attestation_version, age_attested_at)
       VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $8, NOW())`,
      [
        id, name.trim(), cleanEmail, password_hash, verificationToken, verificationExpires,
        eligibility.STATUS.CONFIRMED, eligibility.CURRENT_VERSION,
      ]
    );

    const user = { id, name: name.trim(), email: cleanEmail, is_admin: false, email_verified: false };
    await sendVerificationEmail(user, verificationToken);

    res.status(201).json(await establishSession(res, user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    // Same answer as a wrong password, so this cannot be used to enumerate
    // which accounts have been suspended.
    if (user.account_status && user.account_status !== 'active') {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    res.json(await establishSession(res, user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// The bootstrap the frontend calls on every page load.
//
// Answers "am I signed in, and what CSRF token should I send", and nothing more.
// It does not, and must not, return the session token: the whole design rests on
// that value never being reachable from JavaScript.
//
// no-store because a cached copy of this is a cached answer about who somebody
// is — served to the next person on a shared machine, or held by a proxy.
router.get('/session', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await sessions.authenticate(sessions.tokenFromRequest(req));
    if (!result.ok) {
      if (result.reason === sessions.FAILURE.ERROR) {
        return res.status(503).json({
          error: 'We could not check your session just now. Please try again shortly.',
          code: 'SESSION_CHECK_UNAVAILABLE',
        });
      }
      // Anonymous is a normal answer here, not an error — every page calls this,
      // including pages a signed-out visitor is meant to see.
      if (result.reason !== sessions.FAILURE.NO_TOKEN) sessions.clearSessionCookie(res);
      return res.json({ authenticated: false, user: null, csrf_token: null });
    }

    if (result.renewed) {
      sessions.setSessionCookie(res, result.renewed.token, result.renewed.expiresAt);
    }

    return res.json({
      authenticated: true,
      user: accountView(result.user),
      csrf_token: tokenForFamily(result.session.familyId),
      session_expires_at: new Date(result.session.expiresAt).toISOString(),
    });
  } catch (err) {
    console.error('Session bootstrap failed:', err.message);
    return res.status(503).json({ error: 'Please try again shortly.' });
  }
});

// Signing out ends the session on the server, not just in the browser.
//
// The old implementation was a localStorage delete: the token stayed valid for
// the rest of its thirty days, so signing out on a shared computer protected
// nobody if the token had already been copied.
router.post('/logout', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const token = sessions.tokenFromRequest(req);
    if (token) {
      // Revokes the whole family, not the row that happened to send this
      // request. A rotation leaves a predecessor authenticating for a grace
      // window, so "this session" is a chain of rows, and ending only one of
      // them left the others working — including, if a rotation committed at
      // the wrong instant, a successor nobody had asked for.
      const result = await sessions.authenticate(token);
      if (result.ok) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await sessions.revokeFamily(client, result.session.familyId, sessions.REVOCATION.LOGOUT);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    }
  } catch (err) {
    // The cookie is cleared regardless: a failure here must not leave somebody
    // who pressed "sign out" still holding a cookie.
    console.error('Logout revocation failed:', err.message);
  }
  sessions.clearSessionCookie(res);
  return res.json({ ok: true });
});

// Ends every session for the signed-in account, including this one. The "sign
// out everywhere" a person reaches for after losing a laptop.
router.post('/logout-all', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const revoked = await sessions.revokeAllForUser(
      pool,
      req.userId,
      sessions.REVOCATION.ADMIN_REVOKED
    );
    sessions.clearSessionCookie(res);
    return res.json({ ok: true, sessions_revoked: revoked });
  } catch (err) {
    console.error('Revoking all sessions failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/verify', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ error: 'Missing verification token.' });
    }
    const result = await pool.query(
      'SELECT id, email_verified, verification_token_expires FROM users WHERE verification_token = $1',
      [token]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(400).json({ error: 'This verification link is invalid or has already been used.' });
    }
    if (user.email_verified) {
      return res.json({ message: 'Your email is already verified.' });
    }
    if (new Date(user.verification_token_expires) < new Date()) {
      return res.status(400).json({ error: 'This verification link has expired. Request a new one from your account.' });
    }
    await pool.query(
      'UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_token_expires = NULL WHERE id = $1',
      [user.id]
    );
    res.json({ message: 'Your email is verified.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/resend-verification', authLimiter, requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    if (user.email_verified) {
      return res.json({ message: 'Your email is already verified.' });
    }
    const token = generateToken();
    const expires = new Date(Date.now() + VERIFY_TTL_MS);
    await pool.query(
      'UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3',
      [token, expires, user.id]
    );
    await sendVerificationEmail(user, token);
    res.json({ message: 'Verification email sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);
    const user = result.rows[0];
    if (user) {
      const token = generateToken();
      const expires = new Date(Date.now() + RESET_TTL_MS);
      await pool.query('UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3', [
        token,
        expires,
        user.id,
      ]);
      const link = `${APP_URL}/reset-password.html?token=${token}`;
      await sendEmail({
        to: user.email,
        subject: 'Reset your Naseeb password',
        html: `<p>Hi ${escapeHtmlForEmail(user.name)},</p><p>Reset your password:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
      });
    }
    // Always respond the same way whether or not the email exists, so this
    // endpoint can't be used to check which emails have accounts.
    res.json({ message: "If that email has an account, we've sent a reset link." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (password.length > 72) {
      return res.status(400).json({ error: 'Password must be 72 characters or fewer.' });
    }
    const result = await pool.query(
      'SELECT id, reset_token_expires FROM users WHERE reset_token = $1',
      [token]
    );
    const user = result.rows[0];
    if (!user || new Date(user.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }
    const password_hash = bcrypt.hashSync(password, 10);

    // The password change and the revocation are one transaction. Somebody
    // resetting a password is very often somebody who thinks another person has
    // their account — leaving that person's existing sessions alive would make
    // the reset theatre. This is why sessions are a table and not a signature:
    // it is the one thing a JWT could not do.
    const client = await pool.connect();
    let revoked = 0;
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
        [password_hash, user.id]
      );
      revoked = await sessions.revokeAllForUser(
        client,
        user.id,
        sessions.REVOCATION.PASSWORD_RESET
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Whoever is holding this browser is signed out too, and signs in with the
    // new password like everybody else.
    sessions.clearSessionCookie(res);
    res.set('Cache-Control', 'no-store');
    res.json({
      message: 'Your password has been reset. You can sign in now.',
      sessions_revoked: revoked,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
