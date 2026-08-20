-- 003_giveaway_lifecycle.sql
--
-- Premium prize governance and the automatic giveaway lifecycle.
--
-- Additive and idempotent. Nothing here removes a table, a column or a row:
-- every existing giveaway, entry, claim and audit record survives this migration
-- unchanged, and the backfills below are written so that re-running them cannot
-- move a campaign that has already been decided.
--
-- ---------------------------------------------------------------------------
-- Why `status` keeps its old vocabulary
-- ---------------------------------------------------------------------------
--
-- `giveaways.status` gains six new values and keeps the two it had. `'active'`
-- still means "accepting entries" and `'drawn'` still means "a winner was
-- selected", because those two strings are read in eleven places and asserted by
-- every existing test. Renaming them would be churn with no behavioural gain and
-- a real chance of missing a reader. The new states are the ones that genuinely
-- did not exist.

-- ---------------------------------------------------------------------------
-- Publication, the entry target, and the closing deadline
-- ---------------------------------------------------------------------------

-- When the campaign went live. Distinct from created_at, which is when the host
-- submitted it — under the approval workflow those are now different moments,
-- and the 30-day window runs from publication, not from submission.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- The mandatory closing deadline, as a real timestamp.
--
-- `entry_deadline` is TEXT and is compared in JavaScript with `new Date(...)`.
-- That is fine for one row in a request handler and useless for a maintenance
-- job, which has to ask the database "which campaigns are due?" — so the
-- authoritative deadline is this column, and `entry_deadline` is kept in step
-- with it for the readers that already exist.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ;

-- 100. A column rather than a constant so a campaign carries the target it was
-- published under, and a later change of policy cannot retroactively reopen or
-- close a campaign that is already running.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS entry_target INTEGER NOT NULL DEFAULT 100;

-- Closure is LATCHED, not recomputed.
--
-- This is the important one. If "is it closed?" were a live count against the
-- target, then disqualifying an entry after closure would drop the count below
-- 100 and reopen a closed campaign — which would accept an entry after closure
-- and silently extend the deadline, both of which are forbidden. So closure is
-- a fact with a timestamp and a reason, written once.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS entries_closed_at TIMESTAMPTZ;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS entries_closed_reason TEXT;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS entries_at_close INTEGER;

ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS drawn_at TIMESTAMPTZ;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS no_winner_reason TEXT;

-- Exceptional cancellation. Never an ordinary option — see the CHECK below and
-- server/lib/giveawayLifecycle.js.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS cancelled_by TEXT REFERENCES users(id);
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS cancellation_ground TEXT;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
-- What the entrants are shown. Separate from the reason, which is the internal
-- record: an administrator's account of why a campaign was stopped can name a
-- sponsor, an allegation or a legal instruction, and none of that belongs on a
-- stranger's screen.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS cancellation_public_explanation TEXT;

-- ---------------------------------------------------------------------------
-- Prize governance
-- ---------------------------------------------------------------------------
--
-- Naseeb is a curated premium-giveaway platform. Every prize is reviewed and
-- approved before publication, and these are the facts that review needs.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_category TEXT;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS sponsor_name TEXT;
-- Who actually supplies or funds it, which is not always the sponsor whose name
-- is on the campaign.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_supplied_by TEXT;
-- Genuine retail or reasonable market value. Separate from estimated_value_aed,
-- which is the older free-form field the host filled in for display.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_retail_value_aed NUMERIC;

-- Evidence that the prize exists and is committed.
--
-- Deliberately a REFERENCE and a VERDICT, not a document. Storing a sponsor's
-- invoice, purchase order or stock photograph would put third-party commercial
-- paperwork — and quite possibly personal data inside it — into this database
-- for no operational gain. What is needed later is "did somebody check, and
-- what did they check", so that is what is kept.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_evidence_kind TEXT;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_evidence_reference TEXT;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_evidence_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_evidence_verified_at TIMESTAMPTZ;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_evidence_verified_by TEXT REFERENCES users(id);

-- Custody and fulfilment. Recorded per campaign because it genuinely differs per
-- campaign, and claiming Naseeb physically holds every prize would be false for
-- a hotel stay and false for a concert ticket.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS naseeb_custody TEXT;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS fulfilment_method TEXT;
-- Geographic, booking, availability, age and validity restrictions, in the
-- words a winner will read. Public.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_restrictions TEXT;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_expiry_date DATE;

-- The approval decision itself.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES users(id);
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS rejected_by TEXT REFERENCES users(id);
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS rejection_ground TEXT;
-- Internal. Never rendered to a host, a sponsor, an entrant or any public page.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- Optimistic concurrency, the same mechanism entries and integrity cases use: a
-- decision made from a stale administrator screen is refused rather than
-- silently overwriting somebody else's.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS lifecycle_version INTEGER NOT NULL DEFAULT 0;

-- Which prize standard a campaign was published under.
--
-- 0 = published before curated prize governance existed. 1 = reviewed and
-- approved under it.
--
-- This column exists because the alternative was worse. The governance CHECK
-- constraints below require an approving administrator and verified evidence,
-- and campaigns that predate this migration have neither. Satisfying the
-- constraint for them would mean writing an approval that never happened and a
-- verification nobody performed — fabricating exactly the audit record the
-- constraint exists to guarantee. So the constraints apply from version 1, and
-- version 0 is the truthful statement that a campaign was published under the
-- old rules.
--
-- The DEFAULT is 1, not 0: a row inserted by any future code path is governed
-- unless somebody deliberately says otherwise, and the backfill immediately
-- below is the only thing that ever writes 0.
ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS prize_governance_version INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- Every campaign that exists today was published the moment it was created,
-- because there was no approval step. That is the honest value.
UPDATE giveaways SET published_at = created_at WHERE published_at IS NULL;
UPDATE giveaways SET submitted_at = created_at WHERE submitted_at IS NULL;

-- Grandfathering, done once and only for rows that already existed. `published_at
-- IS NULL` above has just been filled in, so the discriminator is the approval
-- that a pre-governance campaign cannot have: no approving administrator.
UPDATE giveaways SET prize_governance_version = 0 WHERE approved_by IS NULL;

-- The deadline a live campaign is already running to is NOT recalculated.
--
-- Recomputing it as published_at + 30 days would silently extend some campaigns
-- and silently shorten others — both forbidden, and both visible to people who
-- have already entered. The existing text deadline is parsed and kept.
-- Campaigns whose stored value is not a parseable timestamp fall back to the
-- 30-day rule, which is the only defensible guess.
UPDATE giveaways
   SET closes_at = COALESCE(
         (CASE WHEN entry_deadline ~ '^\d{4}-\d{2}-\d{2}'
               THEN entry_deadline::timestamptz
               ELSE NULL END),
         created_at + INTERVAL '30 days')
 WHERE closes_at IS NULL;

-- A campaign that has already been drawn records when, as well as it can: the
-- draw was not timestamped before this migration, so the closing deadline is
-- used and the lifecycle event below says the value is inferred. Inventing a
-- precise time that was never recorded would be worse than saying so.
UPDATE giveaways SET drawn_at = closes_at WHERE status = 'drawn' AND drawn_at IS NULL;
UPDATE giveaways
   SET entries_closed_at = closes_at,
       entries_closed_reason = 'backfilled_pre_lifecycle'
 WHERE status = 'drawn' AND entries_closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only lifecycle history
-- ---------------------------------------------------------------------------
--
-- Every closure, draw, approval, rejection and exceptional cancellation. Uses
-- the same immutability trigger function as the entry-integrity trail, so there
-- is one definition of "append-only" in this schema rather than two.
--
-- No foreign key to giveaways, deliberately, and for the same reason the
-- integrity trail has none: a cascade must never be able to remove the record
-- that something happened to a campaign.
CREATE TABLE IF NOT EXISTS giveaway_lifecycle_events (
  id TEXT PRIMARY KEY,
  giveaway_id TEXT NOT NULL,
  -- What happened. Allowlisted below.
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  -- The entrant-facing code, where there is one. Fixed wording is looked up
  -- from it in code; free text is never promoted into something a stranger
  -- reads.
  reason_code TEXT,
  -- Internal. May name a sponsor, an allegation or a legal instruction.
  admin_notes TEXT,
  actor_user_id TEXT,
  actor_role TEXT NOT NULL,
  -- Counts and identifiers only. Never a recipient, never a token.
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_giveaway_lifecycle_events_giveaway
  ON giveaway_lifecycle_events(giveaway_id, created_at);

DROP TRIGGER IF EXISTS giveaway_lifecycle_events_immutable ON giveaway_lifecycle_events;
CREATE TRIGGER giveaway_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON giveaway_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION integrity_audit_append_only();

-- ---------------------------------------------------------------------------
-- Durable giveaway notifications
-- ---------------------------------------------------------------------------
--
-- Entry receipts, winner notices and cancellation notices used to be
-- `sendEmail(...)` fired after the response and never awaited. A mail outage
-- lost them silently, and nothing recorded that anybody was owed a message.
--
-- Same design as the email-change outbox: intent persisted transactionally, a
-- lease so a crashed worker's row becomes claimable again, capped backoff, a
-- finite attempt limit and a terminal `failed` state that stays visible to an
-- administrator. Nothing retries forever.
--
-- No foreign key to giveaways or users: a cascade must not silently remove the
-- record that a notice was owed. A row whose subject has gone is cancelled by
-- the worker with a reason.
CREATE TABLE IF NOT EXISTS giveaway_notifications (
  id TEXT PRIMARY KEY,
  giveaway_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- 'entry_receipt' | 'winner_notice' | 'cancellation_notice'
  kind TEXT NOT NULL,
  -- 'pending' | 'sent' | 'failed' | 'cancelled'
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  -- A category, never a provider message: bounce text routinely quotes the
  -- recipient address back at you.
  last_error_category TEXT,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  -- One logical notification per person per giveaway per kind.
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_giveaway_notification_idempotency
  ON giveaway_notifications(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_giveaway_notifications_due
  ON giveaway_notifications(status, next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_giveaway_notifications_giveaway
  ON giveaway_notifications(giveaway_id, kind);

CREATE TABLE IF NOT EXISTS giveaway_notification_events (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  -- A category. Never a provider message, never a recipient, never a body.
  error_category TEXT,
  actor_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_giveaway_notification_events_notification
  ON giveaway_notification_events(notification_id, created_at);

DROP TRIGGER IF EXISTS giveaway_notification_events_immutable ON giveaway_notification_events;
CREATE TRIGGER giveaway_notification_events_immutable
  BEFORE UPDATE OR DELETE ON giveaway_notification_events
  FOR EACH ROW EXECUTE FUNCTION integrity_audit_append_only();

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- The lifecycle states, closed in the database as well as in code. An
  -- invented ninth value would be a campaign no reader knows how to treat.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_status_valid') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_status_valid
      CHECK (status IN (
        'pending_approval',      -- submitted, awaiting deliberate Naseeb approval
        'rejected',              -- reviewed and refused; never publishes
        'active',                -- published and accepting entries
        'closed_pending_draw',   -- entries closed, draw not yet run
        'pending_integrity_review', -- entries closed, draw postponed
        'drawn',                 -- exactly one winner selected
        'closed_no_winner',      -- closed with no eligible entry
        'cancelled'              -- exceptional cancellation only
      ));
  END IF;

  -- A published campaign has a publication time and a closing deadline. This is
  -- what makes "every published giveaway must have a deadline" a fact about the
  -- storage rather than a promise about the code.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_published_has_window') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_published_has_window
      CHECK (
        status IN ('pending_approval', 'rejected')
        OR (published_at IS NOT NULL AND closes_at IS NOT NULL)
      );
  END IF;

  -- A drawn campaign has a winner. A campaign that closed without one has a
  -- recorded reason and no winner. Neither can be half-true.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_outcome_coherent') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_outcome_coherent
      CHECK (
        (status <> 'drawn' OR (winner_entry_id IS NOT NULL AND drawn_at IS NOT NULL))
        AND (status <> 'closed_no_winner'
             OR (winner_entry_id IS NULL AND no_winner_reason IS NOT NULL))
      );
  END IF;

  -- Entries cannot be closed without saying when and why.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_closure_explained') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_closure_explained
      CHECK (
        status IN ('pending_approval', 'rejected', 'active', 'cancelled')
        OR (entries_closed_at IS NOT NULL AND entries_closed_reason IS NOT NULL)
      );
  END IF;

  -- Exceptional cancellation. The ground is an allowlist and
  -- `sponsor_withdrawal` is deliberately NOT in it: a sponsor changing their
  -- mind after publication is not a ground for cancelling a campaign people
  -- have entered, and making it unrepresentable in the database is stronger
  -- than making it unavailable in a dropdown.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_cancellation_valid') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_cancellation_valid
      CHECK (
        status <> 'cancelled'
        OR (cancelled_at IS NOT NULL
            AND cancelled_by IS NOT NULL
            AND cancellation_reason IS NOT NULL
            AND length(btrim(cancellation_reason)) >= 10
            AND cancellation_public_explanation IS NOT NULL
            AND cancellation_ground IN (
              'fulfilment_impossible',
              'unlawful',
              'fraudulent',
              'unsafe',
              'prohibited_by_authority'
            ))
      );
  END IF;

  -- Approval is a deliberate act by a named administrator at a recorded time.
  -- A published campaign cannot exist without one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_publication_approved') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_publication_approved
      CHECK (
        status IN ('pending_approval', 'rejected')
        OR prize_governance_version = 0
        OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
      );
  END IF;

  -- The curated prize standard, in the database. Publication requires a
  -- category from the approved list, a named sponsor and supplier, a value, a
  -- verified evidence verdict, and a stated custody and fulfilment method.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_prize_governed') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_prize_governed
      CHECK (
        status IN ('pending_approval', 'rejected')
        OR prize_governance_version = 0
        OR (
          prize_category IN (
            'premium_electronics',
            'luxury_stay_or_holiday',
            'designer_fashion_or_accessories',
            'fine_dining_experience',
            'beauty_and_wellness',
            'events_and_experiences',
            'home_technology_and_appliances',
            'vehicle_or_major_prize',
            'brand_voucher',
            'other_approved_premium'
          )
          AND sponsor_name IS NOT NULL
          AND prize_supplied_by IS NOT NULL
          AND prize_retail_value_aed IS NOT NULL
          AND prize_retail_value_aed > 0
          AND prize_evidence_verified = TRUE
          AND naseeb_custody IN ('naseeb_holds', 'sponsor_holds_committed', 'provider_fulfils')
          AND fulfilment_method IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_rejection_explained') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_rejection_explained
      CHECK (
        status <> 'rejected'
        OR (rejected_at IS NOT NULL AND rejected_by IS NOT NULL AND rejection_ground IS NOT NULL)
      );
  END IF;

  -- The entry target is a positive whole number. 100 today; a column so a
  -- campaign carries the number it was published under.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_governance_version_valid') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_governance_version_valid
      CHECK (prize_governance_version IN (0, 1));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaways_entry_target_valid') THEN
    ALTER TABLE giveaways ADD CONSTRAINT giveaways_entry_target_valid
      CHECK (entry_target > 0 AND entry_target <= 100000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaway_lifecycle_event_type_valid') THEN
    ALTER TABLE giveaway_lifecycle_events ADD CONSTRAINT giveaway_lifecycle_event_type_valid
      CHECK (event_type IN (
        'submitted',
        'approved',
        'rejected',
        'published',
        'entries_closed',
        'draw_postponed_pending_review',
        'drawn',
        'closed_no_winner',
        'cancelled',
        'backfilled_pre_lifecycle'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaway_lifecycle_actor_valid') THEN
    ALTER TABLE giveaway_lifecycle_events ADD CONSTRAINT giveaway_lifecycle_actor_valid
      CHECK (actor_role IN ('admin', 'host', 'system'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaway_notification_kind_valid') THEN
    ALTER TABLE giveaway_notifications ADD CONSTRAINT giveaway_notification_kind_valid
      CHECK (kind IN ('entry_receipt', 'winner_notice', 'cancellation_notice'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giveaway_notification_status_valid') THEN
    ALTER TABLE giveaway_notifications ADD CONSTRAINT giveaway_notification_status_valid
      CHECK (status IN ('pending', 'sent', 'failed', 'cancelled'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- One winner, enforced by the database
-- ---------------------------------------------------------------------------
--
-- The draw already runs inside a transaction with the giveaway row locked. This
-- is the belt to that braces: an entry may be the winning entry of at most one
-- giveaway, so no code path — present or future — can write a second winner
-- over the first and leave two "you won" notices pointing at different people.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_giveaway_winner_entry
  ON giveaways(winner_entry_id)
  WHERE winner_entry_id IS NOT NULL;

-- Campaigns the deadline job has to find. Partial, because the job only ever
-- asks about campaigns that are still open.
CREATE INDEX IF NOT EXISTS idx_giveaways_due_to_close
  ON giveaways(closes_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_giveaways_awaiting_draw
  ON giveaways(status, entries_closed_at)
  WHERE status IN ('closed_pending_draw', 'pending_integrity_review');
