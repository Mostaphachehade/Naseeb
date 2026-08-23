  // Every string a person can end up reading here comes from the dictionary or
  // from the server. Nothing is written in English at the point of display: an
  // Arabic page that renders correctly and then replaces its own text with
  // English the moment a request resolves is worse than one that was never
  // translated, because the reader watches it happen.
  const t = (key) => window.NaseebI18n.t(key);

  async function run() {
    const content = document.getElementById('content');
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      mount(content, [
        el('h2', { text: t('verify.missingLink') }),
        el('p', { class: 'u-a2aae0fb', text: t('verify.missingLinkBody') }),
      ]);
      return;
    }
    try {
      const res = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('common.somethingWentWrong'));

      // Nothing is written client-side. The account's verified flag lives in
      // Postgres, and the next page load reads it back from /auth/session
      // rather than trusting a copy this page edited.

      mount(content, [
        el('h2', { text: t('verify.youreVerified') }),
        // A server-supplied message, so text rather than markup.
        el('p', { class: 'u-a2aae0fb', text: data.message }),
        el('a', {
          href: '/index.html',
          class: 'btn primary u-8a359a76',
          text: t('verify.continueToNaseeb'),
        }),
      ]);
    } catch (err) {
      mount(content, [
        el('h2', { text: t('verify.couldntVerify') }),
        el('p', { class: 'u-a2aae0fb', text: err.message }),
      ]);
    }
  }
  run();
