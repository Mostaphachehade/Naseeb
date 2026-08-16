const { Pool, types } = require('pg');

// node-postgres parses DATE columns (OID 1082) into a JS Date at local
// midnight, then anything that later serializes it (JSON.stringify, our own
// .toISOString() calls) renders in UTC — on a server whose local timezone
// isn't UTC, that silently shifts the date by a day. Returning the raw
// 'YYYY-MM-DD' string instead sidesteps the whole class of bug; every DATE
// value in this app (ads.starts_at/ends_at) is meant to be a calendar day,
// never a specific instant, so there's no timezone to lose here.
types.setTypeParser(1082, (val) => val);

// Postgres connection. Works with any hosted Postgres (Neon, Supabase, Render
// Postgres, etc). Most hosted providers require SSL but use certificates that
// Node doesn't automatically trust, hence rejectUnauthorized: false below.
//
// DATABASE_SSL decides, and the host is only sniffed as a fallback for
// existing deployments that don't set it. The previous version tested the
// connection string for the literal substring 'localhost', which meant an
// otherwise identical local database addressed as 127.0.0.1 was handed an SSL
// config it couldn't honour and failed with "The server does not support SSL
// connections" — a confusing failure for anyone pointing the test suite at a
// local cluster.
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

function isLocalDatabase(connectionString) {
  if (!connectionString) return false;
  try {
    return LOCAL_DB_HOSTS.has(new URL(connectionString).hostname);
  } catch {
    return connectionString.includes('localhost');
  }
}

function sslConfig() {
  const explicit = (process.env.DATABASE_SSL || '').toLowerCase();
  if (explicit === 'false' || explicit === 'disable' || explicit === '0') return false;
  if (explicit === 'true' || explicit === 'require' || explicit === '1') {
    return { rejectUnauthorized: false };
  }
  return isLocalDatabase(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});

async function init() {
  await pool.query(`
    -- Serialises concurrent callers of init(). Postgres runs this whole
    -- multi-statement string as one implicit transaction, so the lock is held
    -- for the migration and released on commit.
    --
    -- CREATE TABLE IF NOT EXISTS is not safe against two connections creating
    -- the same table at the same instant (the loser fails on a pg_type
    -- duplicate key), and the data backfill below takes row locks while the
    -- ALTERs take table locks — which is a deadlock waiting to happen once
    -- more than one process boots against a fresh database. Test files run in
    -- parallel and each call init(), so this is a real path, not a theoretical
    -- one: it deadlocked reliably before this lock was added.
    SELECT pg_advisory_xact_lock(4519283740192837);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      is_verified_business BOOLEAN NOT NULL DEFAULT FALSE,
      email_verified BOOLEAN NOT NULL DEFAULT TRUE,
      verification_token TEXT,
      verification_token_expires TIMESTAMPTZ,
      reset_token TEXT,
      reset_token_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    -- Manually toggled by an admin after actually checking a business (trade
    -- license etc.) — no automated verification exists.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified_business BOOLEAN NOT NULL DEFAULT FALSE;
    -- Default TRUE so accounts that already existed before this column was
    -- added aren't suddenly locked out. New signups override this to FALSE
    -- explicitly in the signup route.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

    -- Whether this account may host a giveaway, and nothing else.
    --
    -- Until this existed, hosting was gated on email_verified — which answers
    -- "can we reach this person", not "may this person publish a prize draw to
    -- the public". Any address that could receive one email could create
    -- unlimited giveaways.
    --
    -- Deliberately a status on the account rather than a boolean, because the
    -- four ways of not being a host are not the same thing and the UI has to
    -- say which one applies: never asked, asked and waiting, asked and turned
    -- down, had access and lost it. Read from this table on every request that
    -- needs it — it is never carried in the JWT, which lives for 30 days and
    -- would keep asserting a status long after it changed.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS host_status TEXT NOT NULL DEFAULT 'not_requested';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS host_status_changed_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS host_status_reason TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS host_status_changed_by TEXT REFERENCES users(id);

    -- Whether the account itself may be used at all.
    --
    -- Kept strictly apart from host_status, which is authorization: losing
    -- permission to publish giveaways must not sign somebody out of the account
    -- they enter giveaways with. This one is authentication — a suspended or
    -- deactivated account holds no valid session and cannot obtain one.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status_changed_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status_reason TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status_changed_by TEXT REFERENCES users(id);

    -- One login, one family.
    --
    -- A session's token is rotated periodically, and for a grace window the
    -- replaced token still authenticates so that browser tabs mid-request are
    -- not signed out. That made "the session" ambiguous: revoking the row that
    -- happened to send a request could leave a sibling alive. A rotation that
    -- committed between a logout resolving its session and revoking it left the
    -- successor working — demonstrated, then fixed by this table.
    --
    -- The family is the logical session. It is what login creates, what logout
    -- revokes, and what holds the absolute expiry, so no amount of rotation can
    -- extend the life of one sign-in.
    CREATE TABLE IF NOT EXISTS session_families (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Set once, at login. Nothing moves it.
      absolute_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revocation_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_families_user
      ON session_families(user_id) WHERE revoked_at IS NULL;

    -- Browser sessions.
    --
    -- Authentication used to be a 30-day JWT in localStorage: readable by any
    -- script on the page, impossible to revoke, and invisible to the server,
    -- which held no record that a session existed. This table is that record.
    --
    -- token_hash holds SHA-256 of a 256-bit random token and nothing else. The
    -- raw token exists only in the Set-Cookie header and the browser's cookie
    -- jar — never here, never in a log, never in an API body, never in a URL.
    -- A dump of this table contains no credential.
    --
    -- No IP address and no user-agent string, deliberately: nothing in this
    -- application reads them, so storing them would be collecting identifiable
    -- data for nobody to look at. See server/lib/sessions.js.
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      -- CASCADE because a deleted account cannot have live sessions, and a
      -- session row that outlived its user would be an orphan nothing could
      -- authenticate anyway.
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revocation_reason TEXT,
      -- The rotation chain, in both directions, so a session's history can be
      -- followed without guessing.
      replaced_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      rotated_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      -- How long a token replaced by a rotation stays usable, so requests
      -- already in flight in another tab do not fail.
      rotation_grace_until TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    -- Which login this row belongs to. Every rotation stays inside its family.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS family_id TEXT
      REFERENCES session_families(id) ON DELETE CASCADE;

    -- Any row written before families existed becomes a family of one. This
    -- table has never been deployed, so in practice there are none — but a
    -- migration that only works on an empty table is not a migration.
    INSERT INTO session_families (id, user_id, absolute_expires_at, created_at, revoked_at, revocation_reason)
    SELECT s.id, s.user_id, s.expires_at, s.created_at, s.revoked_at, s.revocation_reason
      FROM sessions s
     WHERE s.family_id IS NULL
    ON CONFLICT (id) DO NOTHING;
    UPDATE sessions SET family_id = id WHERE family_id IS NULL;
    ALTER TABLE sessions ALTER COLUMN family_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions(family_id);

    -- The two guarantees that must not depend on application code being right.
    --
    -- One predecessor can have at most one successor: a second rotation of the
    -- same row cannot insert a rival, so a chain cannot branch.
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_session_successor
      ON sessions (rotated_from_session_id) WHERE rotated_from_session_id IS NOT NULL;
    -- And a family has at most one live member. Rotation therefore has to
    -- revoke the predecessor BEFORE inserting the successor — which is what
    -- makes a revoked family impossible to revive by racing a rotation.
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_session_family_live
      ON sessions (family_id) WHERE revoked_at IS NULL;

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
    -- Public accountability signal: the host explicitly confirms the prize
    -- was sent, shown on the giveaway page and the public Winners page.
    -- There's no escrow or enforcement behind it — it's a trust signal, not
    -- a guarantee — but an unconfirmed delivery is visible to everyone,
    -- which is the whole point.
    ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_delivered BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_delivered_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      giveaway_id TEXT NOT NULL REFERENCES giveaways(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      ticket_number INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(giveaway_id, user_id)
    );

    -- Entry integrity.
    --
    -- The UNIQUE above is the whole of what this platform can enforce about
    -- fairness: one entry per verified account per giveaway. It cannot enforce
    -- one entry per human, because it has no way to know that two verified
    -- accounts are two people — and the product does not collect identity
    -- documents to find out. Everything below exists because "we cannot prove
    -- it" and "we cannot review it" are different problems, and only the first
    -- one is unavoidable.
    --
    -- An entry is never deleted to remove it from a draw. Deleting one destroys
    -- the record that somebody entered, when, and under which account — which
    -- is exactly the evidence a disputed disqualification turns on. The entry
    -- stays; a status beside it decides whether it is drawn.
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS integrity_status TEXT NOT NULL DEFAULT 'eligible';
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS integrity_status_reason TEXT;
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS integrity_status_changed_at TIMESTAMPTZ;
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS integrity_status_changed_by TEXT REFERENCES users(id);

    -- Only rows that predate the column, and only if something left the value
    -- NULL. Deliberately not a blanket UPDATE: re-running this migration must
    -- never restore a disqualified entry to the draw pool, and a WHERE clause
    -- that matches every row would do exactly that on the next deploy.
    UPDATE entries SET integrity_status = 'eligible' WHERE integrity_status IS NULL;

    CREATE INDEX IF NOT EXISTS idx_entries_integrity
      ON entries(giveaway_id, integrity_status);

    -- Append-only history of every integrity decision.
    --
    -- Holds a reason code for machines and a written reason for people. The
    -- metadata column is for non-sensitive supporting facts only — signal
    -- categories and counts. Never an IP address, never a session identifier,
    -- never anything from a delivery address.
    CREATE TABLE IF NOT EXISTS entry_integrity_events (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      giveaway_id TEXT NOT NULL REFERENCES giveaways(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason TEXT,
      actor_user_id TEXT REFERENCES users(id),
      actor_role TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_entry_integrity_events_entry
      ON entry_integrity_events(entry_id, created_at);

    -- Risk signals: indicators, never verdicts.
    --
    -- Nothing in this table changes an entry's status. It exists so a human has
    -- something to look at, and it is built to hold as little as it can:
    -- network_hmac is a keyed hash of a *normalised* address (an IPv4 /24 or an
    -- IPv6 /48), salted with the current retention window, so the same address
    -- hashes differently after the window turns over and rows from different
    -- windows cannot be joined. The raw address is never written here, or
    -- anywhere else — see server/lib/riskSignals.js.
    CREATE TABLE IF NOT EXISTS entry_risk_signals (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      giveaway_id TEXT NOT NULL REFERENCES giveaways(id),
      signal_code TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      network_hmac TEXT,
      window_id TEXT,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entry_risk_signals_entry ON entry_risk_signals(entry_id);
    CREATE INDEX IF NOT EXISTS idx_entry_risk_signals_expiry ON entry_risk_signals(expires_at);
    CREATE INDEX IF NOT EXISTS idx_entry_risk_signals_network
      ON entry_risk_signals(network_hmac, created_at) WHERE network_hmac IS NOT NULL;

    -- An integrity case is a piece of work for an administrator.
    --
    -- Post-draw cases are the reason this is a table rather than a status: once
    -- a winner exists, a report of abuse must not quietly replace them. The case
    -- pauses fulfilment, records what was alleged and what was decided, and
    -- leaves the winner and their claim exactly where they were.
    CREATE TABLE IF NOT EXISTS entry_integrity_cases (
      id TEXT PRIMARY KEY,
      giveaway_id TEXT NOT NULL REFERENCES giveaways(id),
      entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open',
      post_draw BOOLEAN NOT NULL DEFAULT FALSE,
      opened_reason TEXT NOT NULL,
      opened_by TEXT REFERENCES users(id),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolution TEXT,
      resolution_reason TEXT,
      resolved_by TEXT REFERENCES users(id),
      resolved_at TIMESTAMPTZ
    );
    -- One open case per entry, and one open unattached case per giveaway.
    -- Opening the same case twice is then a no-op rather than a duplicate queue
    -- item, which is what makes the endpoint idempotent under a double-click.
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_integrity_case_open_entry
      ON entry_integrity_cases(entry_id) WHERE status = 'open' AND entry_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_integrity_case_open_giveaway
      ON entry_integrity_cases(giveaway_id) WHERE status = 'open' AND entry_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_integrity_cases_open
      ON entry_integrity_cases(giveaway_id, status);

    -- Applications to host during the private beta.
    --
    -- This table used to be lead capture for three paid plans that were
    -- advertised but never built: submitting it charged nothing, granted
    -- nothing, and changed nothing, while the page told applicants we would
    -- "set up billing for your plan". Hosting was meanwhile open to anyone with
    -- a verified email, so the form asked people to apply for something they
    -- already had.
    --
    -- It is now the actual gate. An application is a request, a decision is a
    -- separate deliberate act by an administrator, and only that decision moves
    -- users.host_status.
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

    -- The decision, and who made it. A decision with no reason and no name
    -- attached is not reviewable later, which is the only time anyone will
    -- want to read it.
    ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
    ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS decided_by TEXT REFERENCES users(id);
    ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS decision_reason TEXT;
    -- Old rows were submitted against the plan picker; new ones carry no plan
    -- at all, because there is nothing to buy. The column stays so the legacy
    -- rows keep saying what they actually said.
    ALTER TABLE host_applications ALTER COLUMN plan DROP NOT NULL;

    -- One open application per account, enforced by the database rather than by
    -- a read-then-write in the route: two submissions racing each other both
    -- pass a "do they already have one?" check and both insert.
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_host_application_open
      ON host_applications (user_id)
      WHERE status = 'pending' AND user_id IS NOT NULL;

    -- Every change of host access, and why. users.host_status is the current
    -- answer; this is how it got there. Nothing here is ever updated or
    -- deleted — a suspension that can be edited afterwards is not evidence of
    -- anything.
    CREATE TABLE IF NOT EXISTS host_status_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      reason TEXT,
      -- 'admin_decision', 'application', or 'migration'. Says whether a human
      -- decided this or a migration inferred it, which is the difference
      -- between a grant someone is answerable for and one nobody is.
      source TEXT NOT NULL,
      changed_by TEXT REFERENCES users(id),
      -- SET NULL rather than CASCADE: an administrator clearing an undecided
      -- application must not take the record of the status change with it.
      application_id TEXT REFERENCES host_applications(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_host_status_events_user ON host_status_events(user_id, created_at);

    -- Statuses are a closed set in the database as well as in the code, so a
    -- typo in a future migration cannot invent a sixth status that the
    -- authorization function has never heard of and therefore treats as
    -- "not approved" — or, worse, that some other code path treats as approved.
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_host_status_valid') THEN
        ALTER TABLE users ADD CONSTRAINT users_host_status_valid
          CHECK (host_status IN ('not_requested', 'pending', 'approved', 'rejected', 'suspended'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_status_valid') THEN
        ALTER TABLE users ADD CONSTRAINT users_account_status_valid
          CHECK (account_status IN ('active', 'suspended', 'deactivated'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'host_applications_status_valid') THEN
        ALTER TABLE host_applications ADD CONSTRAINT host_applications_status_valid
          CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'));
      END IF;
      -- The draw reads integrity_status = 'eligible'. An invented sixth value
      -- would silently drop entries out of the pool with nothing to notice it,
      -- so the set is closed in the database too.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entries_integrity_status_valid') THEN
        ALTER TABLE entries ADD CONSTRAINT entries_integrity_status_valid
          CHECK (integrity_status IN ('eligible', 'under_review', 'disqualified'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_integrity_events_status_valid') THEN
        ALTER TABLE entry_integrity_events ADD CONSTRAINT entry_integrity_events_status_valid
          CHECK (
            to_status IN ('eligible', 'under_review', 'disqualified')
            AND (from_status IS NULL OR from_status IN ('eligible', 'under_review', 'disqualified'))
          );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_integrity_events_actor_valid') THEN
        ALTER TABLE entry_integrity_events ADD CONSTRAINT entry_integrity_events_actor_valid
          CHECK (actor_role IN ('admin', 'system'));
      END IF;
      -- A restrictive decision or a reinstatement without a written reason is
      -- unreviewable later, so the requirement is a constraint rather than a
      -- validation somebody can forget to call. 'system' rows are the automatic
      -- ones and carry a code instead.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_integrity_events_reason_required') THEN
        ALTER TABLE entry_integrity_events ADD CONSTRAINT entry_integrity_events_reason_required
          CHECK (actor_role <> 'admin' OR (reason IS NOT NULL AND length(btrim(reason)) >= 3));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_risk_signals_severity_valid') THEN
        ALTER TABLE entry_risk_signals ADD CONSTRAINT entry_risk_signals_severity_valid
          CHECK (severity IN ('info', 'review'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_integrity_cases_status_valid') THEN
        ALTER TABLE entry_integrity_cases ADD CONSTRAINT entry_integrity_cases_status_valid
          CHECK (
            status IN ('open', 'resolved')
            AND (
              status = 'open'
              OR (resolution IN ('reinstated', 'upheld', 'no_action')
                  AND resolution_reason IS NOT NULL
                  AND length(btrim(resolution_reason)) >= 3)
            )
          );
      END IF;
    END $$;

    -- The integrity history cannot be rewritten, and that is enforced here
    -- rather than by convention. Application code that never issues an UPDATE is
    -- one refactor away from issuing one; a trigger is not.
    --
    -- UPDATE only. A row can still disappear, but only by cascade from the entry
    -- it describes — so the trail and the thing it is a trail of live and die
    -- together, and erasing an account cannot leave orphaned findings about it.
    -- Nothing in the application deletes an entry.
    CREATE OR REPLACE FUNCTION entry_integrity_events_append_only()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'entry_integrity_events is append-only; % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS entry_integrity_events_no_update ON entry_integrity_events;
    CREATE TRIGGER entry_integrity_events_no_update
      BEFORE UPDATE ON entry_integrity_events
      FOR EACH ROW EXECUTE FUNCTION entry_integrity_events_append_only();

    -- Backfill: accounts that were already hosting when approval was introduced.
    --
    -- Non-destructive and narrow on purpose. The only unambiguous fact in the
    -- old data is that an account has published at least one giveaway — those
    -- listings are live, people have entered them, and revoking the host's
    -- access would strand entrants over a migration rather than a decision.
    -- Every grant is written to host_status_events with source 'migration' and
    -- no changed_by, because no human decided it and the record should not
    -- pretend otherwise.
    --
    -- What it deliberately does NOT do:
    --   * grant anything to an account that only submitted the old paid-plan
    --     enquiry form. That form said we would set up billing, could be
    --     submitted by anyone signed in or not, and was never reviewed — it is
    --     not an application to this beta and must not be recorded as one.
    --   * touch any account whose host_status has already been set by a human
    --     (host_status_changed_at IS NOT NULL). This is the same trap the ad
    --     slot backfill fell into: re-deriving state on every boot silently
    --     reverses a deliberate admin decision on the next deploy.
    WITH granted AS (
      UPDATE users u
         SET host_status = 'approved',
             host_status_changed_at = NOW(),
             host_status_reason =
               'Migrated on introduction of host approval: this account had already published at least one giveaway.'
       WHERE u.host_status = 'not_requested'
         AND u.host_status_changed_at IS NULL
         AND EXISTS (SELECT 1 FROM giveaways g WHERE g.host_id = u.id)
      RETURNING u.id, u.host_status_reason
    )
    INSERT INTO host_status_events (id, user_id, from_status, to_status, reason, source, changed_by)
    SELECT 'migration-legacy-host-' || granted.id, granted.id, 'not_requested', 'approved',
           granted.host_status_reason, 'migration', NULL
      FROM granted
    ON CONFLICT (id) DO NOTHING;

    -- Ad inquiries: same pattern as host_applications — captures interest,
    -- billed and followed up on manually, nothing automated.
    CREATE TABLE IF NOT EXISTS ad_inquiries (
      id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      contact_phone TEXT,
      message TEXT,
      contacted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Only one ad is ever "active" at a time (single homepage banner slot),
    -- enforced in application logic, not a DB constraint. click_count is a
    -- simple running total for manual billing — there's no CPC calculator,
    -- just a number the admin can point to.
    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      image_url TEXT NOT NULL,
      target_url TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      click_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- 'image' or 'video' — tells the homepage banner whether to render an
    -- <img> or a muted autoplay <video>. image_url holds the asset URL
    -- either way (Cloudinary serves both from the same kind of secure_url).
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image';

    -- Self-serve paid bookings (Stripe Checkout) alongside the original
    -- manually-toggled admin ads. A paid booking is scheduled for a fixed
    -- date range rather than switched on/off by hand; GET /api/ads/active
    -- prefers a currently-in-window paid booking and falls back to the old
    -- active flag so manual admin ads keep working unchanged.
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS contact_email TEXT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS starts_at DATE;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS ends_at DATE;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS amount_aed NUMERIC;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_ads_stripe_session_id ON ads(stripe_session_id) WHERE stripe_session_id IS NOT NULL;

    -- Payment lifecycle, driven entirely by verified Stripe webhooks.
    --
    -- The older boolean "paid" is kept in step with this column rather than
    -- replaced: /api/ads/active, the admin revenue report and the availability
    -- calculation all read it, and quietly changing what "paid" means under
    -- them would be a worse bug than the duplication. payment_status is the
    -- detailed truth; paid is "should this banner be running and counted as
    -- revenue", which is FALSE again once money goes back out (refund) or is
    -- withdrawn pending resolution (dispute).
    --
    --   pending          booking created, no confirmed payment yet
    --   awaiting_payment session completed on a delayed payment method
    --   paid             verified payment, banner runs
    --   failed           delayed payment did not clear
    --   expired          checkout session expired unpaid
    --   refunded         money returned to the advertiser
    --   disputed         chargeback opened
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;
    -- Refunds and disputes arrive as charge events that reference a payment
    -- intent, not a checkout session, so the intent is what links them back to
    -- a booking. An identifier only — no card data is stored anywhere.
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;
    CREATE INDEX IF NOT EXISTS idx_ads_stripe_payment_intent ON ads(stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;
    -- Existing paid rows predate payment_status; without this they would read
    -- as 'pending' forever and a later refund could not be reconciled.
    UPDATE ads SET payment_status = 'paid' WHERE paid = TRUE AND payment_status = 'pending';

    -- Idempotency ledger for Stripe webhook deliveries. Stripe retries an event
    -- until it gets a 2xx, and can deliver the same event more than once even
    -- after success, so "have I already acted on this event id" has to be a
    -- durable question rather than an in-memory one.
    --
    -- The insert and the business-state update happen in one transaction: an
    -- event is never recorded as processed unless the thing it was meant to do
    -- also committed. Deliberately stores the event id and type only — never
    -- the payload, which would mean keeping customer and payment details we
    -- have no reason to hold.
    CREATE TABLE IF NOT EXISTS stripe_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Does this booking currently occupy the banner slot?
    --
    -- Kept separate from payment_status, which tracks money. The two are
    -- related but not the same question, and conflating them is how a booking
    -- ends up either holding dates it has no claim to or losing dates it paid
    -- for. A payment that arrives too late to reclaim its dates is
    -- payment_status = 'requires_reconciliation' with slot_status = 'released':
    -- real money, no slot, needs a human.
    --
    --   held      reserved while the customer is in Stripe Checkout
    --   paid      confirmed booking, banner runs on these dates
    --   released  not occupying the slot (never did, expired, or given up)
    --
    -- Defaults to 'released' so the manually-toggled admin ads — which have no
    -- dates at all — never participate in slot allocation or the exclusion
    -- constraint below.
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS slot_status TEXT NOT NULL DEFAULT 'released';
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;
    -- Why and when a booking stopped occupying the slot. Abandoned and expired
    -- reservations stay in the table with these set rather than being deleted:
    -- they are commercial records of who tried to buy what, and deleting them
    -- would erase the only evidence of a disputed or lost booking.
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS slot_released_at TIMESTAMPTZ;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS slot_release_reason TEXT;

    -- What was actually quoted, agreed and charged — in fils, as integers.
    --
    -- amount_aed (NUMERIC) stays because the revenue report and the admin
    -- panel read it, but it is derived from amount_fils rather than the other
    -- way round. Money is reconciled against these columns, never against the
    -- current owner setting: the setting is what the price is *now*, and a
    -- booking is owed exactly what it was sold at, whatever happened to the
    -- price afterwards.
    --
    -- quote_version records which price the customer was shown, so a
    -- disagreement about what someone agreed to can be answered from the row.
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS unit_price_fils BIGINT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS weeks INTEGER;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS amount_fils BIGINT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'AED';
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS quote_version TEXT;
    -- Bookings taken before these columns existed. ROUND on NUMERIC is exact —
    -- no floating point is involved in converting an existing amount to fils.
    UPDATE ads
       SET amount_fils = ROUND(amount_aed * 100)
     WHERE amount_fils IS NULL AND amount_aed IS NOT NULL;
    -- Existing paid bookings predate slot_status and would otherwise read as
    -- released, leaving their dates open to be sold twice.
    --
    -- Only rows that have never had a slot decision recorded. A booking that
    -- was explicitly released — a refund, a dispute, or an admin resolving an
    -- overlap by hand — carries a released_at and a reason, and re-claiming it
    -- here would silently overrule that. It would also undo the exact fix this
    -- migration asks an admin to make, so the next deploy would re-break the
    -- overlap they had just resolved.
    UPDATE ads
       SET slot_status = 'paid'
     WHERE paid = TRUE
       AND slot_status = 'released'
       AND slot_released_at IS NULL
       AND slot_release_reason IS NULL
       AND starts_at IS NOT NULL
       AND ends_at IS NOT NULL;

    -- entries(giveaway_id) doesn't need its own index — it's already the
    -- leading column of the UNIQUE(giveaway_id, user_id) constraint above,
    -- which Postgres can use directly for single-column lookups on it.
    CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_giveaways_host_id ON giveaways(host_id);
    CREATE INDEX IF NOT EXISTS idx_giveaways_status_deadline ON giveaways(status, entry_deadline);
    CREATE INDEX IF NOT EXISTS idx_host_applications_user_id ON host_applications(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token) WHERE verification_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;

    -- Owner-editable values that would otherwise be hard-coded — ad price,
    -- hosting plan prices shown on pricing.html, the maintenance banner.
    -- Plain key/value rather than dedicated columns since these are simple
    -- scalars with no relations of their own; see server/lib/settings.js.
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Getting the prize to the winner.
    --
    -- Previously this was one boolean on giveaways, set by the host clicking a
    -- button: the host asserting, alone and unverifiably, that they had sent
    -- the thing they promised. The winner had no way to confirm or contradict
    -- it, no way to pass on a delivery address, and no way to raise a problem.
    -- The privacy policy meanwhile told entrants that hosts could contact them,
    -- which nothing in the system made possible.
    --
    -- One claim per giveaway (UNIQUE), created when a winner is drawn.
    CREATE TABLE IF NOT EXISTS prize_claims (
      id TEXT PRIMARY KEY,
      giveaway_id TEXT NOT NULL UNIQUE REFERENCES giveaways(id),
      winner_user_id TEXT NOT NULL REFERENCES users(id),
      entry_id TEXT NOT NULL REFERENCES entries(id),
      status TEXT NOT NULL DEFAULT 'awaiting_claim',

      -- Only ever the SHA-256 of the emailed token. The token itself is not
      -- stored anywhere, so a database leak yields nothing that can be redeemed.
      token_hash TEXT,
      token_expires_at TIMESTAMPTZ,
      token_used_at TIMESTAMPTZ,
      token_issued_at TIMESTAMPTZ,

      -- Which consent wording the winner agreed to, and when. Without this a
      -- disclosure to the host cannot be justified after the fact.
      consent_version TEXT,
      consented_at TIMESTAMPTZ,

      -- AES-256-GCM. Ciphertext, per-record IV and auth tag are stored
      -- separately; key_version is what makes key rotation possible without
      -- re-encrypting every row on the day of the rotation.
      delivery_ciphertext TEXT,
      delivery_iv TEXT,
      delivery_tag TEXT,
      delivery_key_version TEXT,
      -- Set when retention erases the details. The claim survives; the address
      -- does not.
      delivery_erased_at TIMESTAMPTZ,

      claimed_at TIMESTAMPTZ,
      preparing_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ,
      delivery_reported_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      disputed_at TIMESTAMPTZ,
      disputed_by TEXT REFERENCES users(id),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT REFERENCES users(id),
      expired_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prize_claims_winner ON prize_claims(winner_user_id);
    CREATE INDEX IF NOT EXISTS idx_prize_claims_status ON prize_claims(status);
    -- Token lookup is a single indexed equality on the hash. Partial, because a
    -- used or unissued token has no hash worth indexing.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prize_claims_token_hash
      ON prize_claims(token_hash) WHERE token_hash IS NOT NULL;

    -- Who changed what, when. Deliberately holds no delivery details of its
    -- own: when retention erases an address, this history survives intact,
    -- which is the point of keeping the two apart.
    CREATE TABLE IF NOT EXISTS prize_claim_events (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES prize_claims(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_user_id TEXT REFERENCES users(id),
      actor_role TEXT NOT NULL,
      -- Short, non-sensitive: a dispute reason or an admin's resolution note.
      -- Never an address, never a phone number.
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prize_claim_events_claim ON prize_claim_events(claim_id, created_at);

    -- Claims whose host was suspended while a delivery was still in progress.
    --
    -- Suspending a host is a decision this platform makes about the host. It
    -- must not become the winner's problem to notice and repair. The first
    -- version of the host-access phase left the recovery path as "the winner
    -- raises a dispute and an administrator resolves it", which required the
    -- winner to work out that something had gone wrong internally and then use
    -- the complaints mechanism to fix it. This queue is the replacement: the
    -- moment a host is suspended, every unfinished claim of theirs lands here
    -- for a human, automatically.
    --
    -- A row is a piece of work, not a permission by itself. Whether an
    -- administrator may actually act is re-derived on every request from the
    -- host's current status and the claim's current state — a stale row grants
    -- nothing (see server/lib/claimRescue.js).
    CREATE TABLE IF NOT EXISTS claim_rescue_queue (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES prize_claims(id),
      giveaway_id TEXT NOT NULL REFERENCES giveaways(id),
      host_user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'open',
      opened_reason TEXT,
      opened_by TEXT REFERENCES users(id),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_reason TEXT,
      closed_by TEXT REFERENCES users(id),
      closed_at TIMESTAMPTZ
    );
    -- One open item per claim, enforced by the database. Suspending an already
    -- suspended host, two administrators clicking at once, or a redeem racing a
    -- suspension all collapse onto this: the insert is ON CONFLICT DO NOTHING
    -- against exactly this index.
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_claim_rescue_open
      ON claim_rescue_queue (claim_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_claim_rescue_host ON claim_rescue_queue(host_user_id, status);

    -- Whether the winner has actually been told they won.
    --
    -- The invitation is the one email the whole workflow depends on: a winner
    -- who never receives it cannot claim, and a claim nobody can act on expires
    -- into an admin queue for no reason. Sending it as an unawaited promise made
    -- a mail outage silent — the draw succeeded, the email vanished, and nothing
    -- recorded that it had.
    ALTER TABLE prize_claims ADD COLUMN IF NOT EXISTS invitation_sent_at TIMESTAMPTZ;

    -- Durable outbox for claim emails.
    --
    -- A row here is a promise that someone will be told something, kept until
    -- it is. Deliberately holds NO token: a retry issues a fresh one and
    -- invalidates its predecessor, so a leaked outbox row is not a claim link
    -- and an old link cannot be resurrected from it. last_error_category is a
    -- coarse label rather than a provider message, so a bounce reason cannot
    -- drag an address into the table.
    CREATE TABLE IF NOT EXISTS claim_notifications (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES prize_claims(id),
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error_category TEXT,
      last_attempt_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_claim_notifications_due
      ON claim_notifications(next_attempt_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_claim_notifications_claim ON claim_notifications(claim_id);

    -- Which version of which policy a person accepted, and when.
    --
    -- Starts empty and stays empty until signup captures acceptance, because no
    -- account on this platform has ever been shown a versioned policy. Nothing
    -- is backfilled: an empty table is an honest answer to "who agreed to
    -- what", and a populated one would be a fabricated answer to the same
    -- question — the kind that matters precisely when someone disputes it.
    CREATE TABLE IF NOT EXISTS policy_acceptances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      policy_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, policy_id, policy_version)
    );
    CREATE INDEX IF NOT EXISTS idx_policy_acceptances_user ON policy_acceptances(user_id);
  `);

  // Separate from the batch above because it has to inspect existing data and
  // decide whether the constraint can be applied at all — see the function.
  await ensureSlotExclusionConstraint(pool);
}

const SLOT_CONSTRAINT_NAME = 'ads_no_overlapping_slots';

// Pairs of bookings that both occupy the slot on overlapping dates.
//
// Under the current code this should always come back empty — allocation holds
// an advisory lock and the exclusion constraint refuses overlaps outright. It
// exists for the one moment that isn't covered by either: the migration that
// adds the constraint, running against data written before any of this existed.
//
// Returns identifiers and dates only. Which company booked what is not
// something to write into a server log.
async function findOverlappingSlots(client = pool) {
  const result = await client.query(
    `SELECT a.id AS booking_a, b.id AS booking_b,
            a.starts_at AS a_starts, a.ends_at AS a_ends,
            b.starts_at AS b_starts, b.ends_at AS b_ends
       FROM ads a
       JOIN ads b ON a.id < b.id
      WHERE a.slot_status IN ('held', 'paid')
        AND b.slot_status IN ('held', 'paid')
        AND a.starts_at IS NOT NULL AND a.ends_at IS NOT NULL
        AND b.starts_at IS NOT NULL AND b.ends_at IS NOT NULL
        AND daterange(a.starts_at, a.ends_at, '[]') && daterange(b.starts_at, b.ends_at, '[]')
      ORDER BY a.starts_at`
  );
  return result.rows;
}

// Adds the exclusion constraint that makes double-selling the banner slot
// impossible at the storage layer.
//
// Idempotent: checks pg_constraint first, so a redeploy against a database that
// already has it does nothing. Uses only core PostgreSQL — a GiST exclusion
// constraint over a daterange needs no extension and no superuser, so it
// applies cleanly on Neon, Supabase, Render Postgres or a plain server.
//
// If historical overlapping bookings already exist, the ALTER would fail. That
// data is not this function's to fix: those are real bookings that real
// advertisers may have paid for, and picking a winner automatically would
// destroy a commercial record and quite possibly the wrong one. It reports them
// and leaves both the rows and the decision alone. The application still starts;
// it is simply unprotected until someone resolves the conflict, which is a
// better outcome than refusing to boot the whole site.
//
// DEFERRABLE INITIALLY IMMEDIATE: behaves immediately in normal use, but lets a
// transaction opt into deferring it — which is how the migration's own tests
// stage overlapping rows without dropping the constraint for everyone else.
async function ensureSlotExclusionConstraint(client = pool) {
  const existing = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = 'ads'::regclass`,
    [SLOT_CONSTRAINT_NAME]
  );
  if (existing.rowCount > 0) {
    return { status: 'present' };
  }

  const overlaps = await findOverlappingSlots(client);
  if (overlaps.length > 0) {
    console.error(
      `Cannot add ${SLOT_CONSTRAINT_NAME}: ${overlaps.length} existing booking pair(s) already ` +
        'overlap. These are real commercial records and have been left untouched — no booking ' +
        'has been deleted, moved or overwritten. Resolve them by hand: for one side of each ' +
        'pair, set slot_status to released along with slot_released_at and a slot_release_reason ' +
        '(the reason is what stops this migration re-claiming the slot on the next deploy), then ' +
        'restart to apply the constraint. Self-serve ad checkout cannot be enabled until it ' +
        'applies. Overlapping pairs (booking ids and dates):'
    );
    overlaps.forEach((row) => {
      console.error(
        `  ${row.booking_a} [${row.a_starts} .. ${row.a_ends}] overlaps ` +
          `${row.booking_b} [${row.b_starts} .. ${row.b_ends}]`
      );
    });
    return { status: 'blocked', overlaps };
  }

  await client.query(
    `ALTER TABLE ads ADD CONSTRAINT ${SLOT_CONSTRAINT_NAME}
       EXCLUDE USING gist (daterange(starts_at, ends_at, '[]') WITH &&)
       WHERE (slot_status IN ('held', 'paid') AND starts_at IS NOT NULL AND ends_at IS NOT NULL)
       DEFERRABLE INITIALLY IMMEDIATE`
  );
  return { status: 'created' };
}

// Is the database actually enforcing non-overlapping bookings right now?
//
// Asked of the database every time it matters rather than remembered from
// startup, because "the constraint was there an hour ago" is not the same claim
// as "the constraint is there". A dropped constraint, a restored-from-backup
// database, a migration that reported 'blocked', or a connection that cannot be
// queried at all must all read as unprotected.
//
// Any failure answers false. This gate exists to stop money being taken for
// dates that might be double-sold, so the only safe response to "I could not
// check" is to behave as though the answer were no.
async function isSlotProtectionActive(client = pool) {
  try {
    const result = await client.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'ads'::regclass AND contype = 'x'`,
      [SLOT_CONSTRAINT_NAME]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error('Could not verify booking overlap protection:', err.message);
    return false;
  }
}

module.exports = {
  pool,
  init,
  findOverlappingSlots,
  ensureSlotExclusionConstraint,
  isSlotProtectionActive,
  SLOT_CONSTRAINT_NAME,
};
