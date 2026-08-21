# Launch readiness

**Naseeb is NOT launch-ready.** This document exists to say so precisely, and to
name what would have to change.

The platform is deployed, healthy and deliberately closed:
`DEPLOYMENT_STATE=pre_launch`, schema `0003`, `/healthz` and `/readyz` both 200.
Signup, campaign submission, publication, entry, the draw and claim-start all
answer `503 NOT_OPEN_YET`. That is the intended state and nothing in this phase
changes it.

Status as of **2026-08-21**, on branch `phase-2.4b-launch-readiness`, against
`main` = `8a71ea42d23add2c8896763188a2a71895b31ad8`.

---

## How to read this

Six sections. A launch requires **every** item in the first five to be closed.
An item is listed under the party who can actually close it — engineering cannot
close a legal question, and counsel cannot close a billing decision.

Nothing here may be marked complete on the strength of an intention. "The owner
plans to" is not "done".

---

## 1. Engineering complete

Verified in code and by the automated suite. These are done.

| Item | Evidence |
| --- | --- |
| Fail-closed pre-launch gate | `config.js` `operationsAllowed()`; `test/prelaunch-gate.test.js` |
| Migration ledger, checksummed | `schema_migrations` = 3 rows, canonical LF checksums; `migrate verify` exit 0 |
| Line endings cannot change a migration's identity | `server/lib/canonicalText.js`; `test/migration-line-endings.test.js` |
| Database-backed cookie sessions, rotation, revocation | `test/sessions.test.js`, `test/session-families.test.js` |
| CSRF protection | `test/csrf.test.js` |
| Enforced CSP + DOM safety | `test/csp.test.js`, `test/dom-safety.test.js`, hostile-data browser harness |
| Claim tokens, encryption at rest, key rotation | `test/prize-claims.test.js` |
| Entry integrity, disqualification, append-only audit | `test/entry-integrity.test.js` |
| Transactional draw: one winner, one claim | `test/giveaway-lifecycle.test.js` gl14; `test/race-conditions.test.js` |
| 100-entry close and one-month deadline close | gl2–gl7 |
| Sponsor withdrawal is not self-service | gl20 |
| Cancellation notifies entrants durably | gl21–gl23 |
| Nine maintenance jobs, bounded + advisory-locked | `server/lib/maintenance.js`; `test/operations.test.js` op5–op14 |
| Test suite cannot reach production | `testEnv.js`; `test/test-db-guard.test.js` |
| `noindex, nofollow, noarchive` in pre-launch | verified live on `/`, `/terms.html`, `/privacy.html` |

**Not yet complete in engineering** — tracked in this phase, not yet done:

- [ ] WCAG 2.2 AA remediation. Audited: `aria-live` **0** occurrences sitewide,
      `<h1>` on **5 of 23** pages, no dialog semantics, `verify-email-change.html`
      has no skip link. Async form errors are never announced (WCAG 4.1.3).
- [ ] Arabic parity. Key parity is 81/81, but only **31 `data-i18n` attributes on
      3 of 23 pages**. Twenty pages have no Arabic at all.
- [ ] Automated accessibility coverage (axe-core) across all pages.
- [ ] End-to-end browser rehearsal of the member, administrator, claim and
      fulfilment journeys. Invariants are covered by the existing suite; the
      joined-up browser journey is not.
- [ ] SEO metadata prepared behind the deployment-state switch: canonical
      **0 of 23**, description **16 of 23**, JSON-LD on index only.

---

## 2. Owner action

Only the owner can close these.

- [ ] **Decide whether to pay for Render cron jobs.** Cron cannot run on a Free
      instance; each cron job is a separate billable service, minimum **$1/month**,
      prorated by the second. Verified against Render's docs 2026-08-21.
      - Minimum viable: **1** cron service running `node scripts/maintenance.js all`
        at `*/15 * * * *`.
      - Recommended: **3** services — see `docs/OPERATIONS.md` §4.
      - Until this exists, **no maintenance job runs at all in production.**
        Sessions are never swept, outboxes never drain, claims never expire,
        retention never executes. This is the single largest operational gap.
- [ ] **Create the `naseeb-shared` environment group** (or set variables directly
      on each cron service). It does not exist today; the web service holds its
      variables directly. Cron services running any outbox job need
      `RESEND_API_KEY` and `EMAIL_FROM` or they cannot send.
- [ ] **Remove `JWT_SECRET`** once the rollback window has closed. Nothing reads
      it; it is retained only for rollback compatibility.
- [ ] **Decide the fate of the suspended Singapore service** `srv-d966lc9kh4rs73da92rg`.
- [ ] **Confirm the Neon snapshot** `snap-ancient-resonance-atixc2sh` still exists.
      The Neon connector exposes no snapshot-listing tool, so this cannot be
      verified from here.
- [ ] **Enable Neon branch protection** on `production`. It currently reports
      `protected: false`.
- [ ] **Decide retention of the `production (old)` recovery branch.**
- [ ] Commission a **native Modern Standard Arabic review** of all translated
      copy. Machine-drafted Arabic is marked as pending review in
      `docs/ARABIC_RTL.md` and must not ship to the public unreviewed.

---

## 3. Provider action

- [ ] **Stripe**: account is test-mode only. Going live needs business
      verification, then a live key, `STRIPE_WEBHOOK_SECRET`, and
      `ADS_CHECKOUT_ENABLED=true`. `STRIPE_SECRET_KEY` was removed from Render on
      2026-08-20 because a `sk_test_` value is treated as a placeholder and is
      fatal in production.
- [ ] **Resend**: `mynaseeb.ae` is verified (eu-west-1). Inbound mail for
      `customer@mynaseeb.ae` is still paused — WhatsApp-only. A public support,
      privacy or legal inbox **must not be published anywhere** until it is
      actually configured and verified.
- [ ] **Prize partners**: no signed sponsor agreement exists. A binding
      no-withdrawal agreement and a replacement-prize guarantee are both absent,
      and neither may be implied in public copy.

---

## 4. Counsel action

Qualified UAE counsel only. Engineering must not substitute for this. See
`docs/UAE_COUNSEL_REVIEW.md`.

- [ ] Terms of Service: still a **draft with no effective date**.
- [ ] Privacy Policy: still a **draft with no effective date**.
- [ ] Legal entity, trade licence, registered address, contact for legal notices,
      and the identity of the data controller — all currently "to be confirmed".
- [ ] Governing emirate and competent courts.
- [ ] Whether a promotional-campaign permit applies to giveaways run through this
      platform, and whose responsibility it is.
- [ ] Whether the stated retention periods are appropriate.
- [ ] Enforceability of the liability limits.
- [ ] Correct treatment of host fees and advertising revenue.

**Operator facts as they stand.** Naseeb is operated during development by
Mostapha Chehade personally, in Dubai, UAE. There is **no company and no trade
licence** for Naseeb. It is **not VAT-registered** and is **not conducting
commercial operations**. Nothing in the product may state or imply otherwise.

---

## 5. Public-launch switch

Do not touch any of these until sections 1–4 are closed.

- [ ] `DEPLOYMENT_STATE` → `private_beta`, then `public_launch`.
      Note `launchBlockers()` **refuses** `public_launch` while either policy is a
      draft — the code enforces this, deliberately.
- [ ] SEO activation flips with deployment state: `pre_launch` stays `noindex`;
      only `public_launch` emits indexable metadata and a `robots.txt` that allows
      crawling.
- [ ] `robots.txt` and sitemap generation enabled.
- [ ] `ADS_CHECKOUT_ENABLED` → `true` (only with a live Stripe key and webhook
      secret).
- [ ] Policies marked effective with a real effective date — **a counsel decision,
      not an engineering one**.

---

## 6. Post-launch monitoring

- [ ] Cron run failures surfaced (Render reports a non-zero cron exit as a failed
      run; each job prints one structured JSON line).
- [ ] `/readyz` monitored — it already fails closed on schema drift or a missing
      critical protection.
- [ ] Sentry configured and alerting (`SENTRY_DSN` is set; alert routing is not
      verified).
- [ ] Outbox depth and terminal-failure count watched;
      `NOTIFICATION_FAILURE_THRESHOLD` drives the degraded readiness signal.
- [ ] Backup/restore rehearsed against the real provider. CI proves the
      mechanism; only the owner can prove Neon's backups.
- [ ] First real campaign reviewed end to end before a second is published.

---

## Known technical warnings

| Warning | Disposition |
| --- | --- |
| `npm audit`: 1 moderate, `uuid` | **Not reachable.** The advisory affects v3/v5/v6 when `buf` is supplied; the codebase imports only `v4`, in 10 files, never with `buf`. The offered fix is `uuid@14`, a semver-major bump. Documented, not applied. |
| `pg-connection-string` SSL-mode deprecation | Driven by `sslmode` in `DATABASE_URL`. Fixing it means editing that variable, which is out of scope this phase. Note `server/db.js` uses `rejectUnauthorized: false`; tightening it is a production-boundary decision. Deferred to owner. |
| GitHub Actions forced onto Node 24 | `actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4`. CI-only, no runtime impact. Narrow version bump pending. |

---

## Verification limits — read this before trusting any green tick

This development machine has **no PostgreSQL, no Docker and no `psql`**. The test
suite begins with `scripts/reset-test-db.js` and the application requires a
database at startup, so **nothing runtime can be executed locally**: not the test
suite, not the browser-security harness, not the accessibility suite, not the
rehearsal, not the app itself.

All runtime evidence in this repository therefore comes from **CI** (GitHub
Actions, Postgres 16 service container). Where this document cites a test, it
cites a test that CI runs — not one that was observed passing on a developer
machine.

Automated accessibility checks do **not** prove WCAG conformance. axe-core
catches a minority of failures. Manual keyboard and screen-reader verification is
recorded separately in `docs/ACCESSIBILITY.md`, including what could not be
verified.
