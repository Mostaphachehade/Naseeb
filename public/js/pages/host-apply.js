  const t = (key, vars) => window.NaseebI18n.t(key, vars);
  const iso = (value) => window.NaseebI18n.isolate(value);
  // Dates follow the page's language, not the operating system's.
  const locale = window.NaseebI18n.getLang() === 'ar' ? 'ar-AE' : 'en-GB';

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
    // The reason is the server's own fixed wording, isolated because it can
    // carry a direction of its own inside an Arabic sentence.
    return reason
      ? el('p', { class: 'reason', text: t('hostapply.reasonGiven', { reason: iso(reason) }) })
      : null;
  }

  // Everything below decides what to SHOW. The server decides what is allowed,
  // on every request, from users.host_status — a browser that renders the form
  // anyway still gets a 403 from POST /api/host-applications.
  function render(state) {
    if (state.is_admin) {
      mount(statusPanel, panel(
        t('hostapply.youAreAnAdministrator'),
        el('p', { text: t('hostapply.administratorAccountsCanHost') }),
        el('a', { class: 'btn primary', href: '/create.html', text: t('nav.hostGiveaway') })
      ));
      return;
    }
    if (!state.email_verified) {
      mount(statusPanel, panel(
        t('hostapply.verifyYourEmailFirst'),
        el('p', { text: t('hostapply.weNeedAWorkingEmail') })
      ));
      return;
    }

    switch (state.host_status) {
      case 'approved':
        mount(statusPanel, panel(
          t('hostapply.youAreApprovedToHost'),
          el('p', { text: t('hostapply.yourAccountHasHostAccess') }),
          el('a', { class: 'btn primary', href: '/create.html', text: t('nav.hostGiveaway') })
        ));
        return;
      case 'pending':
        mount(statusPanel, panel(
          t('hostapply.yourApplicationIsWith'),
          [
            el('p', {
              text: t('hostapply.submittedOn', {
                when: state.application
                  ? new Date(state.application.created_at).toLocaleDateString(locale)
                  : t('hostapply.recently'),
              }),
            }),
            el('p', { text: t('hostapply.noReviewDeadline') }),
          ],
          el('a', { class: 'btn ghost u-e21d2b9e', href: '/dashboard.html', text: t('hostapply.backToMyGiveaways') })
        ));
        return;
      case 'rejected':
        mount(statusPanel, panel(
          t('hostapply.notApprovedToHost'),
          [
            el('p', { text: t('hostapply.anAdministratorReviewed') }),
            reasonNode(state.status_reason),
            el('p', { text: t('hostapply.youCanApplyAgain') }),
          ]
        ));
        applyForm.classList.remove('is-hidden');
        return;
      case 'suspended':
        mount(statusPanel, panel(
          t('hostapply.hostingAccessIsSuspended'),
          [
            el('p', { text: t('hostapply.anAdministratorHasSuspended') }),
            reasonNode(state.status_reason),
            el('p', { text: t('hostapply.applyingAgainWillNot') }),
          ],
          el('a', { class: 'btn ghost u-e21d2b9e', href: '/about.html#get-in-touch', text: t('hostapply.contactUs') })
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
        t('hostapply.signInToApply'),
        el('p', { text: t('hostapply.anApplicationIsAttached') }),
        frag([
          el('a', { class: 'btn primary', href: '/login.html?redirect=%2Fhost-apply.html', text: t('nav.signIn') }),
          el('a', { class: 'btn ghost u-f7228bba', href: '/signup.html?redirect=%2Fhost-apply.html', text: t('hostapply.createAFreeAccount') }),
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
