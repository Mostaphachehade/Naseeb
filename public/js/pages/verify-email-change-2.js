  (async () => {
    const content = document.getElementById('content');
    const token = window.__emailChangeToken;
    // Held in memory only for the length of this request, then dropped.
    window.__emailChangeToken = null;

    if (!token) {
      mount(content, [
        el('h2', { text: 'Missing link' }),
        el('p', {
          class: 'u-a2aae0fb',
          text: 'This confirmation link is missing its token. Use the link from the email we sent to your new address, or start the change again from your account.',
        }),
        el('a', { href: '/account.html', class: 'btn primary u-8a359a76', text: 'Go to your account' }),
      ]);
      return;
    }

    try {
      const result = await api('/account/email-change/confirm', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      // Every session ended server-side, including this page's. Forget the
      // in-memory copy so the header renders as signed out rather than
      // pretending otherwise.
      forgetSession();
      mount(content, [
        el('h2', { text: 'Email address changed' }),
        el('p', { class: 'u-a2aae0fb', text: result.note }),
        el('a', { href: '/login.html', class: 'btn primary u-8a359a76', text: 'Sign in' }),
      ]);
    } catch (err) {
      mount(content, [
        el('h2', { text: "Couldn't confirm" }),
        el('p', { class: 'u-a2aae0fb', text: err.message }),
        el('a', { href: '/account.html', class: 'btn ghost u-8a359a76', text: 'Back to your account' }),
      ]);
    }
  })();
