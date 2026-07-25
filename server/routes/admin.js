const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

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
    const { business_name, image_url, target_url } = req.body;
    if (!business_name || !business_name.trim()) {
      return res.status(400).json({ error: 'Business name is required.' });
    }
    if (!image_url || !image_url.trim()) {
      return res.status(400).json({ error: 'Image URL is required.' });
    }

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
      'INSERT INTO ads (id, business_name, image_url, target_url) VALUES ($1, $2, $3, $4)',
      [id, business_name.trim(), image_url.trim(), normalizedTargetUrl]
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

module.exports = router;
