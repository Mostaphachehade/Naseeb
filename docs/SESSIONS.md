# Sessions and CSRF

Browser authentication on Naseeb is an opaque session token in an `HttpOnly`
cookie, with only its SHA-256 hash in Postgres. This document is the whole
model: what it replaced, how it behaves, and what is still open.

> This phase is **not** XSS hardening. There is still no Content-Security-Policy
> and every page still uses inline scripts. Moving the session out of
> JavaScript's reach limits what an injected script can steal; it does not stop
> one running. CSP is separate work, reviewed separately.

---

## 1. What it replaced

| | Before | Now |
|---|---|---|
| Credential | JWT, self-asserting | 256-bit random opaque token |
| Stored in browser | `localStorage`, JS-readable | `HttpOnly` cookie, unreadable by JS |
| Sent as | `Authorization: Bearer` header built by hand | cookie, attached by the browser |
| Stored on server | nothing | SHA-256 hash, one row per session |
| Lifetime | 30 days | 12 hours (configurable 1–168) |
| Revocable | **no** | yes, immediately |
| Sign out | delete the browser's copy; token stayed valid | server-side revocation |
| Password reset | existing sessions kept working | every session revoked |
| CSRF exposure | none (header auth) | mitigated by token + Origin + SameSite |

Three separate problems, all fixed by the same change. Any script on any page
could read the token — one XSS anywhere handed an attacker a month of somebody's
account. Nothing could revoke it. And the server held no record that a session
existed, so it could not have revoked one if it wanted to.

### The authentication surface, before

Every place that minted a JWT: `issueToken()` in `server/routes/auth.js`, called
from `POST /signup` and `POST /login`. Every place that verified one:
`requireAuth`, `optionalAuth`, `requireAdmin` in `server/middleware/auth.js`.
Every place the browser touched it: `getToken`/`setSession`/`clearSession` in
`public/js/app.js`, plus reads in `login.html`, `signup.html`, `verify.html`,
`dashboard.html`, `create.html`, `admin.html`, `owner.html`, `host-apply.html`
and `giveaway.html`. One place built the header: `api()` in `app.js`. No
WebSockets and no background requests existed.

---

## 2. The token

- 32 bytes from `crypto.randomBytes`, base64url.
- Stored as `sha256(token)` hex, in `sessions.token_hash`. SHA-256 rather than
  bcrypt deliberately: the token is uniform randomness, so there is no
  dictionary to attack and nothing a slow hash buys — what matters is that a
  database dump contains no usable credential.
- The raw value exists in exactly three places: the bytes `randomBytes`
  returned, the `Set-Cookie` header, and the browser's cookie jar. Never in the
  database, a log line, an API body, a URL, an email, analytics, Sentry, or any
  JavaScript-readable storage. Tests assert each of those.

### Cookie attributes

```
naseeb_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200[; Secure]
```

- **HttpOnly** — the point of the exercise.
- **SameSite=Lax**, not Strict, and the difference matters. Strict withholds the
  cookie on the first cross-site navigation, so following a link from a
  verification email, a claim invitation or a WhatsApp share would land the
  visitor on a page that believes they are signed out. Lax withholds it on
  cross-site POST — the case CSRF cares about — and sends it on top-level GET.
  It is a second layer regardless: the CSRF token is what actually defends
  writes.
- **Secure** — always on in production. `COOKIE_SECURE` can turn it off outside
  production only, because a Secure cookie is never sent over plain http and
  local development would otherwise be unusable. Production cannot opt out:
  `assertCookieSecurity()` refuses to start on `COOKIE_SECURE=false` or a
  non-https `APP_URL`.
- **Path=/**, and cleared with the same attributes it was set with — a
  mismatched Path or SameSite leaves the original cookie in place.
- **Max-Age** derived from the row's `expires_at`, so the browser stops sending
  a token at the same moment the server stops honouring it.

### Lifetime

**12 hours**, down from 30 days. The judgement: the sensitive things an account
can do here are publishing a giveaway, drawing a winner, reading a winner's home
address, and — for an administrator — everything. Thirty days of ambient
authority in a browser is indefensible for any of those, and it was originally
chosen because it was the JWT library's convenient default, not because anyone
decided a month was right.

`SESSION_TTL_HOURS` is clamped to **1–168 hours**, so no configuration can
restore the old behaviour. There is no sliding extension: a session ends when
it ends.

---

## 3. The schema

`sessions`: `id`, `user_id` (ON DELETE CASCADE), `token_hash` (unique),
`created_at`, `last_used_at`, `expires_at`, `revoked_at`, `revocation_reason`,
`replaced_by_session_id`, `rotated_from_session_id`, `rotation_grace_until`.

**No IP address and no user-agent string**, deliberately. Nothing in this
application reads them — there is no device list, no anomaly detection — so
storing them would be collecting identifiable data for nobody to look at. If a
"sign out my other devices" screen is ever built, that is the moment to decide
what minimal hashed metadata it needs.

`last_used_at` is written at most once a minute per session, so a page view is
not a database write.

### What authentication rejects

| Condition | Result |
|---|---|
| No cookie | 401, no cookie cleared |
| Malformed value | 401 (rejected before any query) |
| Unknown hash | 401, cookie cleared |
| `expires_at` passed | 401, cookie cleared |
| `revoked_at` set | 401, cookie cleared |
| User row missing | 401, cookie cleared |
| `account_status != 'active'` | 401, cookie cleared |
| **Database error** | **503**, cookie left alone |

The last row is the one worth stating: "we cannot tell" is not "you are not
signed in". A database blip must not tell a signed-in person to sign in again,
and must never fall through to anonymous access. `optionalAuth` fails closed the
same way.

---

## 4. Fixation and rotation

**Fixation** is prevented by construction, not by a check. Login never looks at,
adopts or extends the session cookie the browser arrived with: it mints a new
token with a new row, and `Set-Cookie` overwrites whatever was there. A planted
cookie value stops being meaningful the moment the victim signs in, and never
becomes a session at all.

**Rotation policy.** A session's token is swapped for a fresh one on the first
request after `SESSION_ROTATE_AFTER_MINUTES` (default 240) since it was created.
The expiry does **not** move — rotation shortens how long any one captured token
is worth something; it is not a way to keep a session alive by using it.

Rotation happens at most once per session: the row is locked, and a second
concurrent attempt sees `replaced_by_session_id` already set and returns without
minting a rival token.

**Multi-tab safety.** A replaced token keeps working for a 60-second grace
window, authenticating as its successor. Without it, two tabs firing at the
instant a rotation is due would race and one would be signed out through no
fault of anyone's. A test ages a session past the threshold and fires ten
simultaneous requests: all ten succeed, and exactly one rotation happens.

Deliberately **not** rotated on every request: that would turn every
multi-request page load into a race, and buys little when the session already
has a short absolute life.

---

## 5. Revocation

One implementation, `revokeAllForUser`, behind every case — so none of them can
quietly do less than the others.

| Trigger | Scope | Reason recorded |
|---|---|---|
| `POST /api/auth/logout` | this session | `logout` |
| `POST /api/auth/logout-all` | all of the user's | `admin_revoked` |
| `POST /api/auth/reset-password` | all of the user's | `password_reset` |
| `POST /api/admin/users/:id/account-status` (≠ active) | all of that user's | `account_suspended` |
| `POST /api/admin/users/:id/revoke-sessions` | all of that user's | `admin_revoked` |
| Rotation | the replaced token | `rotated` |

A revoked session stops working on the next request, even though the browser
still holds a well-formed, unexpired cookie. That is the thing a JWT could not
do, and the reason sessions are a table.

Password reset and revocation are **one transaction**. Somebody resetting a
password is very often somebody who thinks another person has their account;
leaving that person signed in would make the reset theatre.

### Account status is not host status

Two columns, two routes, and no path that changes one as a side effect of the
other:

- `users.account_status` (`active` / `suspended` / `deactivated`) —
  **authentication**. Not active means no valid session and no new sign-in
  (refused with the same message as a wrong password, so it cannot be used to
  enumerate suspended accounts).
- `users.host_status` — **authorization**. Suspending it stops somebody
  publishing giveaways and drawing winners. It revokes **no** session: a
  suspended host is still an entrant with tickets, and signing them out of the
  platform would punish them for something they can still do. Tested explicitly.

---

## 6. CSRF

Two independent checks, both in front of every API router and both before any
handler runs, so a refused request has written nothing.

**1. Origin.** Every unsafe method (`POST`/`PUT`/`PATCH`/`DELETE`) under `/api`.
If `Origin` is present it must equal `APP_URL`'s origin; otherwise `Referer`'s
origin must. A request carrying neither is allowed through to check 2 — every
major browser sends `Origin` on cross-site POST including form submissions, so
that gap is non-browser callers, which have no cookie to abuse. This check
covers login CSRF too, which the token check cannot reach.

**2. Token.** Every unsafe request that carries a session cookie must send a
matching `X-CSRF-Token` header.

- The token is `HMAC-SHA256(SESSION_SECRET, "csrf:" + sessionId)`, base64url.
  Tied cryptographically to one session with nothing extra persisted: a token
  minted for session A cannot validate against session B, and when a session is
  revoked or rotated its id stops resolving so every token derived from it dies
  at the same instant.
- Compared with `timingSafeEqual`.
- **Header only.** Never a URL (it would reach access logs, Referer headers,
  browser history and shared links), never a form field, never `localStorage` —
  the frontend holds it in a module variable that dies with the page.
- Obtained from `GET /api/auth/session`, which is `Cache-Control: no-store` and
  returns no session token in any field.
- During a rotation grace window both the old and new session's tokens are
  accepted, so a tab that rotated a moment ago does not fail CSRF while holding
  a perfectly good session.
- A failure to verify is a **503**, not a pass.

### Exclusions

**Stripe webhooks only**, and by mount point rather than by a path check:
`app.use('/api/webhooks', express.raw(...), webhookRoutes)` is mounted *before*
`app.use('/api', csrfProtection)`, so the raw-body path never reaches it. Stripe
signs the exact bytes it sent and has no way to know a CSRF token; its
authentication is that signature, and it is still mandatory — an unsigned or
badly signed webhook is a 400. Stripe's POST is not a browser request and
carries no cookie, so there is no ambient authority there to abuse.

There is **no** other exclusion. In particular there is no allowlist of
"anonymous" routes: the rule is "the token is required whenever a session cookie
is present", which is exactly when a cross-site request would carry authority.
`POST /api/claims/lookup` and `/redeem` are reached by a winner who is not
signed in, so they carry no cookie and need no token — and a test proves the
whole fragment-token claim flow still works untouched. A test greps
`server/lib/csrf.js` for path-based exemption smells and fails if one appears.

---

## 7. The frontend

`public/js/app.js` holds two things in memory and nothing on disk: who you are
(for rendering) and the CSRF token (for sending). Both die with the page.

- `GET /api/auth/session` runs once per page load, before the header renders.
  There is no synchronous copy of "am I signed in" any more, which is why the
  authenticated pages now `await requireSession(...)` instead of reading storage.
- `api()` sends `credentials: 'same-origin'` and adds `X-CSRF-Token` to every
  unsafe request. A 401 clears the in-memory state so the page stops pretending.
- Signing out is `POST /api/auth/logout` — a server-side revocation, not a
  browser-side delete.
- `purgeLegacyTokens()` removes `naseeb_token` and `naseeb_user` from
  `localStorage` and `sessionStorage` on load. They are **never exchanged for a
  session**: a token found there has been sitting somewhere we now consider
  unsafe, possibly for a month, and the only correct thing to do with it is
  throw it away.

**Everyone signs in once after this is deployed.** There is no migration path
and there should not be one.

A test walks every file in `public/`, strips comments, and fails on any
`localStorage`/`sessionStorage` read or write of a token-shaped key, and on any
hand-built `Authorization` header.

---

## 8. Boundaries that are not sessions

- **Claim links** still arrive in a URL fragment, are captured before any other
  script runs, and are exchanged by `POST /api/claims/lookup` with the token in
  the body. The query-string form is still a 410.
- **A claim token is not a session.** Presented as a bearer header or as a
  session cookie it authenticates nothing, and redeeming a claim sets no cookie.
- **Verification and reset tokens are purpose-limited.** Neither works as a
  session cookie, and a session does not let anybody reset a password without
  the emailed token.
- **Stripe webhooks** are signature-authenticated and do not accept session
  authentication as a substitute.
- **Administrators and host permissions are still re-read from Postgres** on the
  request that needs them. The session asserts nothing beyond which account it
  belongs to.
- Forged `is_admin`, `role`, `userId`, `host_status` fields in a body, query
  string or header change nothing.

---

## 9. Production startup validation

`server/index.js` refuses to start in production when:

- `SESSION_SECRET` is missing or shorter than 32 characters, or
- `COOKIE_SECURE=false`, or
- `APP_URL` is not an `https://` origin.

Outside production the same problems are a warning, so local development works
over plain http. Only variable **names** ever appear in that output.

---

## 10. Still open

- **No CSP, and inline scripts everywhere.** An injected script can still act as
  the user within their session, and can still read the in-memory CSRF token.
  What it can no longer do is exfiltrate a durable credential. Phase 2.2B.
- **No expired-session sweep runs automatically.** `deleteExpiredSessions()`
  exists and is tested but nothing calls it on a schedule; the table grows until
  someone does. Expired rows are refused regardless, so this is housekeeping.
- **No "your other sessions" screen.** `logout-all` exists as an endpoint but no
  page offers it, and there is no device list — which is also why no device
  metadata is stored.
- **Session lifetime is a judgement, not a measurement.** Twelve hours may prove
  annoying in practice. It is configurable for exactly that reason.
- **`jsonwebtoken` is still a dependency** although nothing in the server uses
  it for authentication any more. Removing it is a separate, trivial change.
