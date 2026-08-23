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
| `noindex, nofollow, noarchive` in pre-launch | verified live on `/`, `/terms.html`, `/privacy.html`; `test/seo.test.js` seo9 |
| One deadline, derived from one scalar | `test/deadline-integrity.test.js` dl1–dl6 |
| Database TLS posture pinned against a silent downgrade | `test/database-tls-posture.test.js` tls1–tls7 |
| No visible text a dictionary cannot reach | `test/i18n-parity.test.js` i18n8, i18n10 |

**Not yet complete in engineering** — tracked in this phase, not yet done:

- [x] WCAG 2.2 AA — **automated portion only.** axe-core over 23 pages at two
      viewports reports 0 serious/critical. Three contrast failures that were
      live on production are fixed, including an effectively invisible submit
      button on `advertise.html` (1.11:1), and five unlabelled controls now have
      accessible names. **This is not conformance** — see `docs/ACCESSIBILITY.md`.
- [ ] **Screen-reader pass — never done.** No NVDA, JAWS, VoiceOver or Orca run
      exists. How any of this sounds is unknown.
- [ ] **Manual keyboard walkthrough — never done.** No local runtime on the
      development machine, so tab order, focus restoration after dialogs, and
      keyboard traps are unverified rather than verified-and-passing.
- [ ] Zoom and reflow at 200% and 400%, touch-target size, and focus appearance
      (WCAG 2.4.11) not assessed.
- [x] **Arabic and RTL across all 23 pages.** Markup, page scripts, `<title>`,
      meta descriptions and the 101 sentences the server sends when it refuses
      something. Evidence: `test/i18n-parity.test.js` (10 checks),
      `test/server-error-i18n.test.js` (5), and CI job `arabic-rtl` — 92
      page/language/viewport combinations in a real browser.
      **The Arabic itself is machine-drafted and has had no native review**, and
      the Arabic Terms and Privacy Policy are a draft of a draft. See
      `docs/ARABIC_RTL.md` §2 for what that does and does not establish.
- [x] Automated accessibility coverage (axe-core) across all pages — CI job
      `accessibility`, 46 page-viewport pairs.
- [x] End-to-end giveaway rehearsal — CI job `rehearsal`, 21/21 requirements,
      reporting separately what it walked and what existing suites prove.
- [x] **SEO prepared behind the deployment-state switch.** Canonical URLs and
      en/ar/x-default alternates on all 12 indexable pages, page-level `noindex`
      on the other 11, unique title and description on all 23, OG and Twitter
      metadata, and `robots.txt`/`sitemap.xml` generated from the deployment
      state instead of committed as files. The homepage `Organization` node is
      **removed** — it asserted a UAE business that does not exist. Evidence:
      `test/seo.test.js` (9 checks). `noindex, nofollow, noarchive` is unchanged
      and still tied to `isPublicLaunch()`. See `docs/SEO.md`.

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
- [ ] **Pin `sslmode=verify-full` in `DATABASE_URL`.** Today the deployed URL's
      `sslmode` — whatever it is — silently overrides the `ssl` option the code
      builds, and if it is `require`, `prefer` or `verify-ca` then certificate
      verification will switch itself off the first time `pg` reaches v9. No code
      change will accompany that. `verify-full` means the same thing before and
      after. Only the owner can edit this variable; the process warns at startup
      when the mode is one that will change meaning. See
      `test/database-tls-posture.test.js`.
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

All three are now resolved. Kept here with their reasoning, because the reasoning
is the part that will matter the next time one of them comes back.

| Warning | Disposition |
| --- | --- |
| `npm audit`: 1 moderate, `uuid` | **Resolved by removing the dependency.** The advisory affects v3/v5/v6 when `buf` is supplied; every one of the 79 call sites was a zero-argument `v4()`, so the vulnerable path was unreachable — a reason not to panic, not a reason to keep it. `npm audit fix --force` wanted `uuid@14`, a breaking major, to fix code we never call. Node 22 has `crypto.randomUUID()`, which 60 other call sites already used. `uuid` is out of `package.json` and the lockfile. `npm audit` reports 0. |
| `pg-connection-string` SSL-mode deprecation | **Resolved by making the posture legible and testable.** The warning reads as a complaint about weak SSL and is the opposite: today `sslmode=require` means `verify-full`, chain and hostname both checked. It warns about pg v9, where `require` will mean encrypt-and-verify-nothing. Following it up found something the warning does not say: an `sslmode` in the URL **replaces** the `ssl` option `server/db.js` builds, so `rejectUnauthorized: false` never applies in a deployment that pins one. The dangerous moment is therefore `npm update`, not a deployment. `server/db.js` now reports the mode at startup when it is one that will change meaning, and `test/database-tls-posture.test.js` pins both the precedence and the verification so the flip is a red build. **Owner action remains:** pin `sslmode=verify-full` in the deployed `DATABASE_URL` — see §2. |
| GitHub Actions forced onto Node 24 | **Resolved.** `actions/checkout`, `setup-node` and `upload-artifact` bumped v4 → v5, the first major that runs natively on Node 24, verified against each action's own `action.yml`. |

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

Automated Arabic checks do **not** prove the Arabic is good. `i18n1`–`i18n10`
prove the dictionaries agree, that no visible text escapes them, and that no page
uses a key it cannot reach. None of them can read Arabic. Register, idiom and
terminology are unverified, and the choice of مسابقة for "giveaway" is an open
question rather than a settled one — `docs/ARABIC_RTL.md` §2.

Automated SEO checks do **not** prove the site will rank, or even that it will be
indexed correctly. `seo1`–`seo9` prove the metadata is internally consistent and
asserts nothing unverified. Whether a crawler agrees is observable only after
`DEPLOYMENT_STATE` changes, in that deployment — `docs/SEO.md` §7.

The end-to-end rehearsal proves the mechanism, not the operation. It runs against
a CI database with fabricated accounts and a stubbed mail provider. No real email
was sent, no money moved, and no live fulfilment service was called.
