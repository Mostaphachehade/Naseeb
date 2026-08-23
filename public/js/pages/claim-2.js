  // Every displayed string comes from the dictionary, and every value the
  // server supplies is wrapped in isolate() before it is dropped into a
  // sentence. A prize title or a host name is a run of text in an unknown
  // direction: inside an Arabic sentence an untreated Latin title reorders the
  // punctuation around it, and a name carrying its own direction marks can
  // reorder the rest of the line.
  const t = (key, vars) => window.NaseebI18n.t(key, vars);
  const iso = (value) => window.NaseebI18n.isolate(value);

  // Already captured and erased by the inline script above.
  const claimToken = window.__claimToken;
  window.__claimToken = null;

  let consentVersion = null;

  function show(panelId) {
    ['loading-panel', 'invalid-panel', 'done-panel', 'claim-panel'].forEach((id) => {
      document.getElementById(id).classList.toggle('is-hidden', id !== panelId);
    });
  }

  function invalid(message) {
    if (message) document.getElementById('invalid-message').textContent = message;
    show('invalid-panel');
  }

  async function load() {
    if (!claimToken) return invalid(t('claim.noClaimLink'));

    let claim;
    try {
      // POST, so the token travels in the request body. In a query string it
      // would be written into the server's access log and every proxy in
      // between — the exact leak the fragment was chosen to avoid.
      claim = await api('/claims/lookup', {
        method: 'POST',
        body: JSON.stringify({ token: claimToken }),
      });
    } catch (err) {
      return invalid(err.message);
    }

    consentVersion = claim.consent_version;
    document.getElementById('giveaway-title').textContent = claim.title;
    document.getElementById('prize-description').textContent = claim.prize_description;
    document.getElementById('prize-line').textContent = t('claim.confirmYourClaimFor', { title: iso(claim.title) });
    document.getElementById('host-line').textContent = t('claim.hostedByFundedBy', {
      host: iso(claim.host_name),
      funder: iso(claim.funded_by),
    });
    document.getElementById('consent-host').textContent = claim.host_name;
    show('claim-panel');
  }

  document.getElementById('claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    const btn = document.getElementById('submit-btn');
    errorEl.classList.remove('show');

    if (!document.getElementById('consent').checked) {
      errorEl.textContent = t('claim.pleaseTickTheBox');
      errorEl.classList.add('show');
      return;
    }

    btn.disabled = true;
    btn.textContent = t('claim.sending');

    try {
      await api('/claims/redeem', {
        method: 'POST',
        body: JSON.stringify({
          token: claimToken,
          consent: true,
          consent_version: consentVersion,
          delivery: {
            recipient_name: document.getElementById('recipient_name').value,
            phone: document.getElementById('phone').value,
            address_line1: document.getElementById('address_line1').value,
            address_line2: document.getElementById('address_line2').value || null,
            city: document.getElementById('city').value,
            emirate: document.getElementById('emirate').value,
            notes: document.getElementById('notes').value || null,
          },
        }),
      });
      document.getElementById('done-message').textContent = t('claim.doneMessage');
      show('done-panel');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = t('claim.confirmClaimAndShare');
    }
  });

  load();
