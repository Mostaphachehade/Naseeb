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

  function panel(title, body, action) {
    return el('div', { class: 'status-panel' }, [
      el('h3', { text: title }),
      body,
      action || null,
    ]);
  }

  // The administrator's reason for a rejection or suspension, shown to the
  // account it concerns. Text node, never markup.
  function reasonNode(reason) {
    return reason ? el('p', { class: 'reason', text: 'Reason given: ' + reason }) : null;
  }

  // Everything below decides what to SHOW. The server decides what is allowed,
  // on every request, from users.host_status — a browser that renders the form
  // anyway still gets a 403 from POST /api/host-applications.
  function render(state) {
    if (state.is_admin) {
      mount(statusPanel, panel(
        'You are an administrator',
        el('p', { text: 'Administrator accounts can host without an approval, so there is nothing to apply for.' }),
        el('a', { class: 'btn primary', href: '/create.html', text: 'Host a giveaway' })
      ));
      return;
    }
    if (!state.email_verified) {
      mount(statusPanel, panel(
        'Verify your email first',
        el('p', { text: 'We need a working email address on your account before you can apply. Check your inbox, or resend the verification email from the banner above.' })
      ));
      return;
    }

    switch (state.host_status) {
      case 'approved':
        mount(statusPanel, panel(
          'You are approved to host',
          el('p', { text: 'Your account has host access. There is nothing further to apply for.' }),
          el('a', { class: 'btn primary', href: '/create.html', text: 'Host a giveaway' })
        ));
        return;
      case 'pending':
        mount(statusPanel, panel(
          'Your application is with an administrator',
          [
            el('p', {
              text: `Submitted ${state.application ? new Date(state.application.created_at).toLocaleDateString() : 'recently'}. It grants no hosting access on its own.`,
            }),
            el('p', { text: 'We have not set a review deadline, so we are not going to promise you one.' }),
          ],
          el('a', { class: 'btn ghost u-e21d2b9e', href: '/dashboard.html', text: 'Back to my giveaways' })
        ));
        return;
      case 'rejected':
        mount(statusPanel, panel(
          'This account has not been approved to host',
          [
            el('p', { text: 'An administrator reviewed your application and did not approve it.' }),
            reasonNode(state.status_reason),
            el('p', { text: 'You can apply again if something has changed since.' }),
          ]
        ));
        applyForm.classList.remove('is-hidden');
        return;
      case 'suspended':
        mount(statusPanel, panel(
          'Hosting access is suspended',
          [
            el('p', { text: 'An administrator has suspended hosting for this account. Your existing giveaways, entries and records are unchanged — what has stopped is publishing new giveaways and drawing winners.' }),
            reasonNode(state.status_reason),
            el('p', { text: 'Applying again will not lift a suspension. Please get in touch.' }),
          ],
          el('a', { class: 'btn ghost u-e21d2b9e', href: '/about.html#get-in-touch', text: 'Contact us' })
        ));
        return;
      default:
        applyForm.classList.remove('is-hidden');
    }
  }

  async function load() {
    await sessionReady;
    if (!isSignedIn()) {
      document.getElementById('form-head').classList.add('is-hidden');
      mount(statusPanel, panel(
        'Sign in to apply',
        el('p', { text: 'An application is attached to your account, so we need you signed in with a verified email address before you can make one.' }),
        frag([
          el('a', { class: 'btn primary', href: '/login.html?redirect=%2Fhost-apply.html', text: 'Sign in' }),
          el('a', { class: 'btn ghost u-f7228bba', href: '/signup.html?redirect=%2Fhost-apply.html', text: 'Create a free account' }),
        ])
      ));
      return;
    }
    try {
      render(await api('/host-applications/me'));
    } catch (err) {
      mount(statusPanel, errorNode(err.message));
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
