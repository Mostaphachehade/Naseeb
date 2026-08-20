  const ready = requireSession('/create.html');

  // Shows the right one of five states instead of a form that 403s on submit.
  // Purely presentational: POST /api/giveaways checks host access itself on
  // every request, so a browser that unhides this form gains nothing.
  const accessPanel = document.getElementById('host-access-panel');
  const createForm = document.getElementById('create-form');

  function accessPanel_(title, bodyNodes, action) {
    return el('div', { class: 'card narrow u-8c71f6a5' }, [
      el('h3', { class: 'u-291b7bbb', text: title }),
      bodyNodes,
      action || null,
    ]);
  }

  // An administrator's typed reason for a rejection or a suspension. It is shown
  // to the account it is about, which makes it the shortest path from one user's
  // keyboard to another user's screen anywhere in the product — text node.
  function reasonNode(reason) {
    return reason ? el('p', { class: 'u-3a46e857', text: 'Reason given: ' + reason }) : null;
  }

  async function gateOnHostAccess() {
    let state;
    try {
      state = await api('/host-applications/me');
    } catch (err) {
      mount(accessPanel, errorNode(err.message));
      return false;
    }

    if (state.can_host) {
      createForm.classList.remove('is-hidden');
      return true;
    }

    if (!state.email_verified) {
      mount(accessPanel, accessPanel_(
        'Verify your email first',
        el('p', {
          class: 'u-a2aae0fb',
          text: 'We need a working email address on your account before you can host. Check your inbox, or resend the verification email from the banner above.',
        })
      ));
      return false;
    }

    const panels = {
      not_requested: () => accessPanel_(
        'Hosting is a closed beta',
        el('p', {
          class: 'u-a2aae0fb',
          text: 'Host access is granted one account at a time. Apply, and an administrator will review it.',
        }),
        el('a', { class: 'btn primary', href: '/host-apply.html', text: 'Apply to host' })
      ),
      pending: () => accessPanel_(
        'Your application is with an administrator',
        el('p', {
          class: 'u-a2aae0fb',
          text: 'You cannot publish a giveaway while an application is open. We have not set a review deadline, so we are not promising one.',
        }),
        el('a', { class: 'btn ghost u-e21d2b9e', href: '/dashboard.html', text: 'Back to my giveaways' })
      ),
      rejected: () => accessPanel_(
        'This account has not been approved to host',
        [
          el('p', {
            class: 'u-a2aae0fb',
            text: 'An administrator reviewed your application and did not approve it.',
          }),
          reasonNode(state.status_reason),
        ],
        el('a', { class: 'btn primary', href: '/host-apply.html', text: 'Apply again' })
      ),
      suspended: () => accessPanel_(
        'Hosting access is suspended',
        [
          el('p', {
            class: 'u-a2aae0fb',
            text: 'Your existing giveaways, entries and records are unchanged. What has stopped is publishing new giveaways and drawing winners.',
          }),
          reasonNode(state.status_reason),
        ],
        el('a', { class: 'btn ghost u-e21d2b9e', href: '/about.html#get-in-touch', text: 'Contact us' })
      ),
    };
    mount(accessPanel, (panels[state.host_status] || panels.not_requested)());
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
      // Cloudinary's response is third-party JSON. It is the API we asked, but
      // it is still a URL arriving over the network, so it goes through the same
      // validator as a stored one before it becomes a src.
      const preview = document.getElementById('image-preview');
      if (!NaseebDom.setMediaSrc(preview, data.secure_url)) {
        statusEl.textContent = 'Upload returned an image address we do not accept.';
        return;
      }
      document.getElementById('image_url').value = data.secure_url;
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
          // The prize facts Naseeb reviews before publication.
          prize_category: document.getElementById('prize_category').value,
          sponsor_name: document.getElementById('sponsor_name').value,
          prize_supplied_by: document.getElementById('prize_supplied_by').value,
          prize_retail_value_aed: document.getElementById('prize_retail_value_aed').value,
          naseeb_custody: document.getElementById('naseeb_custody').value,
          fulfilment_method: document.getElementById('fulfilment_method').value,
          prize_restrictions: document.getElementById('prize_restrictions').value || null,
          prize_expiry_date: document.getElementById('prize_expiry_date').value || null,
          // `entry_deadline` is deliberately NOT sent. It is a consequence of
          // publication — exactly 30 days from the moment Naseeb approves the
          // campaign — not something a host chooses.
        }),
      });
      // Submitted, not published. Saying "your giveaway is live" here would be
      // a lie the host would act on, so the page says what actually happened.
      const form = document.getElementById('create-form');
      form.classList.add('is-hidden');
      const done = NaseebDom.el('div', { class: 'card narrow u-34caecf2' }, [
        NaseebDom.el('h3', { text: 'Submitted for review' }),
        NaseebDom.el('p', {
          text:
            g.next_step ||
            'Naseeb checks every prize before publication. You will see this campaign go live once it is approved.',
        }),
        NaseebDom.el('p', {
          class: 'hint',
          text:
            'It is not visible to anyone yet, and nobody can enter it. Once approved it runs for 30 days, or until it reaches 100 eligible entries — whichever comes first.',
        }),
      ]);
      form.insertAdjacentElement('afterend', done);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });
