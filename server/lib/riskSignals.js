// Risk signals — indicators for a human, never a verdict.
//
// The temptation with abuse work is to build something that acts. This does not
// act. Nothing in this file changes an entry's status, blocks a request, or
// bans an account; the only thing it can do is put a note next to an entry so
// that an administrator has something to look at. Every automatic decision this
// module could make would be a decision made about a real person on evidence
// too weak to explain to them.
//
// What it deliberately does not do, and must not be extended to do:
//
//   - No browser or device fingerprinting.
//   - No identity documents, no facial recognition, no biometrics.
//   - No third-party people-search, data-broker or reputation services.
//   - No cross-site tracking, and no permanent or hidden identifier of any kind.
//
// The one network signal it does keep is built to forget. The raw address is
// never stored. It is normalised to a coarse prefix (an IPv4 /24, an IPv6 /48),
// then HMAC'd with a dedicated secret *and the current retention window*, so:
//
//   - the stored value cannot be reversed to an address;
//   - two rows only match if they are in the same window, so linkage does not
//     survive the retention period even if the rows do;
//   - rotating the secret breaks linkage immediately and everywhere.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const SIGNALS = {
  // Several accounts, all created recently, entering from the same coarse
  // network prefix inside the same window. The honest reading is "a household,
  // an office, a campus, a mobile carrier NAT, or somebody with several
  // accounts" — which is exactly why it is a prompt to look and not a rule.
  SHARED_NETWORK_NEW_ACCOUNTS: 'shared_network_new_accounts',
  // Entries arriving from one coarse prefix faster than a person clicking.
  RAPID_ENTRY_VELOCITY: 'rapid_entry_velocity',
};

const SEVERITY = { INFO: 'info', REVIEW: 'review' };

// Deliberately loose. A signal that fires on two housemates is a signal that
// trains administrators to ignore it.
const SHARED_NETWORK_ACCOUNT_THRESHOLD = 3;
const NEW_ACCOUNT_HOURS = 48;
const VELOCITY_THRESHOLD = 5;
const VELOCITY_MINUTES = 10;

function retentionDays() {
  const raw = Number(process.env.INTEGRITY_SIGNAL_RETENTION_DAYS);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 90) return Math.floor(raw);
  return 30;
}

// Startup validation, mirroring the session-secret rules. A weak or missing
// secret here would make the stored hashes guessable — an attacker who knows
// the scheme could confirm "was this address in your data" by trying addresses,
// which is precisely the property the hash is supposed to remove.
const PLACEHOLDER_PATTERNS = [
  /^changeme/i, /^change_me/i, /^placeholder/i, /^secret$/i, /^your[-_ ]?secret/i,
  /^replace/i, /^example/i, /^test$/i, /^dev$/i, /^xxx+$/i,
];

function assertSignalSecret({ production = process.env.NODE_ENV === 'production' } = {}) {
  const secret = process.env.INTEGRITY_SIGNAL_SECRET;

  if (!production) return { configured: Boolean(secret) };

  // Only the variable name ever appears in these messages.
  if (!secret) {
    throw new Error(
      'INTEGRITY_SIGNAL_SECRET is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (secret.length < 32) {
    throw new Error('INTEGRITY_SIGNAL_SECRET is too short — use at least 32 characters.');
  }
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(secret))) {
    throw new Error('INTEGRITY_SIGNAL_SECRET looks like a placeholder value.');
  }
  if (new Set(secret).size < 8) {
    throw new Error('INTEGRITY_SIGNAL_SECRET has too little variety to be random.');
  }
  for (const other of ['SESSION_SECRET', 'CLAIM_ENCRYPTION_KEY', 'DATABASE_URL', 'STRIPE_SECRET_KEY']) {
    if (process.env[other] && process.env[other] === secret) {
      throw new Error(`INTEGRITY_SIGNAL_SECRET must not be the same value as ${other}.`);
    }
  }
  return { configured: true };
}

function secretKey() {
  const secret = process.env.INTEGRITY_SIGNAL_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    // Unreachable if index.js called assertSignalSecret, which it does. Present
    // so a future caller that skipped it fails rather than hashing with a
    // constant.
    throw new Error('INTEGRITY_SIGNAL_SECRET is not set.');
  }
  // Development and tests: a per-process value, so nothing links across runs and
  // no default secret can be shipped by accident.
  if (!secretKey._ephemeral) secretKey._ephemeral = crypto.randomBytes(32).toString('hex');
  return secretKey._ephemeral;
}

// Which retention window we are in. Rows from different windows hash the same
// address differently, so an old row cannot be joined to a new one.
function currentWindowId(now = new Date()) {
  const days = retentionDays();
  return String(Math.floor(now.getTime() / (days * 86400000)));
}

// Coarse enough to describe "somewhere on this network" and not much more.
// Returns null for anything unparseable, and for loopback and link-local
// addresses, which say nothing about anybody.
function normaliseAddress(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value) return null;

  // Express hands back IPv4-mapped IPv6 for IPv4 clients behind some stacks.
  if (value.startsWith('::ffff:')) value = value.slice(7);

  if (/^[0-9.]+$/.test(value)) {
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some((p) => p === '' || Number(p) > 255)) return null;
    if (parts[0] === '127' || value === '0.0.0.0') return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }

  if (value.includes(':')) {
    if (value === '::1' || value === '::') return null;
    // Expand only as far as the first three groups — a /48, the smallest block
    // typically assigned to one subscriber.
    const groups = value.split('::')[0].split(':').filter(Boolean).slice(0, 3);
    if (!groups.length) return null;
    while (groups.length < 3) groups.push('0');
    return `${groups.join(':')}::/48`;
  }

  return null;
}

// The only value that is ever stored. One-way, keyed, and window-scoped.
function networkKey(raw, { now = new Date() } = {}) {
  const normalised = normaliseAddress(raw);
  if (!normalised) return null;
  const windowId = currentWindowId(now);
  const hmac = crypto
    .createHmac('sha256', secretKey())
    .update(`entry-network:${windowId}:${normalised}`)
    .digest('hex');
  return { hash: hmac, windowId };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

// Called on the entry path, inside the entry's transaction. Everything it can
// do is insert rows into entry_risk_signals. It returns what it recorded so the
// caller can log a count — never the hash, and never an address.
async function recordEntrySignals(client, { entryId, giveawayId, userId, ip, now = new Date() }) {
  const key = networkKey(ip, { now });
  const expiresAt = new Date(now.getTime() + retentionDays() * 86400000);
  const recorded = [];

  if (!key) return recorded;

  // How many distinct accounts, created in the last two days, have entered
  // anything from this prefix inside this window.
  const shared = await client.query(
    `SELECT COUNT(DISTINCT e.user_id)::int AS accounts
       FROM entry_risk_signals s
       JOIN entries e ON e.id = s.entry_id
       JOIN users u ON u.id = e.user_id
      WHERE s.network_hmac = $1
        AND s.window_id = $2
        AND e.user_id <> $3
        AND u.created_at > NOW() - ($4 || ' hours')::interval`,
    [key.hash, key.windowId, userId, String(NEW_ACCOUNT_HOURS)]
  );
  const otherAccounts = shared.rows[0].accounts;

  // How many entries came from this prefix in the last few minutes.
  const velocity = await client.query(
    `SELECT COUNT(*)::int AS c
       FROM entry_risk_signals
      WHERE network_hmac = $1 AND window_id = $2
        AND created_at > NOW() - ($3 || ' minutes')::interval`,
    [key.hash, key.windowId, String(VELOCITY_MINUTES)]
  );

  // The baseline row: one per entry, carrying the hash so later entries can be
  // compared against it. `info` severity — its existence is not a finding.
  const rows = [
    {
      code: 'network_observed',
      severity: SEVERITY.INFO,
      detail: { accounts_recently_seen: otherAccounts + 1 },
    },
  ];

  if (otherAccounts + 1 >= SHARED_NETWORK_ACCOUNT_THRESHOLD) {
    rows.push({
      code: SIGNALS.SHARED_NETWORK_NEW_ACCOUNTS,
      severity: SEVERITY.REVIEW,
      detail: {
        accounts: otherAccounts + 1,
        threshold: SHARED_NETWORK_ACCOUNT_THRESHOLD,
        window_hours: NEW_ACCOUNT_HOURS,
        // Stated in the row itself so nobody reading the queue later has to
        // remember it: this is a household as often as it is an attack.
        note: 'Shared networks are ordinary. Indicator only.',
      },
    });
  }

  if (velocity.rows[0].c + 1 >= VELOCITY_THRESHOLD) {
    rows.push({
      code: SIGNALS.RAPID_ENTRY_VELOCITY,
      severity: SEVERITY.REVIEW,
      detail: {
        entries: velocity.rows[0].c + 1,
        minutes: VELOCITY_MINUTES,
        note: 'Indicator only.',
      },
    });
  }

  for (const row of rows) {
    await client.query(
      `INSERT INTO entry_risk_signals
         (id, entry_id, giveaway_id, signal_code, severity, network_hmac, window_id, detail, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uuid(), entryId, giveawayId, row.code, row.severity, key.hash, key.windowId,
       JSON.stringify(row.detail), expiresAt]
    );
    recorded.push(row.code);
  }

  return recorded;
}

// Retention. Idempotent by construction: deleting rows already past their
// expiry twice deletes nothing the second time.
// Bounded when a limit is given — the scheduled job passes one. Before Phase
// 2.4A this ran only when an administrator pressed a button, which meant the
// retention window was a hope rather than a schedule.
async function purgeExpiredSignals(client, { limit = null } = {}) {
  const result = await client.query(
    `DELETE FROM entry_risk_signals
      WHERE id IN (
        SELECT id FROM entry_risk_signals WHERE expires_at <= NOW() LIMIT $1
      )`,
    [limit && limit > 0 ? Math.floor(limit) : 100000]
  );
  return result.rowCount;
}

// What an administrator sees in the queue: categories and counts, never the
// hash. The hash is not secret in the sense that it identifies anybody, but it
// is a join key across entries, and a join key in a list response is a
// correlation tool nobody asked for.
function summariseForQueue(signals) {
  const categories = [...new Set(signals.map((s) => s.signal_code))].filter(
    (code) => code !== 'network_observed'
  );
  return {
    categories,
    review_count: signals.filter((s) => s.severity === SEVERITY.REVIEW).length,
  };
}

module.exports = {
  SIGNALS,
  SEVERITY,
  SHARED_NETWORK_ACCOUNT_THRESHOLD,
  NEW_ACCOUNT_HOURS,
  VELOCITY_THRESHOLD,
  VELOCITY_MINUTES,
  retentionDays,
  assertSignalSecret,
  normaliseAddress,
  networkKey,
  currentWindowId,
  recordEntrySignals,
  purgeExpiredSignals,
  summariseForQueue,
};
