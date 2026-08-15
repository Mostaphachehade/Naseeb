# Naseeb — free-entry giveaway platform

A full-stack web app where anyone can host a giveaway and anyone can enter — for free, always.
There is no payment flow anywhere in this codebase, by design. Every giveaway must:

- be free to enter (no field for a price or fee exists on the entry endpoint)
- disclose who is funding the prize (`funded_by`, shown publicly — the point is that the
  prize is a marketing/promotional cost carried by the host, not something paid for by entrants)
- draw a winner only after the entry deadline, uniformly at random from all entries
- limit each person to one entry, so no one can pay or otherwise "buy" better odds

## Why it's built this way

In the UAE (and in most countries), a paid-entry raffle or lottery is regulated gambling —
in the UAE specifically, the General Commercial Gaming Regulatory Authority (GCGRA) licenses
all commercial gaming, including any arrangement where a participant pays for a chance to win
a prize. A genuine promotional giveaway — free entry, prize funded as a marketing expense —
sits outside that definition. This app is scoped to stay in the free/promotional lane. If you
ever want to add paid entries, ticket tiers, or "buy more chances," you'd be moving into
licensed commercial gaming territory and should get advice from a lawyer or the GCGRA directly
before building or launching that.

## Stack

- **Backend:** Node.js, Express, Postgres (via `pg`), JWT auth, bcrypt password hashing
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
# edit .env: set JWT_SECRET to a long random string, and DATABASE_URL to your Neon/Supabase connection string
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
    middleware/auth.js        # JWT auth middleware (requireAuth, optionalAuth, requireAdmin)
    middleware/rateLimit.js   # rate limiters for auth, entry, and application endpoints
    routes/auth.js            # signup / login / email verification / password reset
    routes/giveaways.js       # browse (paginated), create, enter, draw, dashboard
    routes/hostApplications.js # public application form -> host_applications table
    routes/admin.js            # admin-only: list/review host applications
    routes/config.js           # exposes non-secret Cloudinary config to the frontend
  public/
    index.html            # browse giveaways
    giveaway.html          # single giveaway: enter, or draw if you're the host
    create.html            # host form (funding disclosure + optional image upload)
    dashboard.html          # your hosted giveaways + your entries
    host-apply.html          # apply to host on a paid plan (individual or company)
    admin.html                # admin-only: review host applications
    verify.html / forgot-password.html / reset-password.html
    login.html / signup.html
    about.html / pricing.html / terms.html / privacy.html
    css/style.css
    js/app.js               # shared auth/session helpers + rendering
```

## Environment variables

See `.env.example` for the full list. `JWT_SECRET` and `DATABASE_URL` are required — the app
won't start without them. Everything else is optional and degrades gracefully if unset:

- **`RESEND_API_KEY`** — without it, verification/reset/notification emails are logged to the
  server console instead of sent. Get a free key at [resend.com](https://resend.com).
- **`ADMIN_NOTIFY_EMAIL`** — where "new host application" emails go. No key, no email.
- **`CLOUDINARY_CLOUD_NAME`** / **`CLOUDINARY_UPLOAD_PRESET`** — enables in-browser image
  upload on the host form. Without them, hosts just paste an image URL instead. Create a free
  account at [cloudinary.com](https://cloudinary.com) and an **unsigned** upload preset
  (Settings → Upload → Upload presets) — unsigned uploads never need the API secret.
- **`APP_URL`** — the public URL this app is served at, used to build links inside emails
  (verification, password reset). Set this to your real domain once deployed.

## Deploying to Render

This repo includes a `render.yaml` blueprint.

1. Push this repo to GitHub if it isn't already.
2. On [render.com](https://render.com), **New +** → **Blueprint**, and point it at this repo.
   Render will read `render.yaml` and set up a web service running `npm start`.
3. Fill in the environment variables it prompts for (`JWT_SECRET`, `DATABASE_URL`, and the
   optional ones above). Generate `JWT_SECRET` with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
4. Once deployed, set `APP_URL` to the `https://your-app.onrender.com` URL Render gives you
   (or your custom domain) so email links point to the right place.

Any other Node host (Railway, Fly.io, a VPS) works the same way without the blueprint —
just set the same environment variables and run `npm start`.

## Pre-launch checklist

- [x] Rate limiting on `/api/auth/*`, `/api/giveaways/:id/enter`, and the host application form
- [x] Email verification required before a new account can host or enter a giveaway
- [x] Terms of Service and Privacy Policy pages
- [ ] A payment processor, if you want to actually charge for the paid hosting plans on the
      pricing page — today, applications are just captured for manual follow-up
      (see `/admin.html`), and hosting itself isn't gated behind payment
