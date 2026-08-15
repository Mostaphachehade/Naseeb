# Naseeb — free-entry giveaway platform

A full-stack web app where anyone can host a giveaway and anyone can enter — for free, always.
There is no payment flow anywhere in this codebase, by design. Every giveaway must:

- be free to enter (no field for a price or fee exists on the entry endpoint)
- disclose who is funding the prize (`funded_by`, shown publicly — the point is that the
  prize is a marketing/promotional cost carried by the host, not something paid for by entrants)
- draw a winner only after the entry deadline, uniformly at random from all entries
- limit each person to one entry, so no one can pay or otherwise "buy" better odds

## Why it's built this way

Paid-entry raffles and lotteries are regulated in most countries. In the UAE, commercial gaming
is overseen by the General Commercial Gaming Regulatory Authority (GCGRA). This application does
not implement a paid-entry model at all: there is no field for an entry price anywhere on the
entry path, and no mechanism for buying better odds.

**That is a description of the code, not a legal conclusion.** Nothing here has been reviewed by
UAE legal counsel, and free entry does not automatically remove permit, advertising,
consumer-protection, prize-fulfilment, trade-licensing or data-protection obligations that may
apply to a particular campaign or operator. Do not treat this repository, its documentation or
its public pages as advice that any campaign is lawful.

`docs/UAE_COUNSEL_REVIEW.md` lists every legal question that is still open, and the facts
(legal entity, licence, address, controller identity, jurisdiction) that are deliberately left
blank rather than invented.

If you ever add paid entries, ticket tiers or "buy more chances," that is a materially different
product and needs advice from a qualified lawyer before it is built, let alone launched.

## Stack

- **Backend:** Node.js, Express, Postgres (via `pg`), JWT auth, bcrypt password hashing
- **Frontend:** Plain HTML/CSS/JS (no build step, no framework) — just open and deploy
- **Database:** Any hosted Postgres works (Neon, Supabase, Render Postgres, etc). A free
  hosted Postgres is required — local SQLite files don't survive restarts on most free
  hosting platforms (Render's free tier included), so this app no longer uses SQLite.

## Setting up a free database

1. Go to **neon.tech** (or supabase.com), sign up free, create a new project
2. Copy the connection string it gives you — it looks like
   `postgresql://user:password@host/dbname?sslmode=require`
3. That's your `DATABASE_URL`

## Running it locally

```bash
npm install
cp .env.example .env
# edit .env: set JWT_SECRET to a long random string, and DATABASE_URL to your Neon/Supabase connection string
npm start
```

Then open http://localhost:3000

Tables are created automatically on first run if they don't already exist.

> **`npm run db:init` is a production-capable command.** It runs the schema
> migration in `server/db.js` against whatever `DATABASE_URL` is in your
> environment — including the live database, with no confirmation prompt and no
> guard in front of it. It is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD
> COLUMN IF NOT EXISTS`), so it is not destructive today, but it is a direct
> write path to production and future migrations may not be as forgiving. Never
> run it casually, never run it to "reset" anything, and never run it while a
> `.env` pointing at production is loaded unless you specifically intend to
> migrate production. To prepare a database for tests, use the test tooling
> below instead — it cannot reach production by construction.

## Running the tests

The test suite never reads `.env`. It reads `.env.test` (gitignored) or real
environment variables, and refuses to run against anything that isn't an
isolated test database — see `testEnv.js`. This is deliberate: the suite
creates, updates and deletes users, giveaways and entries, and it previously
inherited the production connection string from `.env`.

```bash
npm run test:db:start          # throwaway local Postgres in .tmp-testdb/ (port 55432)
export TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55432/naseeb_test"
npm test                       # resets the schema, then runs every test file
npm run test:db:destroy        # when you're done
```

`npm test` refuses to start if the target database isn't named like a test
database (the name must contain `test`), or if it's on a remote host without
`ALLOW_REMOTE_TEST_DB=yes`. Errors describe the target as `host:port/database`
only, so a misconfigured run can't leak a password into a log.

Already have a Postgres you'd rather use? Skip `test:db:start` and point
`TEST_DATABASE_URL` at a scratch database of your own whose name contains
`test`. CI does exactly this with an ephemeral `postgres:16` service container.

## Project structure

```
naseeb/
  server/
    index.js               # Express app entry point
    db.js                   # Postgres schema (users, giveaways, entries, host_applications)
    lib/email.js             # Resend wrapper — logs to console if RESEND_API_KEY isn't set
    middleware/auth.js        # JWT auth middleware (requireAuth, optionalAuth, requireAdmin)
    middleware/rateLimit.js   # rate limiters for auth, entry, and application endpoints
    routes/auth.js            # signup / login / email verification / password reset
    routes/giveaways.js       # browse (paginated), create, enter, draw, dashboard
    routes/hostApplications.js # public application form -> host_applications table
    routes/admin.js            # admin-only: list/review host applications
    routes/config.js           # exposes non-secret Cloudinary config to the frontend
  public/
    index.html            # browse giveaways
    giveaway.html          # single giveaway: enter, or draw if you're the host
    create.html            # host form (funding disclosure + optional image upload)
    dashboard.html          # your hosted giveaways + your entries
    host-apply.html          # apply to host on a paid plan (individual or company)
    admin.html                # admin-only: review host applications
    verify.html / forgot-password.html / reset-password.html
    login.html / signup.html
    about.html / pricing.html / terms.html / privacy.html
    css/style.css
    js/app.js               # shared auth/session helpers + rendering
```

## Environment variables

See `.env.example` for the full list. `JWT_SECRET` and `DATABASE_URL` are required — the app
won't start without them. Everything else is optional and degrades gracefully if unset:

- **`RESEND_API_KEY`** — without it, verification/reset/notification emails are logged to the
  server console instead of sent. Get a free key at [resend.com](https://resend.com).
- **`ADMIN_NOTIFY_EMAIL`** — where "new host application" emails go. No key, no email.
- **`CLOUDINARY_CLOUD_NAME`** / **`CLOUDINARY_UPLOAD_PRESET`** — enables in-browser image
  upload on the host form. Without them, hosts just paste an image URL instead. Create a free
  account at [cloudinary.com](https://cloudinary.com) and an **unsigned** upload preset
  (Settings → Upload → Upload presets) — unsigned uploads never need the API secret.
- **`APP_URL`** — the public URL this app is served at, used to build links inside emails
  (verification, password reset). Set this to your real domain once deployed.
- **`ADS_CHECKOUT_ENABLED`** — self-serve ad checkout. **Off unless explicitly set** to
  `true`/`1`/`yes`/`on`; anything else, including absent or misspelled, fails closed and the
  advertise page falls back to its manual inquiry form.
- **`STRIPE_SECRET_KEY`** / **`STRIPE_WEBHOOK_SECRET`** — **required** whenever
  `ADS_CHECKOUT_ENABLED` is on. The app refuses to start without them, on purpose: with
  checkout live and no verified webhook, customers get charged for bookings nothing ever marks
  as paid.

## Ad payments

Advertiser payments are the only payment flow in this codebase. Entering a giveaway is free
and always will be — there is no price field anywhere on the entry path.

Fulfilment happens **only** in the Stripe webhook at `POST /api/webhooks/stripe`. It used to
happen when the customer's browser returned to the success page, which meant a closed tab or a
dropped connection left a real payment recorded as unpaid and a banner that was bought but
never ran. Webhooks are delivered server-to-server and retried until acknowledged, so nothing
now depends on what the customer does after paying. `/api/ads/checkout/confirm` is a read-only
status lookup — it cannot mark anything paid.

Setting it up:

1. In the Stripe dashboard, add an endpoint pointing at
   `https://your-domain/api/webhooks/stripe`.
2. Subscribe it to: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`.
3. Copy the signing secret it shows **once** into `STRIPE_WEBHOOK_SECRET`. It is per-endpoint
   and per-environment, it is not the API key, and it cannot be retrieved later — if it is
   lost, roll it in the dashboard and update the variable.
4. Locally, `stripe listen --forward-to localhost:3000/api/webhooks/stripe` prints a
   `whsec_...` valid for that session.

Every delivery is signature-verified with `stripe.webhooks.constructEvent()` before any
database statement runs, then recorded in a `stripe_events` ledger in the same transaction as
the state change it causes. That pairing is what makes retries safe: a failure rolls back both,
so Stripe's retry finds the event unprocessed, and a duplicate delivery finds it already
recorded and does nothing. A verified event is still reconciled against the booking — session
id, `client_reference_id`, currency and exact amount must all match, or it is refused and
logged rather than fulfilled.

The ledger stores an event id and type only. Webhook payloads are never persisted and never
logged, so no customer or card data is retained here.

### How the banner slot is reserved

There is one banner position, sold as a date range, so two advertisers must never be able to
buy the same days. Two independent mechanisms stop that:

- **An advisory lock** serialises allocation. A checkout reserves its dates and works out what
  those dates are inside one locked transaction, so concurrent requests take turns and each
  sees the previous booking. Bookings come out consecutive rather than colliding.
- **A PostgreSQL exclusion constraint** (`ads_no_overlapping_slots`) makes overlapping
  held-or-paid ranges impossible to store at all — including via a hand-written `INSERT`, a
  code path that forgets the lock, or a future bug. Application logic can be wrong; a
  constraint cannot.

A booking holds its dates for 60 minutes while the customer is in Stripe Checkout. The Stripe
session is set to expire five minutes *before* that, so the session always stops being payable
before the dates are released — never the other way round. If Stripe session creation fails,
the hold is released immediately rather than blocking the slot for an hour.

Expired and abandoned reservations are released, never deleted: `slot_status`,
`slot_released_at` and `slot_release_reason` record what happened. An abandoned booking is
still a commercial record of who tried to buy what and when.

A payment can legitimately arrive after its hold has lapsed — a slow webhook, a retry after an
outage. If nobody else has taken the dates, the booking simply reclaims them. If somebody has,
it is **not** double-booked: it becomes `payment_status = 'requires_reconciliation'` and is
logged loudly, because real money was taken for dates that cannot be delivered and someone has
to refund or reschedule it.

The migration that adds the constraint checks for pre-existing overlaps first. If it finds any,
it reports the conflicting booking ids and dates — identifiers only, never the advertiser's name
or email — and declines to add the constraint, leaving every row untouched. Those are real
bookings that real advertisers may have paid for, and picking a winner automatically would
destroy a commercial record, quite possibly the wrong one. Resolve them by hand: set one side to
`slot_status = 'released'` **with** `slot_released_at` and a `slot_release_reason`, then restart.
The reason is what stops the migration re-claiming that slot on the next deploy.

### Before enabling ad checkout

`ADS_CHECKOUT_ENABLED` is not a switch to flip once the code looks finished. Three gates enforce
part of that automatically:

- **Startup refuses to boot** if checkout is on and either Stripe variable is missing.
- **Startup refuses to boot** if checkout is on and the overlap constraint is missing, blocked
  or unverifiable. With checkout off the app starts normally, so a deployment carrying
  overlapping legacy bookings can still run while someone fixes the data.
- **`POST /api/ads/checkout` refuses at request time** whenever overlap protection is not
  confirmed — before any hold is inserted and before Stripe is contacted. A startup check only
  proves something about the moment the process began; the constraint can be dropped by a
  migration or a restore while the process runs on happily.

The remaining gates are human ones, and none of them is satisfied by a passing test suite:

- [ ] Overlap constraint confirmed active in the production database
- [ ] Stripe webhook endpoint registered against the production URL, with all six event types
- [ ] `STRIPE_WEBHOOK_SECRET` set for that endpoint in the production environment
- [ ] Displayed price and charged price proven identical (Phase 1.4)
- [ ] **An admin reconciliation queue exists.** A payment that lands after its dates were
      reallocated becomes `payment_status = 'requires_reconciliation'`: real money taken for a
      slot that cannot be delivered. Today that state raises a Sentry alert and nothing more —
      there is no screen anyone can look at and no way to work through a backlog of them.
      Selling slots without somewhere for those to land means the failure is silent to everyone
      except whoever reads the alerts. **This is a mandatory pre-enable gate, not a nice to
      have, and passing Phase 1.4 does not satisfy it.**
- [ ] An end-to-end test on staging covering payment, fulfilment, refund and reconciliation

## Getting the prize to the winner

Drawing a winner used to be where the system stopped caring. The host clicked a
button that said "delivered" and that was the whole record — the winner had no
way to confirm it, contradict it, or pass on an address, and the privacy policy
meanwhile told entrants that hosts could contact them, which nothing made
possible.

A draw now creates a **claim**, and the claim is a state machine:

```
awaiting_claim → claimed → preparing_delivery → shipped_or_arranged
               → delivered_pending_confirmation → delivered
                                    ↘ disputed ↗ (admin resolves)
awaiting_claim → expired (admin review — never an automatic redraw)
```

Who may make each move is part of the definition, not a convention. The host
moves a prize along to *sent*; **only the winner can confirm it arrived**. Either
side can raise a dispute, and only an administrator can resolve one, with a
reason that is recorded. Every transition is stamped with who did it and when.

**Claim links.** The winner gets an emailed link carrying 256 bits of
randomness. Only its SHA-256 hash is stored, so a database leak yields nothing
redeemable. It works once, expires (`CLAIM_TOKEN_TTL_HOURS`), is invalidated the
moment it is used or replaced, and grants access to that one claim and nothing
else. Its body is never written to a log, even in development — see
`CLAIM_DEV_LOG_LINKS` if you need to click one locally.

**Consent.** Nothing about a winner reaches a host until the winner explicitly
agrees, and the version of the consent wording plus the timestamp are recorded.
Decline, and no delivery details are stored at all.

**Delivery details.** Name, phone, address, and optional notes — the minimum to
hand something over. No identity documents, no payment details, no date of
birth; fields a client invents are dropped rather than stored. They are
encrypted with AES-256-GCM (`CLAIM_ENCRYPTION_KEY`) with a fresh IV per record,
and an altered record fails authentication rather than decrypting. They never
appear in an email, a URL, a log, a Sentry payload or an admin list.

**Retention.** `CLAIM_DELIVERY_RETENTION_DAYS` after a delivery is confirmed or
a dispute closed, the encrypted details are erased. The claim, its outcome and
its full transition history survive; the address does not. Cleanup is idempotent
and safe to run concurrently or repeatedly. **The period is provisional and is
one of the things UAE counsel needs to confirm.**

**Claim links live in the URL fragment** — `/claim.html#token=…`, never a query
string. A fragment is never sent to a server, so the token cannot reach this
application's logs, a reverse proxy, or a `Referer` header on the way in. The
page reads it before any other script loads, erases it from the address bar with
`history.replaceState`, and exchanges it through a `POST`. Analytics does not
initialise on that page at all. The link exists in the winner's email, which is
unavoidable and is the whole mechanism — and nowhere else.

**The invitation is sent through a durable outbox.** The intent to notify is
written in the same transaction as the draw, so a mail-provider outage leaves a
pending row to retry rather than losing the one message the workflow depends on.
The outbox holds no token: each attempt issues a fresh one and invalidates its
predecessor, so a leaked outbox row is not a claim link. Errors are stored as a
coarse category, never the provider's message, which routinely quotes the
recipient's address back at you.

**Retention, expiry and retries run on a schedule**, from an in-process timer
(`CLAIM_MAINTENANCE_INTERVAL_MINUTES`, default 15). Deliberately not an HTTP
endpoint: there is no route to call, so there is nothing to authenticate or rate
limit. A Postgres advisory lock means only one instance does the work per tick,
and repeated failures escalate to an explicit alert. The admin endpoint still
exists for running it on demand, but nothing depends on anyone visiting a page.

**Recovering an old giveaway.** Giveaways drawn before this workflow existed
appear under "Drawn giveaways with no claim" in the admin panel. Issuing a claim
emails the winner the draw already chose — it reads `winner_entry_id` and
refuses outright if there isn't one. Nothing here ever picks a winner.

**With `CLAIMS_ENABLED=false`** the claim API returns 503, the draw creates no
claim, and the UI renders no claim controls (the flag is exposed through
`/api/config`). It does **not** restore the old host-only delivery confirmation —
that path is closed permanently, so a disabled workflow means delivery simply
isn't recorded, not that a host can declare it alone again.

**Key rotation.** Move the current `CLAIM_ENCRYPTION_KEY` into
`CLAIM_ENCRYPTION_KEYS_PREVIOUS`, generate a new key with a new version prefix,
deploy. Nothing needs re-encrypting: existing records stay readable under the
version stamped on them, new records use the new key, and an old key can be
dropped from the list once no record references it. Back the key up separately
from database backups — losing it makes stored delivery details permanently
unreadable, by design.

## Standing deployment gates

Recorded here because they outlive any one phase. None of them is satisfied yet, and
none should be treated as satisfied by a passing test suite.

1. **Retention must not depend on the in-process timer alone.** The scheduler in
   `server/lib/claimScheduler.js` runs inside the web service, so it stops when that
   service sleeps, restarts or is scaled to zero — which on a free tier is most of the
   time. Before deployment, add a platform-scheduled job (a Render cron service, or the
   equivalent) that invokes the same maintenance path independently of whether the web
   service is awake. The in-process timer is a convenience, not the mechanism.

2. **Unhandled rejections must not be swallowed.** `server/index.js` currently logs an
   unhandled rejection and carries on, which leaves the process in a state nobody has
   reasoned about. Every background task must catch and report its own failures, and a
   rejection that still reaches the process handler should trigger a controlled shutdown
   so the platform restarts cleanly rather than continuing in an uncertain state.

3. **`CLAIM_ENCRYPTION_KEY` must be generated privately and backed up securely**, then
   set in the deployment environment. Generate it on a trusted machine, store it
   somewhere separate from the database backups, and never print, commit, paste or send
   it. Losing it makes every stored delivery detail permanently unreadable — by design.

4. **`ADS_CHECKOUT_ENABLED` stays `false`.** The pre-enable gates below are unchanged,
   and the admin reconciliation queue in particular is still outstanding.

5. **No production push or deployment is authorised.** Nothing in this branch has been
   deployed, and nothing should be until the gates above and the counsel review in
   `docs/UAE_COUNSEL_REVIEW.md` are resolved.

## Legal and compliance status

**This platform has not been reviewed or approved by qualified UAE legal counsel, and is
not described anywhere as compliant or production-ready.**

**The Terms of Service and Privacy Policy are review drafts and must not be deployed
publicly in their current form.** Both carry status `draft` with **no effective date**,
contain unfilled *to be confirmed* placeholders, have never been presented to anyone for
acceptance, and bind nobody. Deploying them as they stand would put unreviewed legal text
with visible gaps in front of real users.

Policy status is explicit — `draft` → `approved` → `effective` — and nothing infers one
from another: a version bump does not mean approval, a date passing does not activate
anything, and an approved policy still needs a deliberate transition to become effective.
Activation is a reviewed edit to `server/lib/policies.js` that shows up in a diff, never an
environment variable, so no deploy can quietly make an unreviewed document live.
`policy_acceptances` is empty and refuses writes for any policy that is not effective.

- `docs/UAE_COUNSEL_REVIEW.md` — every open legal question, and the facts (legal entity,
  licence, registered address, data controller, jurisdiction) that are deliberately left
  blank rather than invented.
- `docs/LEGAL_COPY_INVENTORY.md` — every claim that was removed, softened or kept, and
  why.
- `test/legal-copy.test.js` — fails the build if a prohibited claim reappears.

Retention periods in the product are **provisional** and pending that review.

## Deploying to Render

This repo includes a `render.yaml` blueprint.

1. Push this repo to GitHub if it isn't already.
2. On [render.com](https://render.com), **New +** → **Blueprint**, and point it at this repo.
   Render will read `render.yaml` and set up a web service running `npm start`.
3. Fill in the environment variables it prompts for (`JWT_SECRET`, `DATABASE_URL`, and the
   optional ones above). Generate `JWT_SECRET` with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
4. Once deployed, set `APP_URL` to the `https://your-app.onrender.com` URL Render gives you
   (or your custom domain) so email links point to the right place.
5. Leave `ADS_CHECKOUT_ENABLED` as `false`. To turn ad payments on later, set
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the dashboard first, register the
   webhook endpoint against the deployed URL, and only then flip the flag — the app will
   refuse to boot if the flag is on and either secret is missing.

Any other Node host (Railway, Fly.io, a VPS) works the same way without the blueprint —
just set the same environment variables and run `npm start`.

## Pre-launch checklist

- [x] Rate limiting on `/api/auth/*`, `/api/giveaways/:id/enter`, and the host application form
- [x] Email verification required before a new account can host or enter a giveaway
- [x] Terms of Service and Privacy Policy pages
- [ ] A payment processor, if you want to actually charge for the paid hosting plans on the
      pricing page — today, applications are just captured for manual follow-up
      (see `/admin.html`), and hosting itself isn't gated behind payment
