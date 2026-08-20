const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { requireHostAccess } = require('../lib/hostAccess');
const { validateMediaUrl, isRenderableMediaUrl } = require('../lib/mediaUrls');
const { enterLimiter } = require('../middleware/rateLimit');
const claims = require('../lib/claims');
const notifications = require('../lib/claimNotifications');
const { areClaimsEnabled } = require('../lib/featureFlags');
const emailDelivery = require('../lib/emailDelivery');
const integrity = require('../lib/entryIntegrity');
const riskSignals = require('../lib/riskSignals');
const eligibility = require('../lib/eligibility');
const lifecycle = require('../lib/giveawayLifecycle');
const prizeStandard = require('../lib/prizeStandard');
const giveawayOutbox = require('../lib/giveawayOutbox');
const appConfig = require('../lib/config');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const router = express.Router();

const MAX_LENGTHS = {
  title: 200,
  description: 5000,
  prize_description: 2000,
  funded_by: 300,
};

async function withHostAndCount(row) {
  const hostRes = await pool.query('SELECT name, is_verified_business FROM users WHERE id = $1', [
    row.host_id,
  ]);
  // Disqualified entries are excluded from every public tally, here and in the
  // three other places that count. integrity.COUNTED_SQL is shared so a fourth
  // variant cannot quietly disagree with the draw — see docs/ENTRY_INTEGRITY.md §6.
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1 AND ${integrity.COUNTED_SQL}`,
    [row.id]
  );
  // The internal record is REMOVED here, not merely omitted from a template.
  //
  // This function spreads the whole row, which was harmless when every column
  // was public. Prize governance added columns that are not: an administrator's
  // review notes, the evidence reference, who approved it, and the written
  // reason a campaign was cancelled — the last of which can name a sponsor, an
  // allegation or a legal instruction. A field added to `giveaways` in future is
  // public by default from here, so anything internal must be listed below.
  const {
    review_notes: _reviewNotes,
    prize_evidence_kind: _evidenceKind,
    prize_evidence_reference: _evidenceReference,
    prize_evidence_verified_by: _evidenceVerifiedBy,
    prize_evidence_verified_at: _evidenceVerifiedAt,
    approved_by: _approvedBy,
    rejected_by: _rejectedBy,
    rejection_ground: _rejectionGround,
    cancelled_by: _cancelledBy,
    cancellation_reason: _cancellationReason,
    ...publicColumns
  } = row;

  return {
    ...publicColumns,
    // Rows written before media validation existed may hold anything. The
    // stored value is left alone — it is the record of what a host actually
    // submitted — but only a URL that would be accepted today is handed to a
    // browser. Anything else becomes null, and the page shows its no-image
    // state rather than a broken image or, worse, a clickable link.
    image_url: isRenderableMediaUrl(row.image_url) ? row.image_url : null,
    host_name: hostRes.rows[0] ? hostRes.rows[0].name : 'Unknown',
    host_verified: hostRes.rows[0] ? hostRes.rows[0].is_verified_business : false,
    entry_count: countRes.rows[0].c,
    // The lifecycle, as a visitor may see it: coarse state, the closing rules,
    // and the campaign-specific prize conditions. Never the review notes, the
    // evidence reference, the approving administrator or an internal
    // cancellation reason — see giveawayLifecycle.publicView.
    lifecycle: lifecycle.publicView(row),
    entries_remaining:
      row.status === lifecycle.STATUS.ACTIVE
        ? Math.max(0, (row.entry_target || lifecycle.ENTRY_TARGET) - countRes.rows[0].c)
        : 0,
  };
}

// Browse all giveaways. Active ones first, newest first, paginated.
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(48, Math.max(1, parseInt(req.query.pageSize, 10) || 12));
    const offset = (page - 1) * pageSize;

    // A submission awaiting review, or one that was rejected, is not a
    // giveaway. It has never been public and it never becomes public — so it is
    // excluded here rather than filtered in the page, which is the difference
    // between "not shown" and "not served".
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM giveaways WHERE status <> ALL($1)`,
      [[lifecycle.STATUS.PENDING_APPROVAL, lifecycle.STATUS.REJECTED]]
    );
    const total = countRes.rows[0].c;

    const result = await pool.query(
      `SELECT * FROM giveaways
        WHERE status <> ALL($3)
        ORDER BY (status = 'active') DESC, closes_at ASC NULLS LAST, entry_deadline ASC
        LIMIT $1 OFFSET $2`,
      [pageSize, offset, [lifecycle.STATUS.PENDING_APPROVAL, lifecycle.STATUS.REJECTED]]
    );
    const items = await Promise.all(result.rows.map(withHostAndCount));
    res.json({ items, total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Homepage trust-bar numbers. Real counts only — no padding, no estimates.
router.get('/stats/summary', async (req, res) => {
  try {
    const giveawaysRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM giveaways WHERE status <> ALL($1)`,
      [[lifecycle.STATUS.PENDING_APPROVAL, lifecycle.STATUS.REJECTED]]
    );
    const entriesRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM entries WHERE ${integrity.COUNTED_SQL}`
    );
    const valueRes = await pool.query(
      `SELECT COALESCE(SUM(estimated_value_aed), 0)::numeric AS v FROM giveaways
        WHERE estimated_value_aed IS NOT NULL AND status <> ALL($1)`,
      [[lifecycle.STATUS.PENDING_APPROVAL, lifecycle.STATUS.REJECTED]]
    );
    res.json({
      giveaways_hosted: giveawaysRes.rows[0].c,
      entries_submitted: entriesRes.rows[0].c,
      value_listed_aed: Number(valueRes.rows[0].v),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Public winners directory. Winner name + ticket number are already shown
// on the individual giveaway page with no auth check — this just collects
// the same already-public info in one place, newest draw first.
router.get('/winners/all', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(48, Math.max(1, parseInt(req.query.pageSize, 10) || 12));
    const offset = (page - 1) * pageSize;

    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS c FROM giveaways WHERE status = 'drawn' AND winner_entry_id IS NOT NULL"
    );
    const total = countRes.rows[0].c;

    const result = await pool.query(
      `SELECT
         giveaways.id, giveaways.title, giveaways.image_url, giveaways.prize_description,
         giveaways.estimated_value_aed, giveaways.entry_deadline, giveaways.status,
         giveaways.prize_delivered, giveaways.prize_delivered_at,
         hostuser.name AS host_name, hostuser.is_verified_business AS host_verified,
         winneruser.name AS winner_name, entries.ticket_number AS winner_ticket_number,
         (SELECT COUNT(*)::int FROM entries e2
           WHERE e2.giveaway_id = giveaways.id AND ${lifecycle.ACCEPTED_SQL.replace(/integrity_status/g, 'e2.integrity_status')}) AS entry_count
       FROM giveaways
       JOIN users hostuser ON hostuser.id = giveaways.host_id
       JOIN entries ON entries.id = giveaways.winner_entry_id
       JOIN users winneruser ON winneruser.id = entries.user_id
       WHERE giveaways.status = 'drawn' AND giveaways.winner_entry_id IS NOT NULL
       ORDER BY giveaways.entry_deadline DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    res.json({
      items: result.rows.map((row) => ({
        ...row,
        image_url: isRenderableMediaUrl(row.image_url) ? row.image_url : null,
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Single giveaway detail, plus whether the current viewer has already entered.
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM giveaways WHERE id = $1', [req.params.id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'This giveaway does not exist.' });

    // The viewer's own entry, and only their own. A coarse status plus the
    // written reason if a decision was made about them — never the signals that
    // prompted a review, never another account, never an administrator's notes.
    let alreadyEntered = false;
    let myEntry = null;
    if (req.userId) {
      const entryRes = await pool.query(
        'SELECT * FROM entries WHERE giveaway_id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      alreadyEntered = entryRes.rows.length > 0;
      if (entryRes.rows[0]) {
        const blocking = await integrity.hasBlockingCase(pool, req.params.id);
        myEntry = integrity.entrantView(entryRes.rows[0], { blockingCase: blocking });
      }
    }

    let winner = null;
    if (row.status === 'drawn' && row.winner_entry_id) {
      const winRes = await pool.query(
        `SELECT entries.ticket_number, users.name FROM entries
         JOIN users ON users.id = entries.user_id
         WHERE entries.id = $1`,
        [row.winner_entry_id]
      );
      if (winRes.rows[0]) {
        winner = { name: winRes.rows[0].name, ticket_number: winRes.rows[0].ticket_number };
      }
    }

    // Coarse, non-sensitive status only: that a delivery is in progress, not
    // who is delivering what to which address.
    const claimRes = await pool.query('SELECT status FROM prize_claims WHERE giveaway_id = $1', [
      req.params.id,
    ]);
    const claimStatus = claimRes.rows[0]
      ? claims.publicStatusFor(claimRes.rows[0].status)
      : null;

    const enriched = await withHostAndCount(row);
    res.json({
      ...enriched,
      already_entered: alreadyEntered,
      my_entry: myEntry,
      winner,
      claim_status: claimStatus,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Create a giveaway. Requires an explicit funding disclosure so every listing
// states, in the host's own words, that the prize is a marketing cost rather
// than something paid for by entrants.
//
// Hosting is a closed beta: requireHostAccess reads users.host_status on this
// request and only an approved account (or an administrator) gets past it. This
// used to check email_verified alone, which meant any address that could
// receive one email could publish unlimited prize draws. Email verification is
// still required — it is now one of two conditions rather than the only one,
// and both live in server/lib/hostAccess.js.
//
// There is still no per-plan quota, because there are no plans to buy. If one
// is ever added, administrators must stay exempt — see test/host-access.test.js.
router.post('/', requireAuth, requireHostAccess, async (req, res) => {
  try {
    // No real campaign may be submitted while the deployment is pre-launch. A
    // submission is the first step of a campaign, and a campaign cannot be
    // fulfilled while the fulfilment role model is unresolved.
    if (appConfig.refuseIfPreLaunch(res, { action: 'submit_giveaway' })) return;

    const me = await pool.query(
      'SELECT age_attestation_status, age_attestation_version FROM users WHERE id = $1',
      [req.userId]
    );
    if (eligibility.blocksAction(me.rows[0], 'create_giveaway')) {
      return res.status(403).json({
        error: eligibility.WORDING + ' Please confirm this before publishing a giveaway.',
        code: 'AGE_ATTESTATION_REQUIRED',
        wording: eligibility.WORDING,
      });
    }
    const {
      title,
      description,
      prize_description,
      estimated_value_aed,
      image_url,
      funded_by,
      max_entries_per_person,
      // Curated prize governance. Every one of these is reviewed by Naseeb
      // before the campaign can be published.
      prize_category,
      sponsor_name,
      prize_supplied_by,
      prize_retail_value_aed,
      naseeb_custody,
      fulfilment_method,
      prize_restrictions,
      prize_expiry_date,
    } = req.body;

    // `entry_deadline` is deliberately NOT read from the request any more.
    //
    // A host used to choose it. It is now a consequence of publication: exactly
    // 30 calendar days from the moment Naseeb approves the campaign, set by
    // `giveawayLifecycle.approveAndPublish`. A host-chosen deadline and a
    // mandatory one cannot both be true, and the mandatory one is the rule.
    const submission = {
      title,
      description,
      prize_description,
      funded_by,
      prize_category,
      sponsor_name,
      prize_supplied_by,
      prize_retail_value_aed,
      naseeb_custody,
      fulfilment_method,
    };
    const missing = prizeStandard.missingForSubmission(submission);
    if (missing.length) {
      return res.status(400).json({
        error:
          'Naseeb reviews every prize before it is published, and this submission is missing some of what that review needs.',
        code: 'SUBMISSION_INCOMPLETE',
        missing,
      });
    }

    if (!prizeStandard.isCategory(prize_category)) {
      return res.status(400).json({
        error: 'Choose the prize category that fits best.',
        code: 'PRIZE_CATEGORY_INVALID',
        categories: prizeStandard.CATEGORIES,
      });
    }
    if (!prizeStandard.isCustody(naseeb_custody)) {
      return res.status(400).json({
        error:
          'Say who will be holding this prize: Naseeb, the sponsor under a commitment to Naseeb, or the provider who fulfils it.',
        code: 'CUSTODY_INVALID',
        allowed: prizeStandard.CUSTODY_IDS,
      });
    }

    const retailValue = Number(prize_retail_value_aed);
    if (!Number.isFinite(retailValue) || retailValue <= 0) {
      return res.status(400).json({
        error: 'Give the genuine retail or market value of the prize in AED.',
        code: 'PRIZE_VALUE_INVALID',
      });
    }

    let expiry = null;
    if (prize_expiry_date !== undefined && prize_expiry_date !== null && String(prize_expiry_date).trim() !== '') {
      const parsed = new Date(prize_expiry_date);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'That prize expiry date is not a date.', code: 'PRIZE_EXPIRY_INVALID' });
      }
      expiry = parsed.toISOString().slice(0, 10);
    }

    for (const [field, max] of Object.entries(MAX_LENGTHS)) {
      const value = { title, description, prize_description, funded_by }[field];
      if (value.trim().length > max) {
        return res.status(400).json({ error: `${field.replace(/_/g, ' ')} must be ${max} characters or fewer.` });
      }
    }

    let value = null;
    if (estimated_value_aed !== undefined && estimated_value_aed !== null && estimated_value_aed !== '') {
      value = Number(estimated_value_aed);
      if (isNaN(value) || value < 0) {
        return res.status(400).json({ error: 'Estimated value must be a non-negative number.' });
      }
    }

    let entryCap = 1;
    if (max_entries_per_person !== undefined && max_entries_per_person !== null && max_entries_per_person !== '') {
      entryCap = Number(max_entries_per_person);
      if (!Number.isInteger(entryCap) || entryCap < 1) {
        return res.status(400).json({ error: 'Max entries per person must be a positive whole number.' });
      }
    }

    // "is it http(s)" was the whole check here, which stops `javascript:` and
    // very little else — and an unbounded set of image origins is what made a
    // real Content-Security-Policy impossible. validateMediaUrl requires https,
    // no embedded credentials, no control characters, and an origin on the
    // allowlist that img-src is built from. See server/lib/mediaUrls.js.
    let normalizedImageUrl = null;
    if (image_url && String(image_url).trim()) {
      const checked = validateMediaUrl(image_url);
      if (!checked.url) {
        return res.status(400).json({ error: checked.error, code: 'MEDIA_URL_REJECTED' });
      }
      normalizedImageUrl = checked.url;
    }

    // A submission, not a publication.
    //
    // This route used to make a campaign live the instant it returned 201.
    // Nothing reviewed the prize, nobody approved it, and the front page showed
    // whatever an approved host chose to type. It now creates a submission
    // awaiting deliberate Naseeb approval: not listed, not enterable, with no
    // publication date and no closing deadline, because it has not been
    // published and has nothing to close.
    const id = uuid();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO giveaways
           (id, host_id, title, description, prize_description, estimated_value_aed,
            image_url, funded_by, entry_deadline, max_entries_per_person,
            status, submitted_at,
            prize_category, sponsor_name, prize_supplied_by, prize_retail_value_aed,
            naseeb_custody, fulfilment_method, prize_restrictions, prize_expiry_date,
            entry_target)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(),
                 $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          id,
          req.userId,
          title.trim(),
          description.trim(),
          prize_description.trim(),
          value,
          normalizedImageUrl,
          funded_by.trim(),
          // Kept in step with `closes_at` from approval onwards. Empty until
          // then, because an unpublished submission has no deadline.
          '',
          entryCap,
          lifecycle.STATUS.PENDING_APPROVAL,
          prize_category,
          String(sponsor_name).trim(),
          String(prize_supplied_by).trim(),
          retailValue,
          naseeb_custody,
          String(fulfilment_method).trim(),
          prize_restrictions ? String(prize_restrictions).trim() : null,
          expiry,
          lifecycle.ENTRY_TARGET,
        ]
      );
      await lifecycle.recordEvent(client, {
        giveawayId: id,
        eventType: 'submitted',
        toStatus: lifecycle.STATUS.PENDING_APPROVAL,
        actorUserId: req.userId,
        actorRole: 'host',
        metadata: { prize_category, naseeb_custody },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const result = await pool.query('SELECT * FROM giveaways WHERE id = $1', [id]);
    const enriched = await withHostAndCount(result.rows[0]);
    res.status(201).json({
      ...enriched,
      submitted_for_review: true,
      // Truthful about what just happened. It is not live, and saying "your
      // giveaway is published" here would be a lie the host acts on.
      next_step:
        'Submitted for review. Naseeb checks every prize before publication — you will see this campaign go live once it is approved, and it will then close at whichever comes first: 100 eligible entries, or 30 days.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Enter a giveaway. Always free — there is no amount, no payment reference,
// nothing to charge. One entry per person per giveaway.
//
// Runs inside a transaction with the giveaway row locked (SELECT ... FOR
// UPDATE) so two near-simultaneous entries (or one impatient double-click)
// can't both read the same entry count and get issued the same ticket
// number — the second request blocks until the first commits, then sees
// the incremented count.
router.post('/:id/enter', enterLimiter, requireAuth, async (req, res) => {
  // Before the connection is even taken. An entry is the thing a real person
  // does, and it is exactly what a pre-launch deployment must not accept.
  if (appConfig.refuseIfPreLaunch(res, { action: 'enter_giveaway' })) return;

  const client = await pool.connect();
  try {
    const userRes = await client.query(
      `SELECT name, email, email_verified, age_attestation_status, age_attestation_version
         FROM users WHERE id = $1`,
      [req.userId]
    );
    const enteringUser = userRes.rows[0];
    if (!enteringUser || !enteringUser.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before entering a giveaway.' });
    }
    // Accounts that existed before the attestation was introduced are marked
    // `unknown` rather than assumed, so they are asked once, here, before a NEW
    // entry. Nothing already in progress is blocked by this — see
    // server/lib/eligibility.js NEVER_GATED_ACTIONS.
    if (eligibility.blocksAction(enteringUser, 'enter_giveaway')) {
      return res.status(403).json({
        error: eligibility.WORDING + ' Please confirm this before entering.',
        code: 'AGE_ATTESTATION_REQUIRED',
        wording: eligibility.WORDING,
      });
    }

    await client.query('BEGIN');

    const result = await client.query('SELECT * FROM giveaways WHERE id = $1 FOR UPDATE', [req.params.id]);
    const giveaway = result.rows[0];
    if (!giveaway) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This giveaway does not exist.' });
    }
    // Closure is a LATCH, not a recomputed count. Once a campaign leaves
    // `active` it never returns, so an entry after closure is refused by state
    // rather than by arithmetic that a later disqualification could undo.
    if (giveaway.status !== lifecycle.STATUS.ACTIVE) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          giveaway.status === lifecycle.STATUS.CANCELLED
            ? 'This giveaway has been cancelled.'
            : 'This giveaway has closed and is no longer accepting entries.',
        code: 'ENTRIES_CLOSED',
        status: giveaway.status,
      });
    }

    // The deadline, read from the database rather than from the process clock,
    // so a request cannot slip in against a skewed local time. The maintenance
    // job closes campaigns on schedule; this is the guard for the interval
    // between the deadline passing and the job running.
    const due = await client.query('SELECT $1::timestamptz <= NOW() AS passed', [giveaway.closes_at]);
    if (due.rows[0].passed) {
      // Close it here, under the lock we already hold, rather than letting the
      // entry through and leaving the campaign open until a worker notices.
      await lifecycle.closeEntries(client, giveaway, {
        reason: lifecycle.CLOSE_REASONS.DEADLINE_REACHED,
      });
      await client.query('COMMIT');
      return res.status(409).json({
        error: 'The closing deadline for this giveaway has passed.',
        code: 'ENTRIES_CLOSED',
        status: lifecycle.STATUS.CLOSED_PENDING_DRAW,
      });
    }

    const existingRes = await client.query(
      'SELECT id FROM entries WHERE giveaway_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (existingRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: "You're already entered in this giveaway. Good luck!" });
    }

    // Ticket numbers count every entry ever made on this giveaway, including
    // any that were later disqualified. They are receipts, not a tally: two
    // people must never be told they hold ticket #4, and reusing a number after
    // a disqualification would do exactly that.
    const countRes = await client.query('SELECT COUNT(*)::int AS c FROM entries WHERE giveaway_id = $1', [
      req.params.id,
    ]);
    const ticketNumber = countRes.rows[0].c + 1;
    const id = uuid();
    await client.query(
      'INSERT INTO entries (id, giveaway_id, user_id, ticket_number) VALUES ($1, $2, $3, $4)',
      [id, req.params.id, req.userId, ticketNumber]
    );

    // Risk signals are recorded in the same transaction, and record is all they
    // do: nothing here can refuse the entry, change its status, or touch the
    // account. A failure to record a signal must never cost somebody their
    // entry, so it is caught and dropped rather than rolled back.
    try {
      await riskSignals.recordEntrySignals(client, {
        entryId: id,
        giveawayId: req.params.id,
        userId: req.userId,
        ip: req.ip,
      });
    } catch (signalErr) {
      console.error('Entry risk signals could not be recorded:', signalErr.message);
    }

    // The receipt is DURABLE. It used to be a `sendEmail(...)` fired after the
    // response and never awaited: a mail outage lost it silently and nothing
    // recorded that anybody was owed one. The intent is written in the same
    // transaction as the entry, so the two commit or roll back together.
    await giveawayOutbox.enqueue(client, {
      giveawayId: req.params.id,
      userId: req.userId,
      kind: giveawayOutbox.KINDS.ENTRY_RECEIPT,
    });

    // The 100th accepted entry closes the campaign, in this transaction, under
    // the same row lock that serialises entries. That is what makes "closes
    // exactly on the 100th" true rather than approximately true: two concurrent
    // entries cannot both read 99, and no 101st entry can slip past a campaign
    // that is already latched closed.
    const closure = await lifecycle.closeIfTargetReached(client, giveaway);

    await client.query('COMMIT');

    res.status(201).json({
      id,
      ticket_number: ticketNumber,
      entries_closed: Boolean(closure.closed),
      // Truthful, and the reason people will want: their entry was the one that
      // filled the campaign.
      closed_reason: closure.closed ? lifecycle.CLOSE_REASONS.TARGET_REACHED : null,
    });

    // Delivery is attempted outside the transaction and is not awaited by the
    // response, but the promise is tracked so shutdown can drain it and the
    // tests can settle it. A failure here leaves a pending row to retry, not a
    // lost message.
    giveawayOutbox.drainInBackground({ appUrl: APP_URL });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// Draw a winner. Only the host can trigger this, and only after the entry
// deadline has passed, so the pool of tickets is fixed and final before the
// random draw runs.
//
// Runs inside a transaction with the giveaway row locked (SELECT ... FOR
// UPDATE) so a double-clicked or double-submitted draw can't run twice
// concurrently, compute two different random winners, and have the second
// write silently overwrite the first — which would leave one "You won"
// email pointing at someone who, per the database, didn't actually win.
//
// Gated on host access as well as ownership, and the two are not the same
// check: approval decides whether this account may operate as a host at all,
// ownership decides whose giveaway it may operate. An approved host still
// cannot draw somebody else's giveaway, and a suspended host cannot draw their
// own — the ownership comparison below is unchanged and still runs.
// Everything that happens when a campaign resolves, in one place.
//
// The route and the deadline maintenance job both call this. A second
// implementation of "pick a winner, create the claim, queue the notices" is the
// last thing this codebase should have: the two would drift, and the weaker one
// would be the one running unattended at 03:00.
//
// The caller owns the transaction and must already hold the giveaway row lock.
async function runDraw(client, giveaway, { actorUserId = null, actorRole = 'system' } = {}) {
  const outcome = await lifecycle.drawIfReady(client, giveaway, { actorUserId, actorRole });
  if (!outcome.drawn) return outcome;

  const winnerUserRes = await client.query('SELECT name, email FROM users WHERE id = $1', [
    outcome.winner.user_id,
  ]);
  const winnerUser = winnerUserRes.rows[0];

  // The winner notice is durable now. It used to be a `sendEmail(...)` fired
  // after the response: a mail outage meant somebody won and was never told,
  // with nothing recording that they were owed the message.
  await giveawayOutbox.enqueue(client, {
    giveawayId: giveaway.id,
    userId: outcome.winner.user_id,
    kind: giveawayOutbox.KINDS.WINNER_NOTICE,
  });

  // The claim, and the intent to tell the winner about it, in the same
  // transaction as the draw. A winner without a claim has no way to receive
  // anything.
  let claim = null;
  if (areClaimsEnabled()) {
    claim = await claims.createClaimForDraw(client, {
      giveawayId: giveaway.id,
      winnerUserId: outcome.winner.user_id,
      entryId: outcome.winner.id,
    });
    await notifications.queueInvitation(client, claim.id);
  }

  return { ...outcome, claim, winnerName: winnerUser ? winnerUser.name : null };
}

router.post('/:id/draw', requireAuth, requireHostAccess, async (req, res) => {
  // A draw commits a winner, a claim and a delivery workflow. None of that may
  // happen while the deployment is pre-launch.
  if (appConfig.refuseIfPreLaunch(res, { action: 'draw_winner' })) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const giveaway = await lifecycle.lockGiveaway(client, req.params.id);
    if (giveaway.host_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the host of this giveaway can draw a winner.' });
    }

    // A host may ask for the draw to run NOW. They may not choose when a
    // campaign closes, they may not draw one that is still open, and they may
    // not draw twice — and none of that is enforced here any more, because all
    // of it lives in the one lifecycle service the deadline job also uses.
    if (giveaway.status === lifecycle.STATUS.ACTIVE) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          'This giveaway is still accepting entries. It closes on its own at whichever comes first — 100 eligible entries, or the closing deadline — and the draw runs from there without anybody pressing anything.',
        code: 'ENTRIES_STILL_OPEN',
        closes_at: giveaway.closes_at,
      });
    }

    // Refused before the draw commits a winner, not after: a winner who cannot
    // be told they won is a claim that expires into an administrator queue.
    if (areClaimsEnabled() && emailDelivery.refuseIfUndeliverable(res, { action: 'draw_winner' })) {
      await client.query('ROLLBACK');
      return undefined;
    }

    const outcome = await runDraw(client, giveaway, {
      actorUserId: req.userId,
      actorRole: 'host',
    });
    await client.query('COMMIT');

    if (outcome.drawn) {
      giveawayOutbox.drainInBackground({ appUrl: APP_URL });
      if (outcome.claim) {
        try {
          await notifications.processDueNotifications({ appUrl: APP_URL });
        } catch (notifyErr) {
          // The draw has already committed. A failure here means the invitation
          // is still pending, which the scheduler and the admin review screen
          // both pick up.
          console.error('Claim invitation delivery attempt failed:', notifyErr.message);
        }
      }
      return res.json({
        winner_name: outcome.winnerName,
        winner_ticket_number: outcome.winner.ticket_number,
      });
    }

    if (outcome.postponed) {
      return res.status(409).json({
        error:
          'An integrity check is open on this giveaway. Entries are closed and the draw runs automatically once the check is resolved — nothing is lost by waiting.',
        code: 'ENTRY_REVIEW_PENDING',
        status: outcome.status,
      });
    }
    if (outcome.noWinner) {
      return res.status(200).json({
        drawn: false,
        status: outcome.status,
        reason: outcome.reason,
        message: 'This giveaway closed with no eligible entry, so no winner was drawn.',
      });
    }
    return res.status(409).json({
      error: 'This giveaway has already been drawn or closed.',
      code: 'ALREADY_RESOLVED',
      status: outcome.status,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof lifecycle.LifecycleError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof integrity.IntegrityError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// Superseded by the claim workflow in server/routes/claims.js.
//
// This used to be the whole of "delivery": the host clicked a button and the
// giveaway said the prize had been delivered. Nobody else had a say — not the
// winner who was supposed to have received it, and not an administrator if the
// two disagreed. prize_delivered is now set only when the winner confirms
// receipt, so this endpoint cannot do what its name says any more.
router.post('/:id/confirm-delivery', requireAuth, requireHostAccess, async (req, res) => {
  try {
    const result = await pool.query('SELECT host_id FROM giveaways WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'This giveaway does not exist.' });
    }
    if (result.rows[0].host_id !== req.userId) {
      return res.status(403).json({ error: 'Only the host of this giveaway can manage delivery.' });
    }
    const claim = await claims.getClaimByGiveaway(pool, req.params.id);
    return res.status(409).json({
      error:
        'Delivery is now confirmed by the winner, not by the host. Move the claim along from your dashboard — the winner confirms receipt at the end.',
      code: 'USE_CLAIM_WORKFLOW',
      claim_id: claim ? claim.id : null,
      claim_status: claim ? claim.status : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Giveaways hosted by the signed-in user. Host-only dashboard data, so it goes
// through the same gate as everything else host-only rather than being the one
// place that only checks for a session.
router.get('/mine/hosted', requireAuth, requireHostAccess, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM giveaways WHERE host_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    const rows = await Promise.all(result.rows.map(withHostAndCount));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Giveaways the signed-in user has entered.
router.get('/mine/entered', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT giveaways.*, entries.id AS my_entry_id, entries.ticket_number,
              entries.created_at AS my_entry_created_at, entries.integrity_status,
              entries.integrity_reason_code,
              EXISTS (
                SELECT 1 FROM entry_integrity_cases c
                 WHERE c.giveaway_id = giveaways.id
                   AND c.status IN ('open', 'upheld_blocked')
              ) AS integrity_case_blocking
       FROM entries
       JOIN giveaways ON giveaways.id = entries.giveaway_id
       WHERE entries.user_id = $1
       ORDER BY entries.created_at DESC`,
      [req.userId]
    );
    const rows = await Promise.all(
      result.rows.map(async (r) => {
        const enriched = await withHostAndCount(r);
        return {
          ...enriched,
          my_ticket_number: r.ticket_number,
          // The entrant's own coarse status, on their own dashboard. Same shape
          // as the giveaway page, from the same function.
          my_entry: integrity.entrantView(
            {
              created_at: r.my_entry_created_at,
              ticket_number: r.ticket_number,
              integrity_status: r.integrity_status,
              integrity_reason_code: r.integrity_reason_code,
            },
            { blockingCase: r.integrity_case_blocking }
          ),
        };
      })
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// A host may say "please look at this", and nothing more.
//
// Hosts have a direct interest in who wins their own giveaway, which is exactly
// why they cannot act on that interest here: this endpoint records a flag and
// opens an administrator case. It does not change an entry's status, it does not
// remove anybody from the pool, and it does not tell the host anything about the
// entrant they did not already know.
router.post('/:id/entries/:entryId/flag', requireAuth, requireHostAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const giveawayRes = await client.query('SELECT host_id FROM giveaways WHERE id = $1', [
      req.params.id,
    ]);
    const giveaway = giveawayRes.rows[0];
    if (!giveaway) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This giveaway does not exist.' });
    }
    if (giveaway.host_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the host of this giveaway can flag an entry on it.' });
    }

    const entryRes = await client.query(
      'SELECT id FROM entries WHERE id = $1 AND giveaway_id = $2',
      [req.params.entryId, req.params.id]
    );
    if (!entryRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That entry is not part of this giveaway.' });
    }

    const opened = await integrity.openCase(client, {
      giveawayId: req.params.id,
      entryId: req.params.entryId,
      // The host's own words, and they are internal notes like any other: a
      // host's theory about an entrant is exactly the sort of text that must
      // never reach the entrant it is about.
      adminNotes: req.body && (req.body.admin_notes || req.body.reason),
      actorUserId: req.userId,
      actorRole: 'admin',
      postDraw: false,
    });

    await client.query('COMMIT');
    // Idempotent: flagging twice reports the same open case rather than
    // creating a second one.
    res.status(opened.created ? 201 : 200).json({
      case_opened: Boolean(opened.case),
      already_open: !opened.created,
      // Deliberately no entry status here. A host flagging an entry learns
      // nothing about whether it was acted on.
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof integrity.IntegrityError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// `runDraw` is exported alongside the router because the maintenance job needs
// exactly the same operation. One implementation, two callers — see the comment
// above the function.
module.exports = router;
module.exports.runDraw = runDraw;
