  // Renders the policy's real status. A draft never shows an effective date:
  // showing a reader a date under that heading is exactly the claim this page
  // must not make.
  //
  // Everything written here replaces text that applyI18n() already translated,
  // so all of it has to be translated too — otherwise the Arabic page loads
  // correctly and then reverts to English a moment later, which is worse than
  // never translating it at all.
  //
  // The date is formatted in the page's language rather than the browser's.
  // toLocaleDateString(undefined, …) asks the browser, and the browser answers
  // with the operating system's locale — so an Arabic page on an English laptop
  // printed "15 August 2026" in the middle of an Arabic sentence, and an English
  // page on an Arabic laptop printed the reverse.
  api('/config')
    .then((config) => {
      const policy = config.policies && config.policies.privacy;
      if (!policy) return;
      const i18n = window.NaseebI18n;
      const lang = i18n ? i18n.getLang() : 'en';
      const locale = lang === 'ar' ? 'ar-AE' : 'en-GB';
      const t = (key, fallback) => {
        if (!i18n) return fallback;
        const value = i18n.t(key);
        // t() returns the key itself when it has no entry; showing a reader
        // "policy.statusDraft" would be worse than showing them English.
        return value === key ? fallback : value;
      };
      const asDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });

      // Not translated: a version identifier is the string that names the
      // document, and a translated one names nothing.
      document.getElementById('policy-version').textContent = policy.version;
      document.getElementById('policy-status-pill').textContent =
        t('policy.status.' + policy.status, policy.status.toUpperCase());
      if (policy.draftRevisedAt) {
        document.getElementById('policy-revised').textContent = asDate(policy.draftRevisedAt);
      }
      document.getElementById('policy-effective').textContent = policy.effectiveDate
        ? asDate(policy.effectiveDate)
        : t('policy.notYetEffective', 'not yet effective');
    })
    .catch(() => {
      // Left as the markup's own text, which already says draft and not yet
      // effective. Swallowed rather than reported because the fallback is the
      // honest answer, not a guess.
    });
