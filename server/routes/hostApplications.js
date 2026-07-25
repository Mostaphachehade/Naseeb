const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { optionalAuth } = require('../middleware/auth');
const { applicationLimiter } = require('../middleware/rateLimit');
const { sendEmail, escapeHtmlForEmail } = require('../lib/email');

const router = express.Router();
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLICANT_TYPES = ['individual', 'company'];
const PLANS = ['pilot', 'standard', 'partner'];

// Applications to host on a paid plan. Nothing here is gated on payment —
// there's no payment processor wired up yet — this just captures who wants
// in so it can be followed up on manually. See db.js for the table comment.
router.post('/', applicationLimiter, optionalAuth, async (req, res) => {
  try {
    const {
      applicant_type,
      full_name,
      business_name,
      trade_license,
      contact_email,
      contact_phone,
      plan,
      message,
    } = req.body;

    if (!APPLICANT_TYPES.includes(applicant_type)) {
      return res.status(400).json({ error: 'Applicant type must be individual or company.' });
    }
    if (!PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Please select a plan.' });
    }
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (full_name.trim().length > 200) {
      return res.status(400).json({ error: 'Name must be 200 characters or fewer.' });
    }
    if (!contact_email || !EMAIL_RE.test(contact_email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
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

    const id = uuid();
    await pool.query(
      `INSERT INTO host_applications
       (id, user_id, applicant_type, full_name, business_name, trade_license, contact_email, contact_phone, plan, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        req.userId || null,
        applicant_type,
        full_name.trim(),
        normalizedBusinessName,
        normalizedTradeLicense,
        contact_email.trim().toLowerCase(),
        contact_phone && contact_phone.trim() ? contact_phone.trim() : null,
        plan,
        message && message.trim() ? message.trim() : null,
      ]
    );

    res.status(201).json({ id });

    // Best-effort — a failed notification shouldn't fail the applicant's request.
    if (ADMIN_NOTIFY_EMAIL) {
      const who = applicant_type === 'company' ? normalizedBusinessName : full_name.trim();
      sendEmail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New host application: ${who} (${plan})`,
        html: `
          <p>New ${applicant_type} application for the <strong>${plan}</strong> plan.</p>
          <p><strong>${escapeHtmlForEmail(who)}</strong>${applicant_type === 'company' ? ` — contact: ${escapeHtmlForEmail(full_name.trim())}` : ''}</p>
          <p>Email: ${escapeHtmlForEmail(contact_email.trim())}${contact_phone ? ` · Phone: ${escapeHtmlForEmail(contact_phone.trim())}` : ''}</p>
          ${normalizedTradeLicense ? `<p>Trade license: ${escapeHtmlForEmail(normalizedTradeLicense)}</p>` : ''}
          ${message ? `<p>Message: ${escapeHtmlForEmail(message.trim())}</p>` : ''}
          <p><a href="${(process.env.APP_URL || 'http://localhost:3000')}/admin.html">Review in the admin panel</a></p>
        `,
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
