# Host access — who may publish a giveaway, and how that is decided

Hosting on Naseeb is a **closed beta**. An account may publish a giveaway only
if an administrator has approved it. This document is the whole model: the
statuses, where they are enforced, what the migration did, and what is still
unresolved.

---

## 1. What it replaced

`POST /api/giveaways` checked one thing:

```js
const verifiedRes = await pool.query('SELECT email_verified, is_admin FROM users WHERE id = $1', [req.userId]);
if (!verifiedRes.rows[0] || !verifiedRes.rows[0].email_verified) {
  return res.status(403).json({ error: 'Please verify your email before hosting a giveaway.' });
}
```

Any address that could receive one email could publish unlimited prize draws to
the public. `is_admin` was read and then never used. `POST /:id/draw` checked
ownership but never whether the owner still had access. `GET /mine/hosted`
checked only that somebody was signed in. `POST /api/host-applications` accepted
anonymous submissions, gated nothing, and told applicants we would "set up
billing for your plan" for plans that did not exist.

---

## 2. The five statuses

`users.host_status`, constrained in the database to exactly these values:

| Status | Meaning | May host? |
|---|---|---|
| `not_requested` | Never asked. The default for every new account. | No |
| `pending` | Applied; waiting for an administrator. | No |
| `approved` | An administrator granted access. | **Yes** |
| `rejected` | An administrator refused it. May apply again. | No |
| `suspended` | Had access and lost it. Applying again does not lift it. | No |

Four accompanying columns: `host_status_changed_at`, `host_status_reason`,
`host_status_changed_by`, plus the append-only `host_status_events` table
(`from_status`, `to_status`, `reason`, `source`, `changed_by`, `application_id`,
`created_at`). `source` is `admin_decision`, `application`, or `migration` — it
distinguishes a grant a human is answerable for from one a migration inferred.

**The status is never in the JWT.** Tokens live for 30 days; a status baked into
one would keep asserting "approved" for a month after a suspension. It is read
from the database on every request that needs it, which is why suspension takes
effect on the very next request with no new sign-in.

---

## 3. One gate

`server/lib/hostAccess.js`:

- `resolveHostAccess(client, userId)` — the whole answer as data.
- `requireHostAccess` — the Express middleware every host-only route mounts.
- `canHost(client, userId)` — the same answer as a boolean, for code already
  inside a transaction.
- `setHostStatus(client, {...})` — the **only** way `users.host_status` moves.
  Locks the account row, writes the event, and returns `null` for a no-op change
  so a double-clicked button does not record a change that did not happen.

Routes behind it:

| Route | Gate |
|---|---|
| `POST /api/giveaways` | `requireAuth` → `requireHostAccess` |
| `POST /api/giveaways/:id/draw` | `requireAuth` → `requireHostAccess` → ownership |
| `POST /api/giveaways/:id/confirm-delivery` | `requireAuth` → `requireHostAccess` → ownership |
| `GET /api/giveaways/mine/hosted` | `requireAuth` → `requireHostAccess` |
| `GET /api/claims/giveaway/:id` | `requireAuth` → `claims.resolveRole` (calls `canHost`) |
| `POST /api/claims/:id/transition` | `requireAuth` → `claims.resolveRole` (calls `canHost`) |

There is no giveaway edit or update route in this codebase. When one is added it
mounts `requireHostAccess` like the rest.

**Approval is not ownership.** Being an approved host lets you operate *your*
giveaways. Every per-route ownership check is unchanged and still runs — an
approved host drawing somebody else's giveaway gets the same 403 it always did.

**Administrators are exempt**, deliberately, on `users.is_admin` read fresh from
the database. The site owner must not be able to lock themselves out of their own
platform, including by fat-fingering their own `host_status`. Both cases are
tested.

### Denial codes

| Code | HTTP | When |
|---|---|---|
| `HOST_APPROVAL_REQUIRED` | 403 | `not_requested` |
| `HOST_APPROVAL_PENDING` | 403 | `pending` |
| `HOST_APPROVAL_REJECTED` | 403 | `rejected` |
| `HOST_ACCESS_SUSPENDED` | 403 | `suspended` |
| `EMAIL_VERIFICATION_REQUIRED` | 403 | email not verified (still required, now alongside approval rather than instead of it) |
| `HOST_ACCESS_UNAVAILABLE` | 503 | the status could not be read — **fails closed** |

An unrecognised status also fails closed: if a future migration invents a sixth
value, the answer is no access, not access by accident.

---

## 4. Applying

`POST /api/host-applications` requires a signed-in, email-verified account.

- **Charges nothing.** There is no payment code in the route, no plan to select,
  and no paid hosting tier to be charged for. A test strips the comments from the
  file and fails if the word `stripe`, `checkout`, `charge` or `payment_intent`
  appears in the code, and a second test wraps `fetch` and asserts no outbound
  request reaches a Stripe host.
- **Grants nothing.** It moves the account to `pending`. Only an administrator's
  decision moves it to `approved`.
- **Promises no deadline.** We do not have a review SLA, so no page states one.
- **Cannot be duplicated.** The account row is locked for the transaction, and a
  partial unique index (`uniq_host_application_open` on `user_id WHERE status =
  'pending'`) is the second line of defence. Five simultaneous submissions
  produce one application, one status event, and four `409
  APPLICATION_ALREADY_PENDING`.
- **Uses the account's email**, not one typed into the form.

`GET /api/host-applications/me` returns the account's own position. The UI reads
it to decide which of the five states to render; it never enforces anything.

---

## 5. Administrator review

| Route | What it does |
|---|---|
| `GET /api/admin/host-applications` | The queue. Carries **no** email, phone, trade licence or message. |
| `GET /api/admin/host-applications/:id` | One application in full, fetched when an administrator opens it. |
| `POST /api/admin/host-applications/:id/decision` | `{decision, reason}`. Reason required. Records decider and timestamp. |
| `POST /api/admin/hosts/:userId/status` | Suspend, reinstate, or grant without an application. Reason required. |
| `GET /api/admin/hosts/:userId/status-events` | The history behind an account's current access. |
| `POST /api/admin/host-applications/:id/close` | Closes an undecided application as `withdrawn`. Reason required. **Nothing is deleted** — see §10. |
| `GET /api/claims/admin/rescue-queue` | Unfinished claims whose host is suspended — see §8. |
| `POST /api/claims/:id/rescue/transition` | One host-side step, on behalf of a suspended host. Reason required. |
| `POST /api/claims/:id/rescue/delivery-details` | Opens one winner's details, deliberately and audited. Reason required. |

There is **no delete route on host applications.** Closing one returns the
account to `not_requested` and records that too.

---

## 6. The migration

Runs inside `init()`. Narrow and non-destructive on purpose.

**Granted:** accounts that had already published at least one giveaway. That is
the only unambiguous fact in the old data — those listings are live and people
have entered them, so revoking access over a migration would strand entrants.
Each grant writes a `host_status_events` row with `source = 'migration'` and
`changed_by = NULL`, because no human decided it.

**Deliberately not granted:** accounts that only submitted the old paid-plan
enquiry form. That form said we would set up billing, could be submitted signed
in or not, and was never reviewed. It is not an application to this beta and must
not be recorded as one. Those accounts stay `not_requested` and their enquiries
show in the admin queue labelled *legacy enquiry*.

**Never overwritten:** any account whose `host_status_changed_at` is already set.
This is the same trap the ad-slot backfill fell into in Phase 1.3 — re-deriving
state on every boot silently reverses a deliberate admin decision on the next
deploy. Tested: a suspended legacy host with giveaways stays suspended across two
`init()` runs, and a second run writes no duplicate event.

---

## 7. Hosting prices

`hosting_plan_standard_price_aed` and `hosting_plan_partner_price_aed` are gone
from `/api/config`, from the settings validators and from the owner panel. They
priced three plans — a free pilot, AED 250 for three listings, AED 900/month for
unlimited hosting with featured placement and a verified badge — none of which
had a checkout, a listing limit, a placement mechanism or any entitlement behind
it. Any rows still in `site_settings` are left alone rather than deleted: they
record what was once advertised. **No replacement price has been invented.**

`/api/config` now reports `hosting_is_paid: false` and `hosting_access_model:
'private_beta_application'`.

---

## 8. Suspending a host does not strand a winner

A suspended host loses the host role on their claims immediately — they cannot
see the winner's delivery details and cannot move the claim along. That is
correct, and it leaves an obvious hole: a winner who has already handed over
their address is waiting on somebody who can no longer act.

An earlier version of this document called the recovery path *"the winner raises
a dispute and an administrator resolves it"*. That was not a recovery path. It
asked the winner to notice a silence, work out that the platform had done
something internally, and then use the complaints mechanism to repair it. The
person with the least information and the least responsibility was carrying the
work.

### The rescue queue

`claim_rescue_queue`, populated **inside the suspension transaction** by
`setHostStatus`. There is no window in which a host has been suspended but their
winners are not yet anybody's job, and no way to suspend a host while forgetting
to. Every unfinished claim of theirs lands there, including the ones where
nothing is waiting on a host right now, so an administrator sees the whole
picture.

Idempotency is in the database: a partial unique index
(`uniq_claim_rescue_open` on `claim_id WHERE status = 'open'`) and an
`ON CONFLICT … DO NOTHING` insert. Suspending twice, two administrators clicking
at once, or a winner's redemption racing a suspension all collapse onto one row.
A test inserts a duplicate directly and asserts the database refuses it, so the
guarantee does not rest on application code.

Rows close automatically when the host is reinstated (`setHostStatus` →
`approved`) or when the claim reaches `delivered` or `cancelled` (inside
`claims.transition`, so it holds for every path that can finish a claim).

`ensureRescueForClaim` covers the two ways a claim can become active *after* a
suspension: a winner opening a link that was already in flight, and an
administrator backfilling a claim for a suspended host's old giveaway.

### Exact rescue permissions

A new role, `admin_rescue`, distinct from `admin`. An administrator resolving a
dispute exercises their own authority; a rescuer does the one job the absent
host would have done. It gets the host's three forward moves and nothing else:

| From | To | Rescuer? |
|---|---|---|
| `claimed` | `preparing_delivery` | **yes** |
| `preparing_delivery` | `shipped_or_arranged` | **yes** |
| `shipped_or_arranged` | `delivered_pending_confirmation` | **yes** |
| `awaiting_claim` | `claimed` | **no** — only the winner, with a token and consent |
| `delivered_pending_confirmation` | `delivered` | **no** — only the winner |
| anything | `disputed` / `cancelled` / `expired` | **no** — not a rescue action |

Winner confirmation remains the only route to `delivered` outside a dispute, and
`giveaways.prize_delivered` still moves only when the winner says so. A test
walks the whole transition table and fails if a future edit ever hands
`admin_rescue` a path to `delivered` or `claimed`.

### Authority is re-derived, never inherited from the queue

`assertRescueAllowed` reads three facts from the database on **every** request:

1. the caller is an administrator (`users.is_admin`);
2. the claim's host is `suspended` **right now** — a reinstated host does their
   own work, and an administrator does not get to take over from a host who is
   perfectly able to act (409 `HOST_NOT_SUSPENDED`);
3. the claim is in a rescue-eligible state **right now** (409
   `NOT_RESCUE_ELIGIBLE`).

A queue row is work to do, not a permission. A test leaves a stale open row
behind after reinstating the host by hand and confirms it grants nothing.

Every rescue action requires a reason (400 `REASON_REQUIRED`) and writes to
`prize_claim_events` with the previous state, the new state, the administrator's
id, `actor_role = 'admin_rescue'`, the reason and a timestamp.

### Delivery details

| | |
|---|---|
| Route | `POST /api/claims/:id/rescue/delivery-details` |
| Never in | `GET /api/claims/admin/rescue-queue`, or any other list |
| Requires | administrator, host suspended, claim eligible, **and a reason** |
| Requires | the winner's recorded consent (`consented_at`, `consent_version`) |
| Refuses | erased details, permanently (409 `DELIVERY_ERASED`) |
| Refuses | details that were never supplied (409 `DELIVERY_UNAVAILABLE`) |
| Audited | a `prize_claim_events` row per opening, `from_status == to_status` — looking is not moving |
| Header | `Cache-Control: no-store` |

The queue reports only a boolean `delivery_available`, so an administrator who
never needs an address never sees one. A test captures every console write and
outgoing email across a full rescue and asserts no address, phone, block, city
or note appears in any of them, nor in the queue, the public giveaway endpoint
or the ordinary admin review queue — only in the one deliberate fetch.

### What this still does not do

A rescuer cannot cancel a claim (that is `admin`, from any active state) and
cannot pull a stalled claim into `disputed`. Neither is a rescue action: the
first is a decision to end the thing, the second is a complaints route. If a
suspended host's winner needs a claim closed rather than fulfilled, an
administrator cancels it through the ordinary admin path.

## 9. Still open

- Nothing here has been reviewed by qualified UAE counsel. See
  `docs/UAE_COUNSEL_REVIEW.md`; §D still lists *"a decision recorded on whether
  host paid plans are offered at all"*, which this phase answers as "no paid tier
  exists today" without deciding the future.
- No notification is sent to an applicant when a decision is made. They see it on
  the dashboard and the apply page. Wiring it into the existing claim outbox is
  later work.
- There is no self-service way for an applicant to withdraw their own
  application; an administrator closes it. Closing is not deleting — see §10.
- The rescue queue is not notified anywhere. An administrator has to open the
  admin page to see it; there is no email or alert when a claim lands in it.
- Admin promotion remains a direct database action (unchanged, see README).

---

## 10. Host applications are never deleted

There was a `DELETE /api/admin/host-applications/:id` route, restricted to
undecided applications and meant for clearing spam. It has been removed. "It was
only spam" is a judgement made at the moment of deleting, by the person deleting,
and it becomes unreviewable the instant the evidence for it is gone.

`POST /api/admin/host-applications/:id/close` replaces it. It sets the status to
`withdrawn` and requires a reason. Preserved unchanged: the original row, its
`created_at`, the account it belongs to, what the applicant wrote, and every
`host_status_events` row. Added: `decided_at`, `decided_by`, `decision_reason`.

An application that already carries an outcome — `approved` or `rejected` —
cannot be closed over (409 `ALREADY_DECIDED`). A later application is a **new
row**, never an edit of the earlier one, so a refusal followed by a fresh
application reads as two events rather than one rewritten answer.

Concurrency: the decision and close routes both take `SELECT … FOR UPDATE` on the
application row. Three simultaneous attempts (approve, reject, close) produce one
200 and two 409s, one outcome on the row, one matching `users.host_status`, and
exactly one `host_status_events` transition out of `pending`.

A test asserts the DELETE route returns 404 and greps the comment-stripped source
of `server/routes/admin.js` for `router.delete('/host-applications` and
`DELETE FROM host_applications`, so neither can reappear quietly.
