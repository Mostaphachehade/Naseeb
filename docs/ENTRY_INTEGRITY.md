# Entry integrity

What this platform guarantees about fairness, what it cannot guarantee, and what
happens when somebody thinks an entry is not honest.

The short version: **one entry per verified account per giveaway**. That is a
`UNIQUE` index and it is genuinely enforced. It is **not** one entry per person,
and nothing in this document changes that — it makes the gap reviewable by a
human instead of pretending it does not exist.

---

## 1. What the system guaranteed before this phase

An audit of the entry path as it stood:

| | Before |
|---|---|
| Entry uniqueness | `UNIQUE(giveaway_id, user_id)` on `entries`, plus a `SELECT … FOR UPDATE` on the giveaway and an explicit existence check inside the entry transaction |
| Account verification | `email_verified` is required to enter; unverified accounts get a 403 |
| Entry rate limiting | `enterLimiter`: 30 requests / 15 minutes, per `req.ip` |
| Proxy handling | `app.set('trust proxy', 1)`, hard-coded |
| Winner selection | `SELECT * FROM entries WHERE giveaway_id = $1`, then `crypto.randomInt` over **every** row |
| Draw locking | Giveaway row locked `FOR UPDATE` for the whole transaction; claim and notification created in the same transaction |
| Entry mutation | No route could modify or delete an entry — there was no status, and no administrator control over the pool at all |
| Public wording | "One entry per person" on the homepage, about page, giveaway page and partners page. The terms page was already accurate; the marketing pages were not |

Two real gaps, and they are the two this phase closes:

- **There was no way to act on a suspected abuse case at all.** Not a bad
  mechanism — no mechanism. The only tool available was deleting rows by hand in
  the database, which destroys the evidence for the decision along with the
  entry.
- **`trust proxy` was a constant.** Correct on Render, wrong anywhere without a
  proxy in front, where a client could write its own `X-Forwarded-For` and mint a
  fresh rate-limit identity per request.

---

## 2. Statuses and transitions

`entries.integrity_status` is one of three values, closed by a CHECK constraint:

| Status | Meaning | In the draw pool |
|---|---|---|
| `eligible` | Ordinary. The default for every entry ever made. | yes |
| `under_review` | An administrator is looking at it. **Not** an outcome. | no — and the draw refuses to run |
| `disqualified` | An administrator decided it does not stand. | no |

Permitted moves:

```
eligible      → under_review, disqualified
under_review  → eligible, disqualified
disqualified  → eligible
```

There is no separate `reinstated` status. A reinstated entry is an ordinary
eligible one — inventing a fourth value would mean the draw query had to know
about two kinds of eligible, which is exactly the sort of thing that becomes a
bug. The **outcome** is recorded instead: the history row carries the reason code
`reinstated_after_review`, so "was this entry ever disqualified?" is a question
the record answers.

Every move is refused unless all of these hold:

- the actor is an administrator, re-read from `users.is_admin` **inside the
  transaction** — never a role, actor id or status from the request body;
- administrator notes of at least 3 characters are supplied (enforced by the
  route *and* by a CHECK constraint on the history table, so neither is the only
  thing standing between here and an unexplained disqualification);
- the entrant-facing reason code is on the allowlist **for that destination** —
  a `disqualified_terms` code on a review would produce a sentence that does not
  match what happened;
- the caller's version matches the row's (see below);
- the move is legal from the entry's current status, read after the row is
  locked.

Asking for the status an entry is already in is a no-op that reports
`changed: false` — a double-clicked button does not produce two history rows
saying the same thing.

### Stale decisions

Row locking makes two requests serial. It does not make the second one informed:
two administrators looking at the same screen, one reinstating while the other
disqualifies, both got their way in turn and the last one won silently.

`entries.integrity_version` and `entry_integrity_cases.version` fix that. The
detail endpoint returns the version; the mutation requires it back. A mismatch is
`409 STALE_DECISION`, which changes no status, writes no event, and returns the
current coarse state and version so the screen can refresh and decide again.

The version is **not** authorization. Administrator status is checked first, from
the database, inside the transaction — a correct version in a non-administrator's
hands still gets `403`, and a stale-version refusal is never what tells an
unauthorised caller they guessed a real id.

---

## 3. Two audiences, two fields

The first version of this phase had one free-text column doing two jobs: the
administrator wrote why, and the entrant read it. That is how a network
heuristic, somebody else's email address, or an allegation that has not been
established ends up on a stranger's screen. The correction splits them.

| | `integrity_admin_notes` | `integrity_reason_code` |
|---|---|---|
| Written by | the administrator, free text | chosen from a fixed allowlist |
| Contains | evidence, accounts compared, what a signal showed | nothing — it is an identifier |
| Read by | an administrator who deliberately opened one entry | the entrant, indirectly |
| Appears in | `GET /api/admin/integrity/entries/:id` only, `no-store` | derived into a fixed sentence |
| Mandatory | **yes**, for every decision | yes |

The entrant never receives the notes, or any part of them. They receive a
sentence looked up **in application constants** from the code — the wording is
not stored per row, so it cannot be edited into an accusation, cannot carry an
address, and cannot describe how anything was noticed:

| Code | What the entrant reads |
|---|---|
| `review_routine_check` | "Your entry is being checked before the draw. This is a routine check, nothing has been decided, and your entry has not been removed." |
| `review_signal_follow_up` | "Your entry is being checked before the draw. Nothing has been decided, and your entry has not been removed." |
| `disqualified_entry_rule` | "This entry is not included in the draw, because it does not meet the rule of one entry per verified account for this giveaway." |
| `disqualified_terms` | "This entry is not included in the draw, because it does not meet the entry terms for this giveaway." |
| `reinstated_after_review` | "This entry was reviewed and is included in the draw as normal." |
| `legacy_unspecified` | "This entry was reviewed by an administrator. If you would like to know more, please get in touch." |

The tone is deliberate: a review is described as a check, and a disqualification
names the rule that was not met rather than what anybody is suspected of doing.

**Migration.** Decisions made under the single-column version had their free text
moved into `integrity_admin_notes` and their entrant-facing code set to
`legacy_unspecified`. Nothing that was written as an internal note was promoted
into something an entrant reads, and no specific public reason was invented for
an old record. The old column was then dropped, because a column still named
`integrity_status_reason` is one careless `SELECT` away from being entrant-facing
again.

## 3a. The record, and why it cannot be erased

`entry_integrity_events` and `entry_integrity_case_events` are append-only, and
that is enforced at the database: a `BEFORE UPDATE OR DELETE` trigger raises on
both. UPDATE alone was not enough — a history that can be deleted is not a
history, and the first version of this phase only blocked rewriting.

Neither table has **any foreign key**. That is the other half of it: a foreign
key is a way for the audit trail to be destroyed by something that is not about
the audit trail. `ON DELETE CASCADE` erases the history the moment an entry is
removed; a plain reference makes the history the reason an account deletion
fails. The columns hold opaque UUIDs, which is exactly what a record of a past
decision needs — a reference to something that used to exist — and they carry no
name, address or contact detail of their own, so preserving the audit does not
mean retaining personal data to do it. A test deletes the entry, the giveaway and
the account, and asserts the decision is still there.

Each event row holds the entry, the giveaway, the previous and new status, the
allowlisted code, the administrator notes, the actor, their role, a timestamp,
and a `metadata` JSON column for non-sensitive supporting facts. **Never** an IP
address, never a session identifier, never anything from a delivery address.

**An entry is never deleted to disqualify it.** The row, its submission time, its
account and its giveaway all survive every outcome. Deleting one would destroy
the evidence a disputed decision turns on, and it is the entrant's evidence at
least as much as ours.

---

## 4. The draw

Inside the existing draw transaction, after the giveaway row is locked
`FOR UPDATE`:

1. **`assertDrawable`** — if any entry on this giveaway is `under_review`, or any
   integrity case is open, the draw stops with `409 ENTRY_REVIEW_PENDING` or
   `409 INTEGRITY_CASE_OPEN`. It fails closed on an open question: a winner drawn
   from a pool somebody is currently arguing about is a winner nobody can defend,
   and a draw that happens an hour later is a far smaller problem.
2. **`lockEligibleEntries`** — `WHERE integrity_status = 'eligible' … FOR UPDATE`.
   The pool is locked for the rest of the transaction, so a disqualification
   committing between the read and the winner write cannot leave the two
   disagreeing about who was in it.
3. Random selection with `crypto.randomInt`, the winner write, the claim and the
   notification — all unchanged, all still in the same transaction.

Lock ordering is **giveaway first, then entries**, in the draw and in every
integrity decision, so the two can race without deadlocking.

---

## 5. Post-draw cases

Once a winner exists, an allegation does not remove them.

- The winner and their claim are preserved. Nothing is redrawn, nothing is
  cancelled.
- Disqualifying the winning entry directly is refused outright with
  `409 WINNER_DISQUALIFICATION_BLOCKED`.
- Opening a case (`POST /api/admin/integrity/cases`) is the available action. It
  is idempotent — a partial unique index means a second open returns the existing
  case rather than a duplicate queue item.
- While a case is open, **protected fulfilment transitions are paused** with
  `409 INTEGRITY_REVIEW_OPEN`. That covers the host's own steps and the
  administrator rescue path, because an administrator shipping for an absent host
  is still shipping a prize that is under review.
- **Raising a dispute stays available.** Pausing the process must not also mute
  the person waiting on it.
### What each resolution means

| Resolution | Case status after | Fulfilment | In the queue |
|---|---|---|---|
| `reinstated` | `resolved` | resumes, on the **existing** claim; no second claim is created | no |
| `no_action` | `resolved` | resumes | no |
| `upheld` | **`upheld_blocked`** | **stays blocked** | **yes** |

`upheld` does not close anything. The first version of this phase treated it as
a resolution, which closed the case and released the pause — so confirming a
concern about a winner was the act that let the prize ship to them. An upheld
case now enters a durable blocked state:

- it keeps blocking every protected fulfilment transition, host and rescue alike;
- it stays in the administrator queue, flagged as blocked;
- it does not delete or replace the winner;
- it does not cancel the claim;
- it does not redraw or choose another entrant;
- it cannot be closed from the administrator screen — trying returns
  `409 CASE_BLOCKED_PENDING_DECISION`.

A database constraint pairs the two so they cannot drift: a case is
`upheld_blocked` if and only if its resolution is `upheld`.

The pause predicate is `hasBlockingCase`, which asks whether the case is **open
OR upheld-and-blocked** — the substantive state, not `status = 'open'`.

**Cancelling, replacing a winner or redrawing is not implemented, and was not
invented here.** Only a later, separately authorised policy — after owner and
counsel approval — decides what happens to an upheld case. Until then it waits,
visibly, with the prize where it is.

The public API exposes only a coarse claim status, and an entrant whose giveaway
has a blocking case is told: *"This giveaway is under review. The outcome is
pending — nothing about the result has been decided."* No allegation, no case
state, no internal vocabulary.

---

## 6. Counting

Public counts exclude `disqualified` entries and include `under_review` ones. One
shared SQL fragment (`integrity.COUNTED_SQL`) is used by the giveaway detail
page, the browse list, the winners list, the host dashboard and the homepage
totals, so a fourth variant cannot quietly disagree.

An entry under review is still an entry because a question is not an outcome.
That would normally let the public count and the draw pool disagree — except the
draw refuses to run while any review is open, so at the moment a winner is
picked, the count and the pool are necessarily the same set.

**Ticket numbers** count every entry ever made, including disqualified ones. They
are receipts, not a tally: two people must never both be told they hold ticket
#4.

---

## 7. Proxy trust and rate limiting

With `N` trusted hops, Express reads the `(N+1)`-th address from the right of
`[socket, …X-Forwarded-For]`. A client can prepend anything it likes; it cannot
control the entry the last trusted proxy appends. So the guarantee is exactly:
**the rightmost N entries are ours, and only those are read.**

`TRUSTED_PROXY_HOPS` configures it, validated at startup:

| Environment | Value | Why |
|---|---|---|
| Local development | `0` (default) | Nothing is in front, so nothing in the header may be believed |
| Test suite | `1`, set by `testEnv.js` | The suite *is* the proxy: it writes the last hop itself |
| Render | `1` | Render terminates TLS and appends the real client address |

`true` and `'*'` are unreachable through this variable, deliberately — they are
the settings that make forwarding headers freely spoofable. A non-numeric,
negative or absurd value throws at startup rather than starting with a limiter
that cannot do its job. Getting it too low is the safe direction to be wrong in:
one shared bucket is a usability problem, while too high is no limit at all.

No existing rate limit was loosened in this phase.

---

## 8. Risk signals

Indicators for a human. **Nothing here changes a status, blocks a request or
bans an account.** Two signals exist:

| Signal | Fires when | Severity |
|---|---|---|
| `shared_network_new_accounts` | ≥3 accounts created in the last 48 hours have entered from the same coarse network prefix in the same retention window | `review` |
| `rapid_entry_velocity` | ≥5 entries from one prefix within 10 minutes | `review` |

Both thresholds are deliberately loose. A signal that fires on two housemates is
a signal that trains administrators to ignore it.

### What is stored, and what is not

The raw IP address is **never stored**. It is normalised to a coarse prefix (an
IPv4 `/24`, an IPv6 `/48`), then HMAC'd with a dedicated secret **and the current
retention window id**:

```
network_hmac = HMAC-SHA256(INTEGRITY_SIGNAL_SECRET, "entry-network:<window>:<prefix>")
```

- Not reversible to an address.
- Rows only match within the same window, so linkage does not survive the
  retention period even if a row does.
- Rotating the secret breaks linkage immediately and everywhere.
- Loopback and unspecified addresses normalise to `null` and are not recorded.

`INTEGRITY_SIGNAL_RETENTION_DAYS` (default 30, clamped to 1–90) sets both the
window length and `expires_at`. `POST /api/admin/integrity/signals/purge` deletes
expired rows and is idempotent — running it twice removes nothing the second
time.

`INTEGRITY_SIGNAL_SECRET` is validated at startup with the same rules as
`SESSION_SECRET`: production refuses to boot on a missing, short, placeholder,
low-entropy or borrowed value, and only the variable name appears in the message.
Outside production the key is a per-process random value, so nothing links across
runs and no default can ship by accident.

### Not built, and not to be added here

No browser or device fingerprinting. No identity documents, facial recognition or
biometrics. No third-party people-search, data-broker or reputation service. No
cross-site tracking. No permanent or hidden identifier of any kind.

---

## 9. What each audience sees

**The administrator queue** (`GET /api/admin/integrity/queue`) carries the
giveaway, a ticket number, an 8-character account *reference*, the account's age
in days, the current status, signal *categories*, and whether a case is open. No
name, no email address, no network hash, no session or CSRF material, no delivery
detail.

**One entry, opened deliberately** (`GET /api/admin/integrity/entries/:id`) adds
the account behind it, the full signal list with its detail objects, and the
decision history. `Cache-Control: no-store`. The network hash is not in this
response either — it is a join key, and a join key handed to a browser is a
correlation tool nobody asked for.

**The entrant** sees a coarse status for their own entry, on the giveaway page
and their dashboard: `entered`, `under_review`, or `disqualified`, plus the fixed
sentence for the decision's reason code, plus `resolution_pending` when the
giveaway has a blocking case. There is no free-text field in that payload at all
— not the administrator's notes, not a signal, not another account, not how
anything was noticed. A decision nobody explains is a decision nobody can
contest; an explanation that quotes an internal investigation is a different
harm, and the allowlist is what keeps both from happening.

**A host** may flag an entry on their own giveaway
(`POST /api/giveaways/:id/entries/:entryId/flag`), which opens an administrator
case and nothing else. Hosts have a direct interest in who wins their own
giveaway, which is exactly why they cannot act on it: the endpoint does not
change a status, does not remove anybody from the pool, and tells the host
nothing about the entrant they did not already know.

---

## 10. Still open

- **No scheduler runs the signal purge.** `expires_at` is set on every row and
  the endpoint is idempotent, but nothing calls it on a timer yet. Until an
  operations phase adds one, retention is a manual action — the same gap
  `docs/SESSIONS.md` §9b records for expired sessions.
- **Signals are computed at entry time only.** An account created after a
  giveaway closes cannot be correlated retrospectively, because the window that
  would link them has turned over. That is the intended trade.
- **A determined multi-accountant with several networks and patient timing
  produces no signal at all.** This phase does not claim to detect that. It
  claims to make a human's decision about it recorded, reversible and explainable.
- **Replacing or redrawing a winner is not implemented**, deliberately, and needs
  owner and legal sign-off before it is.
