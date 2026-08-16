const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { getAllSettings, setSetting } = require('../lib/settings');
const { HOST_STATUS, ADMIN_SETTABLE, setHostStatus } = require('../lib/hostAccess');
const sessions = require('../lib/sessions');
const { validateMediaUrl, validateExternalLinkUrl } = require('../lib/mediaUrls');
const integrity = require('../lib/entryIntegrity');
const riskSignals = require('../lib/riskSignals');
const rights = require('../lib/accountRights');

// Account status is authentication; host status is authorization. Two columns,
// two routes, and deliberately no path that changes one as a side effect of the
// other. See docs/SESSIONS.md.
const ACCOUNT_STATUSES = ['active', 'suspended', 'deactivated'];
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

// Suspend, deactivate or restore an account.
//
// Kept firmly apart from host access above, and the distinction is the whole
// reason there are two columns. Host status decides whether somebody may
// publish a giveaway; account status decides whether they may sign in at all.
// A host who loses hosting keeps their account, their entries and their tickets
// — a suspended host is still an entrant, and signing them out of the platform
// because they may no longer host would punish them for something they can
// still perfectly well do.
router.post('/users/:id/account-status', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, reason } = req.body || {};
    if (!ACCOUNT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ACCOUNT_STATUSES.join(', ')}.` });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A short reason is required.', code: 'REASON_REQUIRED' });
    }
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: "You can't change your own account status here." });
    }

    await client.query('BEGIN');
    const target = await client.query(
      'SELECT id, is_admin, account_status FROM users WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!target.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.' });
    }
    if (target.rows[0].is_admin) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Administrator accounts can't be suspended here." });
    }

    await client.query(
      `UPDATE users
          SET account_status = $1, account_status_changed_at = NOW(),
              account_status_reason = $2, account_status_changed_by = $3
        WHERE id = $4`,
      [status, String(reason).trim(), req.userId, req.params.id]
    );

    // Anything other than active means every live session ends now, not when
    // its cookie happens to expire.
    let revoked = 0;
    if (status !== 'active') {
      revoked = await sessions.revokeAllForUser(
        client,
        req.params.id,
        sessions.REVOCATION.ACCOUNT_SUSPENDED
      );
    }

    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    res.json({ user_id: req.params.id, account_status: status, sessions_revoked: revoked });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Account status change failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// End every session for one account without changing what the account is
// allowed to do — for a "someone else has my laptop" report, where suspending
// the account would be the wrong answer.
router.post('/users/:id/revoke-sessions', requireAdmin, async (req, res) => {
  try {
    const target = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!target.rows[0]) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    const revoked = await sessions.revokeAllForUser(
      pool,
      req.params.id,
      sessions.REVOCATION.ADMIN_REVOKED
    );
    res.set('Cache-Control', 'no-store');
    res.json({ user_id: req.params.id, sessions_revoked: revoked });
  } catch (err) {
    console.error('Session revocation failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
    // A banner is served from our own homepage, so its origin has to be one
    // img-src/media-src allows. See server/lib/mediaUrls.js.
    const checkedMedia = validateMediaUrl(image_url);
    if (!checkedMedia.url) {
      return res.status(400).json({ error: checkedMedia.error, code: 'MEDIA_URL_REJECTED' });
    }
    const normalizedMediaType = media_type === 'video' ? 'video' : 'image';

    // Same validator the click-through path and the admin table use, so a
    // destination that would be refused when rendered cannot be accepted when
    // stored.
    const checkedTarget = validateExternalLinkUrl(target_url);
    if (!checkedTarget.url) {
      return res.status(400).json({ error: checkedTarget.error, code: 'TARGET_URL_REJECTED' });
    }
    const normalizedTargetUrl = checkedTarget.url;

    const id = uuid();
    await pool.query(
      'INSERT INTO ads (id, business_name, image_url, target_url, media_type) VALUES ($1, $2, $3, $4, $5)',
      [id, business_name.trim(), checkedMedia.url, normalizedTargetUrl, normalizedMediaType]
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
        users.account_status, users.account_status_changed_at, users.account_status_reason,
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

// Deleting an account from the admin panel is gone.
//
// It used to work whenever Postgres's foreign keys allowed it — which is to say,
// on any account that had not yet done anything. That sounds harmless and is
// not: it is a second, unreviewed erasure path that sits beside the privacy
// request workflow and answers to none of its rules. No recorded reason, no
// notes, no append-only event, no blocker check, nothing the person is told, and
// no way to establish afterwards that it happened or who did it. An erasure that
// leaves no trace is precisely what the workflow next door exists to prevent.
//
// What replaces it, for each reason somebody used to reach for it:
//
//   abuse or a security problem  →  suspend the account (POST /users/:id/status),
//                                   which is recorded, reversible and explained
//   a compromised session        →  revoke sessions
//   "they asked to be deleted"   →  the privacy request workflow, which weighs
//                                   open claims, payments and audit obligations
//                                   before anything is decided
//   a test or junk account       →  a database operation under a runbook, not an
//                                   application feature (see below)
//
// The route stays mounted and answers 405 rather than 404, so an old bookmark,
// an old script or a stale cached page gets an explanation instead of looking
// like a routing bug somebody should go and fix.
//
// **Direct database deletion is outside normal application behaviour.** There is
// no supported in-app path to it, and there is deliberately no hidden one. If an
// account genuinely has to be removed at the database level — a court order, a
// regulator's instruction, an incident — that is an emergency operation
// requiring a separately approved runbook covering who may authorise it, who
// executes it, what is recorded before and after, and how the append-only audit
// tables (which carry no foreign keys and would therefore survive) are
// reconciled. No such runbook exists yet, and this comment is not one.
// Recorded in docs/PRIVACY_AND_RIGHTS.md §8.
router.delete('/users/:id', requireAdmin, (req, res) => {
  res.set('Allow', 'GET, PATCH, POST');
  res.status(405).json({
    error:
      'Deleting an account is not available. Suspend the account to stop abuse, revoke its sessions if it is compromised, or use the privacy request workflow if the account holder has asked to be erased.',
    code: 'ACCOUNT_DELETION_DISABLED',
    alternatives: [
      { action: 'suspend', route: 'POST /api/admin/users/:id/account-status' },
      { action: 'revoke_sessions', route: 'POST /api/admin/users/:id/revoke-sessions' },
      { action: 'erasure_request', route: 'GET /api/admin/privacy-requests' },
    ],
    note: 'No records were deleted by this request.',
  });
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

// ---------------------------------------------------------------------------
// Entry integrity
// ---------------------------------------------------------------------------

// The queue: what needs a decision, and nothing else.
//
// Carries no network hash, no email address, no session or CSRF token, no
// delivery detail, and no free text an entrant wrote. Signal *categories* and a
// count — enough to decide which row to open, not enough to be a surveillance
// screen somebody leaves up all day.
router.get('/integrity/queue', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.id AS entry_id,
         e.ticket_number,
         e.integrity_status,
         e.created_at AS entered_at,
         g.id AS giveaway_id,
         g.title AS giveaway_title,
         g.status AS giveaway_status,
         (g.winner_entry_id = e.id) AS is_winner,
         u.id AS account_id,
         u.created_at AS account_created_at,
         c.id AS case_id,
         c.status AS case_status,
         c.post_draw AS case_post_draw,
         c.opened_at AS case_opened_at,
         COALESCE(
           (SELECT json_agg(DISTINCT s.signal_code)
              FROM entry_risk_signals s
             WHERE s.entry_id = e.id AND s.severity = 'review'),
           '[]'::json
         ) AS signal_categories
       FROM entries e
       JOIN giveaways g ON g.id = e.giveaway_id
       JOIN users u ON u.id = e.user_id
       LEFT JOIN entry_integrity_cases c
                ON c.entry_id = e.id AND c.status IN ('open', 'upheld_blocked')
      WHERE e.integrity_status <> 'eligible'
         OR c.id IS NOT NULL
         OR EXISTS (
              SELECT 1 FROM entry_risk_signals s2
               WHERE s2.entry_id = e.id AND s2.severity = 'review'
            )
      ORDER BY (c.id IS NOT NULL) DESC, e.created_at DESC
      LIMIT 200`
    );

    res.json(
      result.rows.map((row) => ({
        entry_id: row.entry_id,
        ticket_number: row.ticket_number,
        status: row.integrity_status,
        entered_at: row.entered_at,
        giveaway_id: row.giveaway_id,
        giveaway_title: row.giveaway_title,
        giveaway_status: row.giveaway_status,
        is_winner: Boolean(row.is_winner),
        // An account reference, not an identity. The queue never carries the
        // entrant's name or email; opening the entry is what shows who it is.
        account_ref: String(row.account_id).slice(0, 8),
        account_age_days: Math.floor(
          (Date.now() - new Date(row.account_created_at).getTime()) / 86400000
        ),
        signal_categories: row.signal_categories,
        case_id: row.case_id,
        case_status: row.case_status,
        // An upheld case stays here. That is the point of the state: a confirmed
        // concern that stops the prize moving is exactly the thing an
        // administrator queue must not lose track of.
        case_open: Boolean(row.case_id),
        case_blocked: row.case_status === 'upheld_blocked',
        case_post_draw: Boolean(row.case_post_draw),
        case_opened_at: row.case_opened_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// One entry, opened deliberately. Never part of a list response.
//
// This is where the detail lives: the account behind the entry, the full signal
// list, the decision history. `no-store` because it is exactly the sort of
// screen that should not sit in a shared browser cache or a proxy.
router.get('/integrity/entries/:entryId', requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    const entryRes = await pool.query(
      `SELECT e.*, g.title AS giveaway_title, g.status AS giveaway_status,
              g.winner_entry_id, u.name AS account_name, u.email AS account_email,
              u.created_at AS account_created_at, u.email_verified
         FROM entries e
         JOIN giveaways g ON g.id = e.giveaway_id
         JOIN users u ON u.id = e.user_id
        WHERE e.id = $1`,
      [req.params.entryId]
    );
    const entry = entryRes.rows[0];
    if (!entry) return res.status(404).json({ error: 'That entry does not exist.' });

    const [signalsRes, historyRes, casesRes] = await Promise.all([
      pool.query(
        `SELECT signal_code, severity, detail, created_at, expires_at
           FROM entry_risk_signals WHERE entry_id = $1 ORDER BY created_at DESC`,
        [req.params.entryId]
      ),
      pool.query(
        `SELECT ev.from_status, ev.to_status, ev.reason_code,
                COALESCE(ev.admin_notes, ev.reason) AS admin_notes,
                ev.actor_role, ev.metadata, ev.created_at, actor.name AS actor_name
           FROM entry_integrity_events ev
           LEFT JOIN users actor ON actor.id = ev.actor_user_id
          WHERE ev.entry_id = $1 ORDER BY ev.created_at`,
        [req.params.entryId]
      ),
      pool.query(
        `SELECT id, status, post_draw, opened_reason, opened_at, resolution,
                resolution_reason, resolved_at, version
           FROM entry_integrity_cases WHERE entry_id = $1 ORDER BY opened_at DESC`,
        [req.params.entryId]
      ),
    ]);

    res.json({
      entry: {
        id: entry.id,
        ticket_number: entry.ticket_number,
        entered_at: entry.created_at,
        status: entry.integrity_status,
        reason_code: entry.integrity_reason_code,
        // The administrator's own notes — the evidence, the other accounts, the
        // signal. This response is the only place they appear, it is fetched by
        // a deliberate click, and it is no-store.
        admin_notes: entry.integrity_admin_notes,
        // What the entrant actually sees, shown here so an administrator can
        // check the wording they are about to send rather than guess at it.
        entrant_explanation: integrity.entrantCopyFor(entry.integrity_reason_code),
        // Concurrency token. Required back on any decision about this entry.
        version: entry.integrity_version,
        is_winner: entry.winner_entry_id === entry.id,
      },
      reason_codes: integrity.CODES_FOR_STATUS,
      entrant_copy: integrity.ENTRANT_COPY,
      giveaway: {
        id: entry.giveaway_id,
        title: entry.giveaway_title,
        status: entry.giveaway_status,
      },
      account: {
        name: entry.account_name,
        email: entry.account_email,
        email_verified: entry.email_verified,
        created_at: entry.account_created_at,
      },
      // The network hash is never in this response. It is a join key, and a join
      // key handed to a browser is a correlation tool nobody asked for; the
      // count it produced is the part an administrator can actually use.
      signals: signalsRes.rows.map((s) => ({
        code: s.signal_code,
        severity: s.severity,
        detail: s.detail,
        observed_at: s.created_at,
        expires_at: s.expires_at,
      })),
      history: historyRes.rows,
      cases: casesRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// The decision. One route for all three outcomes, because they are the same
// act with a different destination and should share every guard.
router.post('/integrity/entries/:entryId/status', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    // Only the destination, the allowlisted code, the internal notes and the
    // version are read from the body. A role, an actor id or a risk score sent
    // by the client is ignored — the actor is the session, and the administrator
    // check is a fresh read of users.is_admin inside this transaction. The
    // version is a staleness check, never a permission.
    const { status, reason_code: reasonCode, admin_notes: adminNotes, version } = req.body || {};

    await client.query('BEGIN');
    const result = await integrity.setStatus(client, {
      entryId: req.params.entryId,
      toStatus: status,
      reasonCode,
      adminNotes,
      actorUserId: req.userId,
      expectedVersion: version,
    });
    await client.query('COMMIT');

    res.set('Cache-Control', 'no-store');
    res.json({
      entry_id: req.params.entryId,
      status: result.status,
      changed: result.changed,
      version: result.version,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof integrity.IntegrityError) {
      // `current` gives the screen what it needs to refresh itself after a
      // stale decision: a coarse state and the version to resubmit with.
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code, current: err.details || null });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// Opening a case after a winner exists.
//
// This is the whole post-draw story: it does not replace the winner, does not
// redraw, and does not touch the claim. It pauses fulfilment and puts the
// decision in front of a person. Replacing a winner is a policy this codebase
// does not have, and inventing one here would be inventing it for the owner.
router.post('/integrity/cases', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { giveaway_id: giveawayId, entry_id: entryId, admin_notes: adminNotes } = req.body || {};
    if (!giveawayId) {
      return res.status(400).json({ error: 'A giveaway is required.', code: 'GIVEAWAY_REQUIRED' });
    }

    await client.query('BEGIN');

    const giveawayRes = await client.query(
      'SELECT id, status, winner_entry_id FROM giveaways WHERE id = $1 FOR UPDATE',
      [giveawayId]
    );
    const giveaway = giveawayRes.rows[0];
    if (!giveaway) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That giveaway does not exist.' });
    }

    if (entryId) {
      const entryRes = await client.query(
        'SELECT id FROM entries WHERE id = $1 AND giveaway_id = $2',
        [entryId, giveawayId]
      );
      if (!entryRes.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'That entry is not part of this giveaway.' });
      }
    }

    const opened = await integrity.openCase(client, {
      giveawayId,
      entryId: entryId || null,
      adminNotes,
      actorUserId: req.userId,
      postDraw: giveaway.status === 'drawn',
    });

    await client.query('COMMIT');
    res.status(opened.created ? 201 : 200).json({
      case: opened.case,
      created: opened.created,
      // Said explicitly in the response so nobody has to infer it from silence.
      winner_unchanged: true,
      fulfilment_paused: true,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof integrity.IntegrityError) {
      // `current` gives the screen what it needs to refresh itself after a
      // stale decision: a coarse state and the version to resubmit with.
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code, current: err.details || null });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

router.post('/integrity/cases/:caseId/resolve', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { resolution, admin_notes: adminNotes, version } = req.body || {};

    await client.query('BEGIN');
    const result = await integrity.resolveCase(client, {
      caseId: req.params.caseId,
      resolution,
      adminNotes,
      actorUserId: req.userId,
      expectedVersion: version,
    });
    await client.query('COMMIT');

    res.set('Cache-Control', 'no-store');
    res.json({
      case: result.case,
      changed: result.changed,
      // Said plainly, because "upheld" reads like an ending and is not one.
      fulfilment_paused: integrity.BLOCKING_CASE_STATUSES.includes(result.case.status),
      requires_owner_decision: result.case.status === integrity.CASE_STATUS.UPHELD_BLOCKED,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof integrity.IntegrityError) {
      // `current` gives the screen what it needs to refresh itself after a
      // stale decision: a coarse state and the version to resubmit with.
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code, current: err.details || null });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// Retention, on demand. Idempotent: running it twice deletes nothing the second
// time. There is no scheduler behind it yet — see docs/ENTRY_INTEGRITY.md §9.
router.post('/integrity/signals/purge', requireAdmin, async (req, res) => {
  try {
    const removed = await riskSignals.purgeExpiredSignals(pool);
    res.json({ removed, retention_days: riskSignals.retentionDays() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Privacy requests
// ---------------------------------------------------------------------------

// The queue: a reference, a type, an age, a status, what is blocking it, and
// what can be done. No name, no email address, no message text, no
// administrator notes — a list is a screen that gets left open, and none of
// those fields help decide which row to open.
router.get('/privacy-requests', requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await pool.query(
      `SELECT id, reference, request_type, status, blockers, created_at, updated_at, version,
              user_id
         FROM privacy_requests
        ORDER BY (status IN ('submitted', 'in_review', 'awaiting_information')) DESC, created_at DESC
        LIMIT 200`
    );

    res.json(
      result.rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        type: row.request_type,
        status: row.status,
        age_days: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000),
        created_at: row.created_at,
        version: row.version,
        // An account reference, not an identity. Opening the row is what shows
        // who it is.
        account_ref: String(row.user_id).slice(0, 8),
        // Categories only.
        blocking: Array.isArray(row.blockers) ? row.blockers.map((b) => b.category) : [],
        // A deletion request is not offered `completed`, because it cannot
        // reach it. Offering an action the next call refuses is how a queue
        // teaches somebody to ignore its refusals.
        actions: rights.CLOSED_STATUSES.includes(row.status)
          ? []
          : row.request_type === 'deletion'
            ? rights.DELETION_ALLOWED_STATUSES
            : ['in_review', 'awaiting_information', 'completed', 'declined', 'unable_to_complete'],
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// One request, opened deliberately. This is where the account, the message and
// the internal notes live.
router.get('/privacy-requests/:id', requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await pool.query(
      `SELECT r.*, u.name AS account_name, u.email AS account_email, u.created_at AS account_created_at
         FROM privacy_requests r JOIN users u ON u.id = r.user_id
        WHERE r.id = $1`,
      [req.params.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'That request does not exist.' });

    const [history, blockers, executions] = await Promise.all([
      pool.query(
        `SELECT ev.from_status, ev.to_status, ev.outcome_code, ev.admin_notes,
                ev.actor_role, ev.created_at, actor.name AS actor_name
           FROM privacy_request_events ev
           LEFT JOIN users actor ON actor.id = ev.actor_user_id
          WHERE ev.request_id = $1 ORDER BY ev.created_at`,
        [req.params.id]
      ),
      // Recomputed rather than read from the row: the row's copy is from when
      // the request was made, and a claim may have closed since.
      rights.deletionBlockers(pool, row.user_id),
      pool.query(
        `SELECT action_kind, categories_erased, categories_anonymised, categories_retained,
                summary, executed_at, executed_by, executed_by_job
           FROM privacy_request_executions WHERE request_id = $1 ORDER BY executed_at`,
        [req.params.id]
      ),
    ]);

    res.json({
      request: {
        id: row.id,
        reference: row.reference,
        type: row.request_type,
        status: row.status,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        user_message: row.user_message,
        outcome_code: row.outcome_code,
        admin_notes: row.admin_notes,
        // What the requester currently reads, so an administrator can check the
        // wording rather than guess at it.
        requester_sees: row.outcome_code ? rights.OUTCOME_COPY[row.outcome_code] || null : null,
      },
      account: {
        name: row.account_name,
        email: row.account_email,
        created_at: row.account_created_at,
      },
      blockers,
      outcome_codes: rights.OUTCOMES_FOR_STATUS,
      outcome_copy: rights.OUTCOME_COPY,
      history: history.rows,
      // What this request may actually be moved to. A deletion request has a
      // shorter list than the others while erasure is not implemented, and the
      // screen is told that rather than offering a button that 409s.
      allowed_statuses:
        row.request_type === 'deletion'
          ? rights.DELETION_ALLOWED_STATUSES
          : Object.values(rights.REQUEST_STATUS).filter((s) => s !== rights.REQUEST_STATUS.SUBMITTED),
      deletion_execution_implemented: rights.DELETION_EXECUTION_IMPLEMENTED,
      // Evidence of what was actually carried out. Empty everywhere today.
      executions: executions.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/privacy-requests/:id/decision', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    res.set('Cache-Control', 'no-store');
    const {
      status,
      outcome_code: outcomeCode,
      admin_notes: adminNotes,
      version,
      // Required to complete anything. For a deletion it must name what was
      // erased, anonymised and retained; for an access or correction it must say
      // what was provided or changed. Today no deletion can reach `completed` at
      // all — see server/lib/accountRights.js.
      execution_evidence: executionEvidence,
    } = req.body || {};

    await client.query('BEGIN');
    const result = await rights.decideRequest(client, {
      requestId: req.params.id,
      toStatus: status,
      outcomeCode,
      adminNotes,
      actorUserId: req.userId,
      expectedVersion: version,
      executionEvidence,
    });
    await client.query('COMMIT');

    res.json({
      request: {
        reference: result.request.reference,
        status: result.request.status,
        outcome_code: result.request.outcome_code,
        version: result.request.version,
      },
      previous_status: result.previousStatus,
      // Stated in the response because it is the thing most likely to be
      // misread: a decision here changes a status and writes history. It does
      // not erase or anonymise anything, and no status this endpoint can set
      // today claims that it did.
      records_deleted: false,
      execution_recorded: Boolean(result.execution),
      note: 'No records were deleted by this decision. Any erasure or anonymisation is a separate, deliberate action that is not implemented — see docs/PRIVACY_AND_RIGHTS.md §8.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof rights.RightsError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code, current: err.details || null });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

module.exports = router;
