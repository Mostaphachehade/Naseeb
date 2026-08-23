# Operations

How this platform starts, stays running, is maintained, is deployed and is
recovered — and which of those are engineering controls versus things only the
owner, a provider dashboard or qualified counsel can do.

Companion documents: `docs/DATA_INVENTORY.md`, `docs/PRIVACY_AND_RIGHTS.md`,
`docs/UAE_COUNSEL_REVIEW.md`, `docs/SESSIONS.md`.

**Nothing in this document has been executed against a production service.** No
Render, Neon, Stripe, Resend, Sentry or Cloudinary account was accessed. Every
verification described as *done* was done locally against an isolated test
database with fabricated data; everything else is written as a step somebody
still has to take.

---

## 1. Operational audit — what was found

### 1.1 The scheduling gap

Six maintenance functions existed. How each actually ran, before this phase:

| Function | What triggered it | Consequence |
| --- | --- | --- |
| `expireLapsedClaims` | in-process timer | stops when the process sleeps |
| `eraseExpiredDeliveryDetails` | in-process timer | **retention** stops when the process sleeps |
| claim invitation outbox | in-process timer | undelivered invitations stop being retried |
| email-change outbox | in-process timer | same, for verification and warning emails |
| `expireStaleHolds` | only a request hitting `/api/ads` | a held ad slot blocks a real booking until somebody browses |
| `purgeExpiredSignals` | only an administrator pressing a button | retention window is a hope |
| `deleteExpiredSessions` | **nothing called it** | expired session rows accumulate forever |
| `expireStaleEmailChanges` | **nothing called it** | pending changes look live forever |

Two had no caller at all. Two ran only on traffic. The four on a timer share one
flaw: the web service is on a plan where it sleeps, and **a timer inside a
sleeping process does not fire**. A retention policy that depends on somebody
browsing the site is not a retention policy.

### 1.2 Contradictions between code, README, `.env.example`, CI and `render.yaml`

| # | Contradiction | Resolution |
| --- | --- | --- |
| 1 | `render.yaml` built with `npm install`; CI with `npm ci` | Both `npm ci`. A build that may resolve outside the lockfile is not the artefact that was tested. |
| 2 | No Node version pinned anywhere except CI's `node-version: 22` | `engines.node = 22.x` in `package.json`, `NODE_VERSION` in `render.yaml`, asserted by a test. |
| 3 | `NODE_ENV`, `GA_MEASUREMENT_ID`, `SENTRY_DSN`, `DEPLOYMENT_STATE` absent from `.env.example` | All documented there now. |
| 4 | `CLAIMS_ENABLED`, `COOKIE_SECURE`, `DATABASE_SSL`, `SESSION_TTL_HOURS`, `SESSION_ROTATE_AFTER_MINUTES`, `MEDIA_ORIGIN_ALLOWLIST` absent from `render.yaml` | Optional, and now stated in §2 rather than silently defaulted. |
| 5 | Startup validation lived in five functions with three different definitions of "production" | One validator: `server/lib/config.js`. |
| 6 | `INTEGRITY_SIGNAL_SECRET`, `APP_URL` and `TRUSTED_PROXY_HOPS` were validated inconsistently or not at all | All in the matrix, all validated. |
| 7 | No health endpoint of any kind; `render.yaml` had no `healthCheckPath` | `/healthz` and `/readyz`; blueprint points at `/readyz`. |
| 8 | No graceful shutdown; SIGTERM killed in-flight requests and left leased outbox rows | Shutdown coordinator. |
| 9 | `init()` ran on every boot with nothing recording which schema was applied | Migration ledger with checksums (§6). The first version of that ledger was itself wrong twice over — it checksummed a file every phase kept editing, and it *adopted* any database with a `users` table. Both are fixed: a frozen `001_baseline.sql`, and adoption that verifies object by object or refuses. |
| 10 | No backup verification of any kind | `scripts/backup-verify.js`, run in CI. |
| 11 | `RESEND_API_KEY` was optional in production, with the consequence merely written down | Email is **required** in production, whatever the deployment state (§2). The accompanying "both outboxes retry forever" claim was also wrong and is corrected. |

### 1.3 Startup sequence, before and after

**Before:** `dotenv` → Sentry → five assert functions (each deciding
independently whether to warn or `process.exit`) → `init()` → slot check →
`listen()`.

**After:** `dotenv` → error reporting → **one** configuration validator →
`migrations.verify()` — **verify only; startup never migrates and never
adopts** → slot-constraint verification → in-process scheduler (safety net) →
`listen()` → server attached to the shutdown coordinator, which was installed
*before* any of it so a SIGTERM during a slow boot is handled by the same path.

The middle step is the one that changed twice. It was `init()` on every boot; it
became `migrate()` on every boot, which is worse, because a web process that
migrates will eventually boot against a database somebody did not expect and
change it. It is now a read: the process verifies and fails readiness, and the
schema is changed by a person running `scripts/migrate.js` (§6).

### 1.4 Still true, and not fixed here

- The web process and the maintenance jobs are the only processes. There is no
  separate worker service; the jobs are cron invocations of the same image.
- Rollback is a Render dashboard action. There is no scripted rollback, and
  there is deliberately no automatic destructive schema rollback (§6).
- Backup configuration at the provider is unverified (§8).
- The schema is brought forward by a person, before the deploy. That is
  deliberate (§6, §9.2), but it does mean a deploy and a schema change are two
  steps rather than one, and forgetting the first shows up as a 503 on
  `/readyz` rather than as a broken site.
- The email provider's *deliverability* is not verified here. Configuration is
  shape-checked and no provider call is made at startup; whether a message
  actually arrives is only observable once the owner has verified a sender
  domain and sent one.

---

## 2. Configuration matrix

Authoritative source: `VARIABLES` in `server/lib/config.js`. This table is a
rendering of it; the code is what validates.

**Classifications:** *always* = every environment · *production* = required in
production · *conditional* = required only while a feature is on · *optional* =
system is complete without it · *forbidden in tests* = stripped by `testEnv.js`.

**Exposure:** *secret* = must never appear in a log, an error, a response or a
committed file · *public* = safe to print and commit.

| Variable | Class | Exposure | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | always | secret | Contains credentials. Production refuses a name containing `test`. |
| `SESSION_SECRET` | always | secret | No default, no fallback. Refused if short, placeholder-shaped, low-entropy, or equal to another variable. |
| `NODE_ENV` | production | public | Selects strict validation, HSTS, and refusal of the dev mail logger. |
| `APP_URL` | production | public | Must be `https://` and not placeholder-shaped. |
| `TRUSTED_PROXY_HOPS` | production | public | `1` behind Render. Warned if unset in production; too high makes every rate limit spoofable. |
| `INTEGRITY_SIGNAL_SECRET` | production | secret | Keys the coarsened network hashes. |
| `CLAIM_ENCRYPTION_KEY` | conditional (`CLAIMS_ENABLED`) | secret | **Back up separately from the database** — §8. |
| `STRIPE_SECRET_KEY` | conditional (`ADS_CHECKOUT_ENABLED`) | secret | Unused and warned about while checkout is off. |
| `STRIPE_WEBHOOK_SECRET` | conditional (`ADS_CHECKOUT_ENABLED`) | secret | Per-environment signing secret, not the API key. |
| `RESEND_API_KEY` | **production** | secret | Required. Verification, recovery, claims and security warnings all depend on it. |
| `EMAIL_FROM` | **production** | public | Required, shape-validated. The provider's shared onboarding domain and reserved example domains are refused. |
| `EMAIL_DELIVERY_ENABLED` | optional | public | Temporary maintenance mode. **Defaults ON.** Refused at public launch. |
| `NOTIFICATION_FAILURE_THRESHOLD` | optional | public | Terminal failures in 24h before readiness reports degraded. Default 5. |
| `SENTRY_DSN` | optional | secret | Consequence if unset: nothing alerts. |
| `GA_MEASUREMENT_ID` | optional | public | Consequence if unset: no traffic measurement. |
| `CLOUDINARY_CLOUD_NAME` / `_UPLOAD_PRESET` | optional | public | Without them, hosts paste an image URL. |
| `ADMIN_NOTIFY_EMAIL` | optional | public | Where new host applications are announced. |
| `MEDIA_ORIGIN_ALLOWLIST` | optional | public | Extra image origins for the CSP and validators. |
| `COOKIE_SECURE` | optional | public | `false` is refused in production. |
| `DATABASE_SSL` | optional | public | `false` is refused in production. |
| `CLAIMS_ENABLED` | optional | public | Defaults on. |
| `ADS_CHECKOUT_ENABLED` | optional | public | Defaults **off**; pinned `false` in `render.yaml`. |
| `SESSION_TTL_HOURS`, `SESSION_ROTATE_AFTER_MINUTES` | optional | public | Range-validated. |
| `CLAIM_TOKEN_TTL_HOURS`, `CLAIM_DELIVERY_RETENTION_DAYS`, `INTEGRITY_SIGNAL_RETENTION_DAYS` | optional | public | Range-validated. Provisional pending counsel. |
| `DEPLOYMENT_STATE` | optional | public | §3. Never `public_launch` in a committed file. |
| `MAINTENANCE_BATCH_LIMIT`, `SHUTDOWN_TIMEOUT_MS` | optional | public | Range-validated. |
| `CLAIM_DEV_LOG_LINKS` | forbidden in tests | public | **Refused outright in production** — it prints working claim links. |
| `ALLOW_REMOTE_TEST_DB` | forbidden in tests | public | Deliberately awkward opt-in for a non-local test database. |

### Email is required; Sentry and analytics are optional

`SENTRY_DSN` and `GA_MEASUREMENT_ID` are optional by design and production
**warns rather than refuses**. `RESEND_API_KEY` and `EMAIL_FROM` are **not
optional** — see below. The consequences, stated so nobody discovers them:

- **`RESEND_API_KEY` is REQUIRED in production.** It used to be optional with
  the consequence written down; that was wrong. Verification, password
  recovery, claim invitations, email-change verification and the old-address
  security warning are core workflows, and a process that starts without them
  and reports itself healthy is lying. Production now refuses to start.

  The earlier note also said the outboxes would "retry forever". **They do
  not**, and the correction matters: both have a finite attempt limit
  (`MAX_ATTEMPTS`) and a terminal `failed` state, after which they stop and
  escalate to the administrator queue. With no provider configured, every
  attempt is consumed against a send that cannot succeed and the notification
  reaches terminal failure — recoverable, visible, and now reported by
  readiness as a `notifications` category.
- **`EMAIL_FROM` is REQUIRED in production and shape-validated.** The provider
  requires a verified domain, and a `From` it will reject makes every send fail
  — a failure that shows up as a mysterious outbox rather than as
  configuration. The shared onboarding domain (`resend.dev`), the reserved
  example domains and anything without a deliverable domain are refused. The
  value is validated by shape and **never printed, logged or echoed**. No
  provider call is made at startup, ever: that would make every boot depend on
  somebody else's uptime and every slow response into a failed deploy.
- **`EMAIL_DELIVERY_ENABLED=false` is a deliberate, temporary maintenance
  mode** for a planned provider migration. It defaults **on** — an unset,
  empty or misspelled value can only mean "email is expected to work", never
  "quietly stop sending". While it is off, signup, resend-verification,
  password reset, email change, the winner draw and claim-invitation reissue
  each return **503 `EMAIL_DELIVERY_UNAVAILABLE`** with `Retry-After: 300`
  **before creating the state that email was supposed to complete** — so nobody
  ends up with an unverifiable account whose address is now taken, a pending
  change that blocks the next attempt, a live reset token nobody asked for, or
  a winner who can never be told they won. Existing signed-in sessions are
  untouched, and the UI shows a truthful temporary-unavailability banner. It is
  refused outright at public launch.
- **No `SENTRY_DSN`: nothing alerts.** Errors reach the platform log only,
  which means a failure at 3am is discovered by somebody noticing.
- **No `GA_MEASUREMENT_ID`: no traffic measurement.** Harmless.

### Rules the validator enforces

- Errors name the **variable**, never the value — not a prefix, not a length
  beyond "shorter than N", not a hash.
- Production fails **before** `listen()`.
- A disabled feature demands nothing.
- No insecure production fallback: no secret is defaulted, borrowed or
  downgraded.
- `testEnv.js` strips production-shaped credentials and refuses a remote or
  non-test database.

---

## 3. Deployment state versus public launch

### The state is a GATE, not a label

`DEPLOYMENT_STATE` used to be informational: it chose an `X-Robots-Tag`, a
banner and a line in `/readyz`, and gated no behaviour at all. A deployment could
describe itself as a private beta while accepting registrations, publishing
campaigns, taking entries and running draws. It is now the gate.

| State | Operations | Meaning |
| --- | --- | --- |
| `development` | allowed | Local, and the test suite |
| `staging` | allowed | Fabricated data, not public |
| `pre_launch` | **REFUSED** | Publicly reachable, deliberately not operating |
| `private_beta` | refused while any launch blocker stands | Real activity |
| `public_launch` | refused while any launch blocker stands | Real activity |

`server/lib/config.js` `operationsAllowed()` is the single predicate;
`refuseIfPreLaunch()` is what the routes call. Registration, campaign
submission, publication, entry, the draw, starting a claim and the unattended
lifecycle worker all refuse with **503 `NOT_OPEN_YET`** and write nothing.

**Production defaults to `pre_launch` when the variable is unset or
misspelled.** It used to default to `private_beta`, which reads as cautious and
is not — a private beta accepts real registrations and real entries, so a
missing environment variable would have opened the platform by omission.

There is deliberately **no administrator bypass**: approval and publication are
refused for administrators too. An exemption for the one role that could use it
is the hole the gate exists to close. Exercise the workflow locally, or in a
deployment explicitly set to `staging`.

See `docs/RELEASE_CANDIDATE.md` for the deployment checklist this produces.



Technical deployment and public launch are different decisions.
`DEPLOYMENT_STATE` is one of `development`, `staging`, `pre_launch`,
`private_beta`, `public_launch`.

**Unset or misspelled means `pre_launch`, everywhere.** This paragraph used to
say `private_beta` in production, and that was left behind when the default was
tightened — worth naming rather than quietly correcting, because a stale
statement about a fail-closed default is the kind that gets believed. There is no
inference from `NODE_ENV`, and `public_launch` is never reached by omission.

A staging or private-beta deployment **must identify itself truthfully**:
`config.stateDisclosure()` returns the wording, it is logged at boot, and
`/readyz` reports the state. Nothing may describe such an environment as
approved or production-ready.

**`public_launch` fails startup validation today**, and will keep failing while
any of these is true — each checked, not asserted:

- either policy is not `effective`;
- either policy has no explicit effective date;
- any policy blocker is outstanding (owner information, counsel review);
- checkout is enabled without `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`;
- claims are enabled while claim encryption is unavailable.

`render.yaml` pins `DEPLOYMENT_STATE: pre_launch`. **No committed file sets
`public_launch`.**

---

## 4. Maintenance schedule

Command: `node scripts/maintenance.js <job|all> [--limit N]`

| Exit | Meaning |
| --- | --- |
| 0 | Ran. **Includes "there was nothing to do"** (`idle: true`). |
| 1 | At least one job failed. |
| 2 | Bad arguments. Nothing ran. |

Output is one JSON object on stdout — counts and durations only. No address, no
token, no row content, no connection string. Human text goes to stderr.

Every job: a Postgres advisory lock (a second worker reports `skipped`, which is
a success), bounded batches (`MAINTENANCE_BATCH_LIMIT`, default 500),
idempotent, and stops cleanly on SIGTERM **between batches** rather than
mid-transaction.

| Job | What it does | Lock key |
| --- | --- | --- |
| `sessions` | Removes expired session families | 811001 |
| `risk_signals` | Purges risk signals past retention | 811002 |
| `claims` | Expires lapsed claims; **erases delivery addresses past retention** | 811003 |
| `claim_outbox` | Retries undelivered claim invitations | 811004 |
| `email_change_outbox` | Sends/retries verification and old-address warnings | 811005 |
| `email_changes` | Marks expired pending email changes | 811006 |
| `ad_holds` | Releases unpaid ad-slot holds | 811007 |
| `giveaway_lifecycle` | **Closes campaigns whose 30-day deadline has passed, and draws every campaign that is closed and unblocked** | 811008 |
| `giveaway_outbox` | Sends/retries entry receipts, winner notices and cancellation notices | 811009 |

`giveaway_lifecycle` is the job that makes the closing deadline real. Before it,
a campaign closed when a host remembered to press "draw" — so a host who lost
interest left entrants waiting indefinitely, and on a plan where the web service
sleeps an in-process timer would not have fired anyway.

Its idempotence comes from the state model rather than from bookkeeping: closure
is a **latch** (`entries_closed_at` is written once), and the draw refuses any
campaign already resolved. A retried run after a crash finds the work done and
reports zeros. It also picks up campaigns postponed by an integrity review on an
earlier run, which is how "resolving the review resumes the draw" works
operationally — no separate trigger, just the next pass.

### Schedule (UTC, with Dubai UTC+4)

| Command | Cron (UTC) | UTC | Dubai | Why |
| --- | --- | --- | --- | --- |
| `maintenance.js all` | `*/15 * * * *` | every 15m | every 15m | Outboxes: a verification email must not wait an hour. Also closes and draws campaigns within 15 minutes of their deadline |
| `maintenance.js giveaway_lifecycle giveaway_outbox` | `7 * * * *` | hourly | hourly | Deliberate redundancy: if the frequent job is failing, a campaign whose deadline passed still closes and draws |
| `maintenance.js claims` | `17 * * * *` | hourly | hourly | Retention erasure and claim expiry |
| `maintenance.js sessions risk_signals` | `23 3 * * *` | 03:23 | 07:23 | Housekeeping and retention purge, off-peak |

A campaign therefore closes within **15 minutes** of its deadline in the normal
case, and within an hour if the frequent job is down. It closes *exactly* on the
100th accepted entry, with no delay at all, because that closure happens inside
the entry's own transaction rather than on a schedule.

`all` already covers every job. The dedicated entries are deliberate redundancy:
if the frequent job is failing and nobody has noticed, retention still runs on
its own schedule.

**Ordering does not matter for correctness.** The advisory locks are the
correctness boundary; two crons firing at once produce one worker and one
`skipped`. The stagger is for load.

**Web-service sleep cannot prevent maintenance**: these are platform crons, not
in-process timers. The in-process scheduler still exists and is now explicitly a
*safety net*.

**Manual dashboard steps** (this repository creates nothing) are listed at the
bottom of `render.yaml`. If the plan does not include cron jobs, that is a
commercial decision for the owner — and until it is made, **retention is not
running on a schedule**, which is a fact to record rather than paper over.

### Scheduling status, verified 2026-08-21

Checked against Render's own documentation rather than assumed. Three findings,
two of which corrected what this repository previously said.

**Cron is available to this account, and cost is the only obstacle.** Cron jobs
cannot run on a *Free* instance, but they are separate services with their own
instance type, and the `naseeb` web service is on **Starter**, not Free. Each
cron job bills at a **minimum of $1/month**, prorated by the second. The earlier
note implying the plan made cron impossible was wrong; `render.yaml` also
declared `plan: free` for a web service that is actually Starter, and that has
been corrected.

**The previous blueprint draft would not have worked.** It nested cron entries
under a top-level `jobs:` key. There is no such key in a Render blueprint — cron
jobs are services, declared in the `services:` list with `type: cron` and a
`schedule`. Uncommenting it as written would have failed the sync. Corrected in
`render.yaml`, and still commented.

**Committing `render.yaml` provisions nothing.** A Blueprint must be created and
synced from the dashboard, CLI or API, and no Blueprint is synced for this
repository. The cron definitions stay commented so that even an accidental
future sync cannot create billable services. Activation is two deliberate acts:
uncomment, then sync.

#### What to create

| Service | Command | Schedule (UTC) | Dubai | Timeout |
| --- | --- | --- | --- | --- |
| `naseeb-maintenance` | `node scripts/maintenance.js all` | `*/15 * * * *` | every 15m | 10 min |
| `naseeb-giveaway-lifecycle` | `node scripts/maintenance.js giveaway_lifecycle giveaway_outbox` | `7 * * * *` | hourly :07 | 10 min |
| `naseeb-retention-daily` | `node scripts/maintenance.js sessions risk_signals claims` | `23 3 * * *` | 07:23 | 15 min |

**Minimum viable is one service** — `all` covers every job, so
`naseeb-maintenance` alone is a complete schedule (~$1/month plus runtime). The
other two are redundancy: they keep the lifecycle and retention jobs running on
their own cadence if the frequent job is failing and nobody has noticed. Three
services is the recommendation; one is the floor. **Zero is what exists today.**

Retry and alerting: Render surfaces a non-zero cron exit as a failed run. Every
job is idempotent and advisory-locked, so a retry is always safe and overlapping
runs collapse to one worker plus a `skipped`. No retry logic belongs in the job.

Emergency manual equivalents, safe to run at any time:

```
node scripts/maintenance.js --list
node scripts/maintenance.js all
node scripts/maintenance.js claim_outbox email_change_outbox giveaway_outbox
node scripts/maintenance.js sessions risk_signals claims
```

#### Environment

`fromGroup: naseeb-shared` assumes an environment group that **does not exist
yet** — the web service holds its variables directly. Creating it, or setting
variables on each cron service, is an owner action. A cron service that runs any
outbox job needs `RESEND_API_KEY` and `EMAIL_FROM`: **the outboxes send email**,
and without them those jobs cannot deliver.

#### Consequence of doing nothing

No maintenance job runs in production at all. Expired sessions are never swept,
both outboxes never drain, claims never expire, delivery addresses are never
erased on schedule, risk signals are never purged, ad holds are never released,
and a campaign that reaches its deadline is never closed or drawn by anything
other than a visitor happening to trigger it. This is tracked as the largest
operational gap in `docs/LAUNCH_READINESS.md` §2.

---

## 5. Liveness and readiness

| Endpoint | Checks | Depends on the database |
| --- | --- | --- |
| `GET /healthz` | Process is alive | **No** |
| `GET /readyz` | Configuration, database connectivity, schema version, migration checksums, critical constraints and triggers | Yes |

Liveness deliberately does **not** touch the database. If it did, a database
outage would make every instance look dead, the platform would restart them all,
and a recoverable incident would become a restart loop that cannot recover —
because the thing being restarted is not the thing that is broken.

Readiness returns **503** during a dependency or schema failure, and during
shutdown (`{"status":"draining"}`). Both are `no-store` and `nosniff` and carry
the full security-header stack.

**A failing readiness response contains categories only** — `configuration`,
`database`, `schema`, `notifications`, `internal`. No database host or name, no
table, column or constraint names, no connection string, no variable names or
values, no stack trace, no driver message. The detail goes to the process log
and through the sanitised error reporter. A successful response carries the
schema version and the deployment state, which is what a rollout needs and what
this repository publishes anyway.

`notifications` covers the two ways mandatory delivery fails: nothing is
configured to send (including the `EMAIL_DELIVERY_ENABLED=false` maintenance
mode), or terminally failed notifications in the last 24 hours have reached
`NOTIFICATION_FAILURE_THRESHOLD` (default 5) — messages people are waiting on
are not arriving even though the provider is configured. The threshold is not
zero: one address that hard-bounces is a customer-service matter, a cluster of
them is an outage. **No recipient, provider error, subject, body or count
appears in the response.**

Neither endpoint creates a session, writes a row, or mutates anything.

---

## 6. Schema migrations

`server/lib/migrations.js`, `server/lib/schemaVerify.js`, `scripts/migrate.js`.
Current `SCHEMA_VERSION`: **0002**.

### What the first version got wrong

Two things, both of which the audit caught:

1. **The baseline was a file people edit.** `0001_baseline` *was* `db.init()`'s
   template literal, and every feature phase appended to it. Checksumming a file
   somebody keeps editing records only that it changed again.
2. **Adoption was a guess.** A database with a `users` table was recorded as
   fully migrated on the strength of one `to_regclass`. A database missing a
   column, a CHECK or an append-only trigger would be marked done — and the
   paper trail is the dangerous part, because afterwards nothing ever checks
   again.

### The frozen baseline

`server/migrations/001_baseline.sql` — **1,337 lines, frozen, never edited.**
Its header says so. `server/db.js` reads the file and runs it; the SHA-256 of
its bytes is the checksum recorded in every database's `schema_migrations` row.
Editing a byte — a column, a comment, a trailing newline — changes the checksum
and is detected on the next run and on every readiness check.

Everything after it is `002_schema_ledger.sql`, `003_…`, `004_…`. **Nothing is
ever added to `001`.**

| File | Purpose |
| --- | --- |
| `server/migrations/001_baseline.sql` | The schema as it stood when the ledger was introduced. Idempotent. Frozen. |
| `server/migrations/002_schema_ledger.sql` | Records that the ledger is live. Adds no table, column or constraint and touches no data. |
| `server/migrations/003_giveaway_lifecycle.sql` | Premium prize governance and the automatic giveaway lifecycle. Additive: adds columns, two append-only tables, CHECK constraints and indexes. Removes nothing. |
| `server/migrations/expected-schema.json` | A committed snapshot of the schema the baseline produces. Regenerated with `npm run schema:snapshot`. |

### The expected-schema snapshot

Verification is an object-by-object comparison against that committed snapshot:
tables, columns, data types, nullability, defaults, primary and unique keys,
indexes, foreign-key actions (including `ON DELETE`), CHECK constraints,
exclusion constraints, triggers, functions and extensions.

The first attempt built the reference on the fly, by running the baseline into a
scratch schema in the same database. It does not work, and the reason is worth
recording: the baseline's idempotence checks are name-only —
`IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '…')`. `conname` is not
unique across schemas, so a check running inside a scratch schema sees the *real*
schema's constraint, concludes the object exists, and then issues an `ALTER`
against a table that does not have it yet. A perfectly healthy database fails
its own verification.

A committed snapshot has none of that: verification is a pure read of the
catalogue compared against a file, needs no `CREATE` privilege, cannot perturb
the database it is checking, and is identical every time. Its one cost is that
it must be regenerated when the schema changes — which `sm3` enforces by
comparing it against a live, freshly-built database on every test run.

Two things are deliberately outside the comparison:

- **`schema_migrations`.** The ledger's own table, created by `ensureLedger`.
  Including it would make the snapshot disagree with itself depending on whether
  the ledger had run yet.
- **`ads_no_overlapping_slots`** and its backing index — the one *data-dependent*
  object. See below.

### The one data-dependent object

`ads_no_overlapping_slots` is a GiST exclusion constraint over booked banner
dates. On a database that already contains overlapping bookings written before
it existed, PostgreSQL will not add it — and the right response is emphatically
**not** to delete or move one of them. Those are commercial records somebody may
have paid for, and picking a survivor automatically would destroy the wrong one
about half the time.

So its absence is reported separately from a schema mismatch:

| Situation | Result |
| --- | --- |
| Present | Normal. Checkout may be enabled. |
| Absent, **and** overlapping bookings exist | The schema is otherwise correct. `migrate up` reports `slot_protection: "blocked"` and lists the conflicting pairs **by id and date only**. Adoption is allowed. Self-serve ad checkout stays refused (`server/routes/ads.js` asks `isSlotProtectionActive()` before taking money). |
| Absent, **and no** data conflict | A genuinely unprotected database. **Adoption refuses** (`slot_protection_missing`) and writes no ledger row. `migrate up` adds the constraint. |

No overlapping booking is ever deleted, moved, released or silently resolved.
Resolving one is a human decision, documented in §9.13.

### The two safe paths onto the ledger

```
node scripts/migrate.js status            # what the ledger says, and what the schema is
node scripts/migrate.js verify            # read-only comparison. Changes nothing.
node scripts/migrate.js adopt --dry-run   # verify as if adopting, write nothing
node scripts/migrate.js adopt             # record an ALREADY-MATCHING schema
node scripts/migrate.js up                # execute pending migrations, then verify
```

Exit codes: `0` success, `1` failure or verification failure, `2` bad arguments.

**Verified adoption** — for a database whose schema already equals the baseline.
Read-only verification first; the ledger row is written **only** if every
expected object matches. It is recorded as `applied_by = 'adopted'`, never as
executed, alongside the SHA-256 fingerprint of the schema that was verified. On
any difference it refuses, prints **object names only** (a CHECK definition can
quote a value, and this reaches a log) and writes nothing.

**Baseline execution** — for an empty or older database. Runs the idempotent
baseline under the advisory lock, applies the data-dependent constraint, verifies
the full schema afterwards, and records the migration as `applied_by = 'migrate'`
**only after** it succeeded. Each migration is its own transaction with its
ledger row written inside it, so a failure rolls the DDL back and records
nothing: a partial migration is never marked applied.

### Web startup does neither

`server/index.js` calls `migrations.verify(pool)` and **fails readiness**. It
does not migrate, does not adopt, and does not mutate an unknown database. A web
process that migrates on boot will, sooner or later, boot against a database
somebody did not expect — a restored copy, a rolled-back deploy, a staging URL
pasted into the wrong environment — and change it.

Changing a schema is a thing a person runs, having read what it is about to do.

### Guarantees

- **Ordered and idempotent.** `isOrdered()` is asserted before anything runs;
  every migration may run against a database where it has already had its
  effect.
- **Concurrent deploys cannot double-apply.** One blocking advisory lock
  (`918273645`) around the whole run; a second attempt waits and finds the work
  done. Proved with three simultaneous runs against one database (`sm11`).
- **An edited historical migration is detected.** The checksum recorded at
  application time is compared on every run and every readiness check. A
  mismatch is a hard failure, not a warning.
- **A schema ahead of the code fails readiness.** An unknown ledger id means a
  rollback left the database newer than the process — the case nobody tested.
- **A missing migration fails readiness**, as does a missing ledger table.
- **No automatic destructive rollback.** There is no `down`. Reversing a
  migration is a new migration, written deliberately. No migration body may
  contain `DROP TABLE`, `TRUNCATE` or `DELETE FROM`; only the frozen baseline
  contains a `DROP COLUMN`, and it copies the content elsewhere first.
- **The test reset is not the production path.** `scripts/reset-test-db.js`
  drops the schema — which nothing in production may ever do — and refuses
  anything that is not an isolated test database. It then runs the same
  migrations so readiness can be exercised against a realistic ledger.

### Realistic pre-ledger upgrades

`test/schema-migration.test.js` builds seven fabricated database shapes, each in
its own throwaway PostgreSQL database, and proves twelve things against them.
Every row is invented; nothing there resembles a real advertiser, host or
entrant. See §12 for the results.

---

## 7. Graceful shutdown

`server/lib/shutdown.js`. On `SIGTERM` or `SIGINT`, in order:

1. readiness → false (the load balancer stops sending traffic **before**
   anything is torn down);
2. the scheduler stops; `mayStartWork()` becomes false so no new background work
   begins;
3. the HTTP server stops accepting and in-flight requests finish;
4. leased outbox drains settle;
5. the pool closes;
6. exit **0** if all of that finished inside `SHUTDOWN_TIMEOUT_MS` (default
   20000), **1** if it did not.

A hung shutdown that reports success is a deploy that looks healthy while a
connection leaks, which is why the timeout exits non-zero.

Repeat signals join the shutdown already running rather than starting a
competing one. The exit is an injected callback, so the sequence is driven and
asserted in tests rather than by calling `process.exit` and ending the runner.

---

## 8. Backup and restore

### What is verified locally

`npm run backup:verify` — guarded three ways (the `testEnv` guard, an
independent database-name check, and a refusal to write outside a temp directory
it created). It seeds fabricated data, `pg_dump`s, creates a **new** temporary
database, `pg_restore`s into it, and asserts:

- row counts match across ten tables;
- all five critical constraints and all six append-only triggers restored;
- `DELETE FROM privacy_requests` is still refused **in the restore**;
- integrity history is still append-only in the restore;
- the delivery payload is **still ciphertext** (the fabricated address does not
  appear in the stored value) **and** still decrypts with the test key;
- the migration ledger came with it.

Then it drops the temporary database and removes the dump. Runs in CI as the
`operations` job.

**This proves the mechanism, not the production backup.**

### What only the owner can do

| Action | Who |
| --- | --- |
| Confirm Neon's backup/PITR is enabled, its retention window, and its region | **Owner**, in the Neon dashboard |
| Authorise a production restore | **Owner** — never an engineer acting alone |
| Perform a production restore | Owner, with an engineer |
| Confirm the encryption key backup exists and is readable | **Owner** |

**A backup is not proven until a restore test succeeds.** A dump that has never
been restored is a file, not a backup.

**Restoration must be tested at least quarterly**, and after any schema change
that adds a constraint or a trigger, against a scratch database — never over the
live one.

### Encryption keys

`CLAIM_ENCRYPTION_KEY` is **not in the database and not in any backup of it**.
A database restore without the key produces rows whose delivery details are
permanently unreadable. It must be backed up separately, by the owner, somewhere
that is not the same system — and `CLAIM_ENCRYPTION_KEYS_PREVIOUS` must retain
retired keys until no row still references their version.

---

## 8a. The giveaway lifecycle

`server/lib/giveawayLifecycle.js`, `server/lib/prizeStandard.js`,
`server/lib/giveawayOutbox.js`.

### The states

| Status | Meaning | Public? | Enterable? |
| --- | --- | --- | --- |
| `pending_approval` | Submitted by a host, awaiting deliberate Naseeb approval | No | No |
| `rejected` | Reviewed and refused. Terminal; never publishes | No | No |
| `active` | Published and accepting entries | Yes | Yes |
| `closed_pending_draw` | Entries closed, draw not yet run | Yes | No |
| `pending_integrity_review` | Entries closed, draw postponed by an open integrity question | Yes | No |
| `drawn` | Exactly one winner. Terminal | Yes | No |
| `closed_no_winner` | Closed with no eligible entry, and a recorded reason. Terminal | Yes | No |
| `cancelled` | Exceptional cancellation. Terminal | Yes | No |

`active` and `drawn` keep their historical names: they are read in eleven places
and asserted by every existing test, and renaming them would be churn with a real
chance of missing a reader.

### The closing rules

A published campaign runs for **exactly 30 calendar days** from approval and stops
accepting entries at whichever comes first:

1. the **100th accepted entry** — closed inside that entry's own transaction,
   under the same row lock that serialises entries, so two concurrent entries
   cannot both read 99 and no 101st can slip through;
2. the **30-day deadline** — closed by the `giveaway_lifecycle` maintenance job,
   and also by the next request that arrives after it passes.

**Closure is a latch, not a computation.** `entries_closed_at` is written once.
If "is it closed?" were a live count against the target, disqualifying an entry
after closure would drop the count below 100 and reopen a closed campaign —
accepting an entry after closure and effectively extending the deadline. Both are
forbidden, so closure is a fact with a timestamp and a reason.

### "Eligible" means two things

The schema already carried three hand-written variants that did not agree. There
are now two predicates, each with exactly one definition that every caller shares:

| Constant | SQL | Used for |
| --- | --- | --- |
| `ACCEPTED_SQL` | `integrity_status <> 'disqualified'` | The 100 target, and every public and dashboard tally |
| `DRAWABLE_SQL` | `integrity_status = 'eligible'` | The draw pool, and nothing else |

An entry under review **counts** (somebody submitted it, and it may be
reinstated) but **cannot win** (a winner drawn from a contested pool is a winner
nobody can defend). The threshold uses ACCEPTED so that opening a review cannot
reopen a closed campaign.

### Integrity interaction

If an integrity review or blocking case is open when a campaign closes, entries
close on time — the review extends nothing — and the campaign moves to
`pending_integrity_review`. The draw waits. When the review resolves, the next
pass of the maintenance job draws it: there is no separate trigger and nothing to
remember. An upheld post-draw case continues to block fulfilment under the
existing claim rules; nothing here cancels a claim, replaces a winner or redraws.

### One draw

`drawIfReady` is the only place a winner is selected, and the route and the
maintenance job both call it — a second implementation of "pick a winner" would
drift, and the weaker one would be the one running unattended at 03:00. It uses
`crypto.randomInt` over the locked eligible pool, unchanged from the original
route. A partial unique index on `winner_entry_id` refuses a second winner at the
storage layer even if a future code path forgets the lock.

### Prize governance

A submission never publishes itself. `POST /api/giveaways` creates a
`pending_approval` row with no publication time and no deadline. Publication
requires `POST /api/admin/giveaways/:id/approve` from a named administrator, with
review notes and a verified evidence reference, and a CHECK constraint refuses a
published campaign that lacks a category, sponsor, supplier, value, custody
statement, fulfilment method or verified evidence.

**Evidence is a reference and a verdict, never a document.** Storing a sponsor's
invoice would put third-party commercial paperwork, and quite possibly personal
data inside it, into this database for no operational gain.

`prize_governance_version` is 0 for campaigns published before this migration and
1 for everything after. The constraints apply from version 1: satisfying them for
a pre-existing campaign would mean writing an approval that never happened.

### Exceptional cancellation

Grounds: `fulfilment_impossible`, `unlawful`, `fraudulent`, `unsafe`,
`prohibited_by_authority`. **`sponsor_withdrawal` is not a ground**, is refused by
name with its own error code, and is unrepresentable in the database. A
cancellation needs a named administrator and a written reason of at least ten
characters; every entrant gets a durable notice; the campaign, entries and history
are preserved; and no draw is pretended. The entrant reads a fixed sentence chosen
from the ground — never the administrator's written reason, which can name a
sponsor, an allegation or a legal instruction.

---

## 9. Runbooks

Each says who acts. **Credential rotation is always an owner action and is never
simulated, scripted or performed by this repository.**

Legend: 🔧 engineering control · 👤 owner action · ⚖️ needs UAE counsel ·
🖥️ provider dashboard

### 9.1 Staging deployment
1. 🔧 Confirm CI green on the branch: `test`, `browser-security`, `operations`.
2. 👤🖥️ Create/point the staging service at the branch. `buildCommand: npm ci`.
3. 👤 Set `DEPLOYMENT_STATE=staging`, `NODE_ENV=production`, a **staging-only**
   `SESSION_SECRET`, `INTEGRITY_SIGNAL_SECRET` and `CLAIM_ENCRYPTION_KEY`.
   Never the production values.
4. 🔧 Deploy. Startup validation refuses on missing or weak configuration.
5. 🔧 `GET /readyz` → 200 with `"deployment":"staging"`.
6. 👤 Staging must not be described as approved or production-ready. Anywhere.

### 9.2 Production deployment

**The schema is changed by a person, before the deploy. The web process never
migrates.** A deploy against a database whose schema is not ready comes up and
answers 503 on `/readyz`, which is the intended behaviour, not a failure to fix
by making startup migrate.

1. 🔧 CI green on `main`, including `operations`, `schema-migration` and
   `email-delivery`.
2. 👤🖥️ Confirm every `sync: false` variable is set. Values are never in git.
   `RESEND_API_KEY` and `EMAIL_FROM` are **required** — see §2.
3. 👤🖥️ From a shell with `DATABASE_URL` pointing at the production database:
   ```
   node scripts/migrate.js status     # read this before doing anything
   node scripts/migrate.js verify     # read-only. Changes nothing.
   ```
4. 👤🖥️ Then **one** of:
   - `node scripts/migrate.js adopt --dry-run` then `adopt` — for a database
     that already matches the baseline and has never been on the ledger. It
     refuses on any difference and writes nothing.
   - `node scripts/migrate.js up` — for an empty or older database. It executes
     pending migrations under the advisory lock and verifies afterwards.
5. 🔧 Read the output. `schema_verified` must be `true`. If
   `slot_protection` is `blocked`, go to §9.13 — the deploy may proceed, but
   self-serve ad checkout stays refused.
6. 🔧 Deploy.
7. 🔧 Watch `/readyz`: 503 until schema, configuration and notification delivery
   verify, then 200 with the expected `schema_version` and
   `"deployment":"private_beta"`.
8. 🔧 Confirm the maintenance cron ran and exited 0.
9. 👤 `DEPLOYMENT_STATE` stays `private_beta` until §3's blockers clear.

### 9.3 Rollback
1. 👤🖥️ Roll back to the previous deploy in the Render dashboard.
2. 🔧 **Do not roll the schema back.** There is no automatic destructive
   rollback and there must not be one.
3. 🔧 If the old code fails readiness with *"schema is ahead of this code"*,
   that is the guard working: the schema is newer than the process. Roll
   **forward** or write a deliberate reversing migration.
4. 🔧 Confirm `/readyz` 200 and one clean maintenance run.

### 9.4 Failed migration
1. 🔧 `scripts/migrate.js` exits non-zero and the running instances keep serving
   — the schema command is separate from the deploy, so a failure here has not
   touched the site.
2. 🔧 The failed migration rolled back and **wrote no ledger row**. There is no
   half-applied state to unpick; `migrate status` will still show it pending.
3. 🔧 Read the failure. **Never edit `schema_migrations` to make it pass** — the
   ledger is the record, not a lever.
4. 🔧 A checksum mismatch means a historical migration was edited. Restore the
   original text, or add a new migration; do not rewrite history. `001_baseline`
   is frozen: if its checksum moved, something edited a file that must not be
   edited.
5. 🔧 Adoption refused with `schema_mismatch`: the database is not the shape the
   code expects. Read the object names it printed, then run `migrate up` to
   bring it forward rather than adopting past the difference.
6. 🔧 Adoption refused with `slot_protection_missing`: run `migrate up`, which
   adds the constraint.
7. 🔧 Fix forward in a new commit. Re-run the command.
8. 👤 If data is at risk, stop and go to 9.11 before doing anything else.

### 9.5 Database outage
1. 🔧 `/healthz` stays 200 (by design), `/readyz` goes 503 and traffic drains.
2. 👤🖥️ Check the Neon status page and dashboard.
3. 🔧 Do **not** restart instances in a loop — the process is not what is broken.
4. 🔧 Maintenance crons exit 1 and are visible as failed runs; they are safe to
   re-run once the database is back.
5. 🔧 On recovery, `/readyz` returns 200 by itself. Run `maintenance.js all`
   once and confirm exit 0.

### 9.6 Email provider outage
1. 🔧 Nothing is lost: both outboxes hold the intent durably.
2. 🔧 Confirm rows are `pending` with a growing `attempts`, not `failed`.
3. 🔧 After six attempts a notification goes terminal and appears in the admin
   queue with a sanitised alert.
4. 👤🖥️ Check Resend's status.
5. 🔧 Once recovered: `maintenance.js claim_outbox email_change_outbox`.
6. 🔧 Terminal ones need a deliberate, audited retry in the admin screen with a
   reason. **Every email-change retry issues a fresh link and kills the previous
   one** — see `docs/PRIVACY_AND_RIGHTS.md` §6a.

### 9.7 Stripe webhook outage
1. 🔧 `ADS_CHECKOUT_ENABLED` is `false`. **There is nothing to reconcile today.**
2. If it is ever enabled: 🔧 confirm the app refuses to boot without
   `STRIPE_WEBHOOK_SECRET`; 👤🖥️ replay events from the Stripe dashboard;
   🔧 `stripe_events` makes processing idempotent, so replay is safe.
3. 👤 Do not mark a booking paid by hand to "unblock" a customer. That is the
   failure the whole flag exists to prevent.

### 9.8 Stuck notification outbox
1. 🔧 Admin → Email change delivery. Look at status, attempts, error category.
2. 🔧 `in flight` with an old timestamp means a worker died; the lease expires
   in 120s and the row recovers itself.
3. 🔧 `cancelled` means the underlying change is gone, expired or completed —
   correct, not stuck.
4. 🔧 `failed` needs a deliberate retry with a recorded reason.
5. 🔧 If the whole queue is stuck, the cron is not running (§4) or email is
   unconfigured (§2).

### 9.9 Stuck claim or integrity review
1. 🔧 Admin → Suspended-host claims / Entry integrity.
2. 🔧 A post-draw case resolved `upheld` is **durably blocked by design** and
   cannot be closed from the screen.
3. ⚖️ Cancelling a prize, replacing a winner or redrawing is **not implemented**
   and needs an owner decision with counsel — `docs/UAE_COUNSEL_REVIEW.md` B9.
4. 👤 Never resolve a case to make a queue shorter.

### 9.10 Suspected credential exposure
1. 👤 **Rotation is an owner action.** Nothing here rotates a credential, and
   this runbook does not simulate one.
2. 👤🖥️ Rotate in the provider dashboard, then update the Render environment.
3. 🔧 `SESSION_SECRET` rotation invalidates every CSRF token — everyone signs in
   again. Expected.
4. 🔧 **`CLAIM_ENCRYPTION_KEY` must never be replaced without moving the old
   value into `CLAIM_ENCRYPTION_KEYS_PREVIOUS` first.** Replacing it outright
   makes every stored delivery detail permanently unreadable.
5. 🔧 If a session may be compromised: admin → revoke sessions for that account.
6. ⚖️ Whether an exposure is notifiable under UAE law is a counsel question —
   `docs/UAE_COUNSEL_REVIEW.md` B4. Do not decide it internally.

### 9.11 Backup restoration
1. 👤 **Authorised by the owner. Never an engineer alone.**
2. 🔧 Restore to a **new** database. Never over the live one.
3. 🔧 Point a staging deployment at it and confirm `/readyz` 200.
4. 🔧 Confirm the encryption key still decrypts delivery details (§8).
5. 👤🖥️ Only then consider a cutover.
6. ⚖️ If restoring loses data somebody was told was deleted, that is a counsel
   question before it is an engineering one.

### 9.12 Emergency account or session suspension
1. 🔧 Admin → Hosts → suspend the account (`POST /api/admin/users/:id/account-status`).
   Recorded, reversible, explained.
2. 🔧 Revoke sessions (`POST /api/admin/users/:id/revoke-sessions`).
3. 🔧 **There is no delete.** `DELETE /api/admin/users/:id` answers 405; a
   database-level removal is an emergency operation needing a separately
   approved runbook that does not exist — `docs/PRIVACY_AND_RIGHTS.md` §8.
4. 🔧 Suspending a host moves their unfinished claims to the rescue queue
   automatically. A winner mid-delivery is never stranded.

---

### 9.13 Overlapping banner bookings block the slot constraint

`migrate up` reported `slot_protection: "blocked"`, or `/api/ads` refuses
checkout because `isSlotProtectionActive()` is false.

**Nothing has been deleted, moved or released.** Both sides of every conflicting
pair are exactly where they were. This is a commercial decision, not a schema
one, and the migration deliberately declines to make it.

1. 🔧 `node scripts/migrate.js status` — `slot_exclusion_constraint_active`
   is false.
2. 🔧 The migration log lists each conflicting pair by **booking id and date
   only**. No advertiser is named in a server log.
3. 👤 Look the bookings up by id. Decide, as a commercial matter, which side
   keeps the dates — refund, reschedule or compensate the other.
4. 👤🖥️ For the side that is giving up the slot, and **only** that side:
   ```sql
   UPDATE ads
      SET slot_status = 'released',
          slot_released_at = NOW(),
          slot_release_reason = '<why, in a sentence>'
    WHERE id = '<booking id>';
   ```
   The reason is not decoration: it is what stops the next migration re-claiming
   the slot.
5. 🔧 `node scripts/migrate.js up` — the constraint applies.
6. 🔧 Confirm `slot_exclusion_constraint_active` is now true.

Self-serve ad checkout stays refused until step 6, and `ADS_CHECKOUT_ENABLED`
remains `false` regardless — see §3.

---

## 10. Deterministic builds

- `npm ci` in CI **and** in `render.yaml`. Not `npm install`.
- Node pinned three ways that must agree: `engines.node` in `package.json`,
  `NODE_VERSION` in `render.yaml`, `node-version` in CI. A test asserts it.
- CI fails if `npm ci` modifies `package-lock.json`.
- `.gitignore` and `.npmignore` exclude `node_modules`, `.env*`, `.tmp-testdb/`,
  `*.dump` and `*.sql.gz`.
- Production cannot run against a test database: the validator refuses a
  `DATABASE_URL` containing `test` when `NODE_ENV=production`.
- Tests cannot run against production: `testEnv.js` refuses a non-test name, a
  remote host without an explicit opt-in, and strips production-shaped
  credentials.
- The development mail logger cannot activate in production: it is keyed on the
  absence of `RESEND_API_KEY`, and `CLAIM_DEV_LOG_LINKS=true` is a **startup
  refusal** in production.

---

## 11. What remains an owner, provider or counsel action

| # | Action | Who |
| --- | --- | --- |
| 1 | Create the maintenance cron jobs. **Until this is done, retention does not run on a schedule.** | 👤🖥️ |
| 2 | Confirm Neon backup/PITR is enabled, its window and its region | 👤🖥️ |
| 3 | Back up `CLAIM_ENCRYPTION_KEY` separately from the database | 👤 |
| 4 | Set every `sync: false` variable | 👤🖥️ |
| 5 | Decide whether the plan includes cron jobs and a non-sleeping web service | 👤 |
| 6 | Rotate any credential | 👤 |
| 7 | Perform a production restore | 👤 |
| 8 | Data processing agreements with Resend, Cloudinary, Sentry, Stripe, Render, Neon | 👤⚖️ |
| 9 | Everything in `docs/UAE_COUNSEL_REVIEW.md` | ⚖️ |
| 10 | Move `DEPLOYMENT_STATE` to `public_launch` — currently refused by validation | 👤⚖️ |
| 11 | Run `node scripts/migrate.js status`, `verify`, then `adopt` or `up` against the production database before the first deploy. Nothing here does it automatically | 👤🖥️ |
| 12 | Verify the sender domain with the email provider. `EMAIL_FROM` on `resend.dev` or an example domain is refused | 👤🖥️ |
| 13 | Resolve any overlapping banner bookings by hand (§9.13) before self-serve ad checkout can be enabled | 👤 |
| 14 | **Put the sponsor agreement in place.** Code and website wording cannot make a sponsor perform; the no-withdrawal commitment in §8a rests on a contract that does not yet exist, and it is a prerequisite before Naseeb operates publicly | 👤⚖️ |
| 15 | **Decide whether Naseeb financially guarantees an equivalent replacement** if a sponsor breaches. Deliberately not invented or implemented | 👤⚖️ |
| 16 | Decide and register the operating entity. Naseeb is currently Mostapha Chehade personally, in Dubai, under development — with no company, trade licence, VAT registration or commercial operation | 👤⚖️ |
| 17 | Stand up `support@`, `privacy@` and `legal@mynaseeb.ae` before any page points people at them. None is published today | 👤🖥️ |
| 18 | Build the administrator review screen for the prize queue. The API exists (`GET /api/admin/giveaway-submissions`, approve/reject/cancel); the admin page has no controls for it yet | 👤 |
| 19 | **Pin `sslmode=verify-full` in the deployed `DATABASE_URL`.** An `sslmode` in the connection string silently replaces the `ssl` option the code builds, and `require`, `prefer` and `verify-ca` will all switch from full verification to none when `pg` reaches v9 — during a routine dependency upgrade, with no code change to review. The process warns at startup when the mode is one that will change meaning; only the owner can edit the variable. See `test/database-tls-posture.test.js` | 👤🖥️ |
| 20 | **Native review of the Arabic**, all twelve dictionary files. The translation is machine-drafted and unread by a native speaker. Register, idiom, numeral convention and the choice of مسابقة for "giveaway" are all open — `docs/ARABIC_RTL.md` §2, §8 | 👤 |
| 21 | **A share image** (1200×630 PNG) before Open Graph cards carry one. Until it exists the cards are text-only, which is correct: a declared image that 404s is a broken preview rather than a missing one — `docs/SEO.md` §7 | 👤 |
| 22 | **Re-check `robots.txt` and `/sitemap.xml` in the deployment**, after `DEPLOYMENT_STATE` changes. Both are generated from that state, and the only way to know a crawler agrees is to look at what it was served | 👤🖥️ |

---

## 11a. Where the runtime evidence comes from

This development machine has no PostgreSQL, no Docker and no `psql`, and the
application requires a database at startup. **Nothing runtime is executed
locally** — not the suite, not the browser harnesses, not the app. Every runtime
claim in these documents comes from GitHub Actions, against an ephemeral
`postgres:16` service container, and every account in every one of them is
fabricated.

Six jobs, deliberately separate so a failure names itself rather than arriving as
one red tick:

| Job | What it exercises | Artifact |
| --- | --- | --- |
| `test` | Every `test/*.test.js`. Includes the file-reading ones that need no database: SEO metadata, i18n parity and key reachability, server-error translation coverage, deadline integrity, database TLS posture, legal copy | — |
| `browser-security` | Hostile data in all 43 input fields, eleven payload families, in Chromium. `HOSTILE_SELFTEST=1` proves the detector still reports red | — |
| `operations` | The nine maintenance jobs, their bounds and their advisory locks | — |
| `rehearsal` | One giveaway from submission through approval, entry, closure, draw, claim and delivery — 21 requirements, reporting separately what it walked and what an existing suite proves | `.rehearsal/` |
| `accessibility` | axe-core over 23 pages at two viewports, with proof the rules actually ran | `.accessibility/` |
| `arabic-rtl` | 23 pages × 2 languages × 2 viewports: direction, English leakage, horizontal overflow, console errors, bidi isolation, and that the language switch cannot navigate | `.arabic-rtl/rtl-report.json` |

The browser suites refuse a non-test database twice over: `configureTestEnv()`,
and a second guard that rejects a Neon host outright. Neither reads production
credentials, sends real email, charges anything, or calls a live fulfilment
service.

**A green tick is not conformance.** What each suite does *not* establish is
recorded with it — `docs/ACCESSIBILITY.md` "Not verified", `docs/ARABIC_RTL.md`
§2, `docs/SEO.md` §6, and the verification limits at the end of
`docs/LAUNCH_READINESS.md`.

---

## 12. Pre-ledger upgrade evidence

`test/schema-migration.test.js`. Seven fabricated database shapes, each built in
its own throwaway PostgreSQL database on the isolated local test server and
dropped afterwards. **Every row is invented.** No production data, no real
person, no real company, no real payment, and no hosted service is contacted.

| Fixture | Shape |
| --- | --- |
| `empty` | Nothing at all |
| `matching` | Built by the baseline, ledger removed — the shape of every database that predates the ledger |
| `incomplete` / `upgrade` | Three later tables and two later columns dropped, then given fabricated operating history |
| `noconstraint` | Correct, minus the booking-overlap constraint, with no data conflict |
| `alteredtrigger` | An append-only trigger present by name but firing on fewer events |
| `overlap` | Two overlapping paid banner bookings written before any constraint existed |
| `snapshot` / `partial` / `concurrent` / `readiness` | Freshly built, for the snapshot, partial-failure, concurrency and readiness proofs |

The fabricated history is one approved host, five entrants, one giveaway, five
entries and two append-only integrity events.

| # | Proof | Test | Result |
| --- | --- | --- | --- |
| 1 | An empty database executes the baseline | `sm4` | ✅ `applied: [001_baseline, 002_schema_ledger]`, verified, `slotProtection: created` |
| 2 | An exact schema may be explicitly adopted | `sm5` | ✅ recorded `applied_by: 'adopted'` with a SHA-256 fingerprint; a second attempt is refused |
| 3 | An incomplete schema cannot be adopted | `sm6`, `sm7` | ✅ `schema_mismatch`; three tables and two columns named; **zero ledger rows written** |
| 4 | An incomplete schema upgrades safely where there is no commercial conflict | `sm8` | ✅ all five missing objects restored, verification passes |
| 5 | Existing rows remain intact | `sm8` | ✅ `giveaways`, `entries` and `entry_integrity_events` byte-for-byte identical (md5 over the full row text); `users` identical column-by-column, with the new attestation column defaulting to the honest `unknown` |
| 6 | Append-only history survives | `sm8` | ✅ both events present and unchanged; the restored trigger still refuses `UPDATE` **and** `DELETE` |
| 7 | Overlapping ads prevent the constraint and therefore checkout readiness | `sm9` | ✅ `slotProtection: blocked`; `isSlotProtectionActive()` false; the rest of the schema verifies and is recorded |
| 8 | No overlap is deleted, moved or silently resolved | `sm9` | ✅ both bookings present, both still `paid`, both `slot_released_at` null; the log names ids and dates only, never an advertiser |
| 9 | A partial migration writes no ledger success | `sm10` | ✅ the half-built table rolled back, no ledger row, readiness still failing, no residue after the fabricated migration is removed |
| 10 | Concurrent migration attempts apply once | `sm11` | ✅ three simultaneous runs; exactly one did the work; two ledger rows |
| 11 | Web startup never auto-adopts | `sm12` | ✅ no file under `server/` calls `migrate()` or `adopt()`; `server/index.js` calls `verify()` |
| 12 | Readiness fails until migration or adoption is explicitly completed | `sm13` | ✅ fails with no ledger table, fails with an empty ledger, fails after adopting the baseline alone, passes only once complete, and fails again the moment the ledger is lost |
