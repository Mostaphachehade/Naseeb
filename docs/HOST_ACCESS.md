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
| `DELETE /api/admin/host-applications/:id` | **Only** an undecided application, to clear spam. A decided one returns 409. |

Deleting an undecided application returns the account to `not_requested` and
records that too.

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

## 8. Known consequence: suspending a host with an open claim

A suspended host loses the host role on their claims, which means they can no
longer see the winner's delivery details or move the claim toward delivery. That
is the requested behaviour and it is tested — but it has a cost worth stating
plainly.

The claim state machine only lets an administrator **cancel** a claim that is in
`claimed`, `preparing_delivery` or `shipped_or_arranged`. To resolve one to
`delivered` an administrator first needs it in `disputed`, and only the winner or
the host can raise a dispute. So the recovery path for a winner whose host was
suspended mid-delivery is: **the winner disputes, an administrator resolves.**

`POST /api/admin/hosts/:userId/status` returns `open_claims_affected` and the
admin UI shows it, so nobody suspends a host without being told what they have
just taken on. Making an administrator able to pull a stalled claim into review
directly would remove the dependency on the winner acting first; that is a change
to the claim state machine and is **not** in this phase.

---

## 9. Still open

- Nothing here has been reviewed by qualified UAE counsel. See
  `docs/UAE_COUNSEL_REVIEW.md`; §D still lists *"a decision recorded on whether
  host paid plans are offered at all"*, which this phase answers as "no paid tier
  exists today" without deciding the future.
- No notification is sent to an applicant when a decision is made. They see it on
  the dashboard and the apply page. Wiring it into the existing claim outbox is
  later work.
- There is no self-service way for a host to withdraw an application; an
  administrator deletes it.
- Admin promotion remains a direct database action (unchanged, see README).
