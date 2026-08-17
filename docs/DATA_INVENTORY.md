# Data inventory

What this platform stores, why, who can reach it, how long it is kept, and what
is still undecided.

This is a factual inventory of the code in this repository. It is **not** a
compliance assessment and it is **not** a privacy notice. Nothing here has been
reviewed by qualified UAE counsel, and several rows below say "undecided"
because the honest answer is that nobody has decided yet.

Two conventions run through the whole document.

**Pseudonymous is not anonymous.** A UUID, an eight-character account
reference, a ticket number and a keyed network HMAC are all treated here as
personal data. Each of them can be linked back to an identifiable account by
somebody holding the rest of the database or the HMAC key. Removing a name and
an email address from a row does not make that row anonymous; it makes it a row
about a person whose name you have stopped writing down.

**Sensitivity is stated, not implied.** Every category below is labelled
*public*, *confidential*, *sensitive* or *pseudonymous*, meaning:

| Label | Meaning |
| --- | --- |
| Public | Deliberately visible to anyone, including people with no account. |
| Confidential | Visible to the person it is about, and to administrators. |
| Sensitive | Would cause direct harm if disclosed: credentials, delivery addresses, internal allegations. |
| Pseudonymous | Carries no name or address, but identifies a person when joined to another table. |

Retention is split into two columns on purpose. **Implemented** is what the
code does today, provable from the source. **Awaiting decision** is what has no
answer yet and is listed in `docs/UAE_COUNSEL_REVIEW.md`.

---

## 1. Accounts and authentication

**Table:** `users`

| | |
| --- | --- |
| Fields | `id`, `name`, `email`, `password_hash`, `is_admin`, `is_verified_business`, `email_verified`, `verification_token`, `verification_token_expires`, `reset_token`, `reset_token_expires`, `created_at`, `host_status`, `host_status_changed_at`, `host_status_reason`, `host_status_changed_by`, `account_status`, `account_status_changed_at`, `account_status_reason`, `account_status_changed_by`, `age_attestation_status`, `age_attestation_version`, `age_attested_at` |
| Purpose | Identify the account, authenticate it, contact it, and record decisions made about it. |
| Access | The account holder (own row, via `/api/account/me`); administrators; the database. `name` alone is public where the account has won or hosts a giveaway. |
| Classification | `name` **public** in a winner or host context. `email`, `host_status_reason`, `account_status_reason` **confidential**. `password_hash`, `verification_token`, `reset_token` **sensitive** — they are credentials. |
| Retention implemented | For the life of the account. Verification and reset tokens have expiry columns and are refused after expiry, but expired values are **not** cleared from the row. |
| Awaiting decision | Whether an inactive account is ever closed; how long a closed account's row is kept; whether expired token columns should be nulled on use. |
| Correction / deletion | `name` is self-service (`PATCH /api/account/me`). `email` changes through the verified flow in §6. `password_hash` changes through password reset. Nothing else is user-editable. Full deletion is blocked — see `docs/PRIVACY_AND_RIGHTS.md` §8. |
| External recipient | The email address is sent to Resend when a message is delivered. Nothing else leaves. |

**Age attestation.** `age_attestation_status` is `unknown` or `confirmed` and
nothing else. It records that somebody ticked a box reading *"I confirm that I
am 18 years of age or older."* It is **not** age verification. No date of
birth, identity document, biometric or third-party age estimate is collected
anywhere in this system, and `test/account-rights.test.js` test 10 asserts that
no such column exists in the schema.

---

## 2. Sessions and CSRF

**Tables:** `sessions`, `session_families`

| | |
| --- | --- |
| Fields | `sessions`: `id`, `user_id`, `token_hash`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`, `revocation_reason`, `replaced_by_session_id`, `rotated_from_session_id`, `rotation_grace_until`, `family_id`. `session_families`: `id`, `user_id`, `created_at`, `absolute_expires_at`, `revoked_at`, `revocation_reason`. |
| Purpose | Keep somebody signed in, rotate the credential, and end every sign-in at once when something goes wrong. |
| Access | Nobody reads these through an API. The session cookie is `HttpOnly`; the account holder can end all of them from the account centre. |
| Classification | **Sensitive** — `token_hash` is the hash of a live credential. Otherwise **pseudonymous**. |
| Retention implemented | Rows persist past expiry. `deleteExpiredSessions()` exists and removes families older than 30 days past absolute expiry — **but nothing calls it on a schedule.** See `docs/SESSIONS.md`. |
| Awaiting decision | Who runs the cleanup, and how often. This is an operational gap, not a legal one. |
| Correction / deletion | Not correctable — a session is an event, not a fact about a person. Revocable at any time by the holder. |
| External recipient | None. |
| Notable omission | **No IP address and no user-agent string is stored on a session**, deliberately. |

CSRF tokens are HMACs computed per request from the session secret. They are
**never stored**.

---

## 3. Email verification and password reset

**Fields:** `users.verification_token`, `users.verification_token_expires`,
`users.reset_token`, `users.reset_token_expires`

| | |
| --- | --- |
| Purpose | Prove control of an address; allow a password to be reset. |
| Access | The token is emailed to the address it concerns. Nothing reads it back out over an API. |
| Classification | **Sensitive** — a live single-use credential. |
| Retention implemented | Expiry is enforced on use. The column is not cleared afterwards. |
| Awaiting decision | Whether to null these on use rather than leaving a spent value in the row. |
| External recipient | Resend (the address and the link). |

---

## 4. Email change requests

**Table:** `email_change_requests` (new in this phase)

| | |
| --- | --- |
| Fields | `email_change_requests`: `id`, `user_id`, `token_hash`, `new_email`, `previous_email`, `status`, `created_at`, `expires_at`, `completed_at`, `cancelled_at`, `cancelled_reason`. `email_change_notifications` (the outbox): `id`, `change_id`, `user_id`, `kind`, `status`, `attempts`, `next_attempt_at`, `lease_owner`, `lease_expires_at`, `last_error_category`, `last_attempt_at`, `sent_at`, `failed_at`, `cancelled_reason`, `idempotency_key`. `email_change_notification_events`: append-only delivery history. |
| Purpose | Move an account's address safely: the change is pending until the *new* address proves it received a token. |
| Access | The account holder sees the pending target address and its expiry — never the token. Administrators do not have a route to this table. |
| Classification | `token_hash` **sensitive**; `new_email` / `previous_email` **confidential**. |
| Retention implemented | Rows are kept after completion, cancellation and expiry — the history of address changes is deliberately preserved. `token_hash` is NULL until a delivery worker mints a token immediately before sending it, and every retry overwrites it, so at most one link is live at a time and an undelivered change never has a token at all. The outbox and its events hold no address, token, link or body; the recipient is derived from the change record at send time. See `docs/PRIVACY_AND_RIGHTS.md` §6a. |
| Awaiting decision | How long a completed change record is kept. It contains a former address, which is personal data about the same person. |
| Correction / deletion | Not correctable. A pending change is cancellable by the holder, with a recorded reason. |
| External recipient | Resend — two separate messages, one to each address. The **old** address receives a warning with no completing link. |

---

## 5. Giveaways and entries

**Tables:** `giveaways`, `entries`

| | |
| --- | --- |
| Fields | `giveaways`: `id`, `host_id`, `title`, `description`, `prize_description`, `estimated_value_aed`, `image_url`, `funded_by`, `entry_deadline`, `max_entries_per_person`, `status`, `winner_entry_id`, `created_at`, `prize_delivered`, `prize_delivered_at`. `entries`: `id`, `giveaway_id`, `user_id`, `ticket_number`, `created_at`, `integrity_status`, `integrity_status_changed_at`, `integrity_status_changed_by`, `integrity_reason_code`, `integrity_admin_notes`, `integrity_version`. |
| Purpose | Run the giveaway and draw a winner from eligible entries. |
| Access | Giveaway rows are **public**. An entry is visible to the entrant and to administrators; a host sees entry counts, not an entrant list. |
| Classification | Giveaway content **public**. `entries.user_id` **confidential**. `integrity_admin_notes` **sensitive** — free text that may name another account or describe an allegation, and which is never sent to the entrant. |
| Retention implemented | Indefinite. An entry is **never deleted to disqualify it** — the status changes and an event is appended. |
| Awaiting decision | Whether entries are ever purged after a giveaway closes, and how that interacts with the draw audit trail. |
| Correction / deletion | An entrant cannot edit or withdraw an entry. Deleting one would break the draw record. |
| External recipient | `image_url` points at Cloudinary; the image itself is stored there. |

---

## 6. Entry integrity: events, cases and risk signals

**Tables:** `entry_integrity_events`, `entry_integrity_cases`,
`entry_integrity_case_events`, `entry_risk_signals`

| | |
| --- | --- |
| Fields | Events: `id`, `entry_id`, `giveaway_id`, `from_status`, `to_status`, `reason_code`, `reason`, `admin_notes`, `actor_user_id`, `actor_role`, `metadata`, `created_at`. Cases: `id`, `giveaway_id`, `entry_id`, `status`, `post_draw`, `opened_reason`, `opened_by`, `opened_at`, `resolution`, `resolution_reason`, `resolved_by`, `resolved_at`, `version`. Case events mirror the same shape. Risk signals: `id`, `entry_id`, `giveaway_id`, `signal_code`, `severity`, `network_hmac`, `window_id`, `detail`, `created_at`, `expires_at`. |
| Purpose | Make every integrity decision attributable and reviewable, and surface possible abuse for a human to look at. |
| Access | Administrators only. The entrant sees a coarse status and a fixed sentence chosen by `reason_code` — never `admin_notes`, never a signal. |
| Classification | `admin_notes`, `opened_reason`, `resolution_reason` **sensitive**. `network_hmac` **pseudonymous** — see below. Everything else **confidential**. |
| Retention implemented | Events and case events are **append-only**: `BEFORE UPDATE OR DELETE` triggers reject both, and the tables carry **no foreign keys**, so deleting an account or a giveaway cannot cascade the history away. `entry_risk_signals` carries `expires_at`. |
| Awaiting decision | **Nothing purges expired risk signals on a schedule.** The column exists and the retention window is used in the HMAC key, but no job runs. Also undecided: how long integrity history is kept once every related giveaway is long closed. |
| Correction / deletion | Neither. That is the point of an audit trail. |
| External recipient | None. |

**`network_hmac` is pseudonymous, not anonymous.** No raw IP address is stored
anywhere in these tables. What is stored is an HMAC of a *coarsened* prefix
(IPv4 /24, IPv6 /48) keyed with a server secret plus a retention-window
identifier. That is a deliberate minimisation and it is genuinely better than
storing an address — but anybody holding the key can test a candidate prefix
against a stored value, so it remains data about a person's network. It is
listed as personal data throughout this document and is excluded from data
exports.

---

## 7. Host applications and host status

**Tables:** `host_applications`, `host_status_events`

| | |
| --- | --- |
| Fields | Applications: `id`, `user_id`, `applicant_type`, `full_name`, `business_name`, `trade_license`, `contact_email`, `contact_phone`, `plan`, `message`, `contacted`, `created_at`, `status`, `decided_at`, `decided_by`, `decision_reason`. Status events: `id`, `user_id`, `from_status`, `to_status`, `reason`, `source`, `changed_by`, `application_id`, `created_at`. |
| Purpose | Decide whether an account may host, and record who decided what and why. |
| Access | The applicant sees their own application; administrators see all. |
| Classification | `trade_license`, `contact_phone`, `contact_email`, `full_name` **confidential**. `decision_reason` **sensitive**. `business_name` becomes **public** once the account hosts. |
| Retention implemented | Indefinite. The application list carries the minimum; detail requires opening a row. |
| Awaiting decision | How long a rejected or withdrawn application is kept, and whether a trade licence number needs a shorter life than the rest. |
| Correction / deletion | Not self-service. A correction goes through a privacy request. |
| External recipient | Resend, for the decision notification. |

---

## 8. Prize claims and delivery details

**Tables:** `prize_claims`, `prize_claim_events`, `claim_notifications`,
`claim_rescue_queue`

| | |
| --- | --- |
| Fields | `prize_claims`: `id`, `giveaway_id`, `winner_user_id`, `entry_id`, `status`, `token_hash`, `token_expires_at`, `token_used_at`, `token_issued_at`, `consent_version`, `consented_at`, `delivery_ciphertext`, `delivery_iv`, `delivery_tag`, `delivery_key_version`, `delivery_erased_at`, and the timestamp columns for each transition. Events, notifications and the rescue queue carry ids, statuses, reasons and timing. |
| Purpose | Get a prize to the person who won it, and prove what happened at each step. |
| Access | The winner and the host see what each needs. Administrators can open a rescue case. |
| Classification | `delivery_ciphertext` **sensitive** — a physical address. `token_hash` **sensitive**. Everything else **confidential**. |
| Retention implemented | Delivery details are encrypted at rest (AES-GCM, versioned key) and erased on a schedule after delivery — `delivery_erased_at` records when. Claim history is retained. |
| Awaiting decision | How long a delivered claim's *metadata* is kept once the address is erased. |
| Correction / deletion | The winner supplies delivery details once, with recorded consent. They are not editable afterwards; a mistake is handled through the claim workflow. |
| External recipient | Resend, for claim invitations and status messages. Delivery details reach the **host** through the claim workflow — that is the purpose of collecting them, and consent is recorded with a version. **Delivery details are excluded from the self-service export**, which says so explicitly. |

---

## 9. Notification outboxes

**Table:** `claim_notifications`

| | |
| --- | --- |
| Fields | `id`, `claim_id`, `kind`, `status`, `attempts`, `next_attempt_at`, `last_error_category`, `last_attempt_at`, `delivered_at`, `created_at`, `updated_at` |
| Purpose | Retry a message that failed to send, without re-sending one that succeeded. |
| Access | Administrators, indirectly. |
| Classification | **Pseudonymous** — it holds no address and no message body, only a claim reference and a delivery outcome. `last_error_category` is a category, never the provider's raw response. |
| Retention implemented | Indefinite. |
| Awaiting decision | Whether delivered rows are pruned. |
| External recipient | None directly; it records the outcome of a Resend call. |

---

## 10. Advertising

**Tables:** `ad_inquiries`, `ads`, `stripe_events`

| | |
| --- | --- |
| Fields | `ad_inquiries`: `id`, `business_name`, `contact_email`, `contact_phone`, `message`, `contacted`, `created_at`. `ads`: identity, creative, schedule and payment columns including `stripe_session_id`, `stripe_payment_intent`, `payment_status`, `amount_fils`, `slot_status`. `stripe_events`: `id`, `type`, `processed_at`. |
| Purpose | Sell and schedule a banner slot; make webhook processing idempotent. |
| Access | Administrators. The creative and target URL become **public** while the ad runs. |
| Classification | `contact_email`, `contact_phone`, `message` **confidential**. Stripe identifiers **pseudonymous** — they resolve to a payer inside Stripe. Creative and `target_url` **public**. |
| Retention implemented | Indefinite. `stripe_events` stores only an event id, a type and a timestamp — **no webhook payload is stored**. |
| Awaiting decision | Commercial-record retention. This is the row most likely to be governed by a statutory bookkeeping period, and nobody has established what that period is. |
| Correction / deletion | Not self-service. |
| External recipient | **Stripe** (payment). `ADS_CHECKOUT_ENABLED` is `false`, so no live checkout runs today. |

---

## 11. Policy acceptances and privacy requests

**Tables:** `policy_acceptances`, `privacy_requests`, `privacy_request_events`

| | |
| --- | --- |
| Fields | Acceptances: `id`, `user_id`, `policy_id`, `policy_version`, `policy_effective_date`, `acceptance_kind`, `source`, `accepted_at`. Requests: `id`, `reference`, `user_id`, `request_type`, `status`, `user_message`, `outcome_code`, `admin_notes`, `blockers`, `version`, `created_at`, `updated_at`, `closed_at`, `closed_by`. Request events: `id`, `request_id`, `user_id`, `from_status`, `to_status`, `outcome_code`, `admin_notes`, `actor_user_id`, `actor_role`, `created_at`. Executions: `id`, `request_id`, `user_id`, `action_kind`, `categories_erased`, `categories_anonymised`, `categories_retained`, `summary`, `executed_at`, `executed_by`, `executed_by_job`. |
| Purpose | Record what somebody agreed to and when; run access, correction, deletion and objection requests with an auditable history. |
| Access | The requester sees their own requests, their own message, and a fixed outcome sentence. Administrators see the account and the internal notes, and only after deliberately opening a row. |
| Classification | `admin_notes` **sensitive**. `user_message` **confidential**. Acceptances **confidential**. |
| Retention implemented | `privacy_request_events` and `privacy_request_executions` are both **append-only** (`BEFORE UPDATE OR DELETE` triggers) and carry no foreign keys, so they survive the deletion of the account they describe. `policy_acceptances` is **empty**, because no policy is in force. `privacy_request_executions` is **empty**, because nothing has been erased or anonymised. |
| Awaiting decision | How long a closed request is kept, and whether the requester's own free text should have a shorter life than the decision record. |
| Correction / deletion | Neither, by design. No route deletes a request at any privilege level. |
| External recipient | None. |

`policy_acceptances` being empty is not an oversight. Both documents are
`draft`, both have `effectiveDate: null`, and the acceptance path refuses
anything that is not genuinely effective. An empty table is the truthful answer
to "who has agreed to the Terms".

---

## 12. Administrative and owner actions

**Table:** `site_settings`, plus the `actor_user_id` / `changed_by` /
`decided_by` / `closed_by` columns throughout.

| | |
| --- | --- |
| Purpose | Owner-editable values that would otherwise need a deploy, and attribution for every decision. |
| Access | Administrators. |
| Classification | **Confidential**; the attribution columns are **pseudonymous** references to an administrator's account. |
| Retention implemented | Indefinite. Attribution is embedded in append-only history and cannot be removed. |
| Awaiting decision | Whether an administrator's own identity in a years-old decision record needs a retention limit of its own. |

---

## 13. External processors

Nothing on this list has a data processing agreement in place, because the
legal entity that would sign one has not been established. That is recorded in
`docs/UAE_COUNSEL_REVIEW.md`.

| Processor | What reaches it | Configured by | Status today |
| --- | --- | --- | --- |
| **Resend** | Recipient address, subject and message body, including single-use links. | `RESEND_API_KEY` | Active when configured. Without a key, messages are logged instead — and bodies containing a live link are **suppressed** even then. |
| **Cloudinary** | Uploaded giveaway and advertising images. Served from `res.cloudinary.com`; uploads go to `api.cloudinary.com`. | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET` | Active. Images are host-supplied creative, not personal data by design — but an uploader can put anything in an image. |
| **Stripe** | Payment session, amount, and the payer's own details entered on Stripe's page. Only an event id and type are stored back. | `STRIPE_SECRET_KEY` etc. | **Disabled.** `ADS_CHECKOUT_ENABLED=false`. |
| **Sentry** | Deliberately captured exceptions only, after recursive redaction. No console output, no breadcrumbs, no request body, no headers, no cookies, no query string, no user object. | `SENTRY_DSN` | Active when configured. **See below.** |
| **Google Analytics** | Page views on public pages, via `googletagmanager.com`. | `GA_MEASUREMENT_ID` | Active when configured. **Not loaded** on `/claim.html`, `/admin.html`, `/owner.html`, `/account.html` or `/verify-email-change.html`. |
| **Render** | Hosting: process, logs, and the environment. | Deployment | Active. |
| **Postgres host** | The whole database. | `DATABASE_URL` | Active. |

**Sentry, and why it no longer depends on anybody's discipline.** This used to
be `captureConsoleIntegration({ levels: ['error'] })` — every `console.error` in
the codebase became a Sentry event. It was convenient, and it made the privacy of
an off-platform transmission rest on nobody ever interpolating an address, a
delivery note or a token into a log line. One ordinary-looking `console.error`
that interpolated a user's email address would have sent it off-platform, and
nothing in the diff would have looked wrong.

That integration is gone. What is in its place, in `server/lib/errorReporting.js`:

- **No console capture and no breadcrumbs.** `beforeBreadcrumb` returns `null`
  unconditionally — a breadcrumb is a log line by another name.
- **`sendDefaultPii: false`**, set explicitly rather than inherited, because the
  default has moved between SDK majors.
- **A `beforeSend` scrubber** that walks the whole event and redacts by key
  (anything matching password, token, csrf, cookie, session, authorization,
  cipher/iv/key, stripe, resend, dsn, email, phone, address, delivery, contact,
  trade licence, admin notes, user message, IP, forwarded-for, user-agent,
  network/signal hash) and then by value over every surviving string (email
  addresses, phone numbers, IPv4 and IPv6, URLs with a query string or fragment,
  `token=`-style pairs, `sk_`/`pk_`/`whsec_`/`re_` keys, Postgres connection
  strings, and any opaque 32+ character run).
- **Whole sections removed rather than scrubbed**: `request.cookies`,
  `request.headers`, `request.data`, `request.env`, `request.query_string` and
  the `user` object. The request URL keeps its path — which is what makes an
  error locatable — and loses everything after `?` or `#`.
- **Fails closed.** A scrubber that throws drops the event; a cycle or an
  over-deep structure is redacted rather than followed; a value type it does not
  understand is replaced rather than forwarded.

Capture is now deliberate: `errorReporting.reportError(err, context)`, with the
context scrubbed on the same terms, plus Express's own error handler for what
slips past a route's `try`/`catch`. `test/account-rights.test.js` sf3 and sf3b
pin all of it.

---

## 14. What is deliberately not collected

Listed because absence is a design decision that should be as visible as the
data that is present:

- No date of birth, identity document, national ID, passport number, selfie or
  biometric — anywhere. Age is a self-declared checkbox.
- No raw IP address in any integrity or session table.
- No user-agent string on a session.
- No browser fingerprint, canvas hash, device identifier or hidden permanent
  identifier.
- No third-party people-search, identity-resolution or cross-site tracking.
- No entrant list exposed to a host.
- No Stripe webhook payload — only the event id and type.
- No advertising or analytics on any page that shows an address, a request
  history, an export or a token.
- No console output, breadcrumbs, request bodies, headers, cookies, query
  strings or user objects in an error report.
- No application route that hard-deletes an account.

---

## 15. Where each rule is enforced

| Rule | Enforced by | Proved by |
| --- | --- | --- |
| A privacy request can change state but never be erased | `privacy_requests_no_delete` BEFORE DELETE trigger | `test/account-rights.test.js` sf5 |
| An email-change notification survives a provider outage | `email_change_notifications` outbox, lease + backoff | `test/account-rights.test.js` ob1, ob7 |
| Only the newest verification link works | fresh token per attempt, hash overwritten | `test/account-rights.test.js` ob3 |
| A retry cannot extend a change's expiry | `expires_at` never written after creation | `test/account-rights.test.js` ob4 |
| No address, token, link or body reaches a log | `sensitive` sends, masked dev recipient, category-only errors | `test/account-rights.test.js` ob15 |
| A deletion request cannot be marked completed | `DELETION_EXECUTION_IMPLEMENTED`, the route check, and the `privacy_requests_no_phantom_deletion` CHECK | `test/account-rights.test.js` sf1 |
| A completion names what was actually done | `assertExecutionEvidence` + `privacy_request_executions` | `test/account-rights.test.js` sf1d |
| No route hard-deletes an account | The disabled route; no `DELETE FROM users` anywhere under `server/routes/` | `test/account-rights.test.js` sf2 |
| Error reports carry no personal data | `beforeSend` / `beforeBreadcrumb` in `errorReporting.js` | `test/account-rights.test.js` sf3, sf3b |
| Integrity history cannot be edited or deleted | `BEFORE UPDATE OR DELETE` triggers; no foreign keys | `test/entry-integrity.test.js` |
| Privacy-request history cannot be edited or deleted | `privacy_request_events_immutable` trigger | `test/account-rights.test.js` 26 |
| Internal notes never reach the person | `reason_code` / `outcome_code` allowlists in code | `test/account-rights.test.js` 21, 24 |
| No policy can be accepted | `policies.assertAcceptable` | `test/account-rights.test.js` 1, 2 |
| An export carries no credential or third-party data | Explicit column lists in `dataExport.js` | `test/account-rights.test.js` 20, 21 |
| An email token never appears in a log, a response or plaintext | `sensitive: true`, SHA-256 storage | `test/account-rights.test.js` 15 |
| No age or identity column exists | — | `test/account-rights.test.js` 10 |
