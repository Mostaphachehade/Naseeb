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

- **Backend:** Node.js, Express, SQLite (via `better-sqlite3`), JWT auth, bcrypt password hashing
- **Frontend:** Plain HTML/CSS/JS (no build step, no framework) — just open and deploy
- **No external services required** — everything runs from one process and one local `.db` file

## Running it locally

```bash
npm install
cp .env.example .env
# edit .env and set JWT_SECRET to a long random string
npm start
```

Then open http://localhost:3000

The SQLite database file (`naseeb.db`) is created automatically on first run, in the project root.

## Project structure

```
naseeb/
  server/
    index.js            # Express app entry point
    db.js                # SQLite schema (users, giveaways, entries)
    middleware/auth.js    # JWT auth middleware
    routes/auth.js        # signup / login
    routes/giveaways.js   # browse, create, enter, draw, dashboard
  public/
    index.html           # browse giveaways
    giveaway.html         # single giveaway: enter, or draw if you're the host
    create.html           # host form (includes required funding disclosure)
    dashboard.html         # your hosted giveaways + your entries
    login.html / signup.html
    css/style.css
    js/app.js             # shared auth/session helpers + rendering
```

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Things to change before going live:

1. Set a strong, secret `JWT_SECRET`.
2. Put the SQLite file on a persistent disk/volume, or switch `server/db.js` to Postgres if you
   expect meaningful concurrent traffic.
3. Add rate limiting on `/api/auth/*` and `/api/giveaways/:id/enter` to slow down abuse.
4. Consider email verification before letting a new account enter giveaways, since the
   one-entry-per-person rule is only as good as your ability to stop one person from
   signing up with multiple emails.
5. Add a terms-of-service / eligibility page (age, jurisdiction restrictions, how winners are
   contacted) — the code enforces the mechanics, but the legal terms of your specific giveaways
   are still yours to write.
