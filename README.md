# Naseeb — free-entry giveaway platform

A full-stack web app where anyone can host a giveaway and anyone can enter — for free, always.
There is no payment flow anywhere in this codebase, by design. Every giveaway must:

- be free to enter (no field for a price or fee exists on the entry endpoint)
- disclose who is funding the prize (`funded_by`, shown publicly — the point is that the
  prize is a marketing/promotional cost carried by the host, not something paid for by entrants)
- draw a winner only after the entry deadline, uniformly at random from all entries
- limit each **verified account** to one entry per giveaway, so no one can pay or otherwise
  "buy" better odds. That is what the database enforces; it is not a claim that one account
  is one person, and the product does not collect identity documents to find out. Suspected
  multi-accounting is reviewed by an administrator, with a reason, on the record — see
  `docs/ENTRY_INTEGRITY.md`.

**Hosting is a closed beta.** Entering is open to anyone with a verified email; publishing a
giveaway is not. An account must be approved by an administrator, and access can be suspended
without deleting anything. Suspending a host puts every unfinished prize claim of theirs into
an administrator rescue queue automatically, so a winner mid-delivery is never left waiting on
somebody who can no longer act — and never asked to raise a dispute to fix it. See
`docs/HOST_ACCESS.md` for the model, the routes it gates, the migration, and the exact limits
on what a rescuing administrator may do (they may ship on a host's behalf; only the winner ever
confirms receipt).

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

- **Backend:** Node.js, Express, Postgres (via `pg`), bcrypt password hashing, and
  database-backed sessions in an HttpOnly cookie (see `docs/SESSIONS.md`)
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
# edit .env: set SESSION_SECRET to a long random string, and DATABASE_URL to your Neon/Supabase connection string
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
    middleware/auth.js        # cookie-session auth (requireAuth, optionalAuth, requireAdmin)
    middleware/rateLimit.js   # rate limiters for auth, entry, and application endpoints
    routes/auth.js            # signup / login / logout / session bootstrap / verification / reset
    middleware/auth.js        # cookie session -> req.userId. No bearer path exists.
    lib/sessions.js           # opaque tokens, hashes, expiry, revocation, rotation
    lib/csrf.js               # session-bound CSRF token + Origin/Referer check
    routes/giveaways.js       # browse (paginated), create, enter, draw, dashboard
    routes/hostApplications.js # private-beta host application (sign-in required) + own status
    routes/admin.js            # admin-only: review applications, grant/suspend host access
    lib/hostAccess.js          # THE host authorization gate — see docs/HOST_ACCESS.md
    lib/claimRescue.js         # admin takeover of a suspended host's open claims
    lib/securityHeaders.js     # THE CSP and every other security header — see docs/CSP.md
    lib/mediaUrls.js           # media origin allowlist, shared by URL validation and img-src
    lib/entryIntegrity.js      # entry status, decisions and the draw pool — see docs/ENTRY_INTEGRITY.md
    lib/riskSignals.js         # privacy-minimised abuse indicators; never a verdict
    lib/proxyTrust.js          # how much of X-Forwarded-For is believed
    routes/account.js          # the account centre — see docs/PRIVACY_AND_RIGHTS.md
    lib/accountRights.js       # email change, privacy requests, deletion blockers
    lib/eligibility.js         # the 18+ self-declaration. Not age verification
    lib/dataExport.js          # what a person may download about themselves
    lib/policies.js            # policy status/version/effective date. Inert by design
    lib/errorReporting.js      # Sentry config + the beforeSend scrubber
    routes/config.js           # exposes non-secret Cloudinary config to the frontend
  public/
    index.html            # browse giveaways
    giveaway.html          # single giveaway: enter, or draw if you're the host
    create.html            # host form (funding disclosure + optional image upload)
    dashboard.html          # your hosted giveaways + your entries
    host-apply.html          # apply to the private hosting beta (individual or company)
    admin.html                # admin-only: review applications, grant/suspend host access
    account.html              # your data, your corrections, your privacy requests
    verify-email-change.html   # confirms a new address from a token in the fragment
    verify.html / forgot-password.html / reset-password.html
    login.html / signup.html
    about.html / pricing.html / terms.html / privacy.html
                          # pricing.html lists only what exists: free entry, a free
                          # closed hosting beta, and paid advertising
    css/style.css           # the design system
    css/utilities.css        # the classes that replaced 317 inline style="" attributes
    css/pages.css            # the three former inline <style> blocks
    js/app.js               # shared auth/session helpers + rendering
    js/dom.js                # DOM construction + four context-specific URL validators
    js/pages/*.js            # one file per page — every former inline <script>
```

Every page's script is a file under `public/js/pages/`, loaded in the same order the
inline blocks ran in. There is no build step; that is still true.

## Sessions, CSRF and signing in

Browser authentication is an opaque random token in an **HttpOnly cookie**, with only its
SHA-256 hash stored in Postgres. It is not readable by JavaScript, it can be revoked from the
server at any moment, and it lasts 12 hours rather than the 30 days the previous JWT-in-
localStorage scheme did. Every state-changing request also needs a session-bound CSRF token in
an `X-CSRF-Token` header and an `Origin`/`Referer` matching `APP_URL`.

Three things to know before deploying:

1. **Set `SESSION_SECRET`** (48 random bytes) and make sure `APP_URL` is your real https origin.
   Production refuses to start without both, and a wrong `APP_URL` makes every write fail with
   `403 ORIGIN_NOT_ALLOWED`.
2. **Everyone signs in once** after this ships. Old localStorage tokens are cleared on sight and
   are never exchanged for a session — that is deliberate, not an oversight.
3. **Local development** runs over plain http, so `COOKIE_SECURE` stays `false` there. Production
   cannot make that choice; it is checked at startup, along with the secret itself — production
   refuses to boot on a missing, short, placeholder, low-entropy or borrowed `SESSION_SECRET`.
   Only the variable name ever appears in that message.

Still outstanding: **nothing sweeps expired sessions on a schedule.** Expired sessions are
refused regardless, but the tables grow until a platform-scheduled maintenance job calls
`deleteExpiredSessions()`. See `docs/SESSIONS.md` §9b — session maintenance is not complete.

A **rotation chain is one logical session.** Every login creates a `session_families` row;
rotation stays inside it; logging out with any member — the current token or a predecessor still
inside its grace window — ends the whole family. Two partial unique indexes make that a database
guarantee rather than a convention.

`docs/SESSIONS.md` has the whole model: cookie attributes and why `SameSite=Lax`, the family and
rotation invariants, every revocation trigger, the single Stripe-webhook CSRF exclusion,
production secret validation, and what is still open.

Sessions are not by themselves XSS hardening — a cookie a script cannot read is still a
cookie a script can *use*. That gap is what the next section closes.

## Content Security Policy and XSS hardening

CSP is **enforced** on every response, and there is no environment variable, flag or
code path that turns it off:

```
default-src 'self'; script-src 'self'; script-src-attr 'none';
style-src 'self' https://fonts.googleapis.com; style-src-attr 'none';
font-src 'self' https://fonts.gstatic.com;
img-src 'self' https://res.cloudinary.com; media-src 'self' https://res.cloudinary.com;
connect-src 'self' https://api.cloudinary.com;
object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none';
manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

Production adds `upgrade-insecure-requests`. No `'unsafe-inline'`, no `'unsafe-eval'`,
no wildcards, no bare `data:`/`blob:` for scripts. Google Analytics origins appear only
when `GA_MEASUREMENT_ID` is set, and never on `/claim.html`, `/admin.html` or
`/owner.html`.

What that cost, and what it bought:

| | Before | After |
|---|---|---|
| Inline `<script>` blocks | 20 | **0** |
| Inline `<style>` blocks | 3 | **0** |
| `style=""` attributes | 317 | **0** |
| `setAttribute('style', …)` calls | 0 | 0 |
| `element.style` writes in JS | 82 | **12** (values computed at runtime) |
| Image origins accepted | any `http(s)` URL | an allowlist of 1 |
| `innerHTML` / `insertAdjacentHTML` sites | 74 | **0** |

**Nothing in `public/js` builds markup at runtime.** Not with a template literal, not
with an escaping helper, not once. Elements are created, text is set as text, and each
URL goes through a validator picked for where it is going. `escapeHtml` is gone on
purpose: HTML escaping is correct for exactly one context, so a general-purpose escaper
is a helper that is wrong somewhere. `docs/DOM_SINKS.md` is the full inventory — every
one of the 28 remaining sinks, what flows into it, and why it is safe. Reproduce its
counts with `node scripts/dom-sink-inventory.js`.

Four things to know before touching the frontend:

1. **No inline scripts or styles, ever again.** Add a file under `public/js/pages/` and a
   class in `public/css/utilities.css`. A `style="..."` attribute or an `onclick=`
   handler will silently not run in a browser, and `test/dom-safety.test.js` will fail.
2. **Build with `NaseebDom.el` / `mount`, never `innerHTML`.** `el('p', {text: value})`
   is the whole idiom; `mount(node, children)` replaces a container's contents. An
   `innerHTML` assignment anywhere in `public/js` fails the test suite.
3. **URLs have four validators, not one.** `safeInternalUrl` for our own pages,
   `safeMediaUrl` for images and video, `safeExternalLinkUrl` for an advertiser's site,
   `safeExternalRedirectUrl` for the Stripe hand-off. Never HTML-escape a URL — escaping
   does nothing to `javascript:`.
4. **`element.style.property = value` still works**, and is the right tool when a value is
   computed at runtime. What `style-src-attr 'none'` blocks is the style *attribute* —
   markup, and `setAttribute('style', …)`. `docs/CSP.md` §7 has the measurement, and the
   record of getting this backwards first.

`MEDIA_ORIGIN_ALLOWLIST` is one list with two consumers: it decides which image URLs the
server will store *and* becomes `img-src`/`media-src`. Adding an origin grants it on both
sides at once.

Two suites hold this in place, and they check different things:

```bash
npm test                                   # includes the static + validator guards
TEST_DATABASE_URL=… npm run test:browser-security          # real Chromium, hostile data
```

The second seeds a fabricated payload into **every** field a person can type into — 43
of them, across eleven payload families — serves them from the real app, and asks
Chromium what happened: any execution, CSP violation, JavaScript error, injected element,
hijacked form destination, clobbered global or unexpected network request fails the run.
`HOSTILE_SELFTEST=1` injects a live payload on purpose, so you can confirm the detector
still reports red before trusting it when it reports green.

`docs/CSP.md` is the whole policy: every external origin and why it is there, the other
seven security headers, the media-URL rejection rules, how to add an asset without
weakening anything, and the limitations that stand.

## Entry integrity

**One entry per verified account per giveaway.** That is a `UNIQUE` index and it is
enforced. It is **not** one entry per person: nothing here can tell two verified accounts
apart from two people, and the product does not collect identity documents to find out.
Every public page now says the enforceable thing rather than the flattering one.

What exists for the gap between those two statements:

- `entries.integrity_status` — `eligible` / `under_review` / `disqualified`, closed by a
  CHECK constraint. **An entry is never deleted to disqualify it**; the row, its time, its
  account and its giveaway survive every outcome.
- Append-only history (`entry_integrity_events`, `entry_integrity_case_events`) enforced by
  a `BEFORE UPDATE OR DELETE` trigger, with **no foreign keys**, so nothing cascades the
  audit trail away when an entry, giveaway or account is deleted.
- **Two fields, two audiences.** `integrity_admin_notes` is the administrator's own record
  — evidence, accounts compared, what a signal showed — and appears in exactly one
  `no-store` endpoint. `integrity_reason_code` is from a fixed allowlist, and the sentence
  the entrant reads is looked up from it in code, so it cannot be edited into an
  accusation or carry somebody else's details.
- Optimistic concurrency: the detail endpoint returns a version, the mutation requires it,
  and a stale decision is `409` with no status change and no event. The version is a
  staleness check, never a permission.
- Only a database-confirmed administrator decides, re-read from `users.is_admin` inside
  the transaction. A role, actor id or risk score in the request body is ignored. A host
  may *flag* an entry on their own giveaway; they cannot change its status.
- The draw uses eligible entries only, and **fails closed** with `409` while any entry is
  under review or any integrity case is open.
- After a winner exists, an allegation opens a case that **pauses fulfilment**. The winner
  and their claim are preserved. Resolving as `reinstated` or `no_action` closes the case
  and resumes the existing claim; resolving as **`upheld` does not close anything** — the
  case enters a durable blocked state that keeps pausing fulfilment, stays in the queue,
  and cannot be closed from the admin screen. Cancelling, replacing a winner or redrawing
  is not implemented and needs the owner and counsel before it is.

Risk signals are indicators for a human and **never disqualify anybody**. No raw IP
address is stored: a coarse prefix (IPv4 /24, IPv6 /48) is HMAC'd with
`INTEGRITY_SIGNAL_SECRET` and the current retention window, so the value cannot be
reversed and stops matching once the window turns over. No fingerprinting, no identity
documents, no data brokers, no cross-site tracking.

`TRUSTED_PROXY_HOPS` decides how much of `X-Forwarded-For` is believed — `0` by default,
`1` on Render, validated at startup. Too high and every rate limit becomes spoofable.

`docs/ENTRY_INTEGRITY.md` has the audit of what the system guaranteed before, the exact
transition rules, the draw and locking behaviour, the post-draw model, the signal
definitions and retention, and what is still open.

## Privacy, account rights and age attestation

`/account.html`, signed in, is where somebody reaches their own data: see what is held,
correct their display name, change their email address, download a copy, end every
session, and raise an access, correction, deletion or objection request. Every response on
`/api/account/*` is `Cache-Control: no-store`. An export and an email change each ask for
the password again — a live session shows somebody signed in once, not who is at the
keyboard now.

**Age is a self-declaration and nothing else.** Signup has an unticked, required checkbox
reading exactly *"I confirm that I am 18 years of age or older."*, recorded with a version
and a timestamp. No date of birth, identity document or biometric is collected anywhere,
and a test asserts no such column exists in the schema. Accounts created before this are
`unknown` — never backfilled — and are prompted before entering a giveaway, creating one
or applying to host. They are **never** blocked from finishing an open claim, confirming
delivery, raising a dispute, exporting their data or making a privacy request.

**Policy acceptance is built and deliberately inert.** A policy can be accepted only when
its status is `effective`, it carries an explicit effective date, and that date has
passed. Terms and Privacy are both `draft` with `effectiveDate: null`, so
`policy_acceptances` is empty and stays empty. Activation is a reviewed edit to
`server/lib/policies.js` — that file reads no environment variable, and a test greps it to
prove it. Nothing is inferred from signup, continued use or a deployment date.

**A deletion request cannot be completed, by anybody.** Nothing on this platform erases
or anonymises data, so marking an erasure request "completed" would be a false statement
to the person least able to check it. Three layers refuse it: a switch in
`server/lib/accountRights.js`, the route, and a `CHECK` constraint. A deletion request may
only reach `in_review`, `awaiting_information`, `awaiting_policy` (open, still in the
queue, still needing follow-up), `unable_to_complete` or `declined`, each with a
controlled explanation and mandatory internal notes.

Completing **any** request requires recorded execution evidence — an append-only
`privacy_request_executions` row naming what was erased, what was anonymised, what was
retained and why each retained category was kept, when it ran, and who or what ran it. An
access or correction completion needs a summary of what was actually provided or changed.
What could be erased, anonymised or must be retained is designed in
`docs/PRIVACY_AND_RIGHTS.md` §8 and awaits counsel — no statutory deadline is stated
anywhere, because none has been established.

**No route hard-deletes an account.** `DELETE /api/admin/users/:id` answers `405
ACCOUNT_DELETION_DISABLED` and points at the alternatives: suspend the account, revoke its
sessions, or use the privacy request workflow. Removing an account at the database level
is an emergency operation needing a separately approved runbook, which does not exist —
see `docs/PRIVACY_AND_RIGHTS.md` §8.

**Error reporting carries no personal data by construction.** Sentry's console
integration is gone, `sendDefaultPii` is off, breadcrumbs are dropped, and a `beforeSend`
scrubber in `server/lib/errorReporting.js` recursively redacts credentials, tokens,
cookies, headers, request bodies, query strings, email addresses, phone numbers,
addresses, delivery notes, internal notes, IP addresses, provider secrets and encrypted
payloads. Capture is a deliberate `reportError()` call, not a side effect of logging.

An email change is a security event: password first, a 32-byte token stored only as
SHA-256, two hours, single-use by the `UPDATE` that claims the row, uniqueness re-checked
inside the completion transaction, the token in a URL fragment and in exactly one email to
the **new** address, a warning with no completing link to the old one, and every session
revoked on completion.

`docs/DATA_INVENTORY.md` is the full table-by-table inventory — fields, purpose, access,
classification, retention implemented vs. awaiting decision, and external processors.
`docs/PRIVACY_AND_RIGHTS.md` has the request state machine, the email-change design and
the deletion/anonymisation proposal.

## Environment variables

See `.env.example` for the full list. `SESSION_SECRET` and `DATABASE_URL` are required in
production — the app won't start without them. Everything else is optional and degrades gracefully if unset:

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
- `docs/DATA_INVENTORY.md` — what is stored, who can reach it, and which retention
  periods are implemented versus undecided.
- `docs/PRIVACY_AND_RIGHTS.md` — the request workflow, and the deletion/anonymisation
  design that has not been implemented on purpose.
- `test/legal-copy.test.js` — fails the build if a prohibited claim reappears.

Retention periods in the product are **provisional** and pending that review. A UUID, an
account reference and a keyed network hash are treated throughout as personal data, not as
anonymous — removing a name from a row does not make the row anonymous.

Two scheduled jobs are missing and are operational gaps rather than legal ones: expired
sessions and expired risk signals both have cleanup code, and neither has a scheduler.
No runbook exists for a database-level account removal; the application path to one is
closed, and the operational path is undefined.

## Deploying to Render

This repo includes a `render.yaml` blueprint.

1. Push this repo to GitHub if it isn't already.
2. On [render.com](https://render.com), **New +** → **Blueprint**, and point it at this repo.
   Render will read `render.yaml` and set up a web service running `npm start`.
3. Fill in the environment variables it prompts for (`SESSION_SECRET`, `DATABASE_URL`, and the
   optional ones above). Generate `SESSION_SECRET` with:
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
- [x] Terms of Service and Privacy Policy pages — **drafts, not in effect**; see "Legal and
      compliance status" above
- [x] Revocable server-side sessions in HttpOnly cookies, with CSRF protection
- [x] Enforced Content Security Policy with no inline script or style anywhere
- [ ] A scheduled job that deletes expired sessions — nothing sweeps them today
      (`docs/SESSIONS.md` §9b)
- [ ] A payment processor for hosting, *if* hosting ever stops being free. It is free
      today: hosting is a closed beta gated on an application, not on payment
      (`docs/HOST_ACCESS.md`), and the only paid flow in the codebase is advertising
