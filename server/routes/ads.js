const express = require('express');
const { v4: uuid } = require('uuid');
const { pool, isSlotProtectionActive } = require('../db');
const { adCheckoutLimiter } = require('../middleware/rateLimit');
const { createCheckoutSession } = require('../lib/stripe');
const { getAdPriceQuote, totalFilsFor, formatFils, MAX_WEEKS } = require('../lib/adPricing');
const { isAdsCheckoutEnabled } = require('../lib/featureFlags');
const {
  addDays,
  toDateStr,
  lockSlotAllocation,
  expireStaleHolds,
  nextAvailableDate,
  holdExpiryFrom,
  stripeExpiryFor,
} = require('../lib/adSlots');

const router = express.Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The currently active homepage banner ad, if any. Prefers a paid booking
// whose date range covers today; falls back to the original manually
// admin-toggled ad so that workflow keeps working unchanged.
//
// Keyed on slot_status rather than the paid boolean: a refunded or disputed
// booking releases its slot and must stop running, even though its row still
// records that money once changed hands.
router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, business_name, image_url, target_url, media_type FROM ads
       WHERE (slot_status = 'paid' AND starts_at <= CURRENT_DATE AND ends_at >= CURRENT_DATE)
          OR (slot_status <> 'paid' AND paid = FALSE AND active = TRUE)
       ORDER BY (slot_status = 'paid') DESC
       LIMIT 1`
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Everything the advertise page needs to render prices, and nothing it needs to
// calculate them. The weekly rate, each duration option and each total arrive
// already computed and already formatted, in integer fils plus a display
// string, so the browser never multiplies money.
//
// checkoutEnabled is the only thing this exposes about the flag: a boolean the
// page uses to decide which panel to render. The environment variable itself,
// and every Stripe/database detail behind it, stays server-side.
//
// no-store because a cached copy of this is a stale price. A customer served an
// old quoteVersion from a proxy would be shown one number, then rejected at
// checkout — correct, but a confusing way to find out.
router.get('/availability', async (req, res) => {
  try {
    const [nextDate, quote] = await Promise.all([nextAvailableDate(pool), getAdPriceQuote(pool)]);
    res.set('Cache-Control', 'no-store');
    res.json({
      nextAvailableDate: nextDate,
      ...quote,
      checkoutEnabled: isAdsCheckoutEnabled(),
    });
  } catch (err) {
    console.error(err);
    res.set('Cache-Control', 'no-store');
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

    // Defence in depth. Startup already refuses to boot with checkout on and no
    // overlap protection, but a startup check only proves something about the
    // moment the process began: the constraint can be dropped by a migration, a
    // restore, or a hand-run ALTER while the process keeps running happily. It
    // can also be bypassed entirely by anything that starts the app without
    // going through server/index.js.
    //
    // Checked here, before validation, before the hold is inserted and before
    // Stripe is contacted, so an unprotected checkout takes no money and leaves
    // no trace. The customer-facing message is the same one the kill switch
    // gives — the reason is an internal matter and belongs in the log, not the
    // response.
    if (!(await isSlotProtectionActive(pool))) {
      console.error(
        'Ad checkout refused: booking overlap protection is not active. Two advertisers could ' +
          'otherwise be sold the same dates. Checkout stays unavailable until the ' +
          'exclusion constraint is in place.'
      );
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

    // The price the customer was shown, checked against the price as it stands
    // right now. If the owner changed it between the page loading and this
    // request, the two disagree and the customer must be told rather than
    // quietly charged the new amount — or, just as bad, quietly charged the old
    // one. Verified before anything is created: a stale quote leaves no hold,
    // no booking row and no Stripe session behind.
    //
    // Note what is NOT read here: any price, total or amount from req.body. The
    // browser is told what things cost; it is never asked.
    const quote = await getAdPriceQuote(pool);
    if (req.body.quote_version !== quote.quoteVersion) {
      res.set('Cache-Control', 'no-store');
      return res.status(409).json({
        code: 'PRICE_CHANGED',
        error:
          'The advertising price changed while you were filling this in. Please review the updated total and confirm to continue.',
        quote,
      });
    }

    const unitPriceFils = quote.pricePerWeekFils;
    const amountFils = totalFilsFor(unitPriceFils, weeksNum);
    const id = uuid();
    const holdExpiresAt = holdExpiryFrom();

    // Reserving the dates and working out which dates they are has to be one
    // atomic step. Splitting them — as this route used to — is what let two
    // simultaneous customers be quoted the same range and both pay for it.
    //
    // The hold is committed before Stripe is contacted, not after: a session
    // created against dates nobody is holding is a session that can be paid for
    // dates somebody else has since bought.
    const client = await pool.connect();
    let startsAtStr;
    let endsAtStr;
    try {
      await client.query('BEGIN');
      await lockSlotAllocation(client);
      // Inside the lock, so a hold that lapsed a moment ago is reclaimed here
      // rather than blocking the sale, and no concurrent allocation can be
      // midway through taking the dates this one is about to read as free.
      await expireStaleHolds(client);

      startsAtStr = await nextAvailableDate(client);
      endsAtStr = toDateStr(addDays(startsAtStr, weeksNum * 7 - 1));

      // amount_aed is derived from amount_fils in SQL rather than computed in
      // JavaScript, so the two can never disagree and no float ever touches it.
      await client.query(
        `INSERT INTO ads
           (id, business_name, image_url, target_url, media_type, contact_email,
            starts_at, ends_at, amount_fils, amount_aed, unit_price_fils, weeks,
            currency, quote_version, paid, active,
            slot_status, hold_expires_at, payment_status)
         VALUES ($1, $2, $3, $4, 'image', $5, $6, $7, $8::bigint, $8::numeric / 100, $9, $10,
                 $11, $12, FALSE, FALSE, 'held', $13, 'pending')`,
        [
          id,
          business_name.trim(),
          image_url.trim(),
          normalizedTargetUrl,
          contact_email.trim().toLowerCase(),
          startsAtStr,
          endsAtStr,
          amountFils,
          unitPriceFils,
          weeksNum,
          quote.currency,
          quote.quoteVersion,
          holdExpiresAt,
        ]
      );
      await client.query('COMMIT');
    } catch (holdErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw holdErr;
    } finally {
      client.release();
    }

    let session;
    try {
      session = await createCheckoutSession({
        // Straight from the verified quote, in integer fils. Not recomputed
        // from a decimal, and not taken from the request.
        amountFils,
        currency: quote.currency.toLowerCase(),
        productName: `Naseeb homepage ad — ${business_name.trim()} (${weeksNum} week${weeksNum > 1 ? 's' : ''}, ${formatFils(amountFils)})`,
        successUrl: `${APP_URL}/advertise.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
        cancelUrl: `${APP_URL}/advertise.html?status=cancelled`,
        clientReferenceId: id,
        customerEmail: contact_email.trim(),
        // Stripe stops accepting payment shortly before the hold lapses, so
        // there is never a moment where the session is payable but the dates
        // have already been released to someone else.
        expiresAt: stripeExpiryFor(holdExpiresAt),
      });
    } catch (stripeErr) {
      // The booking row is kept and released rather than deleted: it is the
      // record that these dates were briefly held and why they were let go.
      // Leaving it 'held' would block the slot for an hour over a checkout that
      // never started.
      await pool
        .query(
          `UPDATE ads
              SET slot_status = 'released',
                  slot_released_at = NOW(),
                  slot_release_reason = 'checkout_failed',
                  payment_status = 'failed'
            WHERE id = $1`,
          [id]
        )
        .catch((releaseErr) => {
          // Worth knowing about: the slot stays held until it expires on its
          // own, which is an hour of lost availability, not a lost booking.
          console.error('Could not release the hold after a failed checkout:', releaseErr.message);
        });
      throw stripeErr;
    }

    await pool.query('UPDATE ads SET stripe_session_id = $1 WHERE id = $2', [session.id, id]);

    res.set('Cache-Control', 'no-store');
    res.json({
      checkoutUrl: session.url,
      // Echoed back from the verified quote so the page can show what is about
      // to be charged without recomputing it.
      amountFils,
      amountDisplay: formatFils(amountFils),
      currency: quote.currency,
      quoteVersion: quote.quoteVersion,
    });
  } catch (err) {
    console.error(err);
    res.set('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
      `SELECT business_name, starts_at, ends_at, amount_aed, amount_fils, currency,
              weeks, unit_price_fils, quote_version, payment_status
       FROM ads WHERE stripe_session_id = $1`,
      [sessionId]
    );
    const booking = result.rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    // Formatted from the amount stored on the booking, not from the current
    // price setting — the confirmation must show what this customer was
    // actually charged even if the owner has since changed the rate.
    const amountFils = Number(booking.amount_fils);
    res.set('Cache-Control', 'no-store');
    res.json({
      ...booking,
      amountFils,
      amountDisplay: formatFils(amountFils),
      paid: booking.payment_status === 'paid',
    });
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
