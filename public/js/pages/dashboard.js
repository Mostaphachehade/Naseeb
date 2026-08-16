  // Awaited, because whether somebody is signed in is now a question for the
  // server rather than a synchronous read of browser storage.
  const ready = requireSession('/dashboard.html');

  document.getElementById('hosted-grid').innerHTML = skeletonCards(3);
  document.getElementById('entered-grid').innerHTML = skeletonCards(3);

  // What the host half of this page says depends on host access, which is read
  // from the server. The hosted-giveaways endpoint enforces the same thing
  // independently — this only decides which explanation to show instead of a
  // bare error.
  const HOST_STATE_NOTES = {
    not_requested: {
      note: 'Hosting is a closed beta. Apply and an administrator will review your request.',
      action: '<a href="/host-apply.html" class="btn primary">Apply to host</a>',
    },
    pending: {
      note: 'Your application to host is with an administrator. It grants no access on its own, and we have not set a review deadline.',
      action: '',
    },
    rejected: {
      note: 'This account has not been approved to host giveaways.',
      action: '<a href="/host-apply.html" class="btn ghost u-e21d2b9e">Apply again</a>',
    },
    suspended: {
      note: 'Hosting access for this account is suspended. Nothing has been deleted — your giveaways, entries and records are all still on file — but new listings and draws are stopped, and any open prize claim is now handled by an administrator.',
      action: '',
    },
  };

  async function loadHosted() {
    const hostedGrid = document.getElementById('hosted-grid');
    const noteEl = document.getElementById('host-status-note');
    const actionEl = document.getElementById('host-action');

    let state = null;
    try {
      state = await api('/host-applications/me');
    } catch (err) {
      // Non-fatal: fall through and let the hosted endpoint speak for itself.
    }

    if (state && !state.can_host) {
      const info = HOST_STATE_NOTES[state.host_status] || HOST_STATE_NOTES.not_requested;
      noteEl.innerHTML = `
        <div class="card narrow u-5583aeec">
          <p class="u-ecf28f6f">${info.note}</p>
          ${state.status_reason ? `<p class="u-d02706d3">Reason given: ${escapeHtml(state.status_reason)}</p>` : ''}
        </div>`;
      actionEl.innerHTML = info.action;
      hostedGrid.innerHTML = '';
      return;
    }

    actionEl.innerHTML = '<a href="/create.html" class="btn primary">Host a giveaway</a>';
    try {
      const hosted = await api('/giveaways/mine/hosted');
      hostedGrid.innerHTML = hosted.length
        ? hosted.map(giveawayCard).join('')
        : `<div class="empty u-97294b20">You haven't hosted a giveaway yet. <a href="/create.html">Start one</a>.</div>`;
      applyCardImages(hostedGrid);
    } catch (err) {
      hostedGrid.innerHTML = `<p class="form-error show">${escapeHtml(err.message)}</p>`;
    }
  }

  async function load() {
    const enteredGrid = document.getElementById('entered-grid');
    await loadHosted();

    try {
      const entered = await api('/giveaways/mine/entered');
      enteredGrid.innerHTML = entered.length
        ? entered.map(giveawayCard).join('')
        : `<div class="empty u-97294b20">You haven't entered anything yet. <a href="/index.html">Browse open giveaways</a>.</div>`;
      applyCardImages(enteredGrid);
    } catch (err) {
      enteredGrid.innerHTML = `<p class="form-error show">${escapeHtml(err.message)}</p>`;
    }
  }
  ready.then(load);
