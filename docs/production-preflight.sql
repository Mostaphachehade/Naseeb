-- Production preflight — READ ONLY. Prepared, NOT executed.
--
-- ---------------------------------------------------------------------------
-- Before running this
-- ---------------------------------------------------------------------------
--
-- 1. Confirm Neon backup / point-in-time recovery is enabled, and note its
--    window and region. Nothing in this repository can verify that.
-- 2. Supply the connection through the existing secure environment — a shell
--    with DATABASE_URL already set, or the provider's own SQL console. Never
--    paste a connection string into a chat, a file, a commit or a log.
--
-- Answers the one question the deployment plan rests on: is the production
-- database actually empty? The owner reports no users or campaigns. This
-- verifies it rather than assuming it.
--
-- ---------------------------------------------------------------------------
-- What makes this safe
-- ---------------------------------------------------------------------------
--
--   * `BEGIN TRANSACTION READ ONLY` — PostgreSQL itself refuses any INSERT,
--     UPDATE, DELETE, TRUNCATE, COPY TO, CREATE, ALTER, DROP or GRANT inside
--     it. The guarantee is the server's, not this file's good intentions.
--   * `statement_timeout` — no query can sit on the database.
--   * `lock_timeout` — nothing waits behind a lock. Every statement below is a
--     plain SELECT taking only ACCESS SHARE, which blocks nothing.
--   * `idle_in_transaction_session_timeout` — an abandoned terminal cannot hold
--     a transaction open.
--   * No temporary tables, no functions, no DO blocks, no writes of any kind.
--   * `ROLLBACK` at the end. Nothing to commit; ending this way is explicit.
--
-- ---------------------------------------------------------------------------
-- If the database is completely empty
-- ---------------------------------------------------------------------------
--
-- Query 1 answers that on its own. If it reports `has_users = false`, the
-- tables do not exist yet and queries 2-6 will raise "relation does not exist",
-- which ABORTS the transaction. That is harmless — a read-only transaction that
-- aborts has changed nothing, and the abort is itself the answer: a brand new
-- database with nothing to preserve.
--
-- So: run query 1 first and read it. Run the rest only if it says the tables
-- are there.
--
-- ---------------------------------------------------------------------------
-- How to read the result
-- ---------------------------------------------------------------------------
--
-- EVERY count must be 0, and query 5 must show either no rows or exactly the
-- three known migration ids. If ANY count is non-zero, or the ledger holds an
-- id this code does not know, **STOP**. Do not migrate, do not deploy. A
-- populated database needs the verified-adoption path, the constraint-scan lock
-- behaviour in docs/RELEASE_CANDIDATE.md §3, and a confirmed backup first.

BEGIN TRANSACTION READ ONLY;

-- Bounded, and scoped to this transaction only.
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

-- 1. Does the schema exist at all?
--    If has_users is false, stop here: the database is new.
SELECT to_regclass('public.users')             IS NOT NULL AS has_users,
       to_regclass('public.giveaways')         IS NOT NULL AS has_giveaways,
       to_regclass('public.schema_migrations') IS NOT NULL AS has_ledger;

-- 2. Is there anything in it? Every column must be 0.
SELECT
  (SELECT COUNT(*) FROM users)              AS users,
  (SELECT COUNT(*) FROM giveaways)          AS giveaways,
  (SELECT COUNT(*) FROM entries)            AS entries,
  (SELECT COUNT(*) FROM prize_claims)       AS claims,
  (SELECT COUNT(*) FROM ads)                AS ads,
  (SELECT COUNT(*) FROM sessions)           AS sessions,
  (SELECT COUNT(*) FROM host_applications)  AS host_applications,
  (SELECT COUNT(*) FROM policy_acceptances) AS policy_acceptances;

-- 3. Has money ever been involved? Both must be 0.
SELECT COUNT(*) FILTER (WHERE payment_status = 'paid')        AS paid_ads,
       COUNT(*) FILTER (WHERE stripe_session_id IS NOT NULL)  AS stripe_sessions
  FROM ads;

-- 4. Any live campaign or completed draw? Both must be 0.
SELECT COUNT(*) FILTER (WHERE status = 'active') AS live_campaigns,
       COUNT(*) FILTER (WHERE status = 'drawn')  AS drawn_campaigns
  FROM giveaways;

-- 5. What has already been applied?
--    Expect either no rows, or exactly: 001_baseline, 002_schema_ledger,
--    003_giveaway_lifecycle. Any other id means the database is AHEAD of this
--    code — stop.
SELECT id, applied_by, applied_at
  FROM schema_migrations
 ORDER BY id;

-- 6. Is the schema shape anything unexpected?
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'public'
 ORDER BY table_name;

ROLLBACK;
