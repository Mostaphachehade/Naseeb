const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Naseeb <onboarding@resend.dev>';

// Best-effort send — never throws. Without RESEND_API_KEY configured (local
// dev by default), this just logs what would have been sent so the rest of
// the flow (signup, password reset, etc.) still works without a real inbox.
// `sensitive: true` means the body must never be written to a log, even in
// development. Claim invitations carry a single-use bearer link: printing one
// to the console would put a working credential into terminal scrollback, CI
// output and anything scraping logs — exactly what storing only its hash was
// meant to prevent.
//
// CLAIM_DEV_LOG_LINKS exists because local development otherwise has no way to
// reach the link at all (the database holds only the hash). It is ignored in
// production, unconditionally.
async function sendEmail({ to, subject, html, sensitive = false }) {
  if (!RESEND_API_KEY) {
    const allowSensitiveLog =
      process.env.NODE_ENV !== 'production' && process.env.CLAIM_DEV_LOG_LINKS === 'true';
    if (sensitive && !allowSensitiveLog) {
      console.log(
        `[email:dev] Would send "${subject}" to ${to} (body suppressed — contains a single-use link)`
      );
      return;
    }
    console.log(`[email:dev] Would send "${subject}" to ${to}\n${html}\n`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Failed to send email "${subject}" to ${to}: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error(`Failed to send email "${subject}" to ${to}:`, err);
  }
}

function escapeHtmlForEmail(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { sendEmail, escapeHtmlForEmail };
