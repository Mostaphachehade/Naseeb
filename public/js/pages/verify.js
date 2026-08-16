  async function run() {
    const content = document.getElementById('content');
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      content.innerHTML = `<h2>Missing link</h2><p class="u-a2aae0fb">This verification link is missing its token. Use the link from your email, or request a new one from your dashboard.</p>`;
      return;
    }
    try {
      const res = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

      // Nothing is written client-side. The account's verified flag lives in
      // Postgres, and the next page load reads it back from /auth/session
      // rather than trusting a copy this page edited.

      content.innerHTML = `
        <h2>You're verified.</h2>
        <p class="u-a2aae0fb">${escapeHtml(data.message)}</p>
        <a href="/index.html" class="btn primary u-8a359a76">Continue to Naseeb</a>
      `;
    } catch (err) {
      content.innerHTML = `<h2>Couldn't verify</h2><p class="u-a2aae0fb">${escapeHtml(err.message)}</p>`;
    }
  }
  run();
