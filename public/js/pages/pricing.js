  // The advertising price is the one real price on this page, so it is read
  // from the server rather than typed into the markup where it can drift.
  fetch('/api/ads/availability')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.pricePerWeekDisplay) return;
      document.getElementById('ad-price').textContent = `${data.pricePerWeekDisplay} / week`;
    })
    .catch(() => {});
