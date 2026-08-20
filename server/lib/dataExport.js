// A copy of your own data, for you.
//
// The interesting part of an export is not what it contains — it is what it must
// never contain, and why each exclusion is deliberate rather than an oversight.
//
// EXCLUDED, always:
//
//   password_hash            it is a credential, and a copy of it is an offline
//                            cracking target handed to whoever gets the file
//   session and CSRF values  live credentials
//   verification, reset and  live credentials, and single-use ones at that
//     claim tokens
//   encryption keys          obviously
//   other people's data      a host's entrant list is not the host's data about
//                            themselves; a winner's address is not the host's
//   administrator notes      internal reasoning about a person, which may name
//                            other accounts and unproven concerns
//   risk-signal hashes and   the detection method. Handing somebody the hash of
//     detection detail       their own network prefix tells them nothing useful
//                            and tells an attacker how the scheme works
//   Stripe secrets and       payment-processor internals; the booking facts are
//     full webhook payloads  included, the plumbing is not
//   delivery details of      addresses belong to the person who gave them, and
//     other people           reach the host only through the claim workflow
//
// JSON only. No CSV, deliberately: a CSV of user-controlled text is a formula
// injection waiting for a spreadsheet to open it, and the mitigation (prefixing
// cells) is a second thing to get right for no benefit here.
const VERSION = '2026-08-export-1';

// One place to state what is not in the file, so the person reading it knows
// what to ask for rather than assuming they have everything.
const EXCLUSIONS = [
  'Passwords, and the hash of your password.',
  'Session cookies, CSRF tokens, email verification links, password reset links and prize claim links. These are credentials, not records.',
  'Any data belonging to another person — including entrants in giveaways you host, and delivery addresses other than your own.',
  'Internal administrator notes about any decision.',
  'The technical detection signals used to spot possible entry abuse, and any hashed values derived from them.',
  'Payment processor internals. Your bookings are included; Stripe identifiers and webhook payloads are not.',
];

const DELIVERY_NOTE =
  'Delivery details you provided for a prize are encrypted at rest and are not included in this file. You can see them in the claim itself while it is open, and you can ask for them through an access request.';

// Runs thunks one after another. Deliberately not Promise.all — see the call
// site.
async function sequentially(thunks) {
  const out = [];
  for (const thunk of thunks) {
    // eslint-disable-next-line no-await-in-loop -- one client, one query at a time
    out.push(await thunk());
  }
  return out;
}

async function buildExport(client, userId) {
  const generatedAt = new Date().toISOString();

  // Explicit column lists everywhere. `SELECT *` on a table that later gains a
  // token column is how a credential ends up in an export, and the diff that
  // does it looks like nothing.
  const account = await client.query(
    `SELECT id, name, email, email_verified, created_at,
            is_admin, is_verified_business, host_status, host_status_changed_at,
            account_status, age_attestation_status, age_attestation_version, age_attested_at
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!account.rows[0]) return null;

  // Sequential, not Promise.all. These share one client, and a `pg` client
  // cannot run two queries at once — it queues them and warns that it will stop
  // doing so. Eight small indexed reads are not worth a concurrency bug.
  const [entries, hosted, applications, claims, ads, acceptances, requests, emailChanges] =
    await sequentially([
      () => client.query(
        `SELECT e.id, e.giveaway_id, g.title AS giveaway_title, e.ticket_number,
                e.created_at AS entered_at, e.integrity_status, e.integrity_reason_code
           FROM entries e JOIN giveaways g ON g.id = e.giveaway_id
          WHERE e.user_id = $1 ORDER BY e.created_at`,
        [userId]
      ),
      () => client.query(
        `SELECT id, title, description, prize_description, funded_by, estimated_value_aed,
                entry_deadline, status, created_at, prize_delivered, prize_delivered_at
           FROM giveaways WHERE host_id = $1 ORDER BY created_at`,
        [userId]
      ),
      () => client.query(
        `SELECT id, applicant_type, full_name, business_name, trade_license,
                contact_email, contact_phone, message, status, created_at, decided_at
           FROM host_applications WHERE user_id = $1 ORDER BY created_at`,
        [userId]
      ),
      // Claims where this person is the winner, or the host of the giveaway.
      // Coarse status and timing only — no ciphertext, no key version, no token.
      () => client.query(
        `SELECT c.id, c.giveaway_id, g.title AS giveaway_title, c.status,
                c.claimed_at, c.consented_at, c.consent_version, c.delivery_erased_at,
                (c.winner_user_id = $1) AS you_are_the_winner,
                (g.host_id = $1) AS you_are_the_host
           FROM prize_claims c JOIN giveaways g ON g.id = c.giveaway_id
          WHERE c.winner_user_id = $1 OR g.host_id = $1
          ORDER BY c.created_at`,
        [userId]
      ),
      // Advertising bookings are attached to an email address rather than an
      // account in this schema, so they are matched on the account's address.
      () => client.query(
        `SELECT a.id, a.business_name, a.target_url, a.media_type, a.starts_at, a.ends_at,
                a.amount_aed, a.payment_status, a.created_at
           FROM ads a
           JOIN users u ON lower(u.email) = lower(a.contact_email)
          WHERE u.id = $1 ORDER BY a.created_at`,
        [userId]
      ),
      () => client.query(
        `SELECT policy_id, policy_version, policy_effective_date, acceptance_kind, accepted_at
           FROM policy_acceptances WHERE user_id = $1 ORDER BY accepted_at`,
        [userId]
      ),
      () => client.query(
        `SELECT reference, request_type, status, outcome_code, user_message, created_at, closed_at
           FROM privacy_requests WHERE user_id = $1 ORDER BY created_at`,
        [userId]
      ),
      // The fact that a change happened, never the token. `token_hash` is not
      // selected at all rather than selected and stripped later.
      () => client.query(
        `SELECT new_email, previous_email, status, created_at, completed_at, cancelled_reason
           FROM email_change_requests WHERE user_id = $1 ORDER BY created_at`,
        [userId]
      ),
    ]);

  const user = account.rows[0];

  return {
    export_version: VERSION,
    generated_at: generatedAt,
    about_this_file:
      'This is a copy of the data this platform holds about your own account. It is generated on request and is not stored anywhere after it is sent to you.',
    not_included: EXCLUSIONS,
    delivery_details_note: DELIVERY_NOTE,

    account: {
      account_id: user.id,
      name: user.name,
      email: user.email,
      email_verified: user.email_verified,
      created_at: user.created_at,
      account_status: user.account_status,
      host_status: user.host_status,
      host_status_changed_at: user.host_status_changed_at,
      verified_business: user.is_verified_business,
      administrator: user.is_admin,
    },

    eligibility_attestation: {
      status: user.age_attestation_status,
      version: user.age_attestation_version,
      attested_at: user.age_attested_at,
      note: 'Self-declaration that you are 18 or older. No date of birth or identity document is collected.',
    },

    policy_acceptances: acceptances.rows,
    entries: entries.rows.map((row) => ({
      entry_id: row.id,
      giveaway_id: row.giveaway_id,
      giveaway_title: row.giveaway_title,
      ticket_number: row.ticket_number,
      entered_at: row.entered_at,
      // The coarse outcome and the code that chose your explanation. Not the
      // administrator's notes, and not why it was looked at.
      integrity_outcome: row.integrity_status,
      explanation_code: row.integrity_reason_code,
    })),
    giveaways_you_host: hosted.rows,
    host_applications: applications.rows,
    prize_claims: claims.rows,
    advertising: ads.rows,
    privacy_requests: requests.rows,
    email_change_history: emailChanges.rows,
  };
}

module.exports = { VERSION, EXCLUSIONS, DELIVERY_NOTE, buildExport };
