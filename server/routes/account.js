// The account centre: what a signed-in person may do about their own data.
//
// Everything here is `Cache-Control: no-store`. These responses carry an email
// address, an attestation, a request history and sometimes a whole export —
// none of which belongs in a shared cache, a proxy, or a browser's back-forward
// cache on a borrowed laptop.
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const sessions = require('../lib/sessions');
const rights = require('../lib/accountRights');
const eligibility = require('../lib/eligibility');
const policies = require('../lib/policies');
const dataExport = require('../lib/dataExport');
const outbox = require('../lib/emailChangeOutbox');
const emailDelivery = require('../lib/emailDelivery');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const router = express.Router();

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

function handleError(res, err) {
  if (err instanceof rights.RightsError) {
    return res
      .status(err.status)
      .json({ error: err.message, code: err.code, current: err.details || null });
  }
  if (err && err.code === 'AGE_ATTESTATION_REQUIRED') {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Shows only what the account is allowed to know about itself: nothing about
// other accounts, nothing about how anything is detected, no tokens.
router.get('/me', requireAuth, async (req, res) => {
  try {
    noStore(res);
    const result = await pool.query(
      `SELECT id, name, email, email_verified, created_at, host_status, account_status,
              age_attestation_status, age_attestation_version, age_attested_at
         FROM users WHERE id = $1`,
      [req.userId]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const [pending, requests, acceptances, missing] = await Promise.all([
      pool.query(
        // The address being moved to, and never the token that would move it.
        `SELECT id, new_email, created_at, expires_at FROM email_change_requests
          WHERE user_id = $1 AND status = 'pending'`,
        [req.userId]
      ),
      pool.query(
        `SELECT * FROM privacy_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.userId]
      ),
      pool.query(
        `SELECT policy_id, policy_version, policy_effective_date, acceptance_kind, accepted_at
           FROM policy_acceptances WHERE user_id = $1 ORDER BY accepted_at`,
        [req.userId]
      ),
      policies.missingAcceptances(pool, { userId: req.userId }),
    ]);

    res.json({
      account: {
        id: user.id,
        name: user.name,
        email: user.email,
        email_verified: user.email_verified,
        created_at: user.created_at,
        host_status: user.host_status,
        account_status: user.account_status,
      },
      eligibility: eligibility.selfView(user),
      // Both are reported so the page can say the truthful thing: the documents
      // are drafts, nothing has been accepted, and nothing can be.
      policies: policies.currentPolicies(),
      policy_acceptances: acceptances.rows,
      policies_outstanding: missing,
      pending_email_change: pending.rows[0] || null,
      privacy_requests: requests.rows.map(rights.requesterView),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// Correcting your own display name. Ownership is the session, never a body
// field, and the change is written to the audit trail.
router.patch('/me', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    noStore(res);
    const name = String((req.body && req.body.name) || '').trim();
    if (name.length < 1 || name.length > 100) {
      return res.status(400).json({ error: 'Enter a name between 1 and 100 characters.', code: 'NAME_INVALID' });
    }

    await client.query('BEGIN');
    const before = await client.query('SELECT name FROM users WHERE id = $1 FOR UPDATE', [req.userId]);
    if (!before.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.' });
    }
    await client.query('UPDATE users SET name = $2 WHERE id = $1', [req.userId, name]);
    // Recorded as a correction the account holder made themselves, so a later
    // "who changed this" has an answer that is not a guess. The same append-only
    // table the privacy requests use — it is the account-rights audit log, and a
    // self-service correction is one of the things it exists to record.
    await client.query(
      `INSERT INTO privacy_request_events
         (id, request_id, user_id, from_status, to_status, admin_notes, actor_user_id, actor_role)
       VALUES ($1, 'self-service', $2, 'name', 'name_corrected', $3, $2, 'user')`,
      [
        require('crypto').randomUUID(),
        req.userId,
        // Deliberately not the old or new name: the audit records that the
        // holder corrected it, and the current value is on the account itself.
        'display name corrected by the account holder',
      ]
    );
    await client.query('COMMIT');

    res.json({ name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    client.release();
  }
});

// The age attestation. Explicit, versioned, and never inferred.
router.post('/eligibility', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    noStore(res);
    await client.query('BEGIN');
    const result = await eligibility.recordAttestation(client, {
      userId: req.userId,
      confirmed: req.body && req.body.confirmed === true,
    });
    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    client.release();
  }
});

// Accepting a policy. Refuses for anything that is not genuinely effective,
// which today is everything — so this endpoint exists and always says no.
router.post('/policies/:policyId/accept', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    noStore(res);
    await client.query('BEGIN');
    const result = await policies.recordAcceptance(client, {
      userId: req.userId,
      policyId: req.params.policyId,
    });
    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof policies.PolicyNotAcceptableError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    handleError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------

// Starting a change does not change anything. It creates a pending record and
// sends two different messages to two different addresses.
router.post('/email-change', authLimiter, requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    noStore(res);

    // Before the pending change exists. A change nobody can confirm is a row
    // that blocks the next attempt (one pending change per account) and an
    // address the person believes is being moved.
    if (emailDelivery.refuseIfUndeliverable(res, { action: 'email_change' })) return;

    const { password, new_email: newEmail } = req.body || {};

    // The change and its notification are one transaction. Nothing is sent from
    // here: a delivery worker mints the token and sends the message, so a mail
    // outage leaves a durable record rather than a silent failure.
    await client.query('BEGIN');
    await rights.assertRecentPassword(client, { userId: req.userId, password });
    const started = await rights.startEmailChange(client, { userId: req.userId, newEmail });
    await client.query('COMMIT');

    // Drained immediately so the common case is fast, and deliberately not
    // awaited for its result: whether it succeeds or not, the record is already
    // committed and the retry loop owns it from here.
    outbox.drainInBackground({ limit: 5, appUrl: APP_URL });

    // No token in this response, because none exists yet — it is minted in the
    // worker, immediately before the send. And the wording says what is true:
    // delivery is pending. It does not claim an email was sent.
    res.status(202).json({
      status: 'pending',
      new_email: started.newEmail,
      expires_at: started.expiresAt,
      delivery: 'pending',
      note: 'Your account email has not changed. We are sending a confirmation link to the new address — if it does not arrive, it will be retried automatically. The change only takes effect when that link is used, and you will be signed out everywhere when it does.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    client.release();
  }
});

router.post('/email-change/cancel', requireAuth, async (req, res) => {
  try {
    noStore(res);
    const result = await pool.query(
      `UPDATE email_change_requests
          SET status = 'cancelled', cancelled_at = NOW(),
              cancelled_reason = 'cancelled by the account holder'
        WHERE user_id = $1 AND status = 'pending'
        RETURNING id`,
      [req.userId]
    );
    res.json({ cancelled: result.rowCount });
  } catch (err) {
    handleError(res, err);
  }
});

// Completing it. Deliberately unauthenticated — the person confirming may be on
// a different device, and the token is the proof. It is single-use by the
// UPDATE's own WHERE clause, so two simultaneous submissions produce one change.
router.post('/email-change/confirm', authLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    noStore(res);
    const token = req.body && req.body.token;
    if (!token) {
      return res.status(400).json({ error: 'That link is missing its token.', code: 'TOKEN_REQUIRED' });
    }

    // One transaction: the address moves, every session ends, and the warning to
    // the old address is enqueued. Either all three happen or none does.
    await client.query('BEGIN');
    const request = await rights.completeEmailChange(client, { token });
    // Every session ends, including the one that started this. The threat being
    // defended against is a stolen session moving the recovery address, and
    // leaving that session alive afterwards would defeat the whole exercise.
    await sessions.revokeAllForUser(client, request.user_id, sessions.REVOCATION.EMAIL_CHANGED);
    await client.query('COMMIT');

    // After the commit, and unawaited. A warning that fails to send must not
    // undo a change the person already verified — it stays queued and is
    // retried.
    outbox.drainInBackground({ limit: 5, appUrl: APP_URL });

    res.json({
      status: 'completed',
      note: 'Your email address has been changed and you have been signed out everywhere. Sign in again with the new address.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

router.post('/export', authLimiter, requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    // Reauthentication, because an export is the single most concentrated view
    // of an account that exists, and a live session is evidence somebody signed
    // in once rather than evidence of who is here now.
    await rights.assertRecentPassword(client, {
      userId: req.userId,
      password: req.body && req.body.password,
    });

    const payload = await dataExport.buildExport(client, req.userId);
    if (!payload) return res.status(404).json({ error: 'Account not found.' });

    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/json; charset=utf-8');
    // Attachment, and a fixed filename with no user-controlled part — a
    // filename built from a display name is a header-injection and a
    // path-traversal question nobody needs to answer.
    res.set('Content-Disposition', 'attachment; filename="naseeb-data-export.json"');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    handleError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Privacy requests
// ---------------------------------------------------------------------------

router.post('/privacy-requests', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    noStore(res);
    const { request_type: requestType, message } = req.body || {};

    await client.query('BEGIN');
    const created = await rights.createRequest(client, {
      userId: req.userId,
      requestType,
      message,
    });
    await client.query('COMMIT');

    res.status(201).json({
      request: rights.requesterView(created),
      // Said plainly and up front, not discovered later: this is a request for
      // review by a person, not an erase button.
      note:
        requestType === 'deletion'
          ? 'This is a request for review, not an immediate deletion. Nothing has been deleted. A person will look at what can be removed, what has to be kept for prize, payment or audit reasons, and will reply.'
          : 'A person will review this and reply.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    client.release();
  }
});

router.get('/privacy-requests', requireAuth, async (req, res) => {
  try {
    noStore(res);
    const result = await pool.query(
      'SELECT * FROM privacy_requests WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(result.rows.map(rights.requesterView));
  } catch (err) {
    handleError(res, err);
  }
});

// Ownership by the session, and a 404 rather than a 403 for somebody else's
// reference — whether a given reference exists is not a question this endpoint
// answers for people who do not own it.
router.get('/privacy-requests/:reference', requireAuth, async (req, res) => {
  try {
    noStore(res);
    const result = await pool.query(
      'SELECT * FROM privacy_requests WHERE reference = $1 AND user_id = $2',
      [req.params.reference, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found.' });
    res.json(rights.requesterView(result.rows[0]));
  } catch (err) {
    handleError(res, err);
  }
});

// Ending every session on this account, from the account centre.
router.post('/sessions/revoke-all', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    noStore(res);
    await client.query('BEGIN');
    await sessions.revokeAllForUser(client, req.userId, sessions.REVOCATION.LOGOUT);
    await client.query('COMMIT');
    sessions.clearSessionCookie(res);
    res.json({ status: 'signed_out_everywhere' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    client.release();
  }
});

module.exports = router;
