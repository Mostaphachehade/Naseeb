  async function run() {
    const content = document.getElementById('content');
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      mount(content, [
        el('h2', { text: 'Missing link' }),
        el('p', {
          class: 'u-a2aae0fb',
          text: 'This verification link is missing its token. Use the link from your email, or request a new one from your dashboard.',
        }),
      ]);
      return;
    }
    try {
      const res = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

      // Nothing is written client-side. The account's verified flag lives in
      // Postgres, and the next page load reads it back from /auth/session
      // rather than trusting a copy this page edited.

      mount(content, [
        el('h2', { text: "You're verified." }),
        // A server-supplied message, so text rather than markup.
        el('p', { class: 'u-a2aae0fb', text: data.message }),
        el('a', { href: '/index.html', class: 'btn primary u-8a359a76', text: 'Continue to Naseeb' }),
      ]);
    } catch (err) {
      mount(content, [
        el('h2', { text: "Couldn't verify" }),
        el('p', { class: 'u-a2aae0fb', text: err.message }),
      ]);
    }
  }
  run();
