const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { adCheckoutLimiter } = require('../middleware/rateLimit');
const { createCheckoutSession } = require('../lib/stripe');
const { getSetting } = require('../lib/settings');
const { isAdsCheckoutEnabled } = require('../lib/featureFlags');

const router = express.Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_WEEKS = 8;

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function toDateStr(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// Next free date for the single homepage banner slot: the day after the
// latest paid booking that hasn't ended yet, or today if nothing's booked.
async function computeNextAvailableDate() {
  const result = await pool.query(
    "SELECT MAX(ends_at) AS last_end FROM ads WHERE paid = TRUE AND ends_at >= CURRENT_DATE"
  );
  const lastEnd = result.rows[0].last_end;
  return lastEnd ? toDateStr(addDays(lastEnd, 1)) : toDateStr(new Date());
}

// The currently active homepage banner ad, if any. Prefers a paid booking
// whose date range covers today; falls back to the original manually
// admin-toggled ad so that workflow keeps working unchanged.
router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, business_name, image_url, target_url, media_type FROM ads
       WHERE (paid = TRUE AND starts_at <= CURRENT_DATE AND ends_at >= CURRENT_DATE)
          OR (paid = FALSE AND active = TRUE)
       ORDER BY paid DESC
       LIMIT 1`
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// checkoutEnabled is the only thing this exposes about the flag: a boolean the
// page uses to decide which panel to render. The environment variable itself,
// and every Stripe/database detail behind it, stays server-side.
router.get('/availability', async (req, res) => {
  try {
    const [nextAvailableDate, pricePerWeekAed] = await Promise.all([
      computeNextAvailableDate(),
      getSetting('ad_price_per_week_aed'),
    ]);
    res.json({
      nextAvailableDate,
      pricePerWeekAed: Number(pricePerWeekAed),
      maxWeeks: MAX_WEEKS,
      checkoutEnabled: isAdsCheckoutEnabled(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Books the slot (recomputing the start date server-side, never trusting
// the client) and starts a real Stripe Checkout Session. The ad row is
// inserted immediately as unpaid so there's a record even if the visitor
// abandons checkout; GET /checkout/confirm below is what flips it to paid.
router.post('/checkout', adCheckoutLimiter, async (req, res) => {
  try {
    // Checked before validation, before any database write and before Stripe
    // is contacted, so a disabled checkout is inert rather than partially
    // executed: no pending ad row to reconcile later, no Checkout Session
    // created that nobody will ever fulfil.
    if (!isAdsCheckoutEnabled()) {
      return res.status(503).json({
        error:
          'Online booking is temporarily unavailable. Send an inquiry below and we’ll book your slot directly.',
        checkoutEnabled: false,
      });
    }

    const { business_name, contact_email, image_url, target_url, weeks } = req.body;

    if (!business_name || !business_name.trim()) {
      return res.status(400).json({ error: 'Business name is required.' });
    }
    if (!contact_email || !EMAIL_RE.test(contact_email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!image_url || !image_url.trim()) {
      return res.status(400).json({ error: 'A banner image is required.' });
    }
    let normalizedTargetUrl;
    try {
      const parsed = new URL(target_url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
      normalizedTargetUrl = parsed.href;
    } catch {
      return res.status(400).json({ error: 'Destination link must be a valid http(s) URL.' });
    }
    const weeksNum = Number(weeks);
    if (!Number.isInteger(weeksNum) || weeksNum < 1 || weeksNum > MAX_WEEKS) {
      return res.status(400).json({ error: `Choose between 1 and ${MAX_WEEKS} weeks.` });
    }

    const [startsAtStr, pricePerWeekAed] = await Promise.all([
      computeNextAvailableDate(),
      getSetting('ad_price_per_week_aed'),
    ]);
    const endsAtStr = toDateStr(addDays(startsAtStr, weeksNum * 7 - 1));
    const amountAed = weeksNum * Number(pricePerWeekAed);

    const id = uuid();
    await pool.query(
      `INSERT INTO ads
         (id, business_name, image_url, target_url, media_type, contact_email, starts_at, ends_at, amount_aed, paid, active)
       VALUES ($1, $2, $3, $4, 'image', $5, $6, $7, $8, FALSE, FALSE)`,
      [id, business_name.trim(), image_url.trim(), normalizedTargetUrl, contact_email.trim().toLowerCase(), startsAtStr, endsAtStr, amountAed]
    );

    let session;
    try {
      session = await createCheckoutSession({
        amountFils: amountAed * 100,
        currency: 'aed',
        productName: `Naseeb homepage ad — ${business_name.trim()} (${weeksNum} week${weeksNum > 1 ? 's' : ''})`,
        successUrl: `${APP_URL}/advertise.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
        cancelUrl: `${APP_URL}/advertise.html?status=cancelled`,
        clientReferenceId: id,
        customerEmail: contact_email.trim(),
      });
    } catch (stripeErr) {
      await pool.query('DELETE FROM ads WHERE id = $1', [id]);
      throw stripeErr;
    }

    await pool.query('UPDATE ads SET stripe_session_id = $1 WHERE id = $2', [session.id, id]);

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
});

// Read-only status lookup for the success page after Stripe redirects back.
//
// This used to be the fulfilment path: it asked Stripe whether the session was
// paid and, if so, flipped the booking to paid. That made getting paid
// dependent on the customer's browser completing a redirect — close the tab and
// the payment was real but the booking stayed unpaid forever. Fulfilment now
// happens only in the Stripe webhook (server/routes/webhooks.js), which is
// delivered server-to-server and retried until acknowledged.
//
// What is left is deliberately inert: it reads the booking's current state and
// returns it. It issues no Stripe call and performs no write, so it cannot mark
// anything paid, and it cannot be used to probe Stripe with guessed session ids.
// A customer arriving before the webhook lands sees "still confirming", which is
// the truth at that moment rather than a guess.
//
// Deliberately NOT behind the ADS_CHECKOUT_ENABLED flag. Turning checkout off
// stops new sessions being created; it must not blank the status page for
// someone who paid moments earlier and is still mid-redirect.
router.get('/checkout/confirm', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id.' });

    const result = await pool.query(
      `SELECT business_name, starts_at, ends_at, amount_aed, payment_status
       FROM ads WHERE stripe_session_id = $1`,
      [sessionId]
    );
    const booking = result.rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    res.json({ ...booking, paid: booking.payment_status === 'paid' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong looking up your booking.' });
  }
});

// Plain navigable link (not a fetch/api call) so a click actually counts
// before the visitor leaves for the advertiser's site.
router.get('/:id/click', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE ads SET click_count = click_count + 1 WHERE id = $1 RETURNING target_url',
      [req.params.id]
    );
    const ad = result.rows[0];
    if (!ad) return res.status(404).send('Ad not found.');
    res.redirect(302, ad.target_url);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});

module.exports = router;
