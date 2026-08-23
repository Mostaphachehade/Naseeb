  // The advertising price is the one real price on this page, so it is read
  // from the server rather than typed into the markup where it can drift.
  fetch('/api/ads/availability')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.pricePerWeekDisplay) return;
      // The price is isolated: it is a Latin-digit run with a currency code,
      // and dropped raw into an Arabic line the bidi algorithm moves the
      // separator to the wrong end of it.
      document.getElementById('ad-price').textContent = t('pricing.perWeek', {
        price: isolate(data.pricePerWeekDisplay),
      });
    })
    .catch(() => {});
