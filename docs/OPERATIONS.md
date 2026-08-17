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
| 9 | `init()` ran on every boot with nothing recording which schema was applied | Migration ledger with checksums and a documented baseline-adoption strategy. |
| 10 | No backup verification of any kind | `scripts/backup-verify.js`, run in CI. |

### 1.3 Startup sequence, before and after

**Before:** `dotenv` → Sentry → five assert functions (each deciding
independently whether to warn or `process.exit`) → `init()` → slot check →
`listen()`.

**After:** `dotenv` → error reporting → **one** configuration validator →
`migrate()` (baseline under an advisory lock, ledger recorded) → slot-constraint
verification → in-process scheduler (safety net) → `listen()` → server attached
to the shutdown coordinator, which was installed *before* any of it so a SIGTERM
during a slow boot is handled by the same path.

### 1.4 Still true, and not fixed here

- The web process and the maintenance jobs are the only processes. There is no
  separate worker service; the jobs are cron invocations of the same image.
- Rollback is a Render dashboard action. There is no scripted rollback, and
  there is deliberately no automatic destructive schema rollback (§6).
- Backup configuration at the provider is unverified (§8).

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
| `RESEND_API_KEY` | optional | secret | **Consequence if unset: no email is delivered at all** — see below. |
| `SENTRY_DSN` | optional | secret | Consequence if unset: nothing alerts. |
| `GA_MEASUREMENT_ID` | optional | public | Consequence if unset: no traffic measurement. |
| `CLOUDINARY_CLOUD_NAME` / `_UPLOAD_PRESET` | optional | public | Without them, hosts paste an image URL. |
| `EMAIL_FROM`, `ADMIN_NOTIFY_EMAIL` | optional | public | |
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

### Optional providers, and the consequence of leaving them unset

`RESEND_API_KEY`, `SENTRY_DSN` and `GA_MEASUREMENT_ID` are optional by design and
production **warns rather than refuses**. The consequences, stated so nobody
discovers them:

- **No `RESEND_API_KEY`: no email is delivered.** Verification, password reset,
  claim invitations, winner notices, email-change confirmations and old-address
  warnings are all written to the log instead. Both outboxes will retry
  forever and never succeed. A person who cannot verify their address cannot
  enter; a winner who never gets a claim link never claims. The platform is
  functionally broken and looks healthy.
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

Technical deployment and public launch are different decisions.
`DEPLOYMENT_STATE` is one of `development`, `staging`, `private_beta`,
`public_launch`. Unset means `development` locally and **`private_beta`** in
production — never `public_launch` by omission.

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

`render.yaml` pins `DEPLOYMENT_STATE: private_beta`. **No committed file sets
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

### Schedule (UTC, with Dubai UTC+4)

| Command | Cron (UTC) | UTC | Dubai | Why |
| --- | --- | --- | --- | --- |
| `maintenance.js all` | `*/15 * * * *` | every 15m | every 15m | Outboxes: a verification email must not wait an hour |
| `maintenance.js claims` | `17 * * * *` | hourly | hourly | Retention erasure and claim expiry |
| `maintenance.js sessions risk_signals` | `23 3 * * *` | 03:23 | 07:23 | Housekeeping and retention purge, off-peak |

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
`database`, `schema`, `internal`. No database host or name, no table, column or
constraint names, no connection string, no variable names or values, no stack
trace, no driver message. The detail goes to the process log and through the
sanitised error reporter. A successful response carries the schema version and
the deployment state, which is what a rollout needs and what this repository
publishes anyway.

Neither endpoint creates a session, writes a row, or mutates anything.

---

## 6. Schema migrations

`server/lib/migrations.js`. Current `SCHEMA_VERSION`: **0002**.

### The baseline strategy

Rewriting 1,400 lines of accumulated DDL into an ordered history would be
inventing a past that did not happen — every existing database got its schema
from `init()`, not from a numbered sequence.

So **`0001_baseline` *is* `db.init()`**, checksummed by hashing the SQL text it
executes (`BASELINE_SQL`, extracted for exactly this purpose). Everything after
it is an ordinary numbered migration.

**Adoption.** A database that already has the schema but no ledger is *adopted*:
the row is written with `applied_by = 'adoption'` and a note saying the schema
predates the ledger. It is **not** recorded as executed, because it was not.
`SELECT applied_by FROM schema_migrations` distinguishes adopted databases from
built ones.

### Guarantees

- **Ordered and idempotent.** Every migration may run against a database where
  it has already had its effect.
- **Concurrent deploys cannot double-apply.** One blocking advisory lock
  (`918273645`) around the whole run; a second deploy waits and finds the work
  done.
- **An edited historical migration is detected.** The checksum recorded at
  application time is compared on every run and every readiness check. A
  mismatch is a hard failure, not a warning — the code and the database disagree
  about what was applied and nobody can tell which is right.
- **A schema ahead of the code fails readiness.** An unknown migration id in the
  ledger means a rollback left the database newer than the process, which is the
  case nobody tested.
- **No automatic destructive rollback.** There is no `down`. Reversing a
  migration is a new migration, written deliberately.
- **`db:init` is separated from the test reset.** `npm run db:init` is
  production-capable and documented as such in the README; `scripts/reset-test-db.js`
  drops and rebuilds the schema and refuses anything that is not an isolated
  test database.
- **The slot exclusion constraint is verified on every boot**, not only when the
  baseline runs — it is a verification step, not a migration, and it regressed
  into being skipped when the ledger was introduced. That is now explicit in
  `server/index.js`.

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
1. 🔧 CI green on `main`, including `operations`.
2. 👤🖥️ Confirm every `sync: false` variable is set. Values are never in git.
3. 🔧 Deploy. Migrations run under an advisory lock before `listen()`.
4. 🔧 Watch `/readyz`: 503 until schema and configuration verify, then 200 with
   the expected `schema_version`.
5. 🔧 Confirm the maintenance cron ran and exited 0.
6. 👤 `DEPLOYMENT_STATE` stays `private_beta` until §3's blockers clear.

### 9.3 Rollback
1. 👤🖥️ Roll back to the previous deploy in the Render dashboard.
2. 🔧 **Do not roll the schema back.** There is no automatic destructive
   rollback and there must not be one.
3. 🔧 If the old code fails readiness with *"schema is ahead of this code"*,
   that is the guard working: the schema is newer than the process. Roll
   **forward** or write a deliberate reversing migration.
4. 🔧 Confirm `/readyz` 200 and one clean maintenance run.

### 9.4 Failed migration
1. 🔧 The deploy fails before `listen()`; the previous instances keep serving.
2. 🔧 Read the failure. **Never edit `schema_migrations` to make it pass** — the
   ledger is the record, not a lever.
3. 🔧 A checksum mismatch means a historical migration was edited. Restore the
   original text, or add a new migration; do not rewrite history.
4. 🔧 Fix forward in a new commit. Re-deploy.
5. 👤 If data is at risk, stop and go to 9.11 before doing anything else.

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
