
  const locale = window.NaseebI18n.getLang() === 'ar' ? 'ar-AE' : 'en-GB';

  const ready = requireSession('/owner.html');

  // ---- Quick-host ----
  let qhCloudinaryConfig = null;
  fetch('/api/config').then((r) => r.json()).then((config) => {
    if (config.cloudinary_cloud_name && config.cloudinary_upload_preset) {
      qhCloudinaryConfig = config;
      document.getElementById('qh-image-upload-row').classList.remove('is-hidden');
    }
  }).catch(() => {});

  document.getElementById('qh_image_file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !qhCloudinaryConfig) return;
    const statusEl = document.getElementById('qh-upload-status');
    statusEl.textContent = t('owner.uploading');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', qhCloudinaryConfig.cloudinary_upload_preset);
    try {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${qhCloudinaryConfig.cloudinary_cloud_name}/image/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Upload failed.');
      const preview = document.getElementById('qh-image-preview');
      if (!NaseebDom.setMediaSrc(preview, data.secure_url)) {
        statusEl.textContent = t('owner.uploadReturnedAnImage');
        return;
      }
      document.getElementById('qh_image_url').value = data.secure_url;
      preview.classList.remove('is-hidden');
      statusEl.textContent = t('owner.uploaded');
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  // Default the deadline to a week out so the field isn't left empty.
  (function () {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    document.getElementById('qh_entry_deadline').value = d.toISOString().slice(0, 10);
  })();

  document.getElementById('quick-host-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('qh-error');
    const successEl = document.getElementById('qh-success');
    errorEl.classList.remove('show');
    successEl.classList.remove('show');
    const deadline = document.getElementById('qh_entry_deadline').value;
    try {
      await api('/giveaways', {
        method: 'POST',
        body: JSON.stringify({
          title: document.getElementById('qh_title').value,
          description: document.getElementById('qh_description').value,
          prize_description: document.getElementById('qh_prize_description').value,
          estimated_value_aed: document.getElementById('qh_estimated_value_aed').value || null,
          image_url: document.getElementById('qh_image_url').value || null,
          funded_by: document.getElementById('qh_funded_by').value,
          entry_deadline: new Date(`${deadline}T23:59:59`).toISOString(),
        }),
      });
      e.target.reset();
      document.getElementById('qh-image-preview').classList.add('is-hidden');
      document.getElementById('qh_funded_by').value = 'Naseeb marketing budget';
      successEl.textContent = t('owner.publishedLiveOnThe');
      successEl.classList.add('show');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });

  // ---- Ad revenue ----
  async function loadRevenue() {
    const content = document.getElementById('revenue-content');
    try {
      const r = await api('/admin/revenue');

      // business_name is advertiser-supplied — it arrives from the inquiry form
      // and is echoed straight back here. It is a cell's text, not a cell's
      // markup.
      const monthRows = r.by_month.map((m) => el('tr', {}, [
        td(m.month),
        td(m.bookings, 'mono'),
        td('AED ' + m.revenue_aed.toLocaleString(), 'mono'),
      ]));
      const bookingRows = r.recent_bookings.map((b) => el('tr', {}, [
        td(b.business_name),
        td(t('owner.aedAmount', { amount: Number(b.amount_aed).toLocaleString(locale) }), 'mono'),
        td(`${b.starts_at} – ${b.ends_at}`),
      ]));

      mount(content, [
        el('div', { class: 'admin-dashboard u-8b9688e6' }, [
          statCard(t('owner.aedAmount', { amount: isolate(r.total_revenue_aed.toLocaleString(locale)) }), t('owner.statTotalAdRevenue')),
          statCard(r.total_bookings, t('owner.statPaidBookings')),
          statCard(t('owner.aedAmount', { amount: isolate(r.revenue_last_30_days_aed.toLocaleString(locale)) }), t('owner.statLast30Days')),
        ]),
        dataTable([t('owner.colMonth'), t('owner.colBookings'), t('owner.colRevenue')], monthRows, t('owner.noRevenueYet'), 'u-7dde5e56'),
        el('p', { class: 'u-5bf9ad33', text: t('owner.recentBookings') }),
        dataTable([t('owner.colBusiness'), t('owner.colAmount'), t('owner.colDates')], bookingRows, t('owner.noBookingsYet')),
      ]);
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  // ---- Site settings ----
  let maintenanceModeValue = 'false';
  document.querySelectorAll('#maintenance-toggle .segmented-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      maintenanceModeValue = btn.dataset.value;
      document.querySelectorAll('#maintenance-toggle .segmented-option').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
    });
  });

  async function loadSettings() {
    try {
      const s = await api('/admin/settings');
      document.getElementById('s_ad_price').value = s.ad_price_per_week_aed;
      document.getElementById('s_maintenance_message').value = s.maintenance_message;
      maintenanceModeValue = s.maintenance_mode;
      document.querySelectorAll('#maintenance-toggle .segmented-option').forEach((b) => {
        const isActive = b.dataset.value === maintenanceModeValue;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    } catch (err) {
      document.getElementById('settings-error').textContent = err.message;
      document.getElementById('settings-error').classList.add('show');
    }
  }

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('settings-error');
    const successEl = document.getElementById('settings-success');
    errorEl.classList.remove('show');
    successEl.classList.remove('show');
    try {
      await api('/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ad_price_per_week_aed: document.getElementById('s_ad_price').value,
          maintenance_mode: maintenanceModeValue,
          maintenance_message: document.getElementById('s_maintenance_message').value,
        }),
      });
      successEl.textContent = t('owner.saved');
      successEl.classList.add('show');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });

  ready.then(() => {
    loadRevenue();
    loadSettings();
  });
