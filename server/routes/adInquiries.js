const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { adInquiryLimiter } = require('../middleware/rateLimit');
const { sendEmail, escapeHtmlForEmail } = require('../lib/email');

const router = express.Router();
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Ad placement inquiries. Advertising is a separate product from hosting
// giveaways — sold to anyone, billed manually, tracked via click_count on
// the ads table so pricing conversations have real numbers behind them.
router.post('/', adInquiryLimiter, async (req, res) => {
  try {
    const { business_name, contact_email, contact_phone, message } = req.body;

    if (!business_name || !business_name.trim()) {
      return res.status(400).json({ error: 'Business name is required.' });
    }
    if (business_name.trim().length > 200) {
      return res.status(400).json({ error: 'Business name must be 200 characters or fewer.' });
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

    const id = uuid();
    await pool.query(
      `INSERT INTO ad_inquiries (id, business_name, contact_email, contact_phone, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        business_name.trim(),
        contact_email.trim().toLowerCase(),
        contact_phone && contact_phone.trim() ? contact_phone.trim() : null,
        message && message.trim() ? message.trim() : null,
      ]
    );

    res.status(201).json({ id });

    if (ADMIN_NOTIFY_EMAIL) {
      sendEmail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New ad inquiry: ${business_name.trim()}`,
        html: `
          <p>New advertising inquiry from <strong>${escapeHtmlForEmail(business_name.trim())}</strong>.</p>
          <p>Email: ${escapeHtmlForEmail(contact_email.trim())}${contact_phone ? ` · Phone: ${escapeHtmlForEmail(contact_phone.trim())}` : ''}</p>
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
