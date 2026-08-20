// Allocation and expiry for the single homepage banner slot.
//
// There is exactly one banner position, sold as a date range. The original code
// worked out the next free date with one query and inserted the booking with
// another, with nothing in between to stop a second request doing the same
// thing at the same time — so two advertisers could be quoted, and could pay
// for, identical dates. Unpaid rows were invisible to the calculation as well,
// so a booking in progress held nothing at all.
//
// Two mechanisms now prevent that, and they are deliberately not alternatives
// to each other:
//
//   * An advisory lock serialises allocation, so concurrent requests take turns
//     and each sees the previous one's booking. This is what makes allocation
//     produce sensible consecutive ranges rather than errors.
//
//   * A PostgreSQL exclusion constraint (see server/db.js) makes overlapping
//     held-or-paid ranges impossible to store at all. This is the backstop: it
//     holds even for a code path that forgets the lock, a hand-written INSERT,
//     or a future bug. Application logic can be wrong; a constraint cannot.

// Arbitrary, fixed, and shared by every transaction that allocates or releases
// a slot. Advisory locks are just numbers to Postgres — the only thing that
// matters is that everyone touching the slot agrees on this one.
const AD_SLOT_LOCK_KEY = 738201947382;

// How long a booking holds its dates while the customer is in Stripe Checkout.
// Long enough to find a card and get through 3-D Secure without losing the
// slot; short enough that an abandoned checkout doesn't block sales for a day.
const HOLD_MINUTES = 60;

// The Stripe session is set to expire this many minutes BEFORE the database
// hold does, which is what keeps the guarantee one-directional: the session
// stops being payable first, and only then does the slot free up. Aligning them
// exactly would leave a window where Stripe still accepts a payment for dates
// that have just been released to someone else.
//
// Stripe requires expires_at to be at least 30 minutes out, so HOLD_MINUTES
// minus this must stay comfortably above that.
const STRIPE_EXPIRY_GRACE_MINUTES = 5;

const OCCUPYING_STATUSES = ['held', 'paid'];

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function toDateStr(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// Must be the first statement in any transaction that allocates or releases a
// slot. Transaction-scoped, so it is released on commit or rollback with no
// unlock call to forget — including when a request throws halfway through.
async function lockSlotAllocation(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [AD_SLOT_LOCK_KEY]);
}

// Releases holds whose time has run out. Idempotent by construction: it only
// matches rows still in 'held', so running it twice, or from two places at
// once, changes nothing the second time. Callers run it inside the advisory
// lock, which is what makes "expire, then allocate" atomic with respect to
// another request doing the same.
//
// The row is never deleted. An abandoned booking is a commercial record — who
// tried to buy what dates, when, and why it lapsed — and the released_at and
// release_reason columns are the audit trail for it.
// Bounded when a limit is given — the scheduled job passes one. Previously
// released only when a request happened to hit the ads route.
async function expireStaleHolds(client, { limit = null } = {}) {
  const result = await client.query(
    `UPDATE ads
        SET slot_status = 'released',
            slot_released_at = NOW(),
            slot_release_reason = 'hold_expired',
            payment_status = CASE WHEN payment_status = 'pending' THEN 'expired' ELSE payment_status END
      WHERE id IN (
        SELECT id FROM ads
         WHERE slot_status = 'held'
           AND hold_expires_at IS NOT NULL
           AND hold_expires_at <= NOW()
         LIMIT $1
      )
      RETURNING id`,
    [limit && limit > 0 ? Math.floor(limit) : 100000]
  );
  return result.rowCount;
}

// The next date the banner is free: the day after the last booking that still
// occupies the slot, or today if nothing does.
//
// Counts paid bookings AND holds that haven't expired — a booking someone is
// part-way through paying for is not available to sell to someone else. Expired
// holds are excluded by the hold_expires_at comparison rather than by relying
// on a sweep having run, so this stays correct (and read-only) when called from
// the public availability endpoint.
async function nextAvailableDate(client) {
  const result = await client.query(
    `SELECT MAX(ends_at) AS last_end
       FROM ads
      WHERE slot_status = ANY($1)
        AND starts_at IS NOT NULL
        AND ends_at IS NOT NULL
        AND ends_at >= CURRENT_DATE
        AND (slot_status = 'paid' OR hold_expires_at > NOW())`,
    [OCCUPYING_STATUSES]
  );
  const lastEnd = result.rows[0].last_end;
  return lastEnd ? toDateStr(addDays(lastEnd, 1)) : toDateStr(new Date());
}

// Whether a range is free, ignoring one booking (the one asking). Used when a
// payment arrives for a booking whose hold has already lapsed: if nobody took
// the dates in the meantime it can still be honoured, and if somebody did it
// must not be.
async function isRangeAvailable(client, { startsAt, endsAt, excludeAdId }) {
  const result = await client.query(
    `SELECT 1
       FROM ads
      WHERE id <> $1
        AND slot_status = ANY($2)
        AND starts_at IS NOT NULL
        AND ends_at IS NOT NULL
        AND daterange(starts_at, ends_at, '[]') && daterange($3::date, $4::date, '[]')
      LIMIT 1`,
    [excludeAdId, OCCUPYING_STATUSES, startsAt, endsAt]
  );
  return result.rowCount === 0;
}

function holdExpiryFrom(now = new Date()) {
  return new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);
}

// Stripe wants a Unix timestamp in seconds.
function stripeExpiryFor(holdExpiresAt) {
  return Math.floor(
    (new Date(holdExpiresAt).getTime() - STRIPE_EXPIRY_GRACE_MINUTES * 60 * 1000) / 1000
  );
}

module.exports = {
  AD_SLOT_LOCK_KEY,
  HOLD_MINUTES,
  STRIPE_EXPIRY_GRACE_MINUTES,
  OCCUPYING_STATUSES,
  addDays,
  toDateStr,
  lockSlotAllocation,
  expireStaleHolds,
  nextAvailableDate,
  isRangeAvailable,
  holdExpiryFrom,
  stripeExpiryFor,
};
