// The one place that decides whether this process is safe to run.
//
// Before this file, startup validation was five functions in server/index.js,
// each with its own idea of what "production" meant and its own decision about
// whether to warn or refuse. Three variables were checked nowhere at all, and
// `.env.example`, `render.yaml`, the README and the code disagreed about which
// of them were required. A configuration mistake is not an exotic failure mode:
// it is the most likely way this platform breaks, and it breaks quietly.
//
// So: one validator, one classification per variable, one answer.
//
// ---------------------------------------------------------------------------
// Rules this file follows without exception
// ---------------------------------------------------------------------------
//
//   * A problem names the VARIABLE, never the VALUE. Not the value, not a
//     prefix of it, not its length beyond "shorter than N", not a hash of it.
//     A validation error is written to a log, and a log is not a vault.
//
//   * Production fails BEFORE listening. A process that accepts a request and
//     then discovers it cannot encrypt a delivery address has already accepted
//     the request.
//
//   * A disabled feature demands nothing. Requiring a Stripe key while checkout
//     is off trains people to set fake ones.
//
//   * There is no insecure production fallback. Nothing here defaults a secret,
//     borrows one from another variable, or downgrades a requirement because a
//     value is missing.
const { isAdsCheckoutEnabled, areClaimsEnabled } = require('./featureFlags');
const sessions = require('./sessions');
const riskSignals = require('./riskSignals');
const { resolveTrustProxy } = require('./proxyTrust');
const claimCrypto = require('./claimCrypto');
const policies = require('./policies');
const emailDelivery = require('./emailDelivery');

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const KIND = {
  // Needed everywhere, including development and CI.
  ALWAYS: 'required_always',
  // Needed only in production.
  PRODUCTION: 'required_production',
  // Needed only while a feature is on.
  CONDITIONAL: 'required_when_enabled',
  // The system is complete without it; something is degraded if it is absent.
  OPTIONAL: 'optional',
  // Must never be set in a test process. testEnv.js strips these.
  FORBIDDEN_IN_TESTS: 'forbidden_in_tests',
};

const EXPOSURE = {
  // Value must never appear in a log, an error, a response or a committed file.
  SECRET: 'secret',
  // Safe to print and safe to commit.
  PUBLIC: 'public',
};

// The authoritative matrix. `docs/OPERATIONS.md` renders this; it is not
// maintained by hand there, so the two cannot drift.
const VARIABLES = [
  { name: 'NODE_ENV', kind: KIND.PRODUCTION, exposure: EXPOSURE.PUBLIC,
    purpose: 'Selects production behaviour: strict validation, HSTS, no dev mail logger.' },
  { name: 'PORT', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Listen port. Defaults to 3000; Render sets it.' },
  { name: 'DATABASE_URL', kind: KIND.ALWAYS, exposure: EXPOSURE.SECRET,
    purpose: 'Postgres connection string. Contains credentials.' },
  { name: 'DATABASE_SSL', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Set to false only for a local database with no TLS.' },
  { name: 'APP_URL', kind: KIND.PRODUCTION, exposure: EXPOSURE.PUBLIC,
    purpose: 'Public origin. Builds every link that goes into an email.' },
  { name: 'SESSION_SECRET', kind: KIND.ALWAYS, exposure: EXPOSURE.SECRET,
    purpose: 'Signs CSRF tokens. No default, no fallback.' },
  { name: 'SESSION_TTL_HOURS', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Session lifetime. Defaults documented in docs/SESSIONS.md.' },
  { name: 'SESSION_ROTATE_AFTER_MINUTES', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'How often a session token rotates.' },
  { name: 'COOKIE_SECURE', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Forces the Secure attribute off for local http. Refused in production.' },
  { name: 'TRUSTED_PROXY_HOPS', kind: KIND.PRODUCTION, exposure: EXPOSURE.PUBLIC,
    purpose: 'How much of X-Forwarded-For is believed. 1 behind Render.' },
  { name: 'INTEGRITY_SIGNAL_SECRET', kind: KIND.PRODUCTION, exposure: EXPOSURE.SECRET,
    purpose: 'Keys the coarsened network hashes. No raw address is ever stored.' },
  { name: 'INTEGRITY_SIGNAL_RETENTION_DAYS', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Risk-signal retention window; also salts the HMAC key.' },
  { name: 'CLAIMS_ENABLED', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'The winner claim workflow. Defaults on.' },
  { name: 'CLAIM_ENCRYPTION_KEY', kind: KIND.CONDITIONAL, exposure: EXPOSURE.SECRET,
    enabledBy: 'CLAIMS_ENABLED',
    purpose: 'Encrypts winner delivery details. Losing it makes them unreadable forever.' },
  { name: 'CLAIM_ENCRYPTION_KEYS_PREVIOUS', kind: KIND.OPTIONAL, exposure: EXPOSURE.SECRET,
    purpose: 'Retired keys, so already-encrypted rows stay readable through a rotation.' },
  { name: 'CLAIM_TOKEN_TTL_HOURS', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'How long a claim invitation link works.' },
  { name: 'CLAIM_DELIVERY_RETENTION_DAYS', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Days after delivery before an address is erased.' },
  { name: 'CLAIM_MAINTENANCE_INTERVAL_MINUTES', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'In-process scheduler tick. Not the primary schedule — see docs/OPERATIONS.md.' },
  { name: 'CLAIM_DEV_LOG_LINKS', kind: KIND.FORBIDDEN_IN_TESTS, exposure: EXPOSURE.PUBLIC,
    purpose: 'Prints claim links to the console in development. Refused in production.' },
  { name: 'ADS_CHECKOUT_ENABLED', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Self-serve ad checkout. Defaults off and must stay off for now.' },
  { name: 'STRIPE_SECRET_KEY', kind: KIND.CONDITIONAL, exposure: EXPOSURE.SECRET,
    enabledBy: 'ADS_CHECKOUT_ENABLED', purpose: 'Stripe API key.' },
  { name: 'STRIPE_WEBHOOK_SECRET', kind: KIND.CONDITIONAL, exposure: EXPOSURE.SECRET,
    enabledBy: 'ADS_CHECKOUT_ENABLED',
    purpose: 'Verifies webhook signatures. Different per environment.' },
  { name: 'RESEND_API_KEY', kind: KIND.PRODUCTION, exposure: EXPOSURE.SECRET,
    purpose: 'Sends email. REQUIRED in production — verification, recovery, claims and security warnings all depend on it.' },
  { name: 'EMAIL_FROM', kind: KIND.PRODUCTION, exposure: EXPOSURE.PUBLIC,
    purpose: 'Sender identity, shape-validated. A verified domain is required by the provider; the shared onboarding domain is refused.' },
  { name: 'ADMIN_NOTIFY_EMAIL', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Where new host applications are announced.' },
  { name: 'CLOUDINARY_CLOUD_NAME', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Enables in-browser image upload. Hosts paste a URL without it.' },
  { name: 'CLOUDINARY_UPLOAD_PRESET', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Unsigned upload preset. Never the API secret.' },
  { name: 'MEDIA_ORIGIN_ALLOWLIST', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Extra image origins permitted by the CSP and the URL validators.' },
  { name: 'SENTRY_DSN', kind: KIND.OPTIONAL, exposure: EXPOSURE.SECRET,
    purpose: 'Error reporting. Without it, errors reach the platform log only.' },
  { name: 'GA_MEASUREMENT_ID', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Analytics. Never loaded on account, claim, admin or owner pages.' },
  { name: 'DEPLOYMENT_STATE', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'development | staging | private_beta | public_launch. See section below.' },
  { name: 'EMAIL_DELIVERY_ENABLED', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Temporary email maintenance mode. Defaults ON; refused at public launch.' },
  { name: 'NOTIFICATION_FAILURE_THRESHOLD', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Terminally failed notifications in 24h before readiness reports degraded.' },
  { name: 'MAINTENANCE_BATCH_LIMIT', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'Upper bound on rows a maintenance job touches per run.' },
  { name: 'SHUTDOWN_TIMEOUT_MS', kind: KIND.OPTIONAL, exposure: EXPOSURE.PUBLIC,
    purpose: 'How long a graceful shutdown may take before exiting non-zero.' },
  { name: 'TEST_DATABASE_URL', kind: KIND.OPTIONAL, exposure: EXPOSURE.SECRET,
    purpose: 'The isolated test database. Never read by the running application.' },
  { name: 'ALLOW_REMOTE_TEST_DB', kind: KIND.FORBIDDEN_IN_TESTS, exposure: EXPOSURE.PUBLIC,
    purpose: 'Opt-in for a non-local test database. Deliberately awkward.' },
];

const BY_NAME = new Map(VARIABLES.map((v) => [v.name, v]));

// ---------------------------------------------------------------------------
// Deployment state
// ---------------------------------------------------------------------------
//
// Technical deployment and public launch are different decisions and this
// separates them. A staging environment is allowed to run with draft policies —
// that is what it is for — but it has to say so, and nothing may describe it as
// approved or production-ready.
//
// `public_launch` is the only state that asserts the legal work is done, and it
// is deliberately unreachable today: the policy blockers alone refuse it. It is
// never set in a committed file.
const DEPLOYMENT_STATES = ['development', 'staging', 'private_beta', 'public_launch'];

function deploymentState() {
  const raw = String(process.env.DEPLOYMENT_STATE || '').trim().toLowerCase();
  if (DEPLOYMENT_STATES.includes(raw)) return raw;
  // No inference from NODE_ENV. A production process with no declared state is
  // a private beta, which is the truthful default for this platform today —
  // never a public launch by omission.
  return process.env.NODE_ENV === 'production' ? 'private_beta' : 'development';
}

function isPublicLaunch() {
  return deploymentState() === 'public_launch';
}

// What a staging or private-beta deployment must say about itself. Returned so
// a banner or a response header can carry it, rather than being invented at
// each call site.
function stateDisclosure() {
  const state = deploymentState();
  if (state === 'public_launch') return null;
  return {
    state,
    legally_approved: false,
    disclosure:
      'This deployment is not a public launch. The Terms of Service and Privacy Policy are drafts with no effective date, nothing has been reviewed by qualified UAE counsel, and this environment must not be described as approved or production-ready.',
  };
}

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

// Anything that looks like it was copied out of an example file. Matched
// against the VALUE, but only ever reported as "looks like a placeholder" —
// the value itself never leaves this function.
const PLACEHOLDER_SHAPES = [
  /^change[-_ ]?(this|me)/i,
  /^your[-_ ]?/i,
  /^(secret|password|changeme|placeholder|example|sample|todo|xxx+|foo|bar)$/i,
  /^<.*>$/,
  /^\.\.\.+$/,
  /example\.com$/i,
  /^sk_test_/,
  /^whsec_test_/,
];

function looksLikePlaceholder(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  return PLACEHOLDER_SHAPES.some((pattern) => pattern.test(trimmed));
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

// Returns { ok, problems: [{ variable, message, severity }], warnings, state }.
// Never throws for a configuration problem — the caller decides what a problem
// means, because a maintenance job and a web process do not want the same
// answer. Nothing here reads a value into its output.
function validate({ env = process.env, production = isProduction() } = {}) {
  const problems = [];
  const warnings = [];

  const fail = (variable, message) => problems.push({ variable, message });
  const warn = (variable, message) => warnings.push({ variable, message });

  const present = (name) => Boolean(String(env[name] || '').trim());

  // --- always required ----------------------------------------------------
  if (!present('DATABASE_URL')) {
    fail('DATABASE_URL', 'is not set. The application cannot reach its database.');
  }

  // --- secrets ------------------------------------------------------------
  // Fatal in production, a warning elsewhere — the same split the startup
  // functions used before this file existed.
  //
  // Not pedantry: the test suite deliberately uses a secret that matches the
  // placeholder pattern, precisely so a suite value can never be mistaken for a
  // real one (see testEnv.js). Treating that as fatal everywhere would make the
  // safety measure fail the thing it protects.
  sessions.assertSessionSecret().forEach((message) => {
    // The session module already phrases these as name-only.
    const detail = message.replace(/^SESSION_SECRET\s*/, '').trim() || message;
    if (production) fail('SESSION_SECRET', detail);
    else warn('SESSION_SECRET', detail);
  });

  sessions.assertCookieSecurity().forEach((message) => fail('COOKIE_SECURE', message));

  // --- production-only ----------------------------------------------------
  if (production) {
    if (!present('APP_URL')) {
      fail('APP_URL', 'is not set. Email links would point at localhost.');
    } else if (!/^https:\/\//i.test(env.APP_URL)) {
      fail('APP_URL', 'must be an https:// URL in production.');
    } else if (looksLikePlaceholder(env.APP_URL)) {
      fail('APP_URL', 'looks like a placeholder or example value.');
    }

    if (!present('TRUSTED_PROXY_HOPS')) {
      warn(
        'TRUSTED_PROXY_HOPS',
        'is not set. Behind Render this must be 1; the default of 0 makes every rate limit see the proxy rather than the client.'
      );
    }

    if (String(env.CLAIM_DEV_LOG_LINKS || '').trim().toLowerCase() === 'true') {
      fail(
        'CLAIM_DEV_LOG_LINKS',
        'must never be enabled in production: it prints single-use claim links to the log.'
      );
    }

    // Email is REQUIRED in production. It was optional, with the consequence
    // written down — which was not good enough: verification, password
    // recovery, claim invitations, email-change verification and the
    // old-address security warning are core workflows, and a process that
    // starts without them and reports itself healthy is lying.
    //
    // `private_beta` does not exempt it. A beta with real accounts in it is a
    // deployment where somebody will need to recover a password.
    if (!present('RESEND_API_KEY')) {
      fail(
        'RESEND_API_KEY',
        'is not set. Email verification, password recovery, claim invitations, email-change verification and the old-address security warning cannot be delivered, and each is a core workflow. Set it, or set EMAIL_DELIVERY_ENABLED=false to run a deliberate, temporary maintenance mode in which those actions refuse with a 503 instead of creating unusable state.'
      );
    }
    // Shape only. No provider call is made here or anywhere at startup: that
    // would make every boot depend on somebody else's uptime.
    emailDelivery.senderProblems().forEach((problem) => fail('EMAIL_FROM', problem));

    if (!present('SENTRY_DSN')) {
      warn('SENTRY_DSN', 'is not set. Errors reach the platform log only; nothing alerts.');
    }
  }

  // --- integrity ----------------------------------------------------------
  try {
    riskSignals.assertSignalSecret();
  } catch (err) {
    const message = String(err.message || '');
    if (production) fail('INTEGRITY_SIGNAL_SECRET', message);
    else warn('INTEGRITY_SIGNAL_SECRET', message);
  }

  try {
    resolveTrustProxy();
  } catch (err) {
    fail('TRUSTED_PROXY_HOPS', String(err.message || ''));
  }

  // --- claims -------------------------------------------------------------
  if (areClaimsEnabled() && !claimCrypto.isConfigured()) {
    const message =
      'is missing or invalid while CLAIMS_ENABLED is on. Winner delivery details are encrypted with it, so claims cannot be completed. Generate one with: node -e "console.log(\'v1:\' + require(\'crypto\').randomBytes(32).toString(\'base64\'))"';
    if (production) fail('CLAIM_ENCRYPTION_KEY', message);
    else warn('CLAIM_ENCRYPTION_KEY', message);
  }

  // --- payments -----------------------------------------------------------
  if (isAdsCheckoutEnabled()) {
    ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].forEach((name) => {
      if (!present(name)) {
        fail(name, 'is required while ADS_CHECKOUT_ENABLED is on. Customers could be charged for bookings nothing would mark as paid.');
      } else if (looksLikePlaceholder(env[name])) {
        fail(name, 'looks like a placeholder or a test-mode value.');
      }
    });
  } else {
    // A disabled feature demands nothing — but a key sitting in the environment
    // for a feature that is off is worth saying out loud.
    ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].forEach((name) => {
      if (present(name)) {
        warn(name, 'is set while ADS_CHECKOUT_ENABLED is off. It is unused.');
      }
    });
  }

  // --- placeholder sweep over every secret --------------------------------
  VARIABLES.filter((v) => v.exposure === EXPOSURE.SECRET).forEach((v) => {
    if (present(v.name) && looksLikePlaceholder(env[v.name])) {
      const message = 'looks like a placeholder or example value.';
      if (production) fail(v.name, message);
      else warn(v.name, message);
    }
  });

  // --- ranges -------------------------------------------------------------
  const range = (name, min, max) => {
    if (!present(name)) return;
    const value = Number(env[name]);
    if (!Number.isFinite(value) || value < min || value > max) {
      fail(name, `must be a number between ${min} and ${max}.`);
    }
  };
  range('SESSION_TTL_HOURS', 1, 24 * 90);
  range('SESSION_ROTATE_AFTER_MINUTES', 1, 60 * 24 * 30);
  range('CLAIM_TOKEN_TTL_HOURS', 1, 24 * 30);
  range('CLAIM_DELIVERY_RETENTION_DAYS', 1, 3650);
  range('INTEGRITY_SIGNAL_RETENTION_DAYS', 1, 3650);
  range('CLAIM_MAINTENANCE_INTERVAL_MINUTES', 1, 60 * 24);
  range('MAINTENANCE_BATCH_LIMIT', 1, 100000);
  range('SHUTDOWN_TIMEOUT_MS', 1000, 300000);
  range('TRUSTED_PROXY_HOPS', 0, 10);

  // --- contradictions -----------------------------------------------------
  if (production && String(env.DATABASE_URL || '').includes('test')) {
    fail('DATABASE_URL', 'names a database containing "test" while NODE_ENV=production. Refusing: production must not run against a test database.');
  }
  if (production && String(env.DATABASE_SSL || '').trim().toLowerCase() === 'false') {
    fail('DATABASE_SSL', 'is disabled in production. The connection would be unencrypted.');
  }

  // --- email maintenance mode ---------------------------------------------
  //
  // Explicit and temporary. Reported as a WARNING rather than a problem so the
  // process can run — that is the point of the mode — but loudly, because a
  // deployment silently not sending email is the failure this whole section
  // exists to prevent.
  if (!emailDelivery.isDeliveryEnabled()) {
    warn(
      'EMAIL_DELIVERY_ENABLED',
      'is off. Signup verification, resend verification, password reset, email change and new claim invitations will refuse with 503 rather than create state that cannot be completed. Existing signed-in sessions are unaffected. This is a temporary maintenance mode and must not be left on.'
    );
  }

  // --- launch state -------------------------------------------------------
  const state = deploymentState();
  if (state === 'public_launch') {
    launchBlockers().forEach((blocker) => fail('DEPLOYMENT_STATE', blocker));
  }

  return { ok: problems.length === 0, problems, warnings, state, production };
}

// What stands between here and being able to say this platform is publicly
// launched. Every one of these is a fact about the codebase, checked rather
// than asserted.
function launchBlockers() {
  const blockers = [];

  Object.values(policies.POLICIES).forEach((policy) => {
    if (policy.status !== policies.POLICY_STATUS.EFFECTIVE) {
      blockers.push(
        `cannot be public_launch: the ${policy.id} policy is "${policy.status}", not effective.`
      );
    }
    if (!policy.effectiveDate) {
      blockers.push(`cannot be public_launch: the ${policy.id} policy has no effective date.`);
    }
    (policy.blockers || []).forEach((reason) => {
      blockers.push(`cannot be public_launch: ${policy.id} policy blocker outstanding — ${reason}.`);
    });
  });

  if (isAdsCheckoutEnabled()) {
    ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].forEach((name) => {
      if (!String(process.env[name] || '').trim()) {
        blockers.push(`cannot be public_launch: checkout is enabled without ${name}.`);
      }
    });
  }

  if (areClaimsEnabled() && !claimCrypto.isConfigured()) {
    blockers.push('cannot be public_launch: claims are enabled but claim encryption is unavailable.');
  }

  // A public launch with no working email is a platform where nobody can verify
  // an address or recover an account.
  if (!emailDelivery.isProviderConfigured()) {
    blockers.push('cannot be public_launch: no email provider is configured.');
  }
  emailDelivery.senderProblems().forEach((problem) => {
    blockers.push(`cannot be public_launch: EMAIL_FROM ${problem}`);
  });
  if (!emailDelivery.isDeliveryEnabled()) {
    blockers.push(
      'cannot be public_launch: EMAIL_DELIVERY_ENABLED is off. The email maintenance mode is temporary and is never a launch state.'
    );
  }

  return blockers;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// One string, name-only. Used by the startup path and by the readiness check's
// internal reporting — never by a public response.
function describe(result) {
  const lines = [];
  if (result.problems.length) {
    lines.push('Configuration problems (the process must not serve traffic):');
    result.problems.forEach((p) => lines.push(`  - ${p.variable} ${p.message}`));
  }
  if (result.warnings.length) {
    lines.push('Configuration warnings (the process will run, degraded):');
    result.warnings.forEach((p) => lines.push(`  - ${p.variable} ${p.message}`));
  }
  return lines.join('\n');
}

// Called at startup. Refuses to continue in production; warns elsewhere, so a
// developer can run the site without a Stripe account.
function assertStartupConfiguration({ exit = (code) => process.exit(code), log = console } = {}) {
  const result = validate();

  if (result.warnings.length) log.error(describe({ problems: [], warnings: result.warnings }));

  if (result.ok) return result;

  const message = describe({ problems: result.problems, warnings: [] });
  if (result.production) {
    log.error(`${message}\nRefusing to start.`);
    exit(1);
    return result;
  }
  log.error(`WARNING: ${message}`);
  return result;
}

module.exports = {
  KIND,
  EXPOSURE,
  VARIABLES,
  BY_NAME,
  DEPLOYMENT_STATES,
  deploymentState,
  isPublicLaunch,
  stateDisclosure,
  launchBlockers,
  looksLikePlaceholder,
  isProduction,
  validate,
  describe,
  assertStartupConfiguration,
};
