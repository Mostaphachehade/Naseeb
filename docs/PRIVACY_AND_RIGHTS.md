# Privacy rights, account correction and the request workflow

How a person reaches their own data on this platform, what they can change
themselves, what they have to ask for, and what nobody can do yet.

Companion documents: `docs/DATA_INVENTORY.md` (what is stored),
`docs/UAE_COUNSEL_REVIEW.md` (what is unresolved),
`docs/ENTRY_INTEGRITY.md` (the audit model this reuses).

**This document describes a mechanism, not a compliance position.** No claim of
UAE compliance is made anywhere in it. Both public policy documents are drafts,
neither is in force, and this phase deliberately did not change that.

---

## 1. What a person can do without asking

From `/account.html`, signed in:

| Action | Endpoint | Reauthentication |
| --- | --- | --- |
| See their account, attestation, pending change and request history | `GET /api/account/me` | Session |
| Correct their display name | `PATCH /api/account/me` | Session |
| Attest they are 18 or older | `POST /api/account/eligibility` | Session |
| Start an email change | `POST /api/account/email-change` | **Password** |
| Cancel a pending email change | `POST /api/account/email-change/cancel` | Session |
| Download their data | `POST /api/account/export` | **Password** |
| Raise an access, correction, deletion or objection request | `POST /api/account/privacy-requests` | Session |
| Read their own requests | `GET /api/account/privacy-requests[/:reference]` | Session |
| Sign out everywhere | `POST /api/account/sessions/revoke-all` | Session |

Every response on this router is `Cache-Control: no-store`. These carry an
address, a request history and sometimes a whole export; none of that belongs in
a shared cache, a proxy, or the back-forward cache of a borrowed laptop.

**Why two of them ask for the password again.** A live session proves that
somebody signed in once. It does not prove who is at the keyboard now. An
export is the most concentrated view of an account that exists, and an email
change moves the address that a password reset goes to — an attacker holding a
stolen session who can silently move it owns the account permanently. Both are
worth one extra prompt.

---

## 2. Display-name correction

Ownership is the session and only the session. There is no user id in the
request body that could name somebody else's account; one is ignored if sent,
and a test asserts that.

Each correction appends a row to `privacy_request_events` with
`to_status = 'name_corrected'` and `actor_role = 'user'`. The event deliberately
records **that** the holder corrected their name, not the old or new value: the
current value is on the account, and copying a former name into an append-only
table would create a record that can never be corrected again.

---

## 3. Age attestation

The wording, held in `server/lib/eligibility.js` so the recorded version and the
words somebody read cannot drift apart:

> I confirm that I am 18 years of age or older.

**What this is:** a versioned, timestamped record that a box was ticked.
Version `2026-08-eligibility-18`.

**What this is not:** age verification, identity verification, or any check at
all. Nobody's date of birth is collected. No document is collected. No
biometric is collected. If somebody unticks the truth, this system does not know
and cannot find out. That limitation is stated on the page the person sees, in
the export, and in `docs/DATA_INVENTORY.md`. It is **marked for counsel
review** — whether self-attestation is sufficient here is a legal question, not
a product one.

**Rules the code enforces:**

- The signup checkbox is unticked and `required`. Only `age_confirmed === true`
  counts; `'on'`, `1` and a missing field are all refusals.
- Existing accounts are `unknown`. Nothing backfills them — not signing in, not
  reading a page, not continued use.
- An `unknown` account is prompted before **entering a giveaway, creating one,
  or applying to host** (`GATED_ACTIONS`).
- An `unknown` account is **never** blocked from claiming a prize, moving a
  claim along, confirming delivery, raising a dispute, exporting its data, or
  making a privacy request (`NEVER_GATED_ACTIONS`). A winner mid-delivery must
  not be stranded by a question nobody ever asked them.
- Attestation is not public anywhere: no badge, no field, no list response.

---

## 4. Policy acceptance — built, deliberately inert

The machinery for recording that somebody accepted a policy exists and works.
It has never recorded anything, because nothing is acceptable.

Four separate facts are kept apart, because they answer four different
questions:

| Field | Question |
| --- | --- |
| `version` | Which text is this? |
| `draftRevisedAt` | When was this text last edited? |
| `status` | Has anybody with authority approved it? |
| `effectiveDate` | From when does it bind anybody? |

A policy may be accepted only when **all** of: `status === 'effective'`, an
explicit `effectiveDate` is set, and that date has arrived. Draft is refused
with `POLICY_IS_DRAFT`; approved-but-not-effective is refused with
`POLICY_NOT_YET_EFFECTIVE`.

**Activation is a reviewed edit to `server/lib/policies.js` and nothing else.**
No environment variable is read by that file — asserted by a test that greps its
source for `process.env`. No calendar date rolling over changes a status. No
deployment activates anything. The reason is simple: activation should be a
decision somebody made, that somebody else can see in a diff.

Terms are **agreed to**; a privacy notice is **acknowledged**. They stay
distinct rows with distinct `acceptance_kind` labels rather than being flattened
into "accepted".

`missingAcceptances()` names the exact versions somebody still owes rather than
returning a boolean. Reacceptance is required by default when a new version
becomes effective; a version can opt out with `requiresReacceptance: false`, and
that opt-out is a visible line in a diff rather than a silent default.

**Tests use a fabricated registry** (`FIXTURE_REGISTRY` in
`test/account-rights.test.js`) rather than mutating the real constants. A test
that edits `POLICIES` to prove acceptance works is one careless merge away from
shipping an effective policy nobody approved.

---

## 5. Data export

`POST /api/account/export`, after the password.

JSON only. No CSV is offered, deliberately: a CSV of user-controlled text is a
spreadsheet formula-injection problem, and the mitigation is one more thing to
get right for no benefit. The response is `no-store`,
`Content-Type: application/json`, `X-Content-Type-Options: nosniff`, and
`Content-Disposition: attachment` with a **fixed** filename — nothing
user-controlled reaches a header.

**Included:** account profile, the eligibility attestation, policy acceptances,
the person's own entries with the coarse integrity outcome and explanation code,
giveaways they host, host applications, claims where they are the winner or the
host, advertising bookings matching their address, privacy requests, and email
change history (the fact of each change, never a token).

**Excluded, and the file says so:** password hashes, session and CSRF values,
verification, reset and claim tokens, encryption keys, anybody else's data
(including entrants in a giveaway the requester hosts), internal administrator
notes, risk-signal hashes and detection detail, Stripe internals and webhook
payloads.

**Delivery addresses are excluded.** They are encrypted at rest with a versioned
key, they are erased on a schedule after delivery, and putting them into a
self-service download would undo both. The export says where they can be seen
instead: in the claim itself while it is open, or through an access request.

Every query in `dataExport.js` uses an explicit column list. `SELECT *` on a
table that later gains a token column is how a credential ends up in an export,
and the diff that does it looks like nothing.

---

## 6. Email change

The threat: an attacker holding a live session moves the address a password
reset goes to, and owns the account permanently. Every requirement below exists
because of that one scenario.

1. **Password required** to start it.
2. **Nothing changes.** A row is written to `email_change_requests` with status
   `pending`. `users.email` is untouched, and the old address still signs in.
3. **A 32-byte random token**, base64url, stored only as SHA-256. The plaintext
   exists in exactly one email and nowhere else.
4. **Two hours to use it**, enforced inside the same `UPDATE` that claims the
   row — not by a separate check that could be skipped.
5. **Single-use by construction.** `UPDATE … WHERE token_hash = $1 AND status =
   'pending' AND expires_at > $2 RETURNING *`. Two simultaneous submissions
   produce one change and one 400; the database decides, not the application.
6. **Two different messages to two different addresses.** The new address gets
   the only copy of the token. The old address gets a warning with a masked
   target, no token, and **no link that completes anything** — somebody who did
   not do this is told to change their password, not invited to click.
7. **Uniqueness re-checked inside the completion transaction.** The check at the
   start is hours old by then; somebody else may have signed up with the address
   in between. A contested address is refused with 409 and the account keeps the
   one it has.
8. **Every session ends on completion**, including the one that started it,
   with `revocation_reason = 'email_changed'`. Leaving that session alive would
   defeat the whole exercise. A new sign-in with the new address is required.
9. **One pending change at a time.** A second request supersedes the first, and
   the superseded row is `cancelled` with the reason recorded rather than
   vanishing.
10. **Cancellation and expiry are recorded**, not deleted.

**Delivery failure changes nothing.** The state change and the send are
decoupled — see §6a. A message that never arrives leaves the account exactly
where it was, holding its old address, with the intent to notify durably queued.

**The token never appears in a log.** The confirmation email is sent with
`sensitive: true`, so the development mail logger prints the subject and
suppresses the body. The recipient is masked there too (`a***@example.com`) — a
development log is terminal scrollback and CI output, and an address printed
there is an address disclosed. A test captures every `console` write across a
full change, including a forced provider failure, and asserts that neither
address, the token, a link, a body or the provider's own message appears.

**The token arrives in a URL fragment**, `#token=…`, and
`verify-email-change-1.js` captures it before anything else runs — the same rule
the claim page follows. A fragment is never sent to a server, so the token does
not reach an access log, a proxy, or a `Referer` header on the way in.

---

## 6a. The email-change outbox

Both messages are security-critical, in opposite directions. The verification is
the only way a change can complete. The warning to the old address is the only
signal an account holder gets that somebody moved the address their password
reset goes to — which is precisely the message an attacker wants to go missing.
Sending either as an unawaited promise made a mail outage completely silent.

So the **intent** is written in the same transaction as the thing that caused it,
and delivery is a separate retryable step against that record.

### Schema

`email_change_notifications`

| Column | Purpose |
| --- | --- |
| `change_id`, `user_id` | What this is about. **No foreign key** — a cascade from a deleted account must not silently remove the record that a security notice was owed. |
| `kind` | `verification` or `old_address_warning` |
| `status` | `pending` / `sent` / `failed` / `cancelled` |
| `attempts`, `next_attempt_at` | Capped exponential backoff, finite limit (6) |
| `lease_owner`, `lease_expires_at` | The processing lease |
| `last_error_category`, `last_attempt_at` | A category, never a provider message |
| `sent_at`, `failed_at`, `cancelled_reason` | Outcome |
| `idempotency_key` | `changeId:kind`, uniquely indexed |

`email_change_notification_events` — append-only (`BEFORE UPDATE OR DELETE`),
recording `enqueued`, `token_superseded`, `sent`, `attempt_failed`,
`failed_terminal`, `cancelled` and `manual_retry`.

**What neither table holds:** a plaintext token, a copy of the token hash, a
rendered link, an email body or subject, a recipient address, a session or CSRF
value, a password, a cookie, a provider secret, or anything the provider said.
The recipient is **derived** by joining the change record at send time —
duplicating an address here would put a second copy of personal data in a table
that exists to hold none. A test asserts no such column exists and sweeps every
text column in the schema for the plaintext token.

### Token lifecycle

A pending change is created with **no token**. `token_hash` is `NULL`, and
between that moment and the first send there is nothing anywhere that could be
turned into a working link. A change that is never delivered never has a token
at all.

A token exists only inside `attemptDelivery`, in worker memory, immediately
before the message goes out:

1. **Phase 1 (transaction).** Resolve the recipient from the change record.
   Refuse if the change is completed, cancelled, expired, superseded or gone —
   each cancels the notification with that reason rather than retrying forever.
   Mint 32 random bytes, write only the SHA-256 to `email_change_requests`, and
   commit.
2. **Phase 2 (no transaction open).** Send. The plaintext is a local variable
   and an argument to the template; it is never returned, stored, logged or put
   in a result.
3. **Phase 3 (transaction).** Record `sent`, or a category and a backed-off
   `next_attempt_at`, or terminal failure.

**Every retry mints a fresh token and overwrites the hash**, so there is exactly
one live token per pending change at any moment and it is the one in the most
recent message. Every previously generated link stops working.

**`expires_at` is never touched.** It is set once, at creation. A retry issues a
fresh token that dies at the *original* deadline, so the retry loop cannot
extend the life of a change by a millisecond. The mint itself is guarded:
`UPDATE … WHERE status = 'pending' AND expires_at > now`, so an expired,
cancelled or completed change produces no token at all.

### The safe failure direction, chosen deliberately

If the provider accepted a message but the response was lost, the outbox still
believes the send failed and will retry. **That retry invalidates the link in the
message that may have arrived** and sends a new one. A person can therefore
receive two emails and find the first link dead.

That is the direction we chose. The alternative — leaving the uncertain link live
so both work — means an unknown number of valid tokens for an operation that
moves an account's recovery address, with no way to count or revoke them. A
confusing email is a support question; a second live token is a security hole.

### Concurrency

Rows are claimed with `FOR UPDATE SKIP LOCKED` inside a short transaction that
also stamps a lease and increments `attempts`, then commits **before** the
network call. Two workers — two instances, or a scheduled tick overlapping a
manual drain — each take rows the other has not.

`SKIP LOCKED` protects only for the length of the claiming transaction, which is
why the lease exists: it protects the row for the rest of the attempt and
**expires on its own** after 120 seconds, so a worker that dies mid-send leaves a
row that becomes claimable again without anybody intervening. A test claims a row
as a "crashed" worker, proves nobody else can take it while the lease is live,
expires the lease, and proves the next worker recovers it.

**No database transaction is held open across the network call.** That is the
deliberate difference from the older claim-invitation outbox
(`server/lib/claimNotifications.js`), which does hold one — a divergence worth
knowing about rather than assuming both work the same way.

### Failure and retry

Capped exponential backoff (`min(2^attempts, 60)` minutes), a finite limit of 6
attempts, then `failed`. A terminal failure logs a **sanitised** alert — the
notification id, the kind, the attempt count and the error category, never an
address or the provider's text — and reports through
`errorReporting.reportError`, so the Sentry scrubber from `6212e49` is in the
path.

A failed notification is visible in the administrator queue, top of the list.
**Manual retry is deliberate and audited**: an administrator, re-read from the
database, and a mandatory reason recorded on the append-only trail. It requeues
rather than sending, so a retry that fails again is another attempt through the
same path rather than a second implementation. An already-delivered notification
returns 409 rather than being resent.

### The old-address warning

Enqueued inside the same transaction that moves the address and revokes every
session — either all three happen or none does. A warning that fails to send
therefore **cannot undo a change the person already verified**; it stays queued
and is retried, and the sessions stay revoked.

The message carries no verification token, no completing link, no link to the
completion page and nothing that signs anybody in — the person reading it may be
an account holder who has just been locked out, and handing them a live session
URL would be the opposite of help. The new address is **masked**
(`a***@example.com`). It points at the password-reset route, which exists, and
otherwise says to contact us through the site — **no support address, phone
number or hours are invented**, because none has been approved
(`docs/UAE_COUNSEL_REVIEW.md` A5/A6).

---

## 7. The privacy request workflow

### States

```
                       ┌──────────────┐
                       │  submitted   │  ← the person raises it
                       └──────┬───────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
 ┌─────────────┐   ┌──────────────────────┐   ┌───────────┐
 │  in_review  │──▶│ awaiting_information │   │ declined  │
 └──────┬──────┘   └──────────┬───────────┘   └───────────┘
        │                     │
        │   ┌─────────────────▼──────┐
        ├──▶│    awaiting_policy     │  open, not terminal —
        │   └─────────────────┬──────┘  the only honest resting
        │                     │          place for a deletion today
        ▼                     ▼
 ┌─────────────┐   ┌────────────────────┐
 │  completed  │   │ unable_to_complete │
 └─────────────┘   └────────────────────┘
   requires an
   execution row
```

`completed`, `declined` and `unable_to_complete` are terminal. A closed request
cannot be reopened by a later decision — the attempt returns 409
`REQUEST_CLOSED`. `awaiting_policy` is **not** terminal: the request stays open,
stays in the administrator queue, and still requires follow-up.

**A deletion request cannot reach `completed` at all.** See §7a.

### Rules

- **Ownership is the session.** Somebody else's reference returns **404**, not
  403: whether a given reference exists is not a question this endpoint answers
  for people who do not own it.
- **References are random**, `PR-XXXXXXXX` from 4 random bytes. A sequential id
  would tell anybody holding one how many requests exist and roughly when theirs
  was made.
- **Two audiences, two fields.** `outcome_code` is an allowlisted value that
  selects fixed wording the requester reads. `admin_notes` is free text that
  stays internal. The same split the entry-integrity phase established, for the
  same reason: working notes on a privacy request routinely mention another
  account, an open dispute or an unproven suspicion.
- **Every decision requires notes.** They are the record of why. A decision with
  fewer than three characters of notes is refused.
- **A closing status requires an outcome that happened.** `completed` cannot be
  reached with "we need more information" — the allowlist per status forbids it,
  and a database CHECK constraint (`privacy_requests_closure_explained`) is a
  second line rather than trusting the route alone.
- **Stale decisions return 409.** The detail view returns a `version`; a
  decision must send it back. A screen left open while somebody else decided is
  refused with `STALE_DECISION`, **writes no event, and changes no status**. A
  missing version is refused too — an omitted field is not permission.
- **Nothing is deletable — including the request itself.** A privacy request may
  change state; it cannot be erased. A `BEFORE DELETE` trigger on
  `privacy_requests` refuses a targeted delete, refuses an unqualified
  `DELETE FROM`, and refuses the cascade from a deleted account — so an account
  carrying a privacy request cannot be removed at all through application SQL.
  Controlled `UPDATE`s (status, outcome, notes, version) are untouched: the
  trigger is DELETE-only. `privacy_request_events` and
  `privacy_request_executions` reject UPDATE **and** DELETE on top of that, and
  no route at any privilege level deletes any of the three.

  The trigger is row-level rather than statement-level, which is a deliberate
  narrowing. A statement-level trigger fires on the internal `DELETE` PostgreSQL
  issues for an `ON DELETE CASCADE` even when it matches zero rows, which made
  *every* account undeletable, including accounts that had never made a request.
  Refusing to delete a request is the goal; refusing to delete every user is a
  bug that looks like security. The row-level trigger still fails an unqualified
  bulk delete, because it fires on the first row.

  The isolated test database is reset with `DROP SCHEMA … CASCADE`, which removes
  the table and its trigger together rather than deleting rows through it. No
  test deletes a request through the application.
- **Administrator authorization is re-read from Postgres on every request.**
  Removing the flag mid-session stops the next call; suspending the account
  stops it at authentication.

### 7a. A request is completed only when something was done

The first version of this workflow let an administrator mark a deletion request
`completed` once no blocker stood, and reported `records_deleted: false` in the
same response. Both statements were accurate on their own and the pair was a lie:
a person reading "completed" against their erasure request reasonably concludes
their data is gone, and reasonably stops asking. That is worse than a refusal.

**No deletion request can be completed.** `decideRequest` refuses it with 409
`DELETION_NOT_IMPLEMENTED` before any other check, the queue does not offer the
action, the detail screen says why, and the database refuses it independently
through the `privacy_requests_no_phantom_deletion` CHECK constraint. Three layers,
because the first two are each one edit away from not being there.

A deletion request may move only to:

| Status | Meaning |
| --- | --- |
| `in_review` | Somebody is looking at it. |
| `awaiting_information` | We need something from the requester. |
| `awaiting_policy` | **Open, not closed.** We cannot act because the retention and anonymisation rules do not exist. Stays in the queue; follow-up still required. |
| `unable_to_complete` | An open claim, payment or audit obligation stands in the way. |
| `declined` | We are not going to do it, and have said why. |

The single switch is `DELETION_EXECUTION_IMPLEMENTED = false` in
`server/lib/accountRights.js`. Turning it on is one reviewed edit, and it must not
be turned on until (1) the category rules in §8 are approved by the owner and by
qualified UAE counsel, (2) an engine exists that actually erases and anonymises
and writes down what it did, and (3) the CHECK constraint is dropped in a
deliberate migration.

**Access, correction and objection requests are held to the same standard.**
`completed` requires an `execution_evidence` payload, validated by
`assertExecutionEvidence` and written to `privacy_request_executions` inside the
same transaction as the decision. An access or correction completion needs a
summary of what was actually provided or changed; the request is refused with
`EXECUTION_SUMMARY_REQUIRED` without one.

### Execution evidence

`privacy_request_executions` is the record that a completion rests on. It is
append-only — `BEFORE UPDATE OR DELETE` rejects both — because evidence that can
be edited afterwards is not evidence.

| Column | What it records |
| --- | --- |
| `action_kind` | `erasure` / `anonymisation` / `access_response` / `correction` |
| `categories_erased` | Which data categories were actually erased |
| `categories_anonymised` | Which were anonymised |
| `categories_retained` | `[{ category, reason }]` — **every** retained category carries its own legal or operational reason |
| `summary` | What was provided, sent or changed |
| `executed_at` | When it ran |
| `executed_by` / `executed_by_job` | Exactly one: a person, or a named job. A CHECK constraint enforces the "exactly" |

Two refusals worth naming, because they are the ones that make this more than a
form: a retained category with no reason is rejected
(`RETENTION_REASON_REQUIRED`), and an erasure that erased and anonymised nothing
is rejected (`EXECUTION_EVIDENCE_EMPTY`). Attribution comes from the
authenticated session, never from the request body — a test asserts that a
client naming somebody else is ignored.

### Timing

No response deadline is published, and none is invented in any wording. What the
requester is told is:

> We have not published a response deadline. The applicable timescale under UAE
> law is pending confirmation by qualified counsel.

A test asserts that no outcome sentence contains a day or hour count.

### The administrator queue

`GET /api/admin/privacy-requests` returns the minimum needed to triage:
reference, type, status, age in days, an **eight-character account reference**,
blocking **categories**, and available actions. It carries no name, no address,
no message, no token, no delivery detail and no risk data — asserted by a test
that checks the exact key set.

Identity, the person's message and the internal notes require deliberately
opening one row, and that response is `no-store`.

---

## 8. Deletion and anonymisation — designed, not performed

**Nothing here is implemented, and that is the point.** A deletion request opens
a case for a human. It does not erase anything, the response says so in the
first sentence, and closing the request erases nothing either — the decision
response returns `records_deleted: false` explicitly.

The reason is not caution for its own sake. Actually deleting an account
requires answers this project does not have: what retention period applies to a
commercial record under UAE law, what a prize-fulfilment obligation requires,
whether an integrity decision that protected other entrants may be removed on
the request of the person it was about, and who the data controller is. Guessing
at any of those and then deleting would be irreversible.

### What blocks a deletion today

Computed live by `deletionBlockers()`, recomputed at decision time rather than
read from the copy stored when the request was made:

| Category | Why it blocks |
| --- | --- |
| `open_prize_claim` | Deleting the account would strand a prize in transit. |
| `active_giveaway_hosted` | Entrants have already entered a giveaway that is still open. |
| `open_dispute` | A person has to resolve it first. |
| `open_integrity_case` | A decision about entry integrity is still open. |
| `audit_records` | Always present. Some records cannot simply be removed. |

A `completed` outcome is **refused with 409** while any of the first four
stands. Completing a deletion that has not happened would be a completion in
name only.

### Category-by-category design

Written as a decision to be made, not a decision made.

| Category | Proposed handling | Why it is not settled |
| --- | --- | --- |
| `users.name` | **Erasable.** Replace with a neutral placeholder. | The name appears on a public winners page; whether a past winner's entry can be silently renamed touches the integrity of that page. |
| `users.email` | **Erasable**, once no claim is open. | It is the only route to reach the person about an obligation that outlives the account. |
| `password_hash`, tokens | **Erasable immediately.** No reason to keep a credential for a closed account. | Nothing blocks this; it simply is not implemented. |
| `sessions`, `session_families` | **Erasable.** Revoke and delete. | Nothing blocks this. |
| `entries` | **Anonymisable at best.** The row is part of a draw record: a giveaway with entries removed no longer proves how its winner was chosen. | Whether the entrant reference may be severed while the draw record stays intact. |
| `entry_integrity_events`, `entry_integrity_cases`, case events | **Retain.** Append-only by design, carries no name or address, and records decisions that protected other entrants. | Whether a pseudonymous entry reference is itself personal data that must go — see the pseudonymity note below. |
| `entry_risk_signals` | **Erasable**, and should already expire. | The expiry column exists; **nothing purges it on a schedule.** That is an implementation gap, not a legal one. |
| `prize_claims` delivery details | **Already erased** on a schedule after delivery, with the time recorded. | Nothing outstanding. |
| `prize_claims` metadata and events | **Temporary retention.** A delivered prize is a commercial record. | For how long. |
| `host_applications` | **Anonymisable** after a decision is final. Contains a trade licence number. | Whether a licence number carries its own retention obligation. |
| `ads`, `ad_inquiries`, Stripe identifiers | **Retain.** Commercial and payment records. | The statutory bookkeeping period, which nobody has established. |
| `policy_acceptances` | **Retain.** An acceptance record whose subject is deleted proves nothing. | Currently moot: the table is empty. |
| `privacy_requests` | **Retain**, possibly with the free-text message removed. | Whether the requester's own words need a shorter life than the decision. |
| `privacy_request_events` | **Retain.** Append-only, no foreign keys, survives the account by design. | Same pseudonymity question as integrity history. |
| `host_status_events` | **Retain.** | Same. |

### The pseudonymity question, stated plainly

Several rows above say "retain, it carries no name". That is a description, not
a legal conclusion. A row holding `user_id`, `entry_id` and a timestamp
identifies a person to anybody with the rest of the database. **"No name or
email" does not mean "not personal data."** Whether these tables may be retained
after an erasure request, and whether their identifiers must be severed or
tokenised, is a question for counsel — recorded in
`docs/UAE_COUNSEL_REVIEW.md`.

Nothing in this phase weakened the append-only integrity history to make a
future deletion easier. If that history has to change, it should change as a
deliberate decision with legal advice behind it, not as a side effect.

### There is no way to hard-delete an account

`DELETE /api/admin/users/:id` used to remove a user row whenever Postgres's
foreign keys allowed it — which is to say, on any account that had not yet done
anything. It is disabled: the route stays mounted and answers **405
`ACCOUNT_DELETION_DISABLED`**, so an old bookmark or a stale cached page gets an
explanation rather than looking like a routing bug. The button that called it is
gone from the admin page, not hidden.

It was removed because it was a second, unreviewed erasure path sitting beside
this workflow and answering to none of its rules: no recorded reason, no notes,
no append-only event, no blocker check, nothing said to the person, and no way to
establish afterwards that it happened or who did it. An erasure that leaves no
trace is exactly what the workflow next door exists to prevent.

What replaces it:

| Reason somebody reached for delete | What to use instead |
| --- | --- |
| Abuse or a security problem | Suspend the account — `POST /api/admin/users/:id/account-status`. Recorded, reversible, explained. |
| A compromised session | `POST /api/admin/users/:id/revoke-sessions` |
| "They asked to be deleted" | This workflow, which weighs open claims, payments and audit obligations first |
| A test or junk account | A database operation under a runbook — see below |

A test asserts that no file under `server/routes/` contains `DELETE FROM users`,
that no page script issues a `DELETE` against an account route, and that the
delete button's class no longer exists anywhere.

### Database-level operations are outside normal application behaviour

There is no supported in-app path that hard-deletes an account, and deliberately
no hidden one. If an account genuinely has to be removed at the database level —
a court order, a regulator's instruction, an incident — that is an **emergency
operation requiring a separately approved runbook**, not a feature.

That runbook does not exist yet. When it is written it has to cover, at minimum:

- who may authorise the operation, and who may execute it (not the same person);
- what is recorded before it runs, and where that record lives given that the
  account it describes is about to stop existing;
- how the append-only tables are reconciled. `entry_integrity_events`,
  `entry_integrity_case_events`, `privacy_request_events` and
  `privacy_request_executions` carry **no foreign keys**, so they survive a
  `DELETE FROM users` untouched. That is by design — an audit trail that
  evaporates when its subject is removed is not an audit trail — but it means a
  database-level deletion leaves pseudonymous rows behind, and somebody has to
  decide deliberately whether that is the intended outcome;
- what is verified afterwards, and by whom.

This document is not that runbook, and neither is the comment in
`server/routes/admin.js`.

---

## 9. What remains unresolved after this phase

1. **No policy is in force.** Both documents are drafts pending owner
   information and counsel review. Nothing on the site records agreement to
   either.
2. **No statutory timescale is known**, so none is stated.
3. **No data processing agreement exists** with Resend, Cloudinary, Sentry,
   Stripe or Render, because the contracting entity does not exist yet.
4. **Deletion and anonymisation are designed, not built.** §8 is a
   specification, and §7a is why no deletion request can be marked done.
5. **Retention periods are undecided** for almost every category in
   `docs/DATA_INVENTORY.md`.
6. **Two scheduled jobs are missing**: expired-session cleanup and expired
   risk-signal purge. Both have the code; neither has a scheduler.
7. **No emergency runbook exists** for a database-level account removal. The
   application path is closed; the operational path is undefined.
8. **Age is self-declared.** There is no verification, and adding one is a much
   larger decision with its own legal weight.

Resolved by the Phase 2.3B safety fix, and no longer open: a deletion request
could be marked completed while nothing was deleted (§7a); an administrator
could hard-delete an account outside this workflow (§8); and Sentry's console
integration could carry arbitrary logged text off-platform — that integration is
removed, `sendDefaultPii` is off, and a `beforeSend` scrubber redacts
recursively. See `server/lib/errorReporting.js`.
