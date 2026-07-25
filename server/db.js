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
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      email_verified BOOLEAN NOT NULL DEFAULT TRUE,
      verification_token TEXT,
      verification_token_expires TIMESTAMPTZ,
      reset_token TEXT,
      reset_token_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    -- Default TRUE so accounts that already existed before this column was
    -- added aren't suddenly locked out. New signups override this to FALSE
    -- explicitly in the signup route.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

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

    -- Host applications aren't gating anything today (no payment processor is
    -- wired up, so anyone signed in can already create giveaways for free).
    -- This just captures company/individual intent to host on a paid plan so
    -- it can be followed up on manually.
    CREATE TABLE IF NOT EXISTS host_applications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      applicant_type TEXT NOT NULL,
      full_name TEXT NOT NULL,
      business_name TEXT,
      trade_license TEXT,
      contact_email TEXT NOT NULL,
      contact_phone TEXT,
      plan TEXT NOT NULL,
      message TEXT,
      contacted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS contacted BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}

module.exports = { pool, init };
