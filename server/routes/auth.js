const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { sendEmail } = require('../lib/email');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function issueToken(user) {
  return jwt.sign({ sub: user.id, name: user.name }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function sendVerificationEmail(user, token) {
  const link = `${APP_URL}/verify.html?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your email for Naseeb',
    html: `<p>Hi ${user.name},</p><p>Confirm your email to enter and host giveaways on Naseeb:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`,
  });
}

router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;

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
      `INSERT INTO users (id, name, email, password_hash, email_verified, verification_token, verification_token_expires)
       VALUES ($1, $2, $3, $4, FALSE, $5, $6)`,
      [id, name.trim(), cleanEmail, password_hash, verificationToken, verificationExpires]
    );

    const user = { id, name: name.trim(), email: cleanEmail };
    await sendVerificationEmail(user, verificationToken);

    res.status(201).json({
      token: issueToken(user),
      user: { id, name: user.name, email: cleanEmail, is_admin: false, email_verified: false },
    });
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

    res.json({
      token: issueToken(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_admin: user.is_admin,
        email_verified: user.email_verified,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
        html: `<p>Hi ${user.name},</p><p>Reset your password:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
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
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [password_hash, user.id]
    );
    res.json({ message: 'Your password has been reset. You can sign in now.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
