const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

async function withHostAndCount(row) {
  const hostRes = await pool.query('SELECT name FROM users WHERE id = $1', [row.host_id]);
  const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [
    row.id,
  ]);
  return {
    ...row,
    host_name: hostRes.rows[0] ? hostRes.rows[0].name : 'Unknown',
    entry_count: countRes.rows[0].c,
  };
}

// Browse all giveaways. Active ones first, newest first.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM giveaways ORDER BY (status = 'active') DESC, entry_deadline ASC`
    );
    const rows = await Promise.all(result.rows.map(withHostAndCount));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Single giveaway detail, plus whether the current viewer has already entered.
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM giveaways WHERE id = $1', [req.params.id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'This giveaway does not exist.' });

    let alreadyEntered = false;
    if (req.userId) {
      const entryRes = await pool.query(
        'SELECT id FROM entries WHERE giveaway_id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      alreadyEntered = entryRes.rows.length > 0;
    }

    let winner = null;
    if (row.status === 'drawn' && row.winner_entry_id) {
      const winRes = await pool.query(
        `SELECT entries.ticket_number, users.name FROM entries
         JOIN users ON users.id = entries.user_id
         WHERE entries.id = $1`,
        [row.winner_entry_id]
      );
      if (winRes.rows[0]) {
        winner = { name: winRes.rows[0].name, ticket_number: winRes.rows[0].ticket_number };
      }
    }

    const enriched = await withHostAndCount(row);
    res.json({ ...enriched, already_entered: alreadyEntered, winner });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Create a giveaway. Requires an explicit funding disclosure so every listing
// states, in the host's own words, that the prize is a marketing cost rather
// than something paid for by entrants.
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      title,
      description,
      prize_description,
      estimated_value_aed,
      image_url,
      funded_by,
      entry_deadline,
      max_entries_per_person,
    } = req.body;

    if (!title || !description || !prize_description || !funded_by || !entry_deadline) {
      return res.status(400).json({
        error:
          'Title, description, prize description, funding disclosure, and an entry deadline are all required.',
      });
    }

    const deadline = new Date(entry_deadline);
    if (isNaN(deadline.getTime()) || deadline <= new Date()) {
      return res.status(400).json({ error: 'Entry deadline must be a valid date in the future.' });
    }

    const id = uuid();
    await pool.query(
      `INSERT INTO giveaways
       (id, host_id, title, description, prize_description, estimated_value_aed, image_url, funded_by, entry_deadline, max_entries_per_person)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        req.userId,
        title.trim(),
        description.trim(),
        prize_description.trim(),
        estimated_value_aed ? Number(estimated_value_aed) : null,
        image_url ? image_url.trim() : null,
        funded_by.trim(),
        deadline.toISOString(),
        max_entries_per_person ? Number(max_entries_per_person) : 1,
      ]
    );

    const result = await pool.query('SELECT * FROM giveaways WHERE id = $1', [id]);
    const enriched = await withHostAndCount(result.rows[0]);
    res.status(201).json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Enter a giveaway. Always free — there is no amount, no payment reference,
// nothing to charge. One entry per person per giveaway.
router.post('/:id/enter', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM giveaways WHERE id = $1', [req.params.id]);
    const giveaway = result.rows[0];
    if (!giveaway) return res.status(404).json({ error: 'This giveaway does not exist.' });
    if (giveaway.status !== 'active') {
      return res.status(400).json({ error: 'This giveaway is no longer accepting entries.' });
    }
    if (new Date(giveaway.entry_deadline) <= new Date()) {
      return res.status(400).json({ error: 'The entry deadline for this giveaway has passed.' });
    }

    const existingRes = await pool.query(
      'SELECT id FROM entries WHERE giveaway_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (existingRes.rows.length > 0) {
      return res.status(409).json({ error: "You're already entered in this giveaway. Good luck!" });
    }

    const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [
      req.params.id,
    ]);
    const ticketNumber = countRes.rows[0].c + 1;
    const id = uuid();
    await pool.query(
      'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, $4)',
      [id, req.params.id, req.userId, ticketNumber]
    );

    res.status(201).json({ id, ticket_number: ticketNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Draw a winner. Only the host can trigger this, and only after the entry
// deadline has passed, so the pool of tickets is fixed and final before the
// random draw runs.
router.post('/:id/draw', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM giveaways WHERE id = $1', [req.params.id]);
    const giveaway = result.rows[0];
    if (!giveaway) return res.status(404).json({ error: 'This giveaway does not exist.' });
    if (giveaway.host_id !== req.userId) {
      return res.status(403).json({ error: 'Only the host of this giveaway can draw a winner.' });
    }
    if (giveaway.status !== 'active') {
      return res.status(400).json({ error: 'This giveaway has already been drawn or cancelled.' });
    }
    if (new Date(giveaway.entry_deadline) > new Date()) {
      return res
        .status(400)
        .json({ error: 'You can draw a winner once the entry deadline has passed.' });
    }

    const entriesRes = await pool.query('SELECT * FROM entries WHERE giveaway_id = $1', [
      req.params.id,
    ]);
    const entries = entriesRes.rows;
    if (entries.length === 0) {
      return res.status(400).json({ error: 'No one has entered yet, so there is no one to draw.' });
    }

    const winner = entries[Math.floor(Math.random() * entries.length)];
    await pool.query("UPDATE giveaways SET status = 'drawn', winner_entry_id = $1 WHERE id = $2", [
      winner.id,
      req.params.id,
    ]);

    const winnerUserRes = await pool.query('SELECT name FROM users WHERE id = $1', [winner.user_id]);
    res.json({
      winner_name: winnerUserRes.rows[0].name,
      winner_ticket_number: winner.ticket_number,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Giveaways hosted by the signed-in user.
router.get('/mine/hosted', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM giveaways WHERE host_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    const rows = await Promise.all(result.rows.map(withHostAndCount));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Giveaways the signed-in user has entered.
router.get('/mine/entered', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT giveaways.*, entries.ticket_number FROM entries
       JOIN giveaways ON giveaways.id = entries.giveaway_id
       WHERE entries.user_id = $1
       ORDER BY entries.created_at DESC`,
      [req.userId]
    );
    const rows = await Promise.all(
      result.rows.map(async (r) => {
        const enriched = await withHostAndCount(r);
        return { ...enriched, my_ticket_number: r.ticket_number };
      })
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
