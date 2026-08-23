# Release candidate — deployment checklist

Prepared for the deployment of the `production-hardening` branch.

**Nothing in this document has been executed against a production service.** No
Render, Neon, Stripe, Resend, Sentry or Cloudinary account was accessed. Every
verification described as *done* was done locally against an isolated test
database with fabricated data; everything else is a step somebody still has to
take.

**No secret value appears here, and none may be added.** Where a value is
needed, this document gives the *command that generates it* and the *name of the
variable it goes in*. Values are typed into the Render dashboard once and never
into a file, a commit, a log, a test, or a chat message.

---

## 1. What this deployment is

The site becomes **publicly reachable** and is **not open for business**.

`DEPLOYMENT_STATE=pre_launch`. That is not a label — `server/lib/config.js`
`operationsAllowed()` reads it, and every operational route refuses. A visitor
sees the design, the premium-prize concept and the informational pages, and a
non-dismissible banner saying the platform is not open.

An unset or misspelled `DEPLOYMENT_STATE` resolves to `pre_launch` in
production, so a missing environment variable cannot start operations by
omission.

### Available after deployment

| Available | Notes |
| --- | --- |
| Every public informational page | Home, about, partners, pricing, winners, terms, privacy, advertise |
| The draft Terms and Privacy pages | Clearly marked non-effective drafts with no effective date |
| Sign-in for an account that already exists | There are none in production; the route works |
| `GET /healthz`, `GET /readyz` | Readiness returns 200 in pre-launch: a deployment that is deliberately closed is still healthy |
| `GET /api/config` | Coarse state only |
| Browsing giveaways | There are none |

### Unavailable after deployment

Each answers **503 `NOT_OPEN_YET`** with `Retry-After` and writes nothing:

| Refused | Route |
| --- | --- |
| Registration | `POST /api/auth/signup` |
| Campaign submission | `POST /api/giveaways` |
| Campaign publication | `POST /api/admin/giveaways/:id/approve` |
| Entering a giveaway | `POST /api/giveaways/:id/enter` |
| Drawing a winner | `POST /api/giveaways/:id/draw` |
| Starting a claim | `POST /api/claims/redeem` |
| The unattended lifecycle worker | `maintenance.js giveaway_lifecycle` reports `skipped_reason: pre_launch` |

Separately refused, by their own older gates:

| Refused | Mechanism |
| --- | --- |
| Accepting a draft policy | `policies.assertAcceptable` → 409 `POLICY_IS_DRAFT`, in every deployment state |
| Advertiser checkout and payment | `ADS_CHECKOUT_ENABLED=false`, pinned in `render.yaml` |

**There is no administrator bypass.** Approval and publication are refused for
administrators too. That is deliberate: an exemption for the one role that could
use it is the hole this gate exists to close. Exercising the workflow happens
locally, or in a deployment explicitly set to `staging`.

---

## 2. Render environment variables

Set in the Render dashboard. **Names only below — never paste a value into this
file, a commit, a log or a chat.**

### Required

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | In `render.yaml` |
| `NODE_VERSION` | `22` | In `render.yaml`; matches `engines.node` |
| `PORT` | `3000` | In `render.yaml` |
| `DEPLOYMENT_STATE` | `pre_launch` | In `render.yaml`. Do not override in the dashboard |
| `ADS_CHECKOUT_ENABLED` | `false` | In `render.yaml`. Do not override |
| `APP_URL` | `https://…` | **Must be https and must be the real public origin.** It is the only accepted `Origin` on state-changing requests: wrong, and every write is refused with 403 `ORIGIN_NOT_ALLOWED` |
| `DATABASE_URL` | *(secret)* | The production Postgres connection string. Must NOT contain `test` — production refuses to start against a database whose name does |
| `SESSION_SECRET` | *(secret)* | Signs CSRF tokens. Production refuses to start on a missing, short, placeholder or low-entropy value |
| `INTEGRITY_SIGNAL_SECRET` | *(secret)* | Keys the coarsened network hashes. No raw IP is ever stored |
| `CLAIM_ENCRYPTION_KEY` | *(secret)* | Encrypts winner delivery details. **Back this up separately from the database** — losing it makes every stored delivery detail permanently unreadable, and a database backup does not contain it |
| `TRUSTED_PROXY_HOPS` | `1` | Render terminates TLS and proxies. Too high makes every rate limit spoofable |
| `RESEND_API_KEY` | *(secret)* | **Required in production**, whatever the deployment state |
| `EMAIL_FROM` | `Name <address@your-verified-domain>` | **Required.** Shape-validated: `resend.dev` and the reserved example domains are refused. Must be a domain verified with the provider |

### Deliberately not set

| Variable | Why |
| --- | --- |
| `DATABASE_SSL` | Leave unset. It defaults to TLS for a non-local database; setting it to `false` in production is refused outright |
| `COOKIE_SECURE` | Leave unset. Cookies are Secure in production; setting it to `false` is refused outright |
| `EMAIL_DELIVERY_ENABLED` | Leave unset. It defaults ON; `false` is a temporary provider-migration mode |
| `CLAIM_DEV_LOG_LINKS` | Leave unset. `true` is refused in production — it prints single-use claim links to the log |

### Optional

| Variable | Effect if absent |
| --- | --- |
| `SENTRY_DSN` | Errors reach the platform log only; nothing alerts. Recommended |
| `GA_MEASUREMENT_ID` | No traffic measurement. Harmless |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET` | In-browser image upload is unavailable; a URL can be pasted. **Only needed if uploads will be tested** |
| `ADMIN_NOTIFY_EMAIL` | Host-application notifications go nowhere |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Unused while checkout is off. Leave unset; a key sitting there for a disabled feature is warned about |

### Generating secrets

Run these **on the owner's own machine**, and paste each result straight into
the Render dashboard field. Do not save the output to a file, do not paste it
into a chat, and do not commit it.

```bash
# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# INTEGRITY_SIGNAL_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# CLAIM_ENCRYPTION_KEY  — back this up separately from the database
node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"
```

### Maintenance and cron

The web service on a free plan sleeps, so an in-process timer does not fire.
The maintenance jobs are platform crons, and **until they are created, retention
does not run on a schedule.** In `pre_launch` there is nothing for them to
process, so they are not blocking tonight — but they are required before any
real activity.

| Command | Schedule (UTC) | Dubai |
| --- | --- | --- |
| `node scripts/maintenance.js all` | `*/15 * * * *` | every 15m |
| `node scripts/maintenance.js giveaway_lifecycle giveaway_outbox` | `7 * * * *` | hourly |
| `node scripts/maintenance.js claims` | `17 * * * *` | hourly |
| `node scripts/maintenance.js sessions risk_signals` | `23 3 * * *` | 07:23 |

Create each as a Render Cron Job on the same repo and branch, build command
`npm ci`, linked to the **same environment group** as the web service. Do not
paste values into the cron job.

---

## 3. Database and migration preflight

### Expected state after migration

| | |
| --- | --- |
| `SCHEMA_VERSION` | `0003` |
| `001_baseline` | `f7616d437748cda3f5d2dd0c38a5cd2aab9f84a510d125f51d66b467f1cb4095` |
| `002_schema_ledger` | `afb145463640beee28be97a93fa4c2384c9cebf69280f2e0bd64458590991a4f` |
| `003_giveaway_lifecycle` | `8499d4e2d1773f38ad9853d9e13420de06638791422e76b62fdc43a69988813a` |

### What will run

An **empty** production database runs all three, in order. The web process does
**not** migrate — it verifies and fails readiness. The schema is changed by a
person, before the deploy.

| Migration | What it does | Lock behaviour |
| --- | --- | --- |
| `001_baseline` | Creates the whole schema | `CREATE TABLE` / `CREATE INDEX` on tables it is creating. On an empty database, nothing to block |
| `002_schema_ledger` | `SELECT 1;` | None |
| `003_giveaway_lifecycle` | Adds columns, two tables, CHECK constraints, indexes | See below |

### Can anything rewrite or block a large table?

On the empty database this deploy targets, no — every table has zero rows.

Stated for the general case, because it is the question that matters if this is
ever run against a populated database:

- **`ADD COLUMN … DEFAULT`** does not rewrite a table on PostgreSQL 11+; the
  default is stored in the catalogue. `003` adds several, including
  `entry_target INTEGER NOT NULL DEFAULT 100` and
  `prize_governance_version INTEGER NOT NULL DEFAULT 1`. No rewrite.
- **`ADD CONSTRAINT … CHECK`** takes an `ACCESS EXCLUSIVE` lock and scans the
  table to validate. `003` adds ten. On a large `giveaways` table this would
  block reads and writes for the duration of the scan.
- **`CREATE INDEX`** — not `CONCURRENTLY` — takes a `SHARE` lock, blocking
  writes but not reads. `003` creates four.
- **Three `UPDATE` backfills** on `giveaways`, each `WHERE column IS NULL`. On a
  large table these are the slowest part and hold row locks.
- Nothing drops a table, drops a column, truncates, or deletes a row. A test
  asserts this (`op22b`).

**If this is ever run against a populated `giveaways` table, take the site into
maintenance first.** For the current deployment, the tables are empty and the
whole migration completes in well under a second.

### Rollback and recovery

1. There is **no automatic destructive rollback** and there must not be. There
   is no `down`.
2. `003` is **additive**, so the previous application version runs against the
   migrated schema unchanged: every column it adds is nullable or defaulted, and
   nothing it adds is required by older code. A code rollback needs no schema
   change.
3. If a migration fails, it **rolled back and wrote no ledger row** — each
   migration is its own transaction with its ledger row inside it. There is no
   half-applied state. Fix forward and re-run.
4. If the old code fails readiness with *"schema is ahead of this code"*, that
   is the guard working. Roll forward, or write a deliberate reversing
   migration.
5. **Never edit `schema_migrations` to make something pass.** It is the record,
   not a lever.
6. If data is at risk, stop and restore from backup before doing anything else.

### Required from the owner before migrating

- [ ] **Confirm Neon backup / point-in-time recovery is enabled**, and note its
      window and region. Nothing in this repository can verify that.
- [ ] Confirm the `DATABASE_URL` about to be used is the intended production
      database and not a branch, a fork or a staging copy.

### Verify the database is actually empty — read-only

The owner reports no users or campaigns. **Do not assume it.** Run these first;
every one is read-only and none writes, locks or mutates anything.

```sql
-- 1. Does anything at all exist yet?
SELECT to_regclass('public.users')            IS NOT NULL AS has_users,
       to_regclass('public.giveaways')        IS NOT NULL AS has_giveaways,
       to_regclass('public.schema_migrations') IS NOT NULL AS has_ledger;

-- 2. If the tables exist, is there anything in them?
--    Every count must be 0 to proceed with the "empty database" plan.
SELECT
  (SELECT COUNT(*) FROM users)                AS users,
  (SELECT COUNT(*) FROM giveaways)            AS giveaways,
  (SELECT COUNT(*) FROM entries)              AS entries,
  (SELECT COUNT(*) FROM prize_claims)         AS claims,
  (SELECT COUNT(*) FROM ads)                  AS ads,
  (SELECT COUNT(*) FROM sessions)             AS sessions,
  (SELECT COUNT(*) FROM host_applications)    AS host_applications,
  (SELECT COUNT(*) FROM policy_acceptances)   AS policy_acceptances;

-- 3. Any payment ever recorded? Must be 0.
SELECT COUNT(*) FILTER (WHERE payment_status = 'paid')   AS paid_ads,
       COUNT(*) FILTER (WHERE stripe_session_id IS NOT NULL) AS stripe_sessions
  FROM ads;

-- 4. Any live campaign or unfinished claim? Must be 0.
SELECT COUNT(*) FILTER (WHERE status = 'active') AS live_campaigns,
       COUNT(*) FILTER (WHERE status = 'drawn')  AS drawn_campaigns
  FROM giveaways;

-- 5. What has already been applied, if anything?
SELECT id, applied_by, applied_at FROM schema_migrations ORDER BY id;

-- 6. Is the schema already something unexpected?
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' ORDER BY table_name;
```

**If any count is non-zero, or the ledger holds an id this code does not know,
STOP.** Do not migrate. Report what was found. A populated database needs the
verified-adoption path (`migrate adopt`), the constraint-scan lock behaviour
above, and a backup confirmed first.

### Migration commands, in order

```bash
# With DATABASE_URL pointing at production, from a shell (not the web service):
node scripts/migrate.js status     # read this before doing anything
node scripts/migrate.js verify     # read-only. Changes nothing.
node scripts/migrate.js up         # empty or older database
# or, for a database that already matches exactly:
node scripts/migrate.js adopt --dry-run
node scripts/migrate.js adopt
```

`up` must report `schema_verified: true`. If `slot_protection` is `blocked`,
see `docs/OPERATIONS.md` §9.13 — the deploy may proceed, but self-serve ad
checkout stays refused (it is off anyway).

### Immediately after deployment

- [ ] `GET /healthz` → `200 {"status":"alive"}`
- [ ] `GET /readyz` → `200`, `schema_version: "0003"`, `deployment: "pre_launch"`
- [ ] `GET /api/config` → `accepting_operations: false`, a `pre_launch_notice`
- [ ] Any page → header `X-Robots-Tag: noindex, nofollow, noarchive`
- [ ] `POST /api/auth/signup` with fabricated details → `503 NOT_OPEN_YET`, and
      no row in `users`
- [ ] The home page shows the "Launching soon" banner

If `/readyz` returns 503, read the process log: the failing **category** is in
the response, the detail is in the log.

---

## 4. Blockers before any real campaign

These are enforced, not merely written down. `config.launchBlockers()` returns
each of them, and `operationsAllowed()` refuses every real-activity state while
any of them stands.

1. **The winner-fulfilment role model is unresolved.** The claim workflow is
   still host-operated; the approved model makes Naseeb the fulfilment
   coordinator and the winner-facing contact. Recorded in code as
   `FULFILMENT_ROLE_MODEL_RESOLVED = false`.
2. Both policies are drafts with no effective date.
3. Owner information outstanding: legal entity, licence, registered address,
   contact for notices, data controller identity.
4. Qualified UAE counsel review outstanding.
5. No sponsor agreement exists. The no-withdrawal commitment rests on a contract
   that has not been written.
6. The replacement-guarantee decision has not been made.
7. `support@`, `privacy@` and `legal@mynaseeb.ae` do not exist, so no page
   points at them.

---

## 5. Added in Phase 2.4B, and what it changes for a release

None of this moves a blocker in §4. All of it changes what a release *is*.

**Six CI jobs, not one.** `test`, `browser-security`, `operations`, `rehearsal`,
`accessibility`, `arabic-rtl`. A release candidate is not a candidate until all
six are green on the head commit — separate jobs so a failure names itself
instead of arriving as one red tick. See `docs/OPERATIONS.md` §11a.

**The site is bilingual.** All 23 pages, including the sentences the server sends
when it refuses something. **The Arabic has had no native review**, and the
Arabic Terms and Privacy Policy are a translation of documents that are
themselves unapproved drafts. Offering the Arabic to real users is an owner
action (`docs/OPERATIONS.md` §11, item 20), not something a deploy decides.

**SEO metadata exists and is inert.** Canonical URLs, hreflang alternates, Open
Graph and Twitter metadata on the 12 indexable pages; a page-level `noindex` on
the other 11. `robots.txt` and `sitemap.xml` are generated from
`DEPLOYMENT_STATE`, so the switch that opens the platform is also the switch that
opens it to crawlers. Verify both **in the deployment** after that switch —
`docs/SEO.md` §7.

**One deadline.** `closes_at` and `entry_deadline` are derived from a single
scalar in the one statement that writes them, and the rule is one calendar month
rather than a day count. `test/deadline-integrity.test.js` checks the code, the
pages, the dictionaries and the page scripts — the last of those because the
sentence a host read immediately after submitting a prize said "30 days" while
the code enforced a month.

**Database TLS is pinned against a silent downgrade.** An `sslmode` in
`DATABASE_URL` replaces the `ssl` option the code builds, and `require`,
`prefer` and `verify-ca` will all stop verifying certificates when `pg` reaches
v9 — during a dependency upgrade, with no code change to review. **Pin
`sslmode=verify-full` before that happens** (`docs/OPERATIONS.md` §11, item 19).

**The `uuid` dependency is gone**, replaced by `crypto.randomUUID()`. `npm audit`
reports 0.

### Still not done, and still blocking a public launch

- A screen-reader pass. Never performed.
- A manual keyboard walkthrough. Never performed.
- Zoom and reflow at 200%/400%, touch-target size, focus appearance.
- axe against an RTL rendering. The Arabic sweep checks direction and leakage,
  not accessibility.

`docs/ACCESSIBILITY.md` "Not verified" is the authoritative list.
