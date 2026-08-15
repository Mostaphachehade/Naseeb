// Stripe access, through the official SDK.
//
// This previously spoke to Stripe's REST API with hand-rolled fetch() calls.
// That was fine for creating a Checkout Session, but webhook verification is
// not somewhere to hand-roll anything: getting the signature scheme subtly
// wrong (timing-unsafe comparison, ignoring the timestamp tolerance, mishandling
// multiple v1 signatures during a secret rotation) produces code that looks
// like it works and accepts forged events. stripe.webhooks.constructEvent()
// is the supported implementation of that check, so it is what we use.
const Stripe = require('stripe');

// The SDK is pointed at fetch() rather than its default Node HTTP client so
// outbound calls stay interceptable in tests — the suite stubs globalThis.fetch
// to assert exactly which requests a route would have made, without a network.
let cached = { key: null, client: null };

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('Stripe is not configured.');
  }
  // Rebuilt when the key changes so a process that swaps keys (only tests do)
  // doesn't keep using a client bound to the old one.
  if (cached.client && cached.key === key) return cached.client;
  cached = {
    key,
    client: new Stripe(key, {
      // Resolved on every call rather than captured once. createFetchHttpClient()
      // with no argument binds whatever globalThis.fetch was at construction
      // time, which means a long-lived client keeps using a stale reference if
      // anything replaces global fetch later — instrumentation, a proxy shim, or
      // a test stub. Late-binding keeps the client honest about the current one.
      httpClient: Stripe.createFetchHttpClient((...args) => globalThis.fetch(...args)),
    }),
  };
  return cached.client;
}

async function createCheckoutSession({
  amountFils,
  currency,
  productName,
  successUrl,
  cancelUrl,
  clientReferenceId,
  customerEmail,
}) {
  return stripeClient().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: productName },
          unit_amount: amountFils,
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // The ad row's id. This is what ties a Stripe session back to a booking
    // when the webhook arrives, and it is verified against the stored session
    // id before anything is marked paid.
    client_reference_id: clientReferenceId,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
  });
}

// Verifies the signature on a raw webhook body and returns the parsed event.
// Throws if the signature is absent, malformed, signed with a different secret,
// or outside Stripe's replay-tolerance window. The caller must treat any throw
// as "reject before touching the database".
//
// `payload` must be the exact bytes Stripe sent — see the express.raw() mount
// in server/app.js. A body that has been through express.json() and been
// re-serialised will not verify, because JSON.stringify does not reproduce
// byte-for-byte what was signed.
function constructWebhookEvent(payload, signatureHeader, webhookSecret) {
  // A separate client: webhook verification is pure crypto and needs no API
  // key, so this works even in a process that has no STRIPE_SECRET_KEY set.
  return Stripe.webhooks.constructEvent(payload, signatureHeader, webhookSecret);
}

module.exports = { createCheckoutSession, constructWebhookEvent };
