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
decoupled: starting a change writes a pending row, and the send is a
fire-and-forget call with a `.catch`. A message that never arrives leaves the
account exactly where it was, holding its old address.

**The token never appears in a log.** The confirmation email is sent with
`sensitive: true`, so the development mail logger prints the subject and
suppresses the body — the same treatment a claim invitation gets. A test
captures every `console` write during the flow and asserts no completing link
appears in any of them.

**The token arrives in a URL fragment**, `#token=…`, and
`verify-email-change-1.js` captures it before anything else runs — the same rule
the claim page follows. A fragment is never sent to a server, so the token does
not reach an access log, a proxy, or a `Referer` header on the way in.

---

## 7. The privacy request workflow

### States

```
                    ┌──────────────┐
                    │  submitted   │  ← the person raises it
                    └──────┬───────┘
                           │
          ┌────────────────┼──────────────────┐
          ▼                ▼                  ▼
   ┌─────────────┐  ┌──────────────────┐  ┌───────────┐
   │  in_review  │─▶│awaiting_          │  │ declined  │
   └──────┬──────┘  │information       │  └───────────┘
          │         └────────┬─────────┘
          │                  │
          ▼                  ▼
   ┌─────────────┐   ┌────────────────────┐
   │  completed  │   │ unable_to_complete │
   └─────────────┘   └────────────────────┘
```

`completed`, `declined` and `unable_to_complete` are terminal. A closed request
cannot be reopened by a later decision — the attempt returns 409
`REQUEST_CLOSED`.

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
- **Nothing is deletable.** `privacy_request_events` rejects UPDATE and DELETE
  at the database, and no route at any privilege level deletes a request.
- **Administrator authorization is re-read from Postgres on every request.**
  Removing the flag mid-session stops the next call; suspending the account
  stops it at authentication.

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

### The one pre-existing route that removes an account

`DELETE /api/admin/users/:id` predates this phase. It removes a user row and is
refused by Postgres foreign keys the moment the account has a giveaway, an entry
or an application — so in practice it works only on an account that has done
nothing. It is **not reachable from the privacy-request workflow**, and a test
asserts both that the decision handler contains no delete and that this route
refuses an account with activity. It is listed here rather than pretended away.

---

## 9. What remains unresolved after this phase

1. **No policy is in force.** Both documents are drafts pending owner
   information and counsel review. Nothing on the site records agreement to
   either.
2. **No statutory timescale is known**, so none is stated.
3. **No data processing agreement exists** with Resend, Cloudinary, Sentry,
   Stripe or Render, because the contracting entity does not exist yet.
4. **Deletion and anonymisation are designed, not built.** §8 is a
   specification.
5. **Retention periods are undecided** for almost every category in
   `docs/DATA_INVENTORY.md`.
6. **Two scheduled jobs are missing**: expired-session cleanup and expired
   risk-signal purge. Both have the code; neither has a scheduler.
7. **Sentry's console integration** can carry any text passed to
   `console.error` off-platform. No scrubbing hook is installed.
8. **Age is self-declared.** There is no verification, and adding one is a much
   larger decision with its own legal weight.
