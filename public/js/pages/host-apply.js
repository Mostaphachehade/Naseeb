  const companyFields = document.getElementById('company-fields');
  const fullNameLabel = document.getElementById('full_name-label');
  const businessNameInput = document.getElementById('business_name');
  const statusPanel = document.getElementById('status-panel');
  const applyForm = document.getElementById('apply-form');

  let applicantType = 'individual';
  const typeButtons = document.querySelectorAll('#applicant-type-toggle .segmented-option');

  function syncApplicantType() {
    const isCompany = applicantType === 'company';
    companyFields.classList.toggle('is-hidden', !isCompany);
    businessNameInput.required = isCompany;
    fullNameLabel.textContent = isCompany ? 'Contact person' : 'Full name';
    typeButtons.forEach((btn) => {
      const active = btn.dataset.value === applicantType;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active);
    });
  }
  typeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      applicantType = btn.dataset.value;
      syncApplicantType();
    });
  });
  syncApplicantType();

  function panel(title, body, actionHtml) {
    return `
      <div class="status-panel">
        <h3>${title}</h3>
        ${body}
        ${actionHtml || ''}
      </div>
    `;
  }

  // Everything below decides what to SHOW. The server decides what is allowed,
  // on every request, from users.host_status — a browser that renders the form
  // anyway still gets a 403 from POST /api/host-applications.
  function render(state) {
    if (state.is_admin) {
      statusPanel.innerHTML = panel(
        'You are an administrator',
        `<p>Administrator accounts can host without an approval, so there is nothing to apply for.</p>`,
        `<a class="btn primary" href="/create.html">Host a giveaway</a>`
      );
      return;
    }
    if (!state.email_verified) {
      statusPanel.innerHTML = panel(
        'Verify your email first',
        `<p>We need a working email address on your account before you can apply. Check your inbox, or resend the verification email from the banner above.</p>`
      );
      return;
    }

    switch (state.host_status) {
      case 'approved':
        statusPanel.innerHTML = panel(
          'You are approved to host',
          `<p>Your account has host access. There is nothing further to apply for.</p>`,
          `<a class="btn primary" href="/create.html">Host a giveaway</a>`
        );
        return;
      case 'pending':
        statusPanel.innerHTML = panel(
          'Your application is with an administrator',
          `<p>Submitted ${state.application ? new Date(state.application.created_at).toLocaleDateString() : 'recently'}. It grants no hosting access on its own.</p>
           <p>We have not set a review deadline, so we are not going to promise you one.</p>`,
          `<a class="btn ghost u-e21d2b9e" href="/dashboard.html">Back to my giveaways</a>`
        );
        return;
      case 'rejected':
        statusPanel.innerHTML = panel(
          'This account has not been approved to host',
          `<p>An administrator reviewed your application and did not approve it.</p>
           ${state.status_reason ? `<p class="reason">Reason given: ${escapeHtml(state.status_reason)}</p>` : ''}
           <p>You can apply again if something has changed since.</p>`
        );
        applyForm.classList.remove('is-hidden');
        return;
      case 'suspended':
        statusPanel.innerHTML = panel(
          'Hosting access is suspended',
          `<p>An administrator has suspended hosting for this account. Your existing giveaways, entries and records are unchanged — what has stopped is publishing new giveaways and drawing winners.</p>
           ${state.status_reason ? `<p class="reason">Reason given: ${escapeHtml(state.status_reason)}</p>` : ''}
           <p>Applying again will not lift a suspension. Please get in touch.</p>`,
          `<a class="btn ghost u-e21d2b9e" href="/about.html#get-in-touch">Contact us</a>`
        );
        return;
      default:
        applyForm.classList.remove('is-hidden');
    }
  }

  async function load() {
    await sessionReady;
    if (!isSignedIn()) {
      document.getElementById('form-head').classList.add('is-hidden');
      statusPanel.innerHTML = panel(
        'Sign in to apply',
        `<p>An application is attached to your account, so we need you signed in with a verified email address before you can make one.</p>`,
        `<a class="btn primary" href="/login.html?redirect=%2Fhost-apply.html">Sign in</a>
         <a class="btn ghost u-f7228bba" href="/signup.html?redirect=%2Fhost-apply.html">Create a free account</a>`
      );
      return;
    }
    try {
      render(await api('/host-applications/me'));
    } catch (err) {
      statusPanel.innerHTML = `<p class="form-error show">${escapeHtml(err.message)}</p>`;
    }
  }

  applyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    errorEl.classList.remove('show');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api('/host-applications', {
        method: 'POST',
        body: JSON.stringify({
          applicant_type: applicantType,
          full_name: document.getElementById('full_name').value,
          business_name: businessNameInput.value || null,
          trade_license: document.getElementById('trade_license').value || null,
          contact_phone: document.getElementById('contact_phone').value || null,
          message: document.getElementById('message').value || null,
        }),
      });
      applyForm.classList.add('is-hidden');
      document.getElementById('form-head').classList.add('is-hidden');
      await load();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
      submitBtn.disabled = false;
    }
  });

  load();
