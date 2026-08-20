// Runtime feature flags, read from the environment on every call rather than
// captured at require time — so a deploy can flip one by changing an
// environment variable, and so tests can exercise both states in one process.

// Self-serve ad checkout (Stripe Checkout Session -> paid homepage banner).
//
// Defaults to DISABLED when the variable is absent, which is the opposite of
// how a feature flag usually reads. That is deliberate: while this flag is off,
// the checkout path is known to be unsafe to take money through. Fulfilment
// depends on the customer returning to the success page (an abandoned tab
// leaves a paid booking marked unpaid), and two simultaneous checkouts can be
// sold the same dates because the slot is allocated and inserted in separate
// statements with no lock. Both are being fixed in the phases after this one.
//
// Defaulting to off means a fresh environment, a forgotten variable, or a
// misspelled value can only fail closed — the worst outcome is an advertiser
// using the inquiry form instead, not an advertiser being charged for a
// booking that never runs.
//
// Turn it back on only once the webhook, reservation-concurrency,
// price-parity, refund, dispute and expired-session tests all pass.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

function isAdsCheckoutEnabled() {
  return TRUTHY.has(String(process.env.ADS_CHECKOUT_ENABLED || '').trim().toLowerCase());
}

// The winner claim, delivery and dispute workflow. Defaults to ON: it replaces
// a flow where the host alone declared a prize delivered and the winner had no
// say, so the safe default is the one that gives the winner a voice. The switch
// exists so an operator who has not yet generated an encryption key can run
// without it rather than being locked out of their own site.
function areClaimsEnabled() {
  const raw = String(process.env.CLAIMS_ENABLED || '').trim().toLowerCase();
  if (raw === '') return true;
  return TRUTHY.has(raw);
}

module.exports = { isAdsCheckoutEnabled, areClaimsEnabled };
