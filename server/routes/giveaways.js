const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { enterLimiter } = require('../middleware/rateLimit');
const { sendEmail, escapeHtmlForEmail } = require('../lib/email');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const router = express.Router();

const MAX_LENGTHS = {
  title: 200,
  description: 5000,
  prize_description: 2000,
  funded_by: 300,
};

async function withHostAndCount(row) {
  const hostRes = await pool.query('SELECT name, is_verified_business FROM users WHERE id = $1', [
    row.host_id,
  ]);
  const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [
    row.id,
  ]);
  return {
    ...row,
    host_name: hostRes.rows[0] ? hostRes.rows[0].name : 'Unknown',
    host_verified: hostRes.rows[0] ? hostRes.rows[0].is_verified_business : false,
    entry_count: countRes.rows[0].c,
  };
}

// Browse all giveaways. Active ones first, newest first, paginated.
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(48, Math.max(1, parseInt(req.query.pageSize, 10) || 12));
    const offset = (page - 1) * pageSize;

    const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM giveaways');
    const total = countRes.rows[0].c;

    const result = await pool.query(
      `SELECT * FROM giveaways ORDER BY (status = 'active') DESC, entry_deadline ASC LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    const items = await Promise.all(result.rows.map(withHostAndCount));
    res.json({ items, total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Homepage trust-bar numbers. Real counts only — no padding, no estimates.
router.get('/stats/summary', async (req, res) => {
  try {
    const giveawaysRes = await pool.query('SELECT COUNT(*)::int AS c FROM giveaways');
    const entriesRes = await pool.query('SELECT COUNT(*)::int AS c FROM entries');
    const valueRes = await pool.query(
      'SELECT COALESCE(SUM(estimated_value_aed), 0)::numeric AS v FROM giveaways WHERE estimated_value_aed IS NOT NULL'
    );
    res.json({
      giveaways_hosted: giveawaysRes.rows[0].c,
      entries_submitted: entriesRes.rows[0].c,
      value_listed_aed: Number(valueRes.rows[0].v),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Public winners directory. Winner name + ticket number are already shown
// on the individual giveaway page with no auth check — this just collects
// the same already-public info in one place, newest draw first.
router.get('/winners/all', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(48, Math.max(1, parseInt(req.query.pageSize, 10) || 12));
    const offset = (page - 1) * pageSize;

    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS c FROM giveaways WHERE status = 'drawn' AND winner_entry_id IS NOT NULL"
    );
    const total = countRes.rows[0].c;

    const result = await pool.query(
      `SELECT
         giveaways.id, giveaways.title, giveaways.image_url, giveaways.prize_description,
         giveaways.estimated_value_aed, giveaways.entry_deadline,
         hostuser.name AS host_name, hostuser.is_verified_business AS host_verified,
         winneruser.name AS winner_name, entries.ticket_number AS winner_ticket_number,
         (SELECT COUNT(*)::int FROM entries e2 WHERE e2.giveaway_id = giveaways.id) AS entry_count
       FROM giveaways
       JOIN users hostuser ON hostuser.id = giveaways.host_id
       JOIN entries ON entries.id = giveaways.winner_entry_id
       JOIN users winneruser ON winneruser.id = entries.user_id
       WHERE giveaways.status = 'drawn' AND giveaways.winner_entry_id IS NOT NULL
       ORDER BY giveaways.entry_deadline DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    res.json({ items: result.rows, total, page, pageSize });
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
    const verifiedRes = await pool.query('SELECT email_verified FROM users WHERE id = $1', [req.userId]);
    if (!verifiedRes.rows[0] || !verifiedRes.rows[0].email_verified) {
      return res.status(403).json({ error: 'Please verify your email before hosting a giveaway.' });
    }

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

    for (const [field, max] of Object.entries(MAX_LENGTHS)) {
      const value = { title, description, prize_description, funded_by }[field];
      if (value.trim().length > max) {
        return res.status(400).json({ error: `${field.replace(/_/g, ' ')} must be ${max} characters or fewer.` });
      }
    }

    const deadline = new Date(entry_deadline);
    if (isNaN(deadline.getTime()) || deadline <= new Date()) {
      return res.status(400).json({ error: 'Entry deadline must be a valid date in the future.' });
    }

    let value = null;
    if (estimated_value_aed !== undefined && estimated_value_aed !== null && estimated_value_aed !== '') {
      value = Number(estimated_value_aed);
      if (isNaN(value) || value < 0) {
        return res.status(400).json({ error: 'Estimated value must be a non-negative number.' });
      }
    }

    let entryCap = 1;
    if (max_entries_per_person !== undefined && max_entries_per_person !== null && max_entries_per_person !== '') {
      entryCap = Number(max_entries_per_person);
      if (!Number.isInteger(entryCap) || entryCap < 1) {
        return res.status(400).json({ error: 'Max entries per person must be a positive whole number.' });
      }
    }

    let normalizedImageUrl = null;
    if (image_url && image_url.trim()) {
      try {
        const parsed = new URL(image_url.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('bad protocol');
        }
        normalizedImageUrl = parsed.href;
      } catch {
        return res.status(400).json({ error: 'Image URL must be a valid http(s) URL.' });
      }
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
        value,
        normalizedImageUrl,
        funded_by.trim(),
        deadline.toISOString(),
        entryCap,
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
//
// Runs inside a transaction with the giveaway row locked (SELECT ... FOR
// UPDATE) so two near-simultaneous entries (or one impatient double-click)
// can't both read the same entry count and get issued the same ticket
// number — the second request blocks until the first commits, then sees
// the incremented count.
router.post('/:id/enter', enterLimiter, requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userRes = await client.query('SELECT name, email, email_verified FROM users WHERE id = $1', [
      req.userId,
    ]);
    const enteringUser = userRes.rows[0];
    if (!enteringUser || !enteringUser.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before entering a giveaway.' });
    }

    await client.query('BEGIN');

    const result = await client.query('SELECT * FROM giveaways WHERE id = $1 FOR UPDATE', [req.params.id]);
    const giveaway = result.rows[0];
    if (!giveaway) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This giveaway does not exist.' });
    }
    if (giveaway.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This giveaway is no longer accepting entries.' });
    }
    if (new Date(giveaway.entry_deadline) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The entry deadline for this giveaway has passed.' });
    }

    const existingRes = await client.query(
      'SELECT id FROM entries WHERE giveaway_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (existingRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: "You're already entered in this giveaway. Good luck!" });
    }

    const countRes = await client.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [
      req.params.id,
    ]);
    const ticketNumber = countRes.rows[0].c + 1;
    const id = uuid();
    await client.query(
      'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, $4)',
      [id, req.params.id, req.userId, ticketNumber]
    );
    await client.query('COMMIT');

    res.status(201).json({ id, ticket_number: ticketNumber });

    const giveawayUrl = `${APP_URL}/giveaway.html?id=${req.params.id}`;
    sendEmail({
      to: enteringUser.email,
      subject: `You're entered: ${giveaway.title}`,
      html: `<p>Hi ${escapeHtmlForEmail(enteringUser.name)},</p><p>You're entered in <strong>${escapeHtmlForEmail(giveaway.title)}</strong> — ticket #${ticketNumber}.</p><p>The winner is drawn at random once entries close on ${new Date(giveaway.entry_deadline).toLocaleDateString()}. Good luck!</p><p><a href="${giveawayUrl}">${giveawayUrl}</a></p>`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// Draw a winner. Only the host can trigger this, and only after the entry
// deadline has passed, so the pool of tickets is fixed and final before the
// random draw runs.
//
// Runs inside a transaction with the giveaway row locked (SELECT ... FOR
// UPDATE) so a double-clicked or double-submitted draw can't run twice
// concurrently, compute two different random winners, and have the second
// write silently overwrite the first — which would leave one "You won"
// email pointing at someone who, per the database, didn't actually win.
router.post('/:id/draw', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query('SELECT * FROM giveaways WHERE id = $1 FOR UPDATE', [req.params.id]);
    const giveaway = result.rows[0];
    if (!giveaway) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This giveaway does not exist.' });
    }
    if (giveaway.host_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the host of this giveaway can draw a winner.' });
    }
    if (giveaway.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This giveaway has already been drawn or cancelled.' });
    }
    if (new Date(giveaway.entry_deadline) > new Date()) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ error: 'You can draw a winner once the entry deadline has passed.' });
    }

    const entriesRes = await client.query('SELECT * FROM entries WHERE giveaway_id = $1', [
      req.params.id,
    ]);
    const entries = entriesRes.rows;
    if (entries.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No one has entered yet, so there is no one to draw.' });
    }

    const winner = entries[crypto.randomInt(entries.length)];
    await client.query("UPDATE giveaways SET status = 'drawn', winner_entry_id = $1 WHERE id = $2", [
      winner.id,
      req.params.id,
    ]);

    const winnerUserRes = await client.query('SELECT name, email FROM users WHERE id = $1', [
      winner.user_id,
    ]);
    const winnerUser = winnerUserRes.rows[0];
    await client.query('COMMIT');

    res.json({
      winner_name: winnerUser.name,
      winner_ticket_number: winner.ticket_number,
    });

    const giveawayUrl = `${APP_URL}/giveaway.html?id=${req.params.id}`;
    sendEmail({
      to: winnerUser.email,
      subject: `You won: ${giveaway.title}`,
      html: `<p>Hi ${escapeHtmlForEmail(winnerUser.name)},</p><p>Congratulations — you won <strong>${escapeHtmlForEmail(giveaway.title)}</strong> with ticket #${winner.ticket_number}!</p><p>The host, funded by ${escapeHtmlForEmail(giveaway.funded_by)}, will be in touch to arrange your prize.</p><p><a href="${giveawayUrl}">${giveawayUrl}</a></p>`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
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
