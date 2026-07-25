const express = require('express');
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

module.exports = router;
