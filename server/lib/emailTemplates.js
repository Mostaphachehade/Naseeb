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

module.exports = { winnerEmailHtml, entryEmailHtml };
