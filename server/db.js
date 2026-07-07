const { Pool } = require('pg');

// Postgres connection. Works with any hosted Postgres (Neon, Supabase, Render
// Postgres, etc). Most hosted providers require SSL but use certificates that
// Node doesn't automatically trust, hence rejectUnauthorized: false below.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Intentionally no price/amount/payment columns on giveaways or entries.
    -- Entry into a giveaway must always be free; prizes are funded by the host
    -- as a marketing cost, never from participant payments.
    CREATE TABLE IF NOT EXISTS giveaways (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      prize_description TEXT NOT NULL,
      estimated_value_aed REAL,
      image_url TEXT,
      funded_by TEXT NOT NULL,
      entry_deadline TEXT NOT NULL,
      max_entries_per_person INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      winner_entry_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      giveaway_id TEXT NOT NULL REFERENCES giveaways(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      ticket_number INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(giveaway_id, user_id)
    );
  `);
}

module.exports = { pool, init };
