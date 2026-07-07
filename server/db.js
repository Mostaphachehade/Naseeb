const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'naseeb.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Note: intentionally no price/amount/payment columns on giveaways or entries.
-- Entry into a giveaway must always be free; prizes are funded by the host as
-- a marketing cost, never from participant payments. See server/routes/giveaways.js.
CREATE TABLE IF NOT EXISTS giveaways (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  prize_description TEXT NOT NULL,
  estimated_value_aed REAL,
  image_url TEXT,
  funded_by TEXT NOT NULL, -- required disclosure, e.g. "Marketing budget of Acme Real Estate"
  entry_deadline TEXT NOT NULL,
  max_entries_per_person INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', -- active | drawn | cancelled
  winner_entry_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  giveaway_id TEXT NOT NULL REFERENCES giveaways(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  ticket_number INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(giveaway_id, user_id)
);
`);

module.exports = db;
