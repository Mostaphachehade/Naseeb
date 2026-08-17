// Whether this deployment can actually deliver email, and what to do when it
// cannot.
//
// ---------------------------------------------------------------------------
// The claim this replaces
// ---------------------------------------------------------------------------
//
// Phase 2.4A treated `RESEND_API_KEY` as optional in production and documented
// the consequence: "no email is delivered at all; both outboxes retry forever".
// Two things were wrong with that.
//
// **It should not be optional.** Email verification, password recovery, claim
// invitations, email-change verification and the old-address security warning
// are not decoration — they are how somebody proves an address, recovers an
// account, receives a prize, and learns that their recovery address is being
// moved. A deployment that cannot send them cannot run those workflows, and a
// process that starts anyway and reports itself healthy is lying.
//
// **"Retry forever" was also wrong**, and worth correcting rather than quietly
// dropping. Both outboxes have finite attempt limits (`MAX_ATTEMPTS`) and a
// terminal `failed` state, after which they stop and escalate to an
// administrator. Nothing retries indefinitely. What was true is that with no
// provider configured, every attempt is consumed against a send that cannot
// succeed, and the notification reaches terminal failure — which is a different
// and more recoverable failure than an infinite loop, and readiness now reports
// it.
//
// ---------------------------------------------------------------------------
// The maintenance mode
// ---------------------------------------------------------------------------
//
// `EMAIL_DELIVERY_ENABLED=false` is a deliberate, temporary state for a planned
// provider migration. It defaults to ON — an unset or misspelled value can only
// mean "email is expected to work", never "quietly stop sending". While it is
// off, every action whose mandatory email cannot be delivered returns 503
// **before creating the state that email was supposed to complete**, so nobody
// ends up with an unverifiable account, a pending change that can never be
// confirmed, or a claim invitation that will never arrive.
//
// It is refused outright at public launch.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

// Deliberately not the generic feature-flag helper: the default matters here and
// is the opposite of the ads flag's. Absent means ENABLED.
function isDeliveryEnabled() {
  const raw = String(process.env.EMAIL_DELIVERY_ENABLED || '').trim().toLowerCase();
  if (raw === '') return true;
  if (FALSY.has(raw)) return false;
  // Anything else — including a typo — is treated as enabled, so a mistake
  // cannot silently stop email.
  return true;
}

// Is a provider actually configured? A shape check only: nothing here makes a
// network call, at startup or ever. A provider call during startup would turn
// every boot into a dependency on somebody else's uptime, and a slow one into a
// failed deploy.
function isProviderConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || '').trim());
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// Is there anything at all that will carry a message?
//
// In production that means a configured provider, full stop. **Outside
// production the console logger IS the transport** — `sendEmail` prints what it
// would have sent, which is how local development and the whole test suite
// exercise every email-dependent flow without a provider account.
//
// That distinction is stated rather than implied because it is the difference
// between "email works here" and "email silently does nothing", and the two
// look identical from the outside. Production gets no such leniency: there, a
// missing provider is a refusal to start.
function hasTransport() {
  return isProduction() ? isProviderConfigured() : true;
}

// The sender identity. Resend requires a verified domain, and a `From` the
// provider will reject means every send fails — a failure that shows up as a
// mysterious outbox rather than as configuration.
//
// Accepts either `someone@example.com` or `Name <someone@example.com>`.
// Validated by SHAPE. The value is never returned, logged or echoed.
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/;
const NAMED = /^[^<>]{1,80}<\s*([^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,})\s*>$/;

function senderProblems() {
  const raw = String(process.env.EMAIL_FROM || '').trim();
  if (!raw) {
    return ['is not set. Every message needs a sender the provider will accept.'];
  }

  const named = raw.match(NAMED);
  const address = named ? named[1] : raw;
  if (!ADDRESS.test(address)) {
    return ['is not a valid email address or "Name <address>" pair.'];
  }

  const domain = address.split('@')[1].toLowerCase();
  const problems = [];

  // The provider's shared onboarding domain works for a demo and is not a
  // sender identity: it cannot be verified, it cannot be replied to, and
  // deliverability from it is poor.
  if (domain === 'resend.dev' || domain.endsWith('.resend.dev')) {
    problems.push(
      "uses the provider's shared onboarding domain. Set a sender on a domain you have verified."
    );
  }
  if (['example.com', 'example.org', 'example.net'].includes(domain) || domain.endsWith('.invalid')) {
    problems.push('uses a reserved example domain, which cannot receive or send real mail.');
  }
  if (domain === 'localhost' || !domain.includes('.')) {
    problems.push('has no deliverable domain.');
  }

  return problems;
}

function isSenderConfigured() {
  return senderProblems().length === 0;
}

// Can this deployment deliver email right now?
//
// The maintenance switch applies EVERYWHERE, including development — it is how
// the mode is exercised at all, and a switch that only works in production is a
// switch nobody has tested.
function canDeliver() {
  if (!isDeliveryEnabled()) return false;
  if (!hasTransport()) return false;
  // The sender identity is only meaningful when a real provider will judge it.
  if (isProduction() && !isSenderConfigured()) return false;
  return true;
}

// Why not, as a category. Never a value.
function unavailableReason() {
  if (!isDeliveryEnabled()) return 'maintenance';
  if (!hasTransport()) return 'provider_not_configured';
  if (isProduction() && !isSenderConfigured()) return 'sender_not_configured';
  return null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// Every action whose mandatory email cannot be delivered calls this FIRST, and
// returns before writing anything.
//
// The wording is deliberately about the platform rather than the person: "we
// cannot send you the email" is true and actionable; "your signup failed" is
// neither.
const COPY = {
  maintenance:
    'Email is temporarily unavailable while we move to a new provider. This step needs an email to reach you, so we have not created anything you would be unable to finish. Please try again shortly.',
  provider_not_configured:
    'We cannot send email at the moment, and this step needs an email to reach you. Nothing has been created. Please try again shortly.',
  sender_not_configured:
    'We cannot send email at the moment, and this step needs an email to reach you. Nothing has been created. Please try again shortly.',
};

// Express-friendly. Returns true when the caller should stop.
//
// 503 rather than 500: this is a temporary unavailability of a dependency, and
// `Retry-After` says so to anything automated.
function refuseIfUndeliverable(res, { action } = {}) {
  if (canDeliver()) return false;
  const reason = unavailableReason();

  res.set('Retry-After', '300');
  res.set('Cache-Control', 'no-store');
  res.status(503).json({
    error: COPY[reason] || COPY.provider_not_configured,
    code: 'EMAIL_DELIVERY_UNAVAILABLE',
    // A category, so a support conversation can start somewhere. Not a provider
    // message, not a recipient, not a configuration value.
    reason,
    action: action || null,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// How many terminally failed notifications are tolerable before readiness says
// the platform is degraded. Not zero: one address that hard-bounces is a
// customer-service matter, not an outage. A cluster of them is an outage.
const TERMINAL_FAILURE_THRESHOLD = Number(process.env.NOTIFICATION_FAILURE_THRESHOLD) > 0
  ? Math.floor(Number(process.env.NOTIFICATION_FAILURE_THRESHOLD))
  : 5;

// How far back to look. A failure from three months ago is history.
const FAILURE_WINDOW_HOURS = 24;

// Read-only. Returns a category and counts — never a recipient, a provider
// error, a subject or a body, because this feeds an unauthenticated endpoint.
async function notificationHealth(pool) {
  if (!canDeliver()) {
    return { ok: false, reason: unavailableReason(), failed_recently: null };
  }

  const [claims, changes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n FROM claim_notifications
        WHERE status = 'failed' AND updated_at > NOW() - ($1 || ' hours')::interval`,
      [String(FAILURE_WINDOW_HOURS)]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM email_change_notifications
        WHERE status = 'failed' AND failed_at > NOW() - ($1 || ' hours')::interval`,
      [String(FAILURE_WINDOW_HOURS)]
    ),
  ]);

  const failed = claims.rows[0].n + changes.rows[0].n;
  if (failed >= TERMINAL_FAILURE_THRESHOLD) {
    return { ok: false, reason: 'delivery_failures', failed_recently: failed };
  }
  return { ok: true, reason: null, failed_recently: failed };
}

module.exports = {
  TERMINAL_FAILURE_THRESHOLD,
  FAILURE_WINDOW_HOURS,
  COPY,
  isDeliveryEnabled,
  isProviderConfigured,
  hasTransport,
  isSenderConfigured,
  senderProblems,
  canDeliver,
  unavailableReason,
  refuseIfUndeliverable,
  notificationHealth,
};
