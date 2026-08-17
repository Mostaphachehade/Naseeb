const { escapeHtmlForEmail } = require('./email');

// Email clients (especially desktop Outlook, which renders via Word) don't
// support CSS variables, flexbox/grid, or reliable position:absolute — so
// unlike the rest of the site, this is deliberately table-based with every
// style inlined, using web-safe fonts only. Rounded corners and the dashed
// "perforation" line degrade gracefully (square corners, still a clear tear
// line) on the handful of clients that don't support them.
const INK = '#0B3B36';
const INK_DEEP = '#072925';
const GOLD = '#C9A15A';
const GOLD_BRIGHT = '#E4C078';
const PAPER = '#F7F3EA';
const TEXT_SOFT = '#4C5C56';

function winnerEmailHtml({ winnerName, giveawayTitle, prizeDescription, imageUrl, ticketNumber, fundedBy, giveawayUrl }) {
  const name = escapeHtmlForEmail(winnerName);
  const title = escapeHtmlForEmail(giveawayTitle);
  const prize = escapeHtmlForEmail(prizeDescription);
  const funded = escapeHtmlForEmail(fundedBy);
  const url = escapeHtmlForEmail(giveawayUrl);

  const heroImage = imageUrl
    ? `<tr>
        <td style="padding:0;">
          <img src="${escapeHtmlForEmail(imageUrl)}" width="600" alt="" style="display:block; width:100%; max-width:600px; height:220px; object-fit:cover; background-color:${INK};" />
        </td>
      </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>You won on Naseeb</title>
</head>
<body style="margin:0; padding:0; background-color:${INK_DEEP}; font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INK_DEEP};">
    <tr>
      <td align="center" style="padding:40px 20px;">

        <!-- Brand mark -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr>
            <td align="center" style="padding:0 0 24px;">
              <span style="font-family:Georgia,'Times New Roman',serif; font-size:22px; font-weight:bold; color:${PAPER};">Naseeb<span style="color:${GOLD_BRIGHT};">.</span></span>
            </td>
          </tr>
        </table>

        <!-- The ticket -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; background-color:${PAPER}; border-radius:16px; overflow:hidden;">

          <!-- Winner ribbon -->
          <tr>
            <td align="center" style="background-color:${INK}; padding:16px 24px;">
              <span style="display:inline-block; font-family:'Courier New',Courier,monospace; font-size:12px; font-weight:bold; letter-spacing:2px; color:${INK_DEEP}; background-color:${GOLD}; padding:6px 16px; border-radius:100px;">WINNER &middot; TICKET #${ticketNumber}</span>
            </td>
          </tr>

          ${heroImage}

          <!-- Perforation (ticket tear line) -->
          <tr>
            <td style="padding:0; line-height:0; font-size:0;">
              <div style="border-top:2px dashed ${INK}; opacity:0.25; margin:0 20px;"></div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px 8px;">
              <p style="margin:0 0 4px; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:${TEXT_SOFT};">Hi ${name},</p>
              <p style="margin:0 0 20px; font-family:Arial,Helvetica,sans-serif; font-size:16px; color:${TEXT_SOFT}; line-height:1.5;">Congratulations — the draw is done, and you won.</p>

              <h1 style="margin:0 0 8px; font-family:Georgia,'Times New Roman',serif; font-size:26px; line-height:1.25; color:${INK_DEEP};">${title}</h1>
              <p style="margin:0 0 24px; font-family:Arial,Helvetica,sans-serif; font-size:15px; color:${TEXT_SOFT};">${prize}</p>

              <!-- Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background-color:${GOLD}; border-radius:100px;">
                    <a href="${url}" target="_blank" style="display:inline-block; padding:14px 28px; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold; color:${INK_DEEP}; text-decoration:none;">See your giveaway</a>
                  </td>
                </tr>
              </table>

              <p style="margin:28px 0 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:${TEXT_SOFT}; line-height:1.5;">Funded by ${funded}, disclosed publicly on the listing. The host will be in touch directly to arrange your prize — no payment is ever required to claim it.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 32px 28px;">
              <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; color:${TEXT_SOFT}; opacity:0.8;">Picked uniformly at random from every eligible entry, after the deadline closed. No purchase was ever necessary — not from you, not from anyone.</p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr>
            <td align="center" style="padding:20px 20px 0;">
              <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; color:${TEXT_SOFT};">You're receiving this because you entered a free giveaway on <a href="https://www.mynaseeb.ae" style="color:${GOLD_BRIGHT};">Naseeb</a>.</p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

function entryEmailHtml({ entrantName, giveawayTitle, prizeDescription, imageUrl, ticketNumber, entryDeadline, giveawayUrl }) {
  const name = escapeHtmlForEmail(entrantName);
  const title = escapeHtmlForEmail(giveawayTitle);
  const prize = escapeHtmlForEmail(prizeDescription);
  const url = escapeHtmlForEmail(giveawayUrl);
  const deadline = escapeHtmlForEmail(
    new Date(entryDeadline).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  );

  const heroImage = imageUrl
    ? `<tr>
        <td style="padding:0;">
          <img src="${escapeHtmlForEmail(imageUrl)}" width="600" alt="" style="display:block; width:100%; max-width:600px; height:220px; object-fit:cover; background-color:${INK};" />
        </td>
      </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>You're entered on Naseeb</title>
</head>
<body style="margin:0; padding:0; background-color:${INK_DEEP}; font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INK_DEEP};">
    <tr>
      <td align="center" style="padding:40px 20px;">

        <!-- Brand mark -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr>
            <td align="center" style="padding:0 0 24px;">
              <span style="font-family:Georgia,'Times New Roman',serif; font-size:22px; font-weight:bold; color:${PAPER};">Naseeb<span style="color:${GOLD_BRIGHT};">.</span></span>
            </td>
          </tr>
        </table>

        <!-- The ticket -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; background-color:${PAPER}; border-radius:16px; overflow:hidden;">

          <!-- Entered ribbon -->
          <tr>
            <td align="center" style="background-color:${INK}; padding:16px 24px;">
              <span style="display:inline-block; font-family:'Courier New',Courier,monospace; font-size:12px; font-weight:bold; letter-spacing:2px; color:${INK_DEEP}; background-color:${GOLD}; padding:6px 16px; border-radius:100px;">ENTERED &middot; TICKET #${ticketNumber}</span>
            </td>
          </tr>

          ${heroImage}

          <!-- Perforation (ticket tear line) -->
          <tr>
            <td style="padding:0; line-height:0; font-size:0;">
              <div style="border-top:2px dashed ${INK}; opacity:0.25; margin:0 20px;"></div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px 8px;">
              <p style="margin:0 0 4px; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:${TEXT_SOFT};">Hi ${name},</p>
              <p style="margin:0 0 20px; font-family:Arial,Helvetica,sans-serif; font-size:16px; color:${TEXT_SOFT}; line-height:1.5;">You're in. Here's your ticket.</p>

              <h1 style="margin:0 0 8px; font-family:Georgia,'Times New Roman',serif; font-size:26px; line-height:1.25; color:${INK_DEEP};">${title}</h1>
              <p style="margin:0 0 24px; font-family:Arial,Helvetica,sans-serif; font-size:15px; color:${TEXT_SOFT};">${prize}</p>

              <!-- Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background-color:${GOLD}; border-radius:100px;">
                    <a href="${url}" target="_blank" style="display:inline-block; padding:14px 28px; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold; color:${INK_DEEP}; text-decoration:none;">View your giveaway</a>
                  </td>
                </tr>
              </table>

              <p style="margin:28px 0 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:${TEXT_SOFT}; line-height:1.5;">The winner is drawn at random once entries close on <strong>${deadline}</strong>. We'll email you either way — good luck.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 32px 28px;">
              <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; color:${TEXT_SOFT}; opacity:0.8;">This entry was free — no payment was requested or accepted. One ticket per person keeps the odds equal for everyone.</p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr>
            <td align="center" style="padding:20px 20px 0;">
              <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; color:${TEXT_SOFT};">You're receiving this because you entered a free giveaway on <a href="https://www.mynaseeb.ae" style="color:${GOLD_BRIGHT};">Naseeb</a>.</p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Prize claim emails
//
// None of these carries a delivery address, a phone number, or any of the
// details a winner submits. Both parties are told what changed and asked to
// sign in — an inbox, and whatever a mail provider retains, is not somewhere
// a home address belongs.
// ---------------------------------------------------------------------------

// The one email that contains a claim link. Sent to the winner only, and marked
// sensitive so its body is never logged.
function claimInvitationHtml({ winnerName, giveawayTitle, claimUrl, expiresAt }) {
  const expiry = new Date(expiresAt).toUTCString();
  return `<!DOCTYPE html>
<html><body style="margin:0; padding:24px; background:#F7F4EE; font-family:Arial,Helvetica,sans-serif; color:#1F2421;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto; background:#FFFFFF; border-radius:12px;">
    <tr><td style="padding:28px;">
      <p style="margin:0 0 14px; font-size:16px;">Hi ${escapeHtmlForEmail(winnerName)},</p>
      <p style="margin:0 0 14px; font-size:16px;">You won <strong>${escapeHtmlForEmail(giveawayTitle)}</strong>. To receive your prize, confirm your claim and tell us where to send it.</p>
      <p style="margin:0 0 20px;">
        <a href="${claimUrl}" style="display:inline-block; background:#0B3B36; color:#FFFFFF; text-decoration:none; padding:12px 22px; border-radius:100px; font-weight:bold;">Claim your prize</a>
      </p>
      <p style="margin:0 0 10px; font-size:14px; color:#5B6660;">This link works once and expires on ${expiry}. Don&rsquo;t forward it &mdash; anyone with the link could claim in your place.</p>
      <p style="margin:0; font-size:14px; color:#5B6660;">Your delivery details are only shared with the host after you agree to it, and only what&rsquo;s needed to get the prize to you.</p>
    </td></tr>
  </table>
</body></html>`;
}

// Sent to the host when a winner claims. Says that it happened and nothing more.
function hostClaimNotificationHtml({ hostName, giveawayTitle, winnerName, dashboardUrl }) {
  return `<!DOCTYPE html>
<html><body style="margin:0; padding:24px; background:#F7F4EE; font-family:Arial,Helvetica,sans-serif; color:#1F2421;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto; background:#FFFFFF; border-radius:12px;">
    <tr><td style="padding:28px;">
      <p style="margin:0 0 14px; font-size:16px;">Hi ${escapeHtmlForEmail(hostName)},</p>
      <p style="margin:0 0 14px; font-size:16px;"><strong>${escapeHtmlForEmail(winnerName)}</strong> has claimed the prize for <strong>${escapeHtmlForEmail(giveawayTitle)}</strong> and agreed to share delivery details with you.</p>
      <p style="margin:0 0 20px;">
        <a href="${dashboardUrl}" style="display:inline-block; background:#0B3B36; color:#FFFFFF; text-decoration:none; padding:12px 22px; border-radius:100px; font-weight:bold;">Sign in to arrange delivery</a>
      </p>
      <p style="margin:0; font-size:14px; color:#5B6660;">The delivery address isn&rsquo;t in this email on purpose. Sign in to see it, and mark the prize sent once it&rsquo;s on its way.</p>
    </td></tr>
  </table>
</body></html>`;
}

const CLAIM_STATUS_WORDING = {
  claimed: 'The claim is confirmed.',
  preparing_delivery: 'The host is preparing the prize for delivery.',
  shipped_or_arranged: 'The host has sent or arranged the prize.',
  delivered_pending_confirmation: 'The host says the prize has arrived. Please confirm you received it.',
  delivered: 'Delivery is confirmed. All done.',
  disputed: 'A problem has been raised and an administrator is reviewing it.',
  expired: 'The claim window closed and an administrator is reviewing it.',
  cancelled: 'This claim has been closed.',
};

function claimStatusHtml({ recipientName, giveawayTitle, status, message, giveawayUrl }) {
  const wording = CLAIM_STATUS_WORDING[status] || 'The status of this prize has changed.';
  return `<!DOCTYPE html>
<html><body style="margin:0; padding:24px; background:#F7F4EE; font-family:Arial,Helvetica,sans-serif; color:#1F2421;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto; background:#FFFFFF; border-radius:12px;">
    <tr><td style="padding:28px;">
      <p style="margin:0 0 14px; font-size:16px;">Hi ${escapeHtmlForEmail(recipientName)},</p>
      <p style="margin:0 0 14px; font-size:16px;">${escapeHtmlForEmail(wording)}</p>
      <p style="margin:0 0 14px; font-size:16px;">Giveaway: <strong>${escapeHtmlForEmail(giveawayTitle)}</strong></p>
      <p style="margin:0 0 20px;">
        <a href="${giveawayUrl}" style="display:inline-block; background:#0B3B36; color:#FFFFFF; text-decoration:none; padding:12px 22px; border-radius:100px; font-weight:bold;">Open the giveaway</a>
      </p>
      <p style="margin:0; font-size:14px; color:#5B6660;">${escapeHtmlForEmail(message || '')}</p>
    </td></tr>
  </table>
</body></html>`;
}

// The address on an account is about to change, and this goes to the OLD one.
//
// Deliberately carries no token and no link that completes anything: if this
// message is the first the account holder hears of it, the correct action is to
// secure the account, not to click something in an email they did not expect.
// Goes to the OLD address, after the change has completed.
//
// Carries no token, no completing link and no signed-in link of any kind: the
// person reading it may be the account holder whose account was just taken, and
// handing them a live session URL in an email is the opposite of help. The new
// address is masked, so the message is useful without telling a thief who may
// also read this inbox exactly where the account went.
//
// The recovery instruction is a password reset, which is a route that exists,
// and a plain "contact us" — with no support address, phone number or hours
// invented, because none has been approved. See docs/UAE_COUNSEL_REVIEW.md A5/A6.
function emailChangeNoticeHtml({ name, newEmailMasked, appUrl, completed = false }) {
  if (!completed) {
    return `
      <p>Hello ${escapeHtmlForEmail(name || 'there')},</p>
      <p>Someone asked to change the email address on your Naseeb account to
         <strong>${escapeHtmlForEmail(newEmailMasked)}</strong>.</p>
      <p>The change is not done yet. It only takes effect once the new address is
         confirmed. This message contains no link to confirm it — that link went to
         the new address only.</p>
      <p><strong>If this was not you</strong>, change your password now at
         ${escapeHtmlForEmail(appUrl)}/forgot-password.html and the pending change
         will not complete.</p>
      <p>If it was you, nothing more to do here.</p>
    `;
  }
  return `
    <p>Hello ${escapeHtmlForEmail(name || 'there')},</p>
    <p>The email address on your Naseeb account has been changed to
       <strong>${escapeHtmlForEmail(newEmailMasked)}</strong>. This address will no
       longer receive account email.</p>
    <p>Everyone signed in to the account has been signed out, including on the
       device that made the change.</p>
    <p><strong>If this was not you</strong>, act now: someone else may control the
       account. Reset your password at
       ${escapeHtmlForEmail(appUrl)}/forgot-password.html — a reset now goes to the
       new address, so if you cannot complete it, contact us through the site
       straight away and say that your address was changed without your knowledge.</p>
    <p>This message contains no link that changes anything and no way to sign in.
       We will never ask you for your password.</p>
  `;
}

// Goes to the NEW address, and is the only place the token ever appears.
function emailChangeConfirmHtml({ name, confirmUrl, expiresAt }) {
  return `
    <p>Hello ${escapeHtmlForEmail(name || 'there')},</p>
    <p>Confirm this address to finish changing the email on your Naseeb account:</p>
    <p><a href="${escapeHtmlForEmail(confirmUrl)}">Confirm this email address</a></p>
    <p>The link works once and expires ${escapeHtmlForEmail(new Date(expiresAt).toUTCString())}.</p>
    <p>You will be signed out everywhere once it is done, and will need to sign in
       again with the new address.</p>
    <p>If you did not ask for this, you can ignore this message — nothing changes
       until the link is used.</p>
  `;
}

module.exports = {
  emailChangeNoticeHtml,
  emailChangeConfirmHtml,
  winnerEmailHtml,
  entryEmailHtml,
  claimInvitationHtml,
  hostClaimNotificationHtml,
  claimStatusHtml,
};
