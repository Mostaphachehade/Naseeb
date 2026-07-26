// Plain fetch() against Stripe's REST API rather than the official SDK —
// consistent with how this project already talks to Resend and Cloudinary,
// and Checkout Sessions only need two calls (create, retrieve). Stripe's
// API is form-encoded, not JSON, hence URLSearchParams with bracket-style
// keys rather than a JSON body.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_API = 'https://api.stripe.com/v1';

async function createCheckoutSession({
  amountFils,
  currency,
  productName,
  successUrl,
  cancelUrl,
  clientReferenceId,
  customerEmail,
}) {
  const body = new URLSearchParams();
  body.append('mode', 'payment');
  body.append('line_items[0][price_data][currency]', currency);
  body.append('line_items[0][price_data][product_data][name]', productName);
  body.append('line_items[0][price_data][unit_amount]', String(amountFils));
  body.append('line_items[0][quantity]', '1');
  body.append('success_url', successUrl);
  body.append('cancel_url', cancelUrl);
  body.append('client_reference_id', clientReferenceId);
  if (customerEmail) body.append('customer_email', customerEmail);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || 'Could not start checkout. Please try again.');
  }
  return data;
}

async function retrieveCheckoutSession(sessionId) {
  const res = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || 'Could not verify payment. Please try again.');
  }
  return data;
}

module.exports = { createCheckoutSession, retrieveCheckoutSession };
