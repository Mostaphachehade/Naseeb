
  // Awaited, because whether somebody is signed in is now a question for the
  // server rather than a synchronous read of browser storage.
  const ready = requireSession('/dashboard.html');

  mount(document.getElementById('hosted-grid'), skeletonCards(3));
  mount(document.getElementById('entered-grid'), skeletonCards(3));

  // What the host half of this page says depends on host access, which is read
  // from the server. The hosted-giveaways endpoint enforces the same thing
  // independently — this only decides which explanation to show instead of a
  // bare error.
  //
  // `action` is a function that builds the button, not a string of markup: these
  // are fixed internal links, and there is no reason for a fixed link to travel
  // as text that something later parses.
  const HOST_STATE_NOTES = {
    not_requested: {
      note: () => t('dashboard.hostNotRequested'),
      action: () => el('a', { href: '/host-apply.html', class: 'btn primary', text: t('nav.applyToHost') }),
    },
    pending: {
      note: () => t('dashboard.hostPending'),
      action: () => null,
    },
    rejected: {
      note: () => t('dashboard.hostRejected'),
      action: () => el('a', { href: '/host-apply.html', class: 'btn ghost u-e21d2b9e', text: t('dashboard.applyAgain') }),
    },
    suspended: {
      note: () => t('dashboard.hostSuspended'),
      action: () => null,
    },
  };

  const ENTRY_STATUS_NOTE = {
    under_review: 'dashboard.entryUnderReview',
    disqualified: 'dashboard.entryDisqualified',
  };

  // A short label plus the server's own fixed sentence. No administrator note
  // reaches here, because none is sent.
  function entryStatusNote(myEntry) {
    if (!myEntry) return null;
    const key = ENTRY_STATUS_NOTE[myEntry.status]
      || (myEntry.resolution_pending ? 'dashboard.entryOutcomePending' : null);
    if (!key) return null;
    return el('p', { class: 'delivery-pill pending', text: t(key) });
  }

  function emptyWithLink(before, href, linkText, after) {
    return el('div', { class: 'empty u-97294b20' }, [
      before,
      el('a', { href, text: linkText }),
      after,
    ]);
  }

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
      mount(noteEl, el('div', { class: 'card narrow u-5583aeec' }, [
        el('p', { class: 'u-ecf28f6f', text: info.note() }),
        // An administrator's free-typed reason. Text.
        state.status_reason
          ? el('p', { class: 'u-d02706d3', text: 'Reason given: ' + state.status_reason })
          : null,
      ]));
      mount(actionEl, info.action());
      clear(hostedGrid);
      return;
    }

    mount(actionEl, el('a', { href: '/create.html', class: 'btn primary', text: t('nav.hostGiveaway') }));
    try {
      const hosted = await api('/giveaways/mine/hosted');
      mount(hostedGrid, hosted.length
        ? hosted.map(giveawayCard)
        : emptyWithLink(t('dashboard.emptyHostedBefore'), '/create.html', t('dashboard.emptyHostedLink'), t('dashboard.emptyAfter')));
    } catch (err) {
      mount(hostedGrid, errorNode(err.message));
    }
  }

  async function load() {
    const enteredGrid = document.getElementById('entered-grid');
    await loadHosted();

    try {
      const entered = await api('/giveaways/mine/entered');
      mount(enteredGrid, entered.length
        ? entered.map((g) => {
            const card = giveawayCard(g);
            // Their own entry's coarse status, on their own dashboard. Absent
            // when the entry is ordinary — a badge saying "fine" on every card
            // makes the one that isn't harder to notice.
            const note = entryStatusNote(g.my_entry);
            if (note) card.appendChild(note);
            return card;
          })
        : emptyWithLink(t('dashboard.emptyEnteredBefore'), '/index.html', t('dashboard.browseOpenGiveaways'), t('dashboard.emptyAfter')));
    } catch (err) {
      mount(enteredGrid, errorNode(err.message));
    }
  }
  ready.then(load);
