const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Naseeb <onboarding@resend.dev>';

// Best-effort send — never throws. Without RESEND_API_KEY configured (local
// dev by default), this just logs what would have been sent so the rest of
// the flow (signup, password reset, etc.) still works without a real inbox.
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
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

module.exports = { sendEmail };
