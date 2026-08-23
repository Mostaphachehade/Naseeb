  (async () => {
      const content = document.getElementById('content');
    const token = window.__emailChangeToken;
    // Held in memory only for the length of this request, then dropped.
    window.__emailChangeToken = null;

    if (!token) {
      mount(content, [
        el('h2', { text: t('verifyemailchange.missingLink') }),
        el('p', { class: 'u-a2aae0fb', text: t('verifyemailchange.missingLinkBody') }),
        el('a', {
          href: '/account.html',
          class: 'btn primary u-8a359a76',
          text: t('verifyemailchange.goToYourAccount'),
        }),
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
        el('h2', { text: t('verifyemailchange.emailAddressChanged') }),
        el('p', { class: 'u-a2aae0fb', text: result.note }),
        el('a', {
          href: '/login.html',
          class: 'btn primary u-8a359a76',
          text: t('nav.signIn'),
        }),
      ]);
    } catch (err) {
      mount(content, [
        el('h2', { text: t('verifyemailchange.couldntConfirm') }),
        el('p', { class: 'u-a2aae0fb', text: err.message }),
        el('a', {
          href: '/account.html',
          class: 'btn ghost u-8a359a76',
          text: t('verifyemailchange.backToYourAccount'),
        }),
      ]);
    }
  })();
