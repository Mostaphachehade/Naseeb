  let nextAvailableDate = null;
  // Fail closed: nothing shows a payment form until the server has said, in
  // this response, that checkout is on.
  let checkoutEnabled = false;

  // The current server quote: the weekly rate, every duration with its own
  // server-calculated total, and the version identifying which price these
  // came from. There is no price constant anywhere on this page — if this is
  // null, the page has no prices to show and cannot check out.
  let quote = null;
  // Set when the server rejects a checkout because the price moved. The
  // customer has to look at the new total and submit again.
  let awaitingPriceConfirmation = false;

  async function loadAvailability() {
    try {
      const availability = await api('/ads/availability');
      checkoutEnabled = availability.checkoutEnabled === true;
      nextAvailableDate = availability.nextAvailableDate;
      applyQuote(availability);
      // The page's language, not the browser's: toLocaleDateString(undefined)
      // reads the operating system's locale and puts an English date in the
      // middle of an Arabic sentence.
      const locale = getLang() === 'ar' ? 'ar-AE' : 'en-GB';
      const formatted = new Date(nextAvailableDate + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
      document.getElementById('next-available').textContent = formatted;
      document.getElementById('form-start-date').textContent = formatted;
    } catch (err) {
      checkoutEnabled = false;
      document.getElementById('next-available').textContent = t('advertise.now');
    }
    applyCheckoutState();
  }

  // Renders a server quote. Every number here arrives already calculated and
  // already formatted — the page picks strings out of the response and puts
  // them on screen, and at no point multiplies a rate by a duration itself.
  function applyQuote(next, { keepSelection = true } = {}) {
    if (!next || !Array.isArray(next.durations) || !next.durations.length) return;

    const select = document.getElementById('weeks');
    const previous = keepSelection && select.value ? Number(select.value) : null;
    quote = next;

    document.getElementById('week-price').textContent = quote.pricePerWeekDisplay;

    clear(select);
    quote.durations.forEach((duration) => {
      const option = document.createElement('option');
      option.value = String(duration.weeks);
      option.textContent = duration.label;
      option.dataset.totalDisplay = duration.totalDisplay;
      select.appendChild(option);
    });

    const wanted = quote.durations.some((d) => d.weeks === previous) ? previous : quote.durations[0].weeks;
    select.value = String(wanted);
    renderTotal();
  }

  function renderTotal() {
    if (!quote) return;
    const weeks = Number(document.getElementById('weeks').value);
    const duration = quote.durations.find((d) => d.weeks === weeks);
    if (duration) document.getElementById('total-price').textContent = duration.totalDisplay;
  }

  // Swaps the page between self-serve booking and inquiry-only. The inquiry
  // form is untouched in both states — it's the fallback that keeps the slot
  // sellable while online payment is paused.
  function applyCheckoutState() {
    const form = document.getElementById('ad-form');
    const notice = document.getElementById('checkout-unavailable');

    if (checkoutEnabled) {
      notice.classList.add('is-hidden');
      form.classList.remove('is-hidden');
      return;
    }

    notice.classList.remove('is-hidden');
    form.classList.add('is-hidden');
    document.getElementById('pricing-badge').textContent = t('advertise.bookedByInquiry');
    document.getElementById('inquiry-heading').textContent = t('advertise.bookTheBannerSlot');
    document.getElementById('inquiry-subheading').textContent =
      t('advertise.tellUsYourDates');
  }

  document.getElementById('weeks').addEventListener('change', renderTotal);

  let cloudinaryConfig = null;
  fetch('/api/config').then((r) => r.json()).then((config) => {
    if (config.cloudinary_cloud_name && config.cloudinary_upload_preset) {
      cloudinaryConfig = config;
      document.getElementById('image-upload-row').classList.remove('is-hidden');
      document.getElementById('image-url-hint').textContent = t('advertise.uploadOrPasteUrl');
    }
  }).catch(() => {});

  document.getElementById('image_file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !cloudinaryConfig) return;
    const statusEl = document.getElementById('upload-status');
    statusEl.textContent = t('advertise.uploading');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', cloudinaryConfig.cloudinary_upload_preset);
    try {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudinary_cloud_name}/image/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || t('advertise.uploadFailed'));
      const preview = document.getElementById('image-preview');
      if (!NaseebDom.setMediaSrc(preview, data.secure_url)) {
        statusEl.textContent = t('advertise.uploadAddressRejected');
        return;
      }
      document.getElementById('image_url').value = data.secure_url;
      preview.classList.remove('is-hidden');
      statusEl.textContent = t('advertise.uploaded');
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  document.getElementById('ad-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    const btn = document.getElementById('checkout-btn');
    errorEl.classList.remove('show');

    // The form is hidden when checkout is off, so this is belt-and-braces
    // against a stale page left open across a deploy that turned it off.
    if (!checkoutEnabled) {
      applyCheckoutState();
      return;
    }

    if (!quote) {
      errorEl.textContent = 'Prices are still loading. Give it a moment and try again.';
      errorEl.classList.add('show');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Starting checkout…';

    // Deliberately sends no price and no total — only which duration was
    // chosen, and which quote the customer was looking at when they chose it.
    // The server works out what that costs.
    const payload = {
      business_name: document.getElementById('business_name').value,
      contact_email: document.getElementById('contact_email').value,
      image_url: document.getElementById('image_url').value,
      target_url: document.getElementById('target_url').value,
      weeks: Number(document.getElementById('weeks').value),
      quote_version: quote.quoteVersion,
    };

    let res;
    try {
      res = await fetch('/api/ads/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      errorEl.textContent = 'Could not reach the server. Please try again.';
      errorEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Continue to payment';
      return;
    }

    const data = await res.json().catch(() => ({}));

    // The owner changed the price while this form was open. Nothing has been
    // held and nothing has been charged; show the new total and make the
    // customer agree to it before trying again.
    if (res.status === 409 && data.code === 'PRICE_CHANGED') {
      applyQuote(data.quote);
      awaitingPriceConfirmation = true;

      const weeks = Number(document.getElementById('weeks').value);
      const duration = quote.durations.find((d) => d.weeks === weeks);
      const notice = document.getElementById('price-changed-notice');
      notice.textContent = `${data.error} The new total for ${weeks} week${weeks > 1 ? 's' : ''} is ${duration ? duration.totalDisplay : quote.pricePerWeekDisplay + ' per week'}.`;
      notice.classList.remove('is-hidden');

      btn.disabled = false;
      btn.textContent = 'Confirm new price and continue';
      return;
    }

    if (!res.ok) {
      errorEl.textContent = data.error || 'Something went wrong. Please try again.';
      errorEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = awaitingPriceConfirmation ? 'Confirm new price and continue' : 'Continue to payment';
      return;
    }

    document.getElementById('price-changed-notice').classList.add('is-hidden');
    awaitingPriceConfirmation = false;
    // Stripe's hosted checkout, relayed by our API. Checked against the one
    // origin it may be, because "our API said so" is not a property of a URL.
    if (!NaseebDom.navigateToCheckout(data.checkoutUrl)) {
      errorEl.textContent = 'Checkout is unavailable right now. Please try again later.';
      errorEl.classList.add('show');
      btn.disabled = false;
    }
  });

  document.getElementById('inquiry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('inquiry-error');
    errorEl.classList.remove('show');
    try {
      await api('/ad-inquiries', {
        method: 'POST',
        body: JSON.stringify({
          business_name: document.getElementById('inq_business_name').value,
          contact_email: document.getElementById('inq_contact_email').value,
          message: document.getElementById('inq_message').value || null,
        }),
      });
      document.getElementById('inquiry-form').classList.add('is-hidden');
      document.getElementById('inquiry-success').textContent = "Got it — we'll be in touch.";
      document.getElementById('inquiry-success').classList.add('show');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const sessionId = params.get('session_id');

    if (status === 'success' && sessionId) {
      document.getElementById('booking-flow').classList.add('is-hidden');
      document.getElementById('processing-panel').classList.remove('is-hidden');
      try {
        const booking = await api(`/ads/checkout/confirm?session_id=${encodeURIComponent(sessionId)}`);
        document.getElementById('processing-panel').classList.add('is-hidden');
        document.getElementById('success-panel').classList.remove('is-hidden');

        const runs = `${new Date(booking.starts_at + 'T00:00:00').toLocaleDateString()} – ${new Date(booking.ends_at + 'T00:00:00').toLocaleDateString()}`;

        // This page no longer decides whether the payment succeeded — it only
        // reports what the confirmed booking record says. Stripe's webhook is
        // what marks a booking paid, and it can land a moment after the
        // customer gets redirected here, so "not paid yet" is a normal state to
        // show rather than an error.
        if (booking.paid) {
          document.getElementById('success-details').textContent =
            `${booking.business_name}'s banner runs ${runs} (${booking.amountDisplay} paid).`;
        } else {
          document.getElementById('success-heading').textContent = 'Payment received — confirming';
          document.getElementById('success-details').textContent =
            `We're waiting for your bank to confirm the payment. Once it clears, ${booking.business_name}'s banner is scheduled for ${runs}.`;
          document.getElementById('success-note').textContent =
            "This usually takes a few seconds. You'll get an email as soon as it's confirmed — you don't need to stay on this page or pay again.";
        }
      } catch (err) {
        document.getElementById('processing-panel').classList.add('is-hidden');
        document.getElementById('booking-flow').classList.remove('is-hidden');
        document.getElementById('error').textContent = err.message;
        document.getElementById('error').classList.add('show');
      }
      return;
    }

    if (status === 'cancelled') {
      document.getElementById('cancelled-notice').classList.remove('is-hidden');
    }

    loadAvailability();
  }

  init();
