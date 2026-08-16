const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { applicationLimiter } = require('../middleware/rateLimit');
const { sendEmail, escapeHtmlForEmail } = require('../lib/email');
const { HOST_STATUS, resolveHostAccess, setHostStatus } = require('../lib/hostAccess');
const eligibility = require('../lib/eligibility');

const router = express.Router();
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const APPLICANT_TYPES = ['individual', 'company'];

// Applications to host during the private beta.
//
// What this route does NOT do, and what the page must not imply it does:
//   * charge anything, hold a card, or touch Stripe. There is no import of the
//     payment code in this file and no plan to select, because there is nothing
//     to buy — hosting has no paid tier.
//   * grant hosting access. Submitting moves the account to 'pending' and
//     nothing else. Only an administrator's explicit decision moves it to
//     'approved', in server/routes/admin.js.
//   * promise a review deadline. We do not have a review SLA, so we do not
//     state one.
//
// It requires a signed-in, email-verified account. The old version accepted
// anonymous submissions with a free-text email, which meant an application was
// not attached to anything and could not gate anything.
router.post('/', applicationLimiter, requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const access = await resolveHostAccess(client, req.userId);
    if (!access.exists) {
      return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    }
    if (!access.emailVerified) {
      return res.status(403).json({
        error: 'Please verify your email before applying to host.',
        code: 'EMAIL_VERIFICATION_REQUIRED',
      });
    }
    // Asked once, before a new hosting action. Accounts predating the
    // attestation are `unknown`, never assumed.
    const me = await client.query(
      'SELECT age_attestation_status, age_attestation_version FROM users WHERE id = $1',
      [req.userId]
    );
    if (eligibility.blocksAction(me.rows[0], 'apply_to_host')) {
      return res.status(403).json({
        error: eligibility.WORDING + ' Please confirm this before applying to host.',
        code: 'AGE_ATTESTATION_REQUIRED',
        wording: eligibility.WORDING,
      });
    }
    if (access.status === HOST_STATUS.APPROVED) {
      return res.status(409).json({
        error: 'This account is already approved to host.',
        code: 'ALREADY_APPROVED',
        host_status: access.status,
      });
    }
    if (access.status === HOST_STATUS.SUSPENDED) {
      return res.status(409).json({
        error:
          'Hosting access for this account is suspended. Applying again will not lift it — please contact us.',
        code: 'HOST_ACCESS_SUSPENDED',
        host_status: access.status,
      });
    }

    const { applicant_type, full_name, business_name, trade_license, contact_phone, message } =
      req.body || {};

    if (!APPLICANT_TYPES.includes(applicant_type)) {
      return res.status(400).json({ error: 'Applicant type must be individual or company.' });
    }
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (full_name.trim().length > 200) {
      return res.status(400).json({ error: 'Name must be 200 characters or fewer.' });
    }
    if (contact_phone && contact_phone.trim().length > 40) {
      return res.status(400).json({ error: 'Phone number must be 40 characters or fewer.' });
    }
    if (message && message.trim().length > 2000) {
      return res.status(400).json({ error: 'Message must be 2000 characters or fewer.' });
    }

    let normalizedBusinessName = null;
    let normalizedTradeLicense = null;
    if (applicant_type === 'company') {
      if (!business_name || !business_name.trim()) {
        return res.status(400).json({ error: 'Business name is required for a company application.' });
      }
      if (business_name.trim().length > 200) {
        return res.status(400).json({ error: 'Business name must be 200 characters or fewer.' });
      }
      normalizedBusinessName = business_name.trim();
      if (trade_license && trade_license.trim().length > 100) {
        return res.status(400).json({ error: 'Trade license must be 100 characters or fewer.' });
      }
      normalizedTradeLicense = trade_license && trade_license.trim() ? trade_license.trim() : null;
    }

    // The account row is locked for the rest of this transaction, so two
    // submissions racing each other serialize here instead of both passing the
    // "do they already have one?" check above. The partial unique index on
    // host_applications is the second line of defence, in case a future caller
    // forgets this lock.
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.userId]);

    const openRes = await client.query(
      "SELECT id, created_at FROM host_applications WHERE user_id = $1 AND status = 'pending'",
      [req.userId]
    );
    if (openRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'You already have an application waiting for review.',
        code: 'APPLICATION_ALREADY_PENDING',
        application: { id: openRes.rows[0].id, status: 'pending', created_at: openRes.rows[0].created_at },
      });
    }

    // The contact email comes from the verified account, not from the form. An
    // applicant cannot type somebody else's address into an application that
    // will be attached to their own account.
    const emailRes = await client.query('SELECT email FROM users WHERE id = $1', [req.userId]);
    const accountEmail = emailRes.rows[0].email;

    const id = uuid();
    await client.query(
      `INSERT INTO host_applications
         (id, user_id, applicant_type, full_name, business_name, trade_license,
          contact_email, contact_phone, plan, message, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, 'pending')`,
      [
        id,
        req.userId,
        applicant_type,
        full_name.trim(),
        normalizedBusinessName,
        normalizedTradeLicense,
        accountEmail,
        contact_phone && contact_phone.trim() ? contact_phone.trim() : null,
        message && message.trim() ? message.trim() : null,
      ]
    );

    // Moves the account to 'pending' — a record that they asked, which grants
    // nothing. A rejected applicant who applies again returns to pending, which
    // is why this is not restricted to not_requested.
    await setHostStatus(client, {
      userId: req.userId,
      toStatus: HOST_STATUS.PENDING,
      reason: 'Applied to host during the private beta.',
      changedBy: null,
      source: 'application',
      applicationId: id,
    });

    await client.query('COMMIT');

    res.status(201).json({
      id,
      status: 'pending',
      host_status: HOST_STATUS.PENDING,
      message:
        'Your application is with an administrator. It grants no hosting access on its own, and we have not set a review deadline.',
    });

    if (ADMIN_NOTIFY_EMAIL) {
      const who = applicant_type === 'company' ? normalizedBusinessName : full_name.trim();
      sendEmail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New host application: ${escapeHtmlForEmail(who)}`,
        html: `
          <p>A new ${applicant_type} application to host is waiting for review.</p>
          <p><strong>${escapeHtmlForEmail(who)}</strong></p>
          <p><a href="${APP_URL}/admin.html">Review in the admin panel</a></p>
        `,
      });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The unique index firing means two submissions raced past the lock — the
    // applicant has an application either way, which is what they wanted.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'You already have an application waiting for review.',
        code: 'APPLICATION_ALREADY_PENDING',
      });
    }
    console.error('Host application failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// What the signed-in account's own hosting position is. The UI reads this to
// decide which of the five states to show; it is never what enforces anything.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const access = await resolveHostAccess(pool, req.userId);
    if (!access.exists) {
      return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    }

    const applicationRes = await pool.query(
      `SELECT id, status, created_at, decided_at, decision_reason
         FROM host_applications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.userId]
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      host_status: access.status,
      can_host: access.canHost,
      is_admin: access.isAdmin,
      exempt_as_admin: Boolean(access.exemptAsAdmin),
      email_verified: access.emailVerified,
      status_changed_at: access.statusChangedAt || null,
      status_reason: access.statusReason || null,
      application: applicationRes.rows[0] || null,
    });
  } catch (err) {
    console.error('Host status lookup failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
