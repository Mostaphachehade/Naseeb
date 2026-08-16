  // Cosmetic only. Every route this page calls re-reads users.is_admin from
  // Postgres on the request, so reaching this page without being an
  // administrator produces a screen full of 403s rather than an admin panel.
  const ready = requireSession('/admin.html');


  async function loadStats() {
    const content = document.getElementById('stats-content');
    try {
      const s = await api('/admin/stats');
      const cards = [
        { num: s.pending_host_applications, label: 'Pending applications', attention: s.pending_host_applications > 0 },
        { num: s.pending_ad_inquiries, label: 'Pending ad inquiries', attention: s.pending_ad_inquiries > 0 },
        { num: s.live_giveaways, label: 'Live giveaways' },
        { num: s.total_hosts, label: 'Total hosts' },
        { num: s.verified_hosts, label: 'Verified hosts' },
        { num: s.approved_hosts, label: 'Approved hosts' },
        { num: s.suspended_hosts, label: 'Suspended hosts', attention: s.suspended_hosts > 0 },
        { num: s.active_ad ? s.active_ad.click_count : '—', label: s.active_ad ? `Clicks — ${escapeHtml(s.active_ad.business_name)}` : 'No active ad' },
      ];
      content.innerHTML = cards.map((c) => `
        <div class="admin-stat ${c.attention ? 'attention' : ''}">
          <div class="admin-stat-num">${c.num}</div>
          <div class="admin-stat-label">${c.label}</div>
        </div>
      `).join('');
    } catch (err) {
      content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  // The queue deliberately carries no email address, no phone number, no trade
  // licence and no free-text message. A list is a screen that gets left open and
  // scrolled past; none of those fields help decide which application to open.
  // They arrive with the detail fetch below, when an administrator opens one.
  const STATUS_LABELS = {
    pending: 'Waiting for review',
    approved: 'Approved',
    rejected: 'Not approved',
    withdrawn: 'Withdrawn',
  };

  function appRow(a) {
    const typeBadge = `<span class="pill-badge ${a.applicant_type === 'company' ? 'company' : ''}">${escapeHtml(a.applicant_type)}</span>`;
    const statusBadge = `<span class="pill-badge">${escapeHtml(STATUS_LABELS[a.status] || a.status)}</span>`;
    const submitted = new Date(a.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const decided = a.decided_at
      ? `${new Date(a.decided_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}${a.decided_by_name ? ` by ${escapeHtml(a.decided_by_name)}` : ''}`
      : '<span class="u-a2aae0fb">—</span>';
    const legacy = a.user_id
      ? ''
      : '<br><span class="u-73c3c8ab">Legacy enquiry — no account attached</span>';
    return `
      <tr class="${a.status !== 'pending' ? 'contacted' : ''}" data-id="${a.id}">
        <td>${typeBadge}</td>
        <td>${escapeHtml(a.display_name || '—')}${legacy}</td>
        <td>${statusBadge}</td>
        <td>${submitted}</td>
        <td>${decided}</td>
        <td class="u-a9efa544">
          <button class="btn ghost app-open-btn u-51820e15">Review</button>
          ${a.status === 'pending' ? '<button class="btn ghost app-close-btn u-51820e15">Close without deciding</button>' : ''}
        </td>
      </tr>
      <tr class="app-detail-row u-c8be1ccb is-hidden" data-detail-for="${a.id}"><td colspan="6"></td></tr>
    `;
  }

  async function openApplication(id) {
    const cell = document.querySelector(`tr[data-detail-for="${id}"] td`);
    const row = cell.parentElement;
    if (!row.classList.contains('is-hidden')) {
      row.classList.add('is-hidden');
      return;
    }
    row.classList.remove('is-hidden');
    cell.innerHTML = 'Loading…';
    try {
      const a = await api(`/admin/host-applications/${id}`);
      const decided = a.status !== 'pending';
      cell.innerHTML = `
        <div class="u-1b074808">
          <p class="u-a353e69c"><strong>${escapeHtml(a.business_name || a.full_name)}</strong>${a.business_name ? ` — contact: ${escapeHtml(a.full_name)}` : ''}</p>
          <p class="u-3e786f67">
            ${escapeHtml(a.account_email || a.contact_email || '—')}${a.contact_phone ? ` · ${escapeHtml(a.contact_phone)}` : ''}${a.trade_license ? ` · licence ${escapeHtml(a.trade_license)}` : ''}
          </p>
          ${a.plan ? `<p class="u-06519697">Submitted against the withdrawn "${escapeHtml(a.plan)}" plan, before hosting plans were removed.</p>` : ''}
          ${a.message ? `<p class="u-f06aec11">${escapeHtml(a.message)}</p>` : ''}
          <p class="u-acb85f03">Account host status: <strong>${escapeHtml(a.host_status || 'no account')}</strong></p>
          ${decided
            ? `<p class="u-45314556">${escapeHtml(STATUS_LABELS[a.status] || a.status)} on ${new Date(a.decided_at).toLocaleString()}${a.decided_by_name ? ` by ${escapeHtml(a.decided_by_name)}` : ''}${a.decision_reason ? ` — "${escapeHtml(a.decision_reason)}"` : ''}</p>`
            : `<label for="reason-${a.id}" class="u-1964b55e">Reason (recorded against this decision, and shown to the applicant)</label>
               <input id="reason-${a.id}" class="decision-reason" maxlength="1000" placeholder="Why this decision?" />
               <div class="u-d8a81eac">
                 <button class="btn primary decide-btn u-14da4875" data-decision="approved" data-id="${a.id}">Approve to host</button>
                 <button class="btn ghost decide-btn u-a716ef8e" data-decision="rejected" data-id="${a.id}">Do not approve</button>
               </div>
               <p class="hint u-b1ecc496">Approving is the only thing that grants host access. Nothing else on this page does.</p>`}
        </div>
      `;
      cell.querySelectorAll('.decide-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const reason = cell.querySelector('.decision-reason').value;
          if (!reason.trim()) {
            alert('A short reason is required — it is recorded against the decision.');
            return;
          }
          btn.disabled = true;
          try {
            await api(`/admin/host-applications/${btn.dataset.id}/decision`, {
              method: 'POST',
              body: JSON.stringify({ decision: btn.dataset.decision, reason }),
            });
            load();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      cell.innerHTML = `<span class="form-error show">${escapeHtml(err.message)}</span>`;
    }
  }

  async function load() {
    const content = document.getElementById('content');
    try {
      const applications = await api('/admin/host-applications');
      if (applications.length === 0) {
        content.innerHTML = `<div class="empty">No applications yet.</div>`;
        return;
      }
      content.innerHTML = `
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Type</th><th>Who</th><th>Status</th><th>Submitted</th><th>Decided</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>${applications.map(appRow).join('')}</tbody>
          </table>
        </div>
      `;
      content.querySelectorAll('.app-open-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => openApplication(e.target.closest('tr').dataset.id));
      });
      // Closes, never deletes. The row, its submission time, the account it
      // belongs to and its status events all stay exactly where they are —
      // "it was only spam" is a judgement that becomes unreviewable the moment
      // the evidence for it is gone.
      content.querySelectorAll('.app-close-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const reason = prompt('Why is this application being closed without a decision? Recorded against the application.');
          if (reason === null) return;
          if (!reason.trim()) { alert('A short reason is required.'); return; }
          const id = e.target.closest('tr').dataset.id;
          btn.disabled = true;
          try {
            await api(`/admin/host-applications/${id}/close`, {
              method: 'POST',
              body: JSON.stringify({ reason }),
            });
            load();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function adInquiryRow(a) {
    return `
      <tr class="${a.contacted ? 'contacted' : ''}" data-id="${a.id}">
        <td>${escapeHtml(a.business_name)}</td>
        <td>${escapeHtml(a.contact_email)}${a.contact_phone ? `<br><span class="u-c2238623">${escapeHtml(a.contact_phone)}</span>` : ''}</td>
        <td class="u-71b5af5d">${a.message ? escapeHtml(a.message) : '<span class="u-a2aae0fb">—</span>'}</td>
        <td>${new Date(a.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
        <td class="u-a9efa544">
          <button class="btn ghost inquiry-contacted-btn u-51820e15" data-contacted="${a.contacted}">${a.contacted ? 'Mark not contacted' : 'Mark contacted'}</button>
          <button class="btn ghost inquiry-delete-btn u-54750247">Delete</button>
        </td>
      </tr>
    `;
  }

  async function loadAdInquiries() {
    const content = document.getElementById('ad-inquiries-content');
    try {
      const inquiries = await api('/admin/ad-inquiries');
      if (inquiries.length === 0) {
        content.innerHTML = `<div class="empty">No ad inquiries yet.</div>`;
        return;
      }
      content.innerHTML = `
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Business</th><th>Contact</th><th>Message</th><th>Submitted</th><th>Actions</th></tr></thead>
            <tbody>${inquiries.map(adInquiryRow).join('')}</tbody>
          </table>
        </div>
      `;
      content.querySelectorAll('.inquiry-contacted-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          const nextContacted = btn.dataset.contacted !== 'true';
          btn.disabled = true;
          try {
            await api(`/admin/ad-inquiries/${id}`, { method: 'PATCH', body: JSON.stringify({ contacted: nextContacted }) });
            loadAdInquiries();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
      content.querySelectorAll('.inquiry-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          if (!confirm('Delete this inquiry? This cannot be undone.')) return;
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          btn.disabled = true;
          try {
            await api(`/admin/ad-inquiries/${id}`, { method: 'DELETE' });
            loadAdInquiries();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function adStatusCell(a) {
    if (a.paid) {
      // starts_at/ends_at arrive as full ISO datetime strings (Postgres
      // DATE values serialize with a time component in JSON) — slice to
      // the date portion before comparing or displaying.
      const startsAt = a.starts_at.slice(0, 10);
      const endsAt = a.ends_at.slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const isLive = startsAt <= today && endsAt >= today;
      const label = isLive ? 'live' : (startsAt > today ? 'upcoming' : 'finished');
      return `<span class="pill-badge company">paid · ${label}</span><br><span class="hint u-b98cacf2">${startsAt} – ${endsAt} · AED ${Number(a.amount_aed).toLocaleString()}</span>`;
    }
    if (a.stripe_session_id) {
      return `<span class="pill-badge">checkout pending</span>`;
    }
    return a.active ? '<span class="pill-badge company">active</span>' : '<span class="pill-badge">inactive</span>';
  }

  function adRow(a) {
    const thumb = a.media_type === 'video'
      ? `<video src="${escapeHtml(a.image_url)}" muted class="u-6e0bccff"></video>`
      : `<img src="${escapeHtml(a.image_url)}" alt="" class="u-6e0bccff" />`;
    // Self-serve paid bookings are scheduled by date, not hand-toggled —
    // only manually-created admin ads get the activate/deactivate button.
    const isManual = !a.paid && !a.stripe_session_id;
    return `
      <tr data-id="${a.id}">
        <td>${thumb}</td>
        <td>${escapeHtml(a.business_name)} ${a.media_type === 'video' ? '<span class="pill-badge">video</span>' : ''}</td>
        <td class="u-9f5261ae"><a href="${escapeHtml(a.target_url)}" target="_blank" rel="noopener">${escapeHtml(a.target_url)}</a></td>
        <td class="mono">${a.click_count}</td>
        <td>${adStatusCell(a)}</td>
        <td>
          ${isManual ? `<button class="btn ghost ad-toggle-btn u-cc20b935" data-active="${a.active}">${a.active ? 'Deactivate' : 'Activate'}</button>` : ''}
          <button class="btn ghost ad-delete-btn u-162e4030">Delete</button>
        </td>
      </tr>
    `;
  }

  async function loadAds() {
    const content = document.getElementById('ads-content');
    try {
      const ads = await api('/admin/ads');
      if (ads.length === 0) {
        content.innerHTML = `<div class="empty">No ads yet. Add one above.</div>`;
        return;
      }
      content.innerHTML = `
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Banner</th><th>Business</th><th>Destination</th><th>Clicks</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${ads.map(adRow).join('')}</tbody>
          </table>
        </div>
      `;
      content.querySelectorAll('.ad-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          const nextActive = btn.dataset.active !== 'true';
          btn.disabled = true;
          try {
            await api(`/admin/ads/${id}`, { method: 'PATCH', body: JSON.stringify({ active: nextActive }) });
            loadAds();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
      content.querySelectorAll('.ad-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          if (!confirm('Delete this ad? This cannot be undone.')) return;
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          btn.disabled = true;
          try {
            await api(`/admin/ads/${id}`, { method: 'DELETE' });
            loadAds();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  const GIVEAWAY_STATUS_CLASS = { active: 'company', cancelled: '', drawn: '' };

  function giveawayRow(g) {
    const deadline = new Date(g.entry_deadline).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const statusBadge = `<span class="pill-badge ${GIVEAWAY_STATUS_CLASS[g.status] || ''}">${escapeHtml(g.status)}</span>`;
    let action = '<span class="u-c2238623">—</span>';
    if (g.status === 'active') {
      action = `<button class="btn ghost giveaway-cancel-btn u-162e4030">Cancel</button>`;
    } else if (g.status === 'cancelled') {
      action = `<button class="btn ghost giveaway-reinstate-btn u-cc20b935">Reinstate</button>`;
    }
    return `
      <tr data-id="${g.id}">
        <td>${escapeHtml(g.title)}</td>
        <td>${escapeHtml(g.host_name)}<br><span class="u-c2238623">${escapeHtml(g.host_email)}</span></td>
        <td class="mono">${g.entry_count}</td>
        <td>${deadline}</td>
        <td>${statusBadge}</td>
        <td>${action}</td>
      </tr>
    `;
  }

  async function loadGiveaways() {
    const content = document.getElementById('giveaways-content');
    try {
      const giveaways = await api('/admin/giveaways');
      if (giveaways.length === 0) {
        content.innerHTML = `<div class="empty">No giveaways yet.</div>`;
        return;
      }
      content.innerHTML = `
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Title</th><th>Host</th><th>Entries</th><th>Deadline</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${giveaways.map(giveawayRow).join('')}</tbody>
          </table>
        </div>
      `;
      content.querySelectorAll('.giveaway-cancel-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          if (!confirm('Cancel this giveaway? Entrants will no longer be able to enter.')) return;
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          btn.disabled = true;
          try {
            await api(`/admin/giveaways/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
            loadGiveaways();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
      content.querySelectorAll('.giveaway-reinstate-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          btn.disabled = true;
          try {
            await api(`/admin/giveaways/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
            loadGiveaways();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function userRow(u) {
    const joined = new Date(u.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const deleteBtn = u.is_admin
      ? '<span class="u-c2238623">—</span>'
      : `<button class="btn ghost user-delete-btn u-54750247">Delete</button>`;
    return `
      <tr data-id="${u.id}">
        <td>${escapeHtml(u.name)}${u.is_admin ? ' <span class="pill-badge company">admin</span>' : ''}</td>
        <td>${escapeHtml(u.email)}</td>
        <td class="mono">${u.giveaways_hosted}</td>
        <td>${joined}</td>
        <td><input type="checkbox" class="verified-toggle" ${u.is_verified_business ? 'checked' : ''} /></td>
        <td>${hostStatusCell(u)}</td>
        <td class="u-a9efa544">${hostActions(u)} ${deleteBtn}</td>
      </tr>
    `;
  }

  const HOST_STATUS_LABELS = {
    not_requested: 'Never applied',
    pending: 'Waiting for review',
    approved: 'Approved',
    rejected: 'Not approved',
    suspended: 'Suspended',
  };

  function hostStatusCell(u) {
    const label = HOST_STATUS_LABELS[u.host_status] || u.host_status || '—';
    const when = u.host_status_changed_at
      ? `<br><span class="u-5e8e7900">${new Date(u.host_status_changed_at).toLocaleDateString()}</span>`
      : '';
    const exempt = u.is_admin
      ? '<br><span class="u-5e8e7900">admin — this gate does not apply</span>'
      : '';
    return `<span class="pill-badge">${escapeHtml(label)}</span>${when}${exempt}`;
  }

  function hostActions(u) {
    // Suspending and reinstating both need a reason, so both go through the
    // same prompt. Neither deletes anything.
    if (u.host_status === 'approved') {
      return `<button class="btn ghost host-status-btn u-51820e15" data-status="suspended">Suspend hosting</button>`;
    }
    if (u.host_status === 'suspended') {
      return `<button class="btn ghost host-status-btn u-51820e15" data-status="approved">Reinstate</button>`;
    }
    return `<button class="btn ghost host-status-btn u-51820e15" data-status="approved">Grant hosting</button>`;
  }

  async function loadUsers() {
    const content = document.getElementById('users-content');
    try {
      const users = await api('/admin/users');
      if (users.length === 0) {
        content.innerHTML = `<div class="empty">No accounts yet.</div>`;
        return;
      }
      content.innerHTML = `
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th>Hosted</th><th>Joined</th><th>Verified</th><th>Host access</th><th>Actions</th></tr></thead>
            <tbody>${users.map(userRow).join('')}</tbody>
          </table>
        </div>
      `;
      content.querySelectorAll('.verified-toggle').forEach((box) => {
        box.addEventListener('change', async (e) => {
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          const is_verified_business = e.target.checked;
          e.target.disabled = true;
          try {
            await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ is_verified_business }) });
          } catch (err) {
            e.target.checked = !is_verified_business;
            alert(err.message);
          } finally {
            e.target.disabled = false;
          }
        });
      });
      content.querySelectorAll('.host-status-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.closest('tr').dataset.id;
          const status = btn.dataset.status;
          const reason = prompt(
            status === 'suspended'
              ? 'Why is hosting being suspended? This is recorded against the change and shown to the account.'
              : 'Why is hosting being granted? This is recorded against the change and shown to the account.'
          );
          if (reason === null) return;
          if (!reason.trim()) {
            alert('A short reason is required.');
            return;
          }
          btn.disabled = true;
          try {
            const result = await api(`/admin/hosts/${id}/status`, {
              method: 'POST',
              body: JSON.stringify({ status, reason }),
            });
            if (result.open_claims_affected > 0) {
              alert(
                `${result.open_claims_affected} open prize claim(s) for this host are now handled by an administrator. ` +
                'Nothing was deleted — the winner can raise a dispute and an administrator resolves it.'
              );
            }
            loadUsers();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
      content.querySelectorAll('.user-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const row = e.target.closest('tr');
          const id = row.dataset.id;
          if (!confirm('Delete this host account? This cannot be undone.')) return;
          btn.disabled = true;
          try {
            await api(`/admin/users/${id}`, { method: 'DELETE' });
            loadUsers();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  let cloudinaryConfig = null;
  let adMediaType = 'image';

  fetch('/api/config').then((r) => r.json()).then((config) => {
    if (config.cloudinary_cloud_name && config.cloudinary_upload_preset) {
      cloudinaryConfig = config;
      document.getElementById('ad-image-upload-row').classList.remove('is-hidden');
      document.getElementById('ad-image-url-hint').textContent = 'Upload a file above, or paste a media URL.';
    }
  }).catch(() => {});

  document.querySelectorAll('#ad-media-type-toggle .segmented-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      adMediaType = btn.dataset.value;
      document.querySelectorAll('#ad-media-type-toggle .segmented-option').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      const isVideo = adMediaType === 'video';
      document.getElementById('ad-file-label').textContent = isVideo ? 'Banner video' : 'Banner image';
      document.getElementById('ad_image_file').accept = isVideo ? 'video/*' : 'image/*';
      document.getElementById('ad_image_file').value = '';
      document.getElementById('ad_image_url').value = '';
      document.getElementById('ad-image-preview').classList.add('is-hidden');
      document.getElementById('ad-video-preview').classList.add('is-hidden');
      document.getElementById('ad-upload-status').textContent = '';
    });
  });

  document.getElementById('ad_image_file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !cloudinaryConfig) return;
    const statusEl = document.getElementById('ad-upload-status');
    statusEl.textContent = 'Uploading…';
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', cloudinaryConfig.cloudinary_upload_preset);
    const resourceType = adMediaType === 'video' ? 'video' : 'image';
    try {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudinary_cloud_name}/${resourceType}/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Upload failed.');
      document.getElementById('ad_image_url').value = data.secure_url;
      const imgPreview = document.getElementById('ad-image-preview');
      const videoPreview = document.getElementById('ad-video-preview');
      if (adMediaType === 'video') {
        videoPreview.src = data.secure_url;
        videoPreview.classList.remove('is-hidden');
        imgPreview.classList.add('is-hidden');
      } else {
        imgPreview.src = data.secure_url;
        imgPreview.classList.remove('is-hidden');
        videoPreview.classList.add('is-hidden');
      }
      statusEl.textContent = 'Uploaded.';
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  document.getElementById('ad-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('ad-create-error');
    errorEl.classList.remove('show');
    try {
      await api('/admin/ads', {
        method: 'POST',
        body: JSON.stringify({
          business_name: document.getElementById('ad_business_name').value,
          image_url: document.getElementById('ad_image_url').value,
          target_url: document.getElementById('ad_target_url').value,
          media_type: adMediaType,
        }),
      });
      e.target.reset();
      document.getElementById('ad-image-preview').classList.add('is-hidden');
      document.getElementById('ad-video-preview').classList.add('is-hidden');
      loadAds();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });

  function wireSearch(inputId, containerId) {
    document.getElementById(inputId).addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase();
      document.querySelectorAll(`#${containerId} tbody tr`).forEach((row) => {
        row.classList.toggle('is-hidden', !row.textContent.toLowerCase().includes(term));
      });
    });
  }
  wireSearch('applications-search', 'content');
  wireSearch('hosts-search', 'users-content');

  function ageLabel(since) {
    if (!since) return '';
    const days = Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'} old`;
    const hours = Math.floor((Date.now() - new Date(since).getTime()) / 3600000);
    return `${hours} hour${hours === 1 ? '' : 's'} old`;
  }

  // ------------------------------------------------------------------
  // Suspended-host claim rescue
  // ------------------------------------------------------------------

  // What a rescuer may do from each state. Mirrors the server table in
  // server/lib/claimStateMachine.js; the server refuses anything else outright,
  // so this only decides which button to draw.
  const RESCUE_NEXT = {
    claimed: { to: 'preparing_delivery', label: 'Mark preparing delivery' },
    preparing_delivery: { to: 'shipped_or_arranged', label: 'Mark shipped / arranged' },
    shipped_or_arranged: { to: 'delivered_pending_confirmation', label: 'Report delivered — winner confirms' },
  };

  const CLAIM_STATE_LABELS = {
    awaiting_claim: 'Waiting for the winner to claim',
    claimed: 'Claimed — waiting on the host',
    preparing_delivery: 'Preparing delivery',
    shipped_or_arranged: 'Shipped or arranged',
    delivered_pending_confirmation: 'Waiting for the winner to confirm receipt',
    disputed: 'Disputed',
    expired: 'Claim window expired',
  };

  function rescueRow(r) {
    const next = r.action_available ? RESCUE_NEXT[r.claim_status] : null;
    const waiting = !next
      ? '<span class="u-c2238623">Nothing for you to do here — this one is waiting on the winner.</span>'
      : '';
    return `
      <tr data-claim="${r.claim_id}">
        <td>${escapeHtml(r.title)}<br><span class="u-a76e0798">host: ${escapeHtml(r.host_name)} · winner: ${escapeHtml(r.winner_name)}</span></td>
        <td><span class="pill-badge">${escapeHtml(CLAIM_STATE_LABELS[r.claim_status] || r.claim_status)}</span></td>
        <td>${new Date(r.opened_at).toLocaleDateString()}<br><span class="u-a76e0798">${escapeHtml(r.opened_reason || '')}</span></td>
        <td class="u-a9efa544">
          ${next ? `<button class="btn primary rescue-step u-51820e15" data-to="${next.to}">${next.label}</button>` : ''}
          ${r.delivery_available ? '<button class="btn ghost rescue-details u-51820e15">Open delivery details</button>' : '<span class="u-73c3c8ab">no details available</span>'}
          ${waiting}
        </td>
      </tr>
      <tr data-details-for="${r.claim_id}" class="u-c8be1ccb is-hidden"><td colspan="4"></td></tr>
    `;
  }

  async function loadRescueQueue() {
    const content = document.getElementById('rescue-content');
    try {
      const rows = await api('/claims/admin/rescue-queue');
      if (rows.length === 0) {
        content.innerHTML = '<div class="empty">No suspended host has an unfinished claim.</div>';
        return;
      }
      content.innerHTML = `
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Giveaway</th><th>Claim state</th><th>In the queue since</th><th>Actions</th></tr></thead>
            <tbody>${rows.map(rescueRow).join('')}</tbody>
          </table>
        </div>
      `;

      content.querySelectorAll('.rescue-step').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const claimId = e.target.closest('tr').dataset.claim;
          const reason = prompt('Why are you taking this step for the host? Recorded in the claim history.');
          if (reason === null) return;
          if (!reason.trim()) { alert('A short reason is required.'); return; }
          btn.disabled = true;
          try {
            await api(`/claims/${claimId}/rescue/transition`, {
              method: 'POST',
              body: JSON.stringify({ to: btn.dataset.to, reason }),
            });
            loadRescueQueue();
            loadClaims();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        });
      });

      content.querySelectorAll('.rescue-details').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const claimId = e.target.closest('tr').dataset.claim;
          const cell = content.querySelector(`tr[data-details-for="${claimId}"] td`);
          const row = cell.parentElement;
          if (!row.classList.contains('is-hidden')) { row.classList.add('is-hidden'); cell.innerHTML = ''; return; }
          const reason = prompt('Why do you need the winner\'s address? This is recorded against the claim.');
          if (reason === null) return;
          if (!reason.trim()) { alert('A short reason is required.'); return; }
          btn.disabled = true;
          try {
            const result = await api(`/claims/${claimId}/rescue/delivery-details`, {
              method: 'POST',
              body: JSON.stringify({ reason }),
            });
            const d = result.delivery.details;
            row.classList.remove('is-hidden');
            cell.innerHTML = `
              <div class="u-1b074808">
                <p class="u-06519697">Opened for fulfilment and recorded in this claim's history. Winner consented ${new Date(result.delivery.consentedAt).toLocaleDateString()} (${escapeHtml(result.delivery.consentVersion)}).</p>
                <p class="u-1da9facb">${escapeHtml(d.recipient_name)} · ${escapeHtml(d.phone)}</p>
                <p class="u-1da9facb">${escapeHtml(d.address_line1)}${d.address_line2 ? `, ${escapeHtml(d.address_line2)}` : ''}</p>
                <p class="u-1da9facb">${escapeHtml(d.city)}, ${escapeHtml(d.emirate)}</p>
                ${d.notes ? `<p class="u-f1d2a576">${escapeHtml(d.notes)}</p>` : ''}
              </div>
            `;
          } catch (err) {
            alert(err.message);
          } finally {
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadClaims() {
    const box = document.getElementById('claims-content');
    try {
      const rows = await api('/claims/admin/review');
      if (!rows.length) {
        box.replaceChildren();
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'Nothing waiting. Disputes and expired claims appear here.';
        box.appendChild(empty);
        return;
      }

      box.replaceChildren();
      rows.forEach((row) => {
        const card = document.createElement('div');
        card.className = 'card narrow';
        card.classList.add('js-card-block');

        const head = document.createElement('div');
        head.classList.add('js-row-between');
        const title = document.createElement('strong');
        title.textContent = row.title;
        const pill = document.createElement('span');
        pill.className = 'pill-badge';
        pill.textContent = row.status === 'disputed' ? 'Disputed' : 'Claim expired';
        head.append(title, pill);

        const meta = document.createElement('p');
        meta.className = 'hint';
        meta.textContent = `Winner: ${row.winner_name} · Host: ${row.host_name} · ${ageLabel(row.disputed_at || row.expired_at)}`;

        const action = document.createElement('p');
        action.classList.add('js-muted-note');
        action.textContent =
          row.status === 'disputed'
            ? 'Needs a decision: mark delivered, send back for redelivery, or close it. A reason is required either way.'
            : 'Needs a decision: reissue the claim link to the same winner, or close it.';

        const controls = document.createElement('div');
        controls.classList.add('js-button-row');

        const open = document.createElement('button');
        open.className = 'btn ghost';
        open.textContent = 'Open case';
        // Delivery details are loaded only here, on a deliberate click by an
        // authenticated administrator — never as part of the list above.
        open.onclick = () => openCase(row, card);
        controls.appendChild(open);

        card.append(head, meta, action, controls);
        box.appendChild(card);
      });
    } catch (err) {
      box.textContent = err.message;
    }
  }

  async function openCase(row, card) {
    if (card.querySelector('.case-detail')) return;

    const detail = document.createElement('div');
    detail.className = 'case-detail';
    detail.classList.add('js-detail-panel');
    card.appendChild(detail);

    let claim;
    try {
      claim = await api(`/claims/giveaway/${row.giveaway_id}`);
    } catch (err) {
      detail.textContent = err.message;
      return;
    }

    const history = document.createElement('div');
    history.classList.add('js-history');
    claim.history.forEach((event) => {
      const line = document.createElement('div');
      line.textContent = `${new Date(event.created_at).toLocaleString()} — ${event.to_status.replace(/_/g, ' ')} by ${event.actor_role}${event.note ? `: ${event.note}` : ''}`;
      history.appendChild(line);
    });
    detail.appendChild(history);

    if (claim.delivery && claim.delivery.available) {
      const d = claim.delivery.details;
      const box = document.createElement('div');
      box.classList.add('js-mint-box');
      const label = document.createElement('strong');
      label.textContent = 'Delivery details (opened deliberately, for this case)';
      box.appendChild(label);
      [d.recipient_name, d.phone, d.address_line1, d.address_line2, [d.city, d.emirate].filter(Boolean).join(', ')]
        .filter(Boolean)
        .forEach((line) => {
          const p = document.createElement('div');
          p.textContent = line;
          box.appendChild(p);
        });
      detail.appendChild(box);
    }

    const reason = document.createElement('textarea');
    reason.placeholder = 'Reason for your decision — recorded against this claim.';
    reason.maxLength = 500;
    reason.classList.add('js-spaced-input');
    detail.appendChild(reason);

    const error = document.createElement('p');
    error.className = 'form-error';

    const act = async (to) => {
      error.classList.remove('show');
      if (!reason.value.trim()) {
        error.textContent = 'A reason is required — it is recorded against the claim.';
        error.classList.add('show');
        return;
      }
      try {
        await api(`/claims/${claim.id}/transition`, {
          method: 'POST',
          body: JSON.stringify({ to, note: reason.value.trim() }),
        });
        loadClaims();
      } catch (err) {
        error.textContent = err.message;
        error.classList.add('show');
      }
    };

    const buttons = document.createElement('div');
    buttons.classList.add('js-button-row');

    if (row.status === 'disputed') {
      [['delivered', 'Mark delivered'], ['preparing_delivery', 'Send back for redelivery'], ['cancelled', 'Close claim']].forEach(
        ([to, label]) => {
          const b = document.createElement('button');
          b.className = 'btn ghost';
          b.textContent = label;
          b.onclick = () => act(to);
          buttons.appendChild(b);
        }
      );
    } else {
      const reissue = document.createElement('button');
      reissue.className = 'btn primary';
      reissue.textContent = 'Reissue claim link to the same winner';
      reissue.onclick = async () => {
        error.classList.remove('show');
        try {
          await api(`/claims/${claim.id}/admin/reissue`, {
            method: 'POST',
            body: JSON.stringify({ note: reason.value.trim() || 'reissued after review' }),
          });
          loadClaims();
        } catch (err) {
          error.textContent = err.message;
          error.classList.add('show');
        }
      };
      buttons.appendChild(reissue);

      const close = document.createElement('button');
      close.className = 'btn ghost';
      close.textContent = 'Close claim';
      close.onclick = () => act('cancelled');
      buttons.appendChild(close);
    }

    detail.append(buttons, error);
  }

  async function loadMissingClaims() {
    const box = document.getElementById('missing-claims-content');
    try {
      const rows = await api('/claims/admin/missing-claims');
      box.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'None — every drawn giveaway has a claim.';
        box.appendChild(empty);
        return;
      }
      rows.forEach((row) => {
        const card = document.createElement('div');
        card.className = 'card narrow';
        card.classList.add('js-summary-card');
        const label = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = row.title;
        const who = document.createElement('div');
        who.className = 'hint';
        who.textContent = `Winner already drawn: ${row.winner_name}`;
        label.append(title, who);

        const button = document.createElement('button');
        button.className = 'btn primary';
        button.textContent = 'Issue claim to that winner';
        button.onclick = async () => {
          button.disabled = true;
          try {
            await api(`/claims/admin/backfill/${row.giveaway_id}`, { method: 'POST' });
            loadMissingClaims();
            loadClaims();
          } catch (err) {
            who.textContent = err.message;
            button.disabled = false;
          }
        };
        card.append(label, button);
        box.appendChild(card);
      });
    } catch (err) {
      box.textContent = err.message;
    }
  }

  ready.then(() => {
    loadStats();
    loadClaims();
    loadRescueQueue();
    loadMissingClaims();
    load();
    loadAdInquiries();
    loadAds();
    loadGiveaways();
    loadUsers();
  });
