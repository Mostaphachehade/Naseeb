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
    if (!claimToken) return invalid('No claim link was provided.');

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
    document.getElementById('prize-line').textContent = `Confirm your claim for ${claim.title}.`;
    document.getElementById('host-line').textContent = `Hosted by ${claim.host_name}. Funded by: ${claim.funded_by}`;
    document.getElementById('consent-host').textContent = claim.host_name;
    show('claim-panel');
  }

  document.getElementById('claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    const btn = document.getElementById('submit-btn');
    errorEl.classList.remove('show');

    if (!document.getElementById('consent').checked) {
      errorEl.textContent = 'Please tick the box so we can share your address with the host.';
      errorEl.classList.add('show');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Sending…';

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
      document.getElementById('done-message').textContent =
        "The host has been told you've claimed, and can now arrange delivery. You'll get an email at each step, and you're the one who confirms it arrived.";
      show('done-panel');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Confirm claim and share details';
    }
  });

  load();
