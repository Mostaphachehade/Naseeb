// Read per call rather than captured at require time. Configuration that is
// frozen when a module first loads cannot be changed without a restart, which
// makes the send path untestable and makes a mid-flight credential rotation a
// deploy rather than an environment change.
function resendApiKey() {
  return process.env.RESEND_API_KEY;
}
function emailFrom() {
  return process.env.EMAIL_FROM || 'Naseeb <onboarding@resend.dev>';
}

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
// `strict: true` makes a failure throw instead of being swallowed. The default
// stays best-effort, because a failed "you're entered" notice should not undo
// an entry — but the claim outbox has to know whether a send worked in order to
// retry it, and a helper that always resolves cannot tell it.
async function sendEmail({ to, subject, html, sensitive = false, strict = false }) {
  const apiKey = resendApiKey();
  if (!apiKey) {
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
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: emailFrom(), to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const message = `Failed to send email "${subject}": ${res.status}`;
      // The provider's response body routinely quotes the recipient address
      // back; it is useful in a log but must not become an error message that
      // gets stored.
      console.error(`${message} ${body}`);
      if (strict) throw new Error(message);
    }
    return { delivered: true };
  } catch (err) {
    if (strict) throw err;
    console.error(`Failed to send email "${subject}" to ${to}:`, err);
  }
  return { delivered: false };
}

function escapeHtmlForEmail(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { sendEmail, escapeHtmlForEmail };
