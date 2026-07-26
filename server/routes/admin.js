const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

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
      pool.query("SELECT COUNT(*)::int AS c FROM host_applications WHERE contacted = FALSE"),
      pool.query("SELECT COUNT(*)::int AS c FROM ad_inquiries WHERE contacted = FALSE"),
      pool.query("SELECT COUNT(*)::int AS c FROM giveaways WHERE status = 'active'"),
      pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_verified_business) ::int AS verified FROM users"
      ),
      pool.query('SELECT business_name, click_count FROM ads WHERE active = TRUE LIMIT 1'),
    ]);

    res.json({
      pending_host_applications: pendingApps.rows[0].c,
      pending_ad_inquiries: pendingInquiries.rows[0].c,
      live_giveaways: liveGiveaways.rows[0].c,
      total_hosts: hosts.rows[0].total,
      verified_hosts: hosts.rows[0].verified,
      active_ad: activeAd.rows[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/host-applications', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM host_applications ORDER BY contacted ASC, created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.patch('/host-applications/:id', requireAdmin, async (req, res) => {
  try {
    const { contacted } = req.body;
    if (typeof contacted !== 'boolean') {
      return res.status(400).json({ error: 'contacted must be true or false.' });
    }
    const result = await pool.query(
      'UPDATE host_applications SET contacted = $1 WHERE id = $2 RETURNING *',
      [contacted, req.params.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Application not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/host-applications/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM host_applications WHERE id = $1 RETURNING id', [
      req.params.id,
    ]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Application not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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

module.exports = router;
