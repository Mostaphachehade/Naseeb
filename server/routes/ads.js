const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// The currently active homepage banner ad, if any. Only one ad is ever
// active at a time — enforced when an admin activates one (see admin.js).
router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, business_name, image_url, target_url FROM ads WHERE active = TRUE LIMIT 1'
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Plain navigable link (not a fetch/api call) so a click actually counts
// before the visitor leaves for the advertiser's site.
router.get('/:id/click', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE ads SET click_count = click_count + 1 WHERE id = $1 RETURNING target_url',
      [req.params.id]
    );
    const ad = result.rows[0];
    if (!ad) return res.status(404).send('Ad not found.');
    res.redirect(302, ad.target_url);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});

module.exports = router;
