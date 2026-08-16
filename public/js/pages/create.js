  const ready = requireSession('/create.html');

  // Shows the right one of five states instead of a form that 403s on submit.
  // Purely presentational: POST /api/giveaways checks host access itself on
  // every request, so a browser that unhides this form gains nothing.
  const accessPanel = document.getElementById('host-access-panel');
  const createForm = document.getElementById('create-form');

  function accessPanelHtml(title, body, actionHtml) {
    return `
      <div class="card narrow u-8c71f6a5">
        <h3 class="u-291b7bbb">${title}</h3>
        ${body}
        ${actionHtml || ''}
      </div>
    `;
  }

  async function gateOnHostAccess() {
    let state;
    try {
      state = await api('/host-applications/me');
    } catch (err) {
      accessPanel.innerHTML = `<p class="form-error show">${escapeHtml(err.message)}</p>`;
      return false;
    }

    if (state.can_host) {
      createForm.classList.remove('is-hidden');
      return true;
    }

    if (!state.email_verified) {
      accessPanel.innerHTML = accessPanelHtml(
        'Verify your email first',
        `<p class="u-a2aae0fb">We need a working email address on your account before you can host. Check your inbox, or resend the verification email from the banner above.</p>`
      );
      return false;
    }

    const panels = {
      not_requested: [
        'Hosting is a closed beta',
        `<p class="u-a2aae0fb">Host access is granted one account at a time. Apply, and an administrator will review it.</p>`,
        `<a class="btn primary" href="/host-apply.html">Apply to host</a>`,
      ],
      pending: [
        'Your application is with an administrator',
        `<p class="u-a2aae0fb">You cannot publish a giveaway while an application is open. We have not set a review deadline, so we are not promising one.</p>`,
        `<a class="btn ghost u-e21d2b9e" href="/dashboard.html">Back to my giveaways</a>`,
      ],
      rejected: [
        'This account has not been approved to host',
        `<p class="u-a2aae0fb">An administrator reviewed your application and did not approve it.</p>
         ${state.status_reason ? `<p class="u-3a46e857">Reason given: ${escapeHtml(state.status_reason)}</p>` : ''}`,
        `<a class="btn primary" href="/host-apply.html">Apply again</a>`,
      ],
      suspended: [
        'Hosting access is suspended',
        `<p class="u-a2aae0fb">Your existing giveaways, entries and records are unchanged. What has stopped is publishing new giveaways and drawing winners.</p>
         ${state.status_reason ? `<p class="u-3a46e857">Reason given: ${escapeHtml(state.status_reason)}</p>` : ''}`,
        `<a class="btn ghost u-e21d2b9e" href="/about.html#get-in-touch">Contact us</a>`,
      ],
    };
    const chosen = panels[state.host_status] || panels.not_requested;
    accessPanel.innerHTML = accessPanelHtml(...chosen);
    return false;
  }

  ready.then(gateOnHostAccess);

  let cloudinaryConfig = null;
  fetch('/api/config').then((r) => r.json()).then((config) => {
    if (config.cloudinary_cloud_name && config.cloudinary_upload_preset) {
      cloudinaryConfig = config;
      document.getElementById('image-upload-row').classList.remove('is-hidden');
      document.getElementById('image-url-hint').textContent = 'Upload a file above, or paste an image URL.';
    }
  }).catch(() => {});

  document.getElementById('image_file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !cloudinaryConfig) return;
    const statusEl = document.getElementById('upload-status');
    statusEl.textContent = 'Uploading…';
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', cloudinaryConfig.cloudinary_upload_preset);
    try {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudinary_cloud_name}/image/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Upload failed.');
      document.getElementById('image_url').value = data.secure_url;
      const preview = document.getElementById('image-preview');
      preview.src = data.secure_url;
      preview.classList.remove('is-hidden');
      statusEl.textContent = 'Uploaded.';
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    errorEl.classList.remove('show');
    try {
      const g = await api('/giveaways', {
        method: 'POST',
        body: JSON.stringify({
          title: document.getElementById('title').value,
          description: document.getElementById('description').value,
          prize_description: document.getElementById('prize_description').value,
          estimated_value_aed: document.getElementById('estimated_value_aed').value || null,
          image_url: document.getElementById('image_url').value || null,
          funded_by: document.getElementById('funded_by').value,
          entry_deadline: new Date(document.getElementById('entry_deadline').value).toISOString(),
        }),
      });
      window.location.href = `/giveaway.html?id=${g.id}`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });
