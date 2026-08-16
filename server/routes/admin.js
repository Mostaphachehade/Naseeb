const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { getAllSettings, setSetting } = require('../lib/settings');
const { HOST_STATUS, ADMIN_SETTABLE, setHostStatus } = require('../lib/hostAccess');
const { PRICE_FORMAT } = require('../lib/adPricing');

const router = express.Router();

const SETTINGS_VALIDATORS = {
  // Stricter than "is it a number": this value is converted to integer fils and
  // charged. Number('1e3') and Number(' 500 ') are both finite and both produce
  // a price no one intended, and anything with more than two decimal places
  // cannot be represented in fils at all. Must be a plain decimal amount.
  //
  // Changing it necessarily changes the quote version (derived from the value
  // and its updated_at), so customers mid-checkout are told the price moved
  // rather than being charged the new one. Existing bookings are untouched —
  // they carry their own agreed amount.
  ad_price_per_week_aed: (v) => PRICE_FORMAT.test(String(v).trim()) && Number(v) > 0,
  maintenance_mode: (v) => v === 'true' || v === 'false',
  maintenance_message: (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 500,
};

// Single at-a-glance summary so an admin doesn't have to scroll every
// section just to see what needs attention.
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [
      pendingApps,
      pendingInquiries,
      liveGiveaways,
      hosts,
      activeAd,
    ] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS c FROM host_applications WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*)::int AS c FROM ad_inquiries WHERE contacted = FALSE"),
      pool.query("SELECT COUNT(*)::int AS c FROM giveaways WHERE status = 'active'"),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_verified_business)::int AS verified,
                COUNT(*) FILTER (WHERE host_status = 'approved')::int AS approved_hosts,
                COUNT(*) FILTER (WHERE host_status = 'suspended')::int AS suspended_hosts
           FROM users`
      ),
      pool.query(
        `SELECT business_name, click_count FROM ads
         WHERE (paid = TRUE AND starts_at <= CURRENT_DATE AND ends_at >= CURRENT_DATE)
            OR (paid = FALSE AND active = TRUE)
         ORDER BY paid DESC
         LIMIT 1`
      ),
    ]);

    res.json({
      pending_host_applications: pendingApps.rows[0].c,
      pending_ad_inquiries: pendingInquiries.rows[0].c,
      live_giveaways: liveGiveaways.rows[0].c,
      total_hosts: hosts.rows[0].total,
      verified_hosts: hosts.rows[0].verified,
      approved_hosts: hosts.rows[0].approved_hosts,
      suspended_hosts: hosts.rows[0].suspended_hosts,
      active_ad: activeAd.rows[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// The review queue.
//
// Deliberately narrow: who applied, whether they are an individual or a
// company, when, and where the decision stands. No email address, no phone
// number, no trade licence, no free-text message. A queue is a screen that gets
// left open, scrolled past and screenshotted, and none of those fields help
// anyone decide which application to open — they are on the detail endpoint
// below, fetched when an administrator actually opens one.
router.get('/host-applications', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.applicant_type, a.status, a.created_at, a.decided_at, a.plan,
              COALESCE(a.business_name, a.full_name) AS display_name,
              a.user_id, u.host_status,
              decider.name AS decided_by_name
         FROM host_applications a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN users decider ON decider.id = a.decided_by
        ORDER BY (a.status = 'pending') DESC, a.created_at DESC`
    );
    res.set('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// One application in full, including the contact details, fetched only when an
// administrator opens it rather than rendered into a list of everyone.
router.get('/host-applications/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.host_status, u.email AS account_email, decider.name AS decided_by_name
         FROM host_applications a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN users decider ON decider.id = a.decided_by
        WHERE a.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Application not found.' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Decide an application. Approving is the only thing on this platform that
// grants hosting access, and it takes a named administrator, a timestamp and a
// reason — an unexplained decision is unreviewable exactly when someone asks
// why it was made.
router.post('/host-applications/:id/decision', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { decision, reason } = req.body || {};
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ error: "decision must be 'approved' or 'rejected'." });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A short reason is required.', code: 'REASON_REQUIRED' });
    }
    if (String(reason).trim().length > 1000) {
      return res.status(400).json({ error: 'Reason must be 1000 characters or fewer.' });
    }

    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, user_id, status FROM host_applications WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Application not found.' });
    }
    const application = existing.rows[0];
    if (application.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `This application was already ${application.status}. Change the account's host access directly instead.`,
        code: 'ALREADY_DECIDED',
      });
    }
    // A legacy row from the old lead-capture form may have no account attached.
    // There is nothing to grant access to, so it can be closed but not approved.
    if (!application.user_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          'This enquiry predates host approval and is not attached to an account, so no access can be granted from it.',
        code: 'NO_ACCOUNT_ATTACHED',
      });
    }

    await client.query(
      `UPDATE host_applications
          SET status = $1, decided_at = NOW(), decided_by = $2, decision_reason = $3, contacted = TRUE
        WHERE id = $4`,
      [decision, req.userId, String(reason).trim(), req.params.id]
    );

    const change = await setHostStatus(client, {
      userId: application.user_id,
      toStatus: decision === 'approved' ? HOST_STATUS.APPROVED : HOST_STATUS.REJECTED,
      reason: String(reason).trim(),
      changedBy: req.userId,
      source: 'admin_decision',
      applicationId: req.params.id,
    });

    await client.query('COMMIT');

    res.set('Cache-Control', 'no-store');
    res.json({
      id: req.params.id,
      status: decision,
      host_status: decision === 'approved' ? HOST_STATUS.APPROVED : HOST_STATUS.REJECTED,
      status_changed: Boolean(change),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Host application decision failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// Change an account's host access directly — suspend a host, lift a
// suspension, or approve someone without an application on file.
//
// Nothing is deleted by any of these: a suspended host keeps every giveaway,
// entry, claim and event they had. What changes is what they may do next.
router.post('/hosts/:userId/status', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, reason } = req.body || {};
    if (!ADMIN_SETTABLE.has(status)) {
      return res.status(400).json({
        error: `status must be one of: ${[...ADMIN_SETTABLE].join(', ')}.`,
      });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A short reason is required.', code: 'REASON_REQUIRED' });
    }
    if (String(reason).trim().length > 1000) {
      return res.status(400).json({ error: 'Reason must be 1000 characters or fewer.' });
    }

    await client.query('BEGIN');

    const target = await client.query('SELECT id, is_admin FROM users WHERE id = $1', [
      req.params.userId,
    ]);
    if (!target.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.' });
    }

    const change = await setHostStatus(client, {
      userId: req.params.userId,
      toStatus: status,
      reason: String(reason).trim(),
      changedBy: req.userId,
      source: 'admin_decision',
    });

    // How many claims this affects, counted before the commit so the answer
    // matches what was changed. Suspending a host who is mid-delivery hands
    // those claims to administrators — see docs/HOST_ACCESS.md.
    const openClaims = await client.query(
      `SELECT COUNT(*)::int AS c
         FROM prize_claims c
         JOIN giveaways g ON g.id = c.giveaway_id
        WHERE g.host_id = $1
          AND c.status NOT IN ('delivered', 'cancelled')`,
      [req.params.userId]
    );

    await client.query('COMMIT');

    res.set('Cache-Control', 'no-store');
    res.json({
      user_id: req.params.userId,
      host_status: status,
      status_changed: Boolean(change),
      // An administrator's own status is recorded, but it does not gate them:
      // the exemption in server/lib/hostAccess.js is on is_admin.
      admin_exempt_from_status: Boolean(target.rows[0].is_admin),
      open_claims_affected: status === HOST_STATUS.APPROVED ? 0 : openClaims.rows[0].c,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Host status change failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// The history behind one account's current host access.
router.get('/hosts/:userId/status-events', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.from_status, e.to_status, e.reason, e.source, e.created_at,
              changer.name AS changed_by_name
         FROM host_status_events e
         LEFT JOIN users changer ON changer.id = e.changed_by
        WHERE e.user_id = $1
        ORDER BY e.created_at ASC`,
      [req.params.userId]
    );
    res.set('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Closing an application without approving or refusing it — a duplicate, a
// mistake, spam, or an applicant who asked to be taken off the list.
//
// There is deliberately **no delete route on this resource**, and there was one
// until this commit. It let an administrator remove an undecided application
// outright, which meant the record of somebody asking to host could be made to
// have never happened. "It was only spam" is a judgement made at the moment of
// deleting, by the person deleting, and it is unreviewable afterwards precisely
// because the row is gone. `withdrawn` is the honest version of the same
// action: the application is closed, and it is still there, with who closed it,
// when, and why.
router.post('/host-applications/:id/close', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A short reason is required.', code: 'REASON_REQUIRED' });
    }
    if (String(reason).trim().length > 1000) {
      return res.status(400).json({ error: 'Reason must be 1000 characters or fewer.' });
    }

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, user_id, status FROM host_applications WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Application not found.' });
    }
    // An approved or refused application already carries an outcome. Closing it
    // would write a second, different answer over the first.
    if (existing.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `This application was already ${existing.rows[0].status} and its outcome cannot be rewritten.`,
        code: 'ALREADY_DECIDED',
      });
    }

    await client.query(
      `UPDATE host_applications
          SET status = 'withdrawn', decided_at = NOW(), decided_by = $1, decision_reason = $2,
              contacted = TRUE
        WHERE id = $3`,
      [req.userId, String(reason).trim(), req.params.id]
    );

    // The account goes back to never having asked — it has no open application
    // and no decision against it — and that move is itself an event, so the
    // history reads: applied, then closed by this administrator for this reason.
    if (existing.rows[0].user_id) {
      await setHostStatus(client, {
        userId: existing.rows[0].user_id,
        toStatus: HOST_STATUS.NOT_REQUESTED,
        reason: `Application closed without a decision: ${String(reason).trim()}`,
        changedBy: req.userId,
        source: 'admin_decision',
        applicationId: req.params.id,
      });
    }

    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    res.json({ id: req.params.id, status: 'withdrawn' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Host application close failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

router.get('/ad-inquiries', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM ad_inquiries ORDER BY contacted ASC, created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.patch('/ad-inquiries/:id', requireAdmin, async (req, res) => {
  try {
    const { contacted } = req.body;
    if (typeof contacted !== 'boolean') {
      return res.status(400).json({ error: 'contacted must be true or false.' });
    }
    const result = await pool.query(
      'UPDATE ad_inquiries SET contacted = $1 WHERE id = $2 RETURNING *',
      [contacted, req.params.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Inquiry not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/ad-inquiries/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM ad_inquiries WHERE id = $1 RETURNING id', [
      req.params.id,
    ]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Inquiry not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/ads', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ads ORDER BY active DESC, created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/ads', requireAdmin, async (req, res) => {
  try {
    const { business_name, image_url, target_url, media_type } = req.body;
    if (!business_name || !business_name.trim()) {
      return res.status(400).json({ error: 'Business name is required.' });
    }
    if (!image_url || !image_url.trim()) {
      return res.status(400).json({ error: 'Media URL is required.' });
    }
    const normalizedMediaType = media_type === 'video' ? 'video' : 'image';

    let normalizedTargetUrl;
    try {
      const parsed = new URL(target_url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
      normalizedTargetUrl = parsed.href;
    } catch {
      return res.status(400).json({ error: 'Target URL must be a valid http(s) URL.' });
    }

    const id = uuid();
    await pool.query(
      'INSERT INTO ads (id, business_name, image_url, target_url, media_type) VALUES ($1, $2, $3, $4, $5)',
      [id, business_name.trim(), image_url.trim(), normalizedTargetUrl, normalizedMediaType]
    );
    const result = await pool.query('SELECT * FROM ads WHERE id = $1', [id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.patch('/ads/:id', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be true or false.' });
    }
    // Only one ad is ever active at a time — the single homepage banner slot.
    if (active) {
      await pool.query('UPDATE ads SET active = FALSE WHERE active = TRUE');
    }
    const result = await pool.query('UPDATE ads SET active = $1 WHERE id = $2 RETURNING *', [
      active,
      req.params.id,
    ]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Ad not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/ads/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM ads WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Ad not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/giveaways', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        giveaways.id, giveaways.title, giveaways.status, giveaways.entry_deadline, giveaways.created_at,
        users.name AS host_name, users.email AS host_email,
        (SELECT COUNT(*)::int FROM entries WHERE entries.giveaway_id = giveaways.id) AS entry_count
      FROM giveaways
      JOIN users ON users.id = giveaways.host_id
      ORDER BY (giveaways.status = 'active') DESC, giveaways.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Moderation only — cancel a giveaway (blocks new entries, same as a host
// cancelling their own) or reinstate one cancelled by mistake. Drawn
// giveaways are left alone; there's nothing to moderate once a winner exists.
router.patch('/giveaways/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== 'active' && status !== 'cancelled') {
      return res.status(400).json({ error: "status must be 'active' or 'cancelled'." });
    }
    const current = await pool.query('SELECT status FROM giveaways WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) {
      return res.status(404).json({ error: 'Giveaway not found.' });
    }
    if (current.rows[0].status === 'drawn') {
      return res.status(400).json({ error: 'This giveaway has already been drawn and cannot be changed.' });
    }
    const result = await pool.query('UPDATE giveaways SET status = $1 WHERE id = $2 RETURNING id, status', [
      status,
      req.params.id,
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        users.id, users.name, users.email, users.is_admin, users.is_verified_business, users.created_at,
        users.host_status, users.host_status_changed_at, users.host_status_reason,
        (SELECT COUNT(*)::int FROM giveaways WHERE giveaways.host_id = users.id) AS giveaways_hosted
      FROM users
      ORDER BY users.is_verified_business ASC, users.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Only toggles the verified-business badge. Admin promotion stays a direct
// DB action (see README) — not exposed here, so a UI slip can't hand out
// admin access.
router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { is_verified_business } = req.body;
    if (typeof is_verified_business !== 'boolean') {
      return res.status(400).json({ error: 'is_verified_business must be true or false.' });
    }
    const result = await pool.query(
      'UPDATE users SET is_verified_business = $1 WHERE id = $2 RETURNING id, name, email, is_admin, is_verified_business, created_at',
      [is_verified_business, req.params.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Deleting a user only works while nothing references them (no giveaways,
// entries, or host applications) — Postgres's foreign key constraints
// enforce that, so a host with real activity can't be deleted by accident.
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: "You can't delete your own account." });
    }
    const target = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.params.id]);
    if (!target.rows[0]) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (target.rows[0].is_admin) {
      return res.status(400).json({ error: "Admin accounts can't be deleted here." });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({
        error: 'This host still has giveaways, entries, or applications on record — cancel or remove those first.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Owner-editable values that would otherwise need a code deploy — see
// server/lib/settings.js for the full list and defaults.
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.patch('/settings', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Expected an object of settings to update.' });
    }
    for (const [key, value] of Object.entries(updates)) {
      const validate = SETTINGS_VALIDATORS[key];
      if (!validate) {
        return res.status(400).json({ error: `Unknown setting: ${key}` });
      }
      if (!validate(String(value))) {
        return res.status(400).json({ error: `Invalid value for ${key}.` });
      }
    }
    for (const [key, value] of Object.entries(updates)) {
      await setSetting(key, String(value).trim());
    }
    const settings = await getAllSettings();
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Ad revenue only — hosting plans aren't wired to real billing yet (see
// server/routes/giveaways.js), so there's nothing else to report on.
router.get('/revenue', requireAdmin, async (req, res) => {
  try {
    const [totals, last30, byMonth, recentBookings] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS bookings, COALESCE(SUM(amount_aed), 0)::numeric AS total FROM ads WHERE paid = TRUE`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS bookings, COALESCE(SUM(amount_aed), 0)::numeric AS total FROM ads
         WHERE paid = TRUE AND created_at >= NOW() - INTERVAL '30 days'`
      ),
      pool.query(
        `SELECT to_char(created_at, 'YYYY-MM') AS month, COUNT(*)::int AS bookings, COALESCE(SUM(amount_aed), 0)::numeric AS revenue
         FROM ads WHERE paid = TRUE
         GROUP BY month ORDER BY month DESC LIMIT 6`
      ),
      pool.query(
        `SELECT business_name, amount_aed, starts_at, ends_at, created_at FROM ads
         WHERE paid = TRUE ORDER BY created_at DESC LIMIT 10`
      ),
    ]);

    res.json({
      total_revenue_aed: Number(totals.rows[0].total),
      total_bookings: totals.rows[0].bookings,
      revenue_last_30_days_aed: Number(last30.rows[0].total),
      bookings_last_30_days: last30.rows[0].bookings,
      by_month: byMonth.rows.map((r) => ({ month: r.month, bookings: r.bookings, revenue_aed: Number(r.revenue) })),
      recent_bookings: recentBookings.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
