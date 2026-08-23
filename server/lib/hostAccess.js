// Who may host a giveaway — decided in exactly one place.
//
// Before this, the answer was spread across the routes that needed it, and it
// was the wrong answer: POST /api/giveaways checked users.email_verified and
// nothing else, so any address capable of receiving one email could publish
// unlimited prize draws to the public. The draw endpoint checked ownership but
// not whether the owner still had access. The host dashboard checked only that
// somebody was signed in.
//
// Everything host-only now goes through requireHostAccess() below. The status
// is read from the database on every request: it is never in the JWT, which
// lives for 30 days and would otherwise keep asserting "approved" for a month
// after an account was suspended.
//
// Two rules that are easy to lose and are tested explicitly:
//   * Ownership is separate from approval. Being an approved host lets you
//     operate YOUR giveaways. It has never let anyone touch another host's, and
//     the per-route ownership checks stay exactly where they were.
//   * Administrators are exempt from the status gate, deliberately and only via
//     users.is_admin read fresh from the database. The site owner must not be
//     able to lock themselves out of their own platform.

const { randomUUID } = require('node:crypto');
const { pool } = require('../db');
const rescue = require('./claimRescue');

const HOST_STATUS = {
  NOT_REQUESTED: 'not_requested',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
};

const HOST_STATUSES = Object.values(HOST_STATUS);

// What a status can be changed to, and what that means. Kept as data so the
// admin route validates against the same table the UI describes.
const ADMIN_SETTABLE = new Set([
  HOST_STATUS.APPROVED,
  HOST_STATUS.REJECTED,
  HOST_STATUS.SUSPENDED,
]);

// One message and one machine-readable code per way of not being a host, so
// the UI can say which of the four applies instead of showing the same dead end
// to somebody who never asked and somebody who was turned down.
const DENIALS = {
  [HOST_STATUS.NOT_REQUESTED]: {
    code: 'HOST_APPROVAL_REQUIRED',
    message:
      'Hosting is currently a closed beta. Apply to host and an administrator will review your request.',
  },
  [HOST_STATUS.PENDING]: {
    code: 'HOST_APPROVAL_PENDING',
    message:
      'Your application to host is with an administrator. We have not set a review deadline, so we will not promise you one.',
  },
  [HOST_STATUS.REJECTED]: {
    code: 'HOST_APPROVAL_REJECTED',
    message: 'This account has not been approved to host giveaways.',
  },
  [HOST_STATUS.SUSPENDED]: {
    code: 'HOST_ACCESS_SUSPENDED',
    message: 'Hosting access for this account is suspended. Existing listings and records are unchanged.',
  },
};

const UNVERIFIED_EMAIL_DENIAL = {
  code: 'EMAIL_VERIFICATION_REQUIRED',
  message: 'Please verify your email before hosting a giveaway.',
};

const UNKNOWN_ACCOUNT_DENIAL = {
  code: 'ACCOUNT_NOT_FOUND',
  message: 'Your session has expired. Sign in again.',
};

function isValidStatus(status) {
  return HOST_STATUSES.includes(status);
}

// The whole authorization answer for one account, as data. Routes and the
// middleware both use this, and so does the UI endpoint — there is one
// computation of "can this person host", not one per caller.
//
// An unrecognised status fails closed. If a future migration invents a value
// this module has never seen, the result is no access rather than access by
// accident.
async function resolveHostAccess(client, userId) {
  if (!userId) {
    return { userId: null, exists: false, isAdmin: false, status: null, emailVerified: false, canHost: false, denial: UNKNOWN_ACCOUNT_DENIAL };
  }

  const result = await (client || pool).query(
    `SELECT id, is_admin, email_verified, host_status, host_status_changed_at,
            host_status_reason
       FROM users WHERE id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user) {
    return { userId, exists: false, isAdmin: false, status: null, emailVerified: false, canHost: false, denial: UNKNOWN_ACCOUNT_DENIAL };
  }

  const base = {
    userId,
    exists: true,
    isAdmin: Boolean(user.is_admin),
    status: user.host_status,
    statusChangedAt: user.host_status_changed_at,
    // The reason is shown back to the account it is about, and to admins. It
    // is written by an administrator, so it is theirs to stand behind.
    statusReason: user.host_status_reason,
    emailVerified: Boolean(user.email_verified),
  };

  // The explicit administrator exemption. Read from the database on this
  // request, not from a token and not from anything the browser sent.
  if (base.isAdmin) {
    return { ...base, canHost: true, exemptAsAdmin: true, denial: null };
  }

  if (!base.emailVerified) {
    return { ...base, canHost: false, exemptAsAdmin: false, denial: UNVERIFIED_EMAIL_DENIAL };
  }

  if (base.status === HOST_STATUS.APPROVED) {
    return { ...base, canHost: true, exemptAsAdmin: false, denial: null };
  }

  return {
    ...base,
    canHost: false,
    exemptAsAdmin: false,
    denial: DENIALS[base.status] || DENIALS[HOST_STATUS.NOT_REQUESTED],
  };
}

// The middleware every host-only route mounts. Assumes requireAuth ran first
// and set req.userId; on its own it would 401 rather than let anyone through.
//
// Leaves req.hostAccess behind so a route that needs the detail (the dashboard,
// for instance) does not query for it a second time.
async function requireHostAccess(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Sign in to continue.' });
    }
    const access = await resolveHostAccess(pool, req.userId);
    req.hostAccess = access;

    if (access.canHost) return next();

    if (!access.exists) {
      return res.status(401).json({ error: access.denial.message, code: access.denial.code });
    }
    return res.status(403).json({
      error: access.denial.message,
      code: access.denial.code,
      host_status: access.status,
    });
  } catch (err) {
    console.error('Host access check failed:', err.message);
    // Fails closed. An unreadable status is not an approved one.
    return res.status(503).json({
      error: 'We could not confirm your hosting access just now. Please try again shortly.',
      code: 'HOST_ACCESS_UNAVAILABLE',
    });
  }
}

// Convenience for code paths that are already inside a transaction and have a
// client in hand (claims role resolution). Returns a boolean, and the same
// answer requireHostAccess would give.
async function canHost(client, userId) {
  const access = await resolveHostAccess(client, userId);
  return access.canHost;
}

// Records a change of host access. The only way users.host_status moves.
//
// Every call writes an event: the previous status, the new one, who changed it,
// why, and whether a human or a migration did it. Returns null when the status
// is already what was asked for, so a double-clicked approve button does not
// write a second event claiming a change that did not happen.
//
// Suspension also opens the claim rescue queue, and restoring access closes it,
// both in this same transaction. That coupling is the point: there is no window
// in which a host has been suspended but their winners are not yet anybody's
// responsibility, and no way to suspend a host while forgetting to.
async function setHostStatus(client, { userId, toStatus, reason, changedBy, source, applicationId = null }) {
  if (!isValidStatus(toStatus)) {
    throw new Error(`Unknown host status: ${toStatus}`);
  }

  // Locks the account row for the duration, so two administrators deciding at
  // the same instant produce two events in a defined order rather than one
  // event and one lost write.
  const current = await client.query('SELECT host_status FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!current.rows[0]) {
    throw new Error('Account not found');
  }
  const fromStatus = current.rows[0].host_status;
  if (fromStatus === toStatus) {
    return null;
  }

  await client.query(
    `UPDATE users
        SET host_status = $1,
            host_status_changed_at = NOW(),
            host_status_reason = $2,
            host_status_changed_by = $3
      WHERE id = $4`,
    [toStatus, reason || null, changedBy || null, userId]
  );

  const eventId = randomUUID();
  await client.query(
    `INSERT INTO host_status_events
       (id, user_id, from_status, to_status, reason, source, changed_by, application_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [eventId, userId, fromStatus, toStatus, reason || null, source, changedBy || null, applicationId]
  );

  let rescuesOpened = 0;
  let rescuesClosed = 0;
  if (toStatus === HOST_STATUS.SUSPENDED) {
    rescuesOpened = await rescue.openRescuesForHost(client, {
      hostUserId: userId,
      reason: reason || 'Host access suspended.',
      openedBy: changedBy,
    });
  } else if (toStatus === HOST_STATUS.APPROVED) {
    // The host is back, so their deliveries are theirs again.
    rescuesClosed = await rescue.closeRescuesForHost(client, {
      hostUserId: userId,
      reason: reason ? `Host access restored: ${reason}` : 'Host access restored.',
      closedBy: changedBy,
    });
  }

  return { id: eventId, fromStatus, toStatus, rescuesOpened, rescuesClosed };
}

module.exports = {
  HOST_STATUS,
  HOST_STATUSES,
  ADMIN_SETTABLE,
  DENIALS,
  isValidStatus,
  resolveHostAccess,
  requireHostAccess,
  canHost,
  setHostStatus,
};
