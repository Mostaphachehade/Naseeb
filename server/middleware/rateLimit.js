const rateLimit = require('express-rate-limit');

// Tight limit on auth: signup/login are the main brute-force and
// mass-account-creation surface, and the platform's one-entry-per-person
// fairness guarantee only holds if accounts can't be created in bulk.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

// Looser limit on entering a giveaway: still worth throttling to slow down
// scripted entry spam, but a real user retrying a few times shouldn't be hit.
const enterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

// Public, unauthenticated form — throttle it so it can't be used to spam the
// host_applications table or as an email-enumeration probe.
const applicationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many applications submitted. Please try again in a few minutes.' },
});

// Same shape as applicationLimiter, but a separate instance/store — ad
// inquiries and host applications are unrelated forms and shouldn't share
// one rate-limit bucket per IP.
const adInquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many inquiries submitted. Please try again in a few minutes.' },
});

// Creates a real Stripe Checkout Session per request (and a pending DB row)
// — tighter than the plain inquiry form since each hit has a small real
// cost, not just a database insert.
const adCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please try again in a few minutes.' },
});

// Claim links are bearer credentials, so guessing one has to be expensive. The
// tokens are 256 bits and unguessable in practice, but a limiter turns "in
// practice" into "also by policy", and stops a leaked link being hammered.
const claimTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

// Fulfilment steps and disputes. Looser, since these are signed-in actions by
// people with a legitimate stake — but still bounded, so a scripted client
// cannot flood the audit history or the notification emails.
const claimActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

module.exports = {
  authLimiter,
  enterLimiter,
  applicationLimiter,
  adInquiryLimiter,
  adCheckoutLimiter,
  claimTokenLimiter,
  claimActionLimiter,
};
