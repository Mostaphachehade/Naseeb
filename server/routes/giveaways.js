const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

function withHostAndCount(row) {
  const host = db.prepare('SELECT name FROM users WHERE id = ?').get(row.host_id);
  const entryCount = db
    .prepare('SELECT COUNT(*) AS c FROM entries WHERE giveaway_id = ?')
    .get(row.id).c;
  return { ...row, host_name: host ? host.name : 'Unknown', entry_count: entryCount };
}

// Browse all giveaways. Active ones first, newest first.
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM giveaways
       ORDER BY (status = 'active') DESC, entry_deadline ASC`
    )
    .all();
  res.json(rows.map(withHostAndCount));
});

// Single giveaway detail, plus whether the current viewer has already entered.
router.get('/:id', optionalAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'This giveaway does not exist.' });

  let alreadyEntered = false;
  if (req.userId) {
    const entry = db
      .prepare('SELECT id FROM entries WHERE giveaway_id = ? AND user_id = ?')
      .get(req.params.id, req.userId);
    alreadyEntered = !!entry;
  }

  let winner = null;
  if (row.status === 'drawn' && row.winner_entry_id) {
    const winEntry = db
      .prepare(
        `SELECT entries.ticket_number, users.name FROM entries
         JOIN users ON users.id = entries.user_id
         WHERE entries.id = ?`
      )
      .get(row.winner_entry_id);
    if (winEntry) winner = { name: winEntry.name, ticket_number: winEntry.ticket_number };
  }

  res.json({ ...withHostAndCount(row), already_entered: alreadyEntered, winner });
});

// Create a giveaway. Requires an explicit funding disclosure so every listing
// states, in the host's own words, that the prize is a marketing cost rather
// than something paid for by entrants.
router.post('/', requireAuth, (req, res) => {
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
  db.prepare(
    `INSERT INTO giveaways
     (id, host_id, title, description, prize_description, estimated_value_aed, image_url, funded_by, entry_deadline, max_entries_per_person)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.userId,
    title.trim(),
    description.trim(),
    prize_description.trim(),
    estimated_value_aed ? Number(estimated_value_aed) : null,
    image_url ? image_url.trim() : null,
    funded_by.trim(),
    deadline.toISOString(),
    max_entries_per_person ? Number(max_entries_per_person) : 1
  );

  const row = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id);
  res.status(201).json(withHostAndCount(row));
});

// Enter a giveaway. Always free — there is no amount, no payment reference,
// nothing to charge. One entry per person per giveaway.
router.post('/:id/enter', requireAuth, (req, res) => {
  const giveaway = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!giveaway) return res.status(404).json({ error: 'This giveaway does not exist.' });
  if (giveaway.status !== 'active') {
    return res.status(400).json({ error: 'This giveaway is no longer accepting entries.' });
  }
  if (new Date(giveaway.entry_deadline) <= new Date()) {
    return res.status(400).json({ error: 'The entry deadline for this giveaway has passed.' });
  }

  const existing = db
    .prepare('SELECT id FROM entries WHERE giveaway_id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (existing) {
    return res.status(409).json({ error: "You're already entered in this giveaway. Good luck!" });
  }

  const ticketNumber =
    db.prepare('SELECT COUNT(*) AS c FROM entries WHERE giveaway_id = ?').get(req.params.id).c + 1;
  const id = uuid();
  db.prepare(
    'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES (?, ?, ?, ?)'
  ).run(id, req.params.id, req.userId, ticketNumber);

  res.status(201).json({ id, ticket_number: ticketNumber });
});

// Draw a winner. Only the host can trigger this, and only after the entry
// deadline has passed, so the pool of tickets is fixed and final before the
// random draw runs.
router.post('/:id/draw', requireAuth, (req, res) => {
  const giveaway = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!giveaway) return res.status(404).json({ error: 'This giveaway does not exist.' });
  if (giveaway.host_id !== req.userId) {
    return res.status(403).json({ error: 'Only the host of this giveaway can draw a winner.' });
  }
  if (giveaway.status !== 'active') {
    return res.status(400).json({ error: 'This giveaway has already been drawn or cancelled.' });
  }
  if (new Date(giveaway.entry_deadline) > new Date()) {
    return res.status(400).json({ error: 'You can draw a winner once the entry deadline has passed.' });
  }

  const entries = db.prepare('SELECT * FROM entries WHERE giveaway_id = ?').all(req.params.id);
  if (entries.length === 0) {
    return res.status(400).json({ error: 'No one has entered yet, so there is no one to draw.' });
  }

  const winner = entries[Math.floor(Math.random() * entries.length)];
  db.prepare("UPDATE giveaways SET status = 'drawn', winner_entry_id = ? WHERE id = ?").run(
    winner.id,
    req.params.id
  );

  const winnerUser = db.prepare('SELECT name FROM users WHERE id = ?').get(winner.user_id);
  res.json({ winner_name: winnerUser.name, winner_ticket_number: winner.ticket_number });
});

// Giveaways hosted by the signed-in user.
router.get('/mine/hosted', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM giveaways WHERE host_id = ? ORDER BY created_at DESC')
    .all(req.userId);
  res.json(rows.map(withHostAndCount));
});

// Giveaways the signed-in user has entered.
router.get('/mine/entered', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT giveaways.*, entries.ticket_number FROM entries
       JOIN giveaways ON giveaways.id = entries.giveaway_id
       WHERE entries.user_id = ?
       ORDER BY entries.created_at DESC`
    )
    .all(req.userId);
  res.json(rows.map((r) => ({ ...withHostAndCount(r), my_ticket_number: r.ticket_number })));
});

module.exports = router;
