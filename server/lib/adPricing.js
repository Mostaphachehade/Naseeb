// The single authoritative source of advertising prices.
//
// Before this, the price lived in three places that could disagree: the owner
// setting the server charged from, a hard-coded AED 500 in advertise.html, and
// a second hard-coded total inside each dropdown option. Changing the price in
// the owner panel changed what Stripe charged and nothing else, so a customer
// could read one number on the page and be billed another.
//
// Everything the page displays — the weekly rate, every duration option, the
// total, the confirmation line — is now computed here and sent to the browser
// already formatted. The browser renders strings; it never does arithmetic on
// money, and nothing it sends back about price is trusted.
const crypto = require('crypto');
const { pool } = require('../db');
const { DEFAULTS } = require('./settings');

const PRICE_SETTING_KEY = 'ad_price_per_week_aed';
const CURRENCY = 'AED';
const CURRENCY_MINOR_UNITS = 100; // fils per dirham
const MAX_WEEKS = 8;
const DURATION_OPTIONS = [1, 2, 4, 8];

// Prices are stored as a decimal string because that is what an owner types.
// Converting to fils by multiplying by 100 in floating point is how 49.99
// becomes 4998.999999999999 and then, after rounding, an amount nobody agreed
// to. Splitting on the decimal point and working in integers keeps every value
// exact by construction.
const PRICE_FORMAT = /^\d{1,7}(\.\d{1,2})?$/;

function aedToFils(value) {
  const raw = String(value).trim();
  if (!PRICE_FORMAT.test(raw)) {
    throw new Error(`Invalid price: ${raw}`);
  }
  const [whole, fraction = ''] = raw.split('.');
  return Number(whole) * CURRENCY_MINOR_UNITS + Number(`${fraction}00`.slice(0, 2));
}

// Deliberately not Intl.NumberFormat: the same booking must read identically in
// a log, a test, an email and the page, regardless of the server's locale.
function formatFils(fils) {
  const whole = Math.floor(fils / CURRENCY_MINOR_UNITS);
  const minor = fils % CURRENCY_MINOR_UNITS;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return minor === 0
    ? `${CURRENCY} ${grouped}`
    : `${CURRENCY} ${grouped}.${String(minor).padStart(2, '0')}`;
}

// Identifies exactly which price a quote was made at.
//
// Derived from the price and the moment it was last changed rather than being a
// counter of its own, so it cannot drift out of step with the value it
// describes: any change to the setting necessarily produces a different
// version, and no bookkeeping has to remember to bump it.
function quoteVersionFor(pricePerWeekFils, updatedAt) {
  return crypto
    .createHash('sha256')
    .update(`${PRICE_SETTING_KEY}:${pricePerWeekFils}:${updatedAt}`)
    .digest('hex')
    .slice(0, 16);
}

// The current authoritative quote. Every price the customer sees, and every
// amount Stripe is asked for, comes from one of these.
async function getAdPriceQuote(client = pool) {
  const result = await client.query(
    'SELECT value, updated_at FROM site_settings WHERE key = $1',
    [PRICE_SETTING_KEY]
  );
  const row = result.rows[0];
  const value = row ? row.value : DEFAULTS[PRICE_SETTING_KEY];
  // A price that has never been changed has no updated_at; the default value is
  // itself the thing being versioned.
  const updatedAt = row ? new Date(row.updated_at).toISOString() : 'default';

  const pricePerWeekFils = aedToFils(value);

  return {
    pricePerWeekFils,
    pricePerWeekDisplay: formatFils(pricePerWeekFils),
    currency: CURRENCY,
    currencyMinorUnits: CURRENCY_MINOR_UNITS,
    quoteVersion: quoteVersionFor(pricePerWeekFils, updatedAt),
    maxWeeks: MAX_WEEKS,
    // Integer multiplication only. The page renders these; it does not compute
    // a total of its own from the weekly rate.
    durations: DURATION_OPTIONS.map((weeks) => {
      const totalFils = pricePerWeekFils * weeks;
      return {
        weeks,
        totalFils,
        totalDisplay: formatFils(totalFils),
        label: `${weeks} week${weeks > 1 ? 's' : ''} — ${formatFils(totalFils)}`,
      };
    }),
  };
}

function totalFilsFor(pricePerWeekFils, weeks) {
  return pricePerWeekFils * weeks;
}

module.exports = {
  PRICE_SETTING_KEY,
  PRICE_FORMAT,
  CURRENCY,
  CURRENCY_MINOR_UNITS,
  MAX_WEEKS,
  DURATION_OPTIONS,
  aedToFils,
  formatFils,
  quoteVersionFor,
  getAdPriceQuote,
  totalFilsFor,
};
