// Wrapped in an async IIFE because this file awaits the session bootstrap at
// the top. It was written inside an inline <script>, where a top-level await
// is a syntax error too — the browser check added in this phase is what
// finally surfaced it.
(async () => {
  // Dates follow the page's language, not the operating system's:
  // toLocaleDateString(undefined) asks the browser and gets the OS locale, which
  // put an English date in the middle of an Arabic line.
  const locale = window.NaseebI18n.getLang() === 'ar' ? 'ar-AE' : 'en-GB';
  const id = new URLSearchParams(window.location.search).get('id');
  await sessionReady;
  const user = getUser();
  let currentGiveaway = null;

  async function load() {
    // Without an id there is nothing to fetch. Asking anyway sent
    // /api/giveaways/null, took a 404, and logged a console error for a request
    // this page already knew could not succeed — noise that makes a real failure
    // harder to see.
    if (!id) {
      document.getElementById('title').textContent = t('detail.notFound');
      document.getElementById('description').textContent = t('errors.giveawayDoesNotExist');
      return;
    }
    try {
      const g = await api(`/giveaways/${id}`);
      currentGiveaway = g;

      // Isolated: a title in the other direction otherwise drags the dash and
      // the brand to the wrong end of the tab label.
      document.title = t('detail.documentTitle', { title: isolate(g.title) });
      document.getElementById('title').textContent = g.title;
      // The host's display name is host-controlled. It is a text node beside the
      // badge element, not a string concatenated into markup.
      mount(document.getElementById('hosted-by'), [
        t('detail.hostedBy', { name: isolate(g.host_name) }),
        g.host_verified ? verifiedBadge() : null,
      ]);
      document.getElementById('description').textContent = g.description;
      document.getElementById('prize').textContent = g.prize_description;
      // The fallback used to be a hot-linked Unsplash photo, which meant
      // img-src would have had to admit an entire third-party image host for
      // one decorative default. It is a local file now, and the giveaway's own
      // image is validated before it is used at all.
      NaseebDom.setMediaSrc(
        document.getElementById('image'),
        g.image_url,
        '/img/giveaway-placeholder.svg'
      );

      document.getElementById('row-status').textContent = g.status === 'drawn' ? t('detail.winnerDrawn') : t('detail.open');
      document.getElementById('row-entries').textContent = g.entry_count;
      document.getElementById('row-value').textContent = g.estimated_value_aed ? `AED ${g.estimated_value_aed.toLocaleString()}` : t('detail.notDisclosed');
      document.getElementById('row-deadline').textContent = new Date(g.entry_deadline).toLocaleString();
      document.getElementById('row-funded').textContent = g.funded_by;

      const eyebrow = document.getElementById('status-eyebrow');
      eyebrow.textContent = g.status === 'drawn' ? t('detail.winnerDrawn').toUpperCase() : timeLeft(g.entry_deadline).toUpperCase();

      // The viewer's own entry status, and nobody else's. The sentence shown is
      // chosen by the server from a fixed allowlist — never the administrator's
      // notes, never a signal, never another account.
      renderMyEntryStatus(g.my_entry);

      const enterBtn = document.getElementById('enter-btn');
      const drawBtn = document.getElementById('draw-btn');
      const isHost = user && user.id === g.host_id;
      const deadlinePassed = new Date(g.entry_deadline) <= new Date();

      if (g.winner) {
        document.getElementById('winner-box').classList.remove('is-hidden');
        document.getElementById('winner-text').textContent = `${g.winner.name} (ticket #${g.winner.ticket_number})`;
        mount(document.getElementById('delivery-status'), deliveryPill(g));

        const celebratedKey = `naseeb_celebrated_${id}`;
        if (!sessionStorage.getItem(celebratedKey)) {
          celebrate();
          sessionStorage.setItem(celebratedKey, '1');
        }
      }

      if (g.status === 'drawn') {
        enterBtn.classList.add('is-hidden');
      } else if (!user) {
        enterBtn.textContent = t('detail.signInToEnter');
        enterBtn.onclick = () => NaseebDom.navigate('/login.html');
      } else if (g.already_entered) {
        enterBtn.textContent = t('detail.alreadyEntered');
        enterBtn.disabled = true;
      } else if (deadlinePassed) {
        enterBtn.textContent = t('detail.entriesClosed');
        enterBtn.disabled = true;
      } else {
        enterBtn.onclick = enterGiveaway;
      }

      if (isHost && g.status === 'active') {
        drawBtn.classList.remove('is-hidden');
        drawBtn.disabled = !deadlinePassed;
        drawBtn.textContent = deadlinePassed ? t('detail.drawWinner') : t('detail.drawAvailable');
        drawBtn.onclick = drawWinner;
      }

      await renderClaim(g, isHost);
    } catch (err) {
      document.getElementById('title').textContent = t('detail.notFound');
      document.getElementById('description').textContent = err.message;
    }
  }

  // The whole message comes from the server, chosen from an allowlist of fixed
  // sentences. There is no free text in it, no administrator note, and nothing
  // about how anything was noticed — see docs/ENTRY_INTEGRITY.md §3.
  function renderMyEntryStatus(myEntry) {
    const box = document.getElementById('entry-status');
    if (!box) return;
    if (!myEntry || !myEntry.explanation) {
      box.classList.add('is-hidden');
      clear(box);
      return;
    }
    box.classList.remove('is-hidden');
    setText(box, myEntry.explanation);
  }

  async function enterGiveaway() {
    const errorEl = document.getElementById('action-error');
    const successEl = document.getElementById('action-success');
    const enterBtn = document.getElementById('enter-btn');
    errorEl.classList.remove('show');
    successEl.classList.remove('show');
    enterBtn.disabled = true;
    try {
      const { ticket_number } = await api(`/giveaways/${id}/enter`, { method: 'POST' });
      successEl.textContent = t('detail.enteredSuccess', { n: ticket_number });
      successEl.classList.add('show');
      load();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
      enterBtn.disabled = false;
    }
  }

  async function drawWinner() {
    const errorEl = document.getElementById('action-error');
    const drawBtn = document.getElementById('draw-btn');
    errorEl.classList.remove('show');
    drawBtn.disabled = true;
    try {
      await api(`/giveaways/${id}/draw`, { method: 'POST' });
      load();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
      drawBtn.disabled = false;
    }
  }

  // What each state means to the person looking at it, and which move they may
  // make next. Mirrors the server's state machine — the server is still the
  // one enforcing it; this only decides what to offer.
  const CLAIM_STATE_TEXT = {
    awaiting_claim: {
      pill: 'Awaiting winner',
      host: 'The winner has been emailed a claim link. Delivery details arrive once they claim and consent.',
      winner: 'Check your email for your claim link, and tell us where to send the prize.',
    },
    claimed: {
      pill: 'Claimed',
      host: 'The winner has claimed and shared delivery details. Start preparing the prize.',
      winner: 'The host has your delivery details and will prepare your prize.',
    },
    preparing_delivery: {
      pill: 'Preparing',
      host: "Mark it sent once it's with a courier or the handover is arranged.",
      winner: 'The host is preparing your prize.',
    },
    shipped_or_arranged: {
      pill: 'Sent',
      host: "Once it should have arrived, say so — the winner then confirms they received it.",
      winner: 'Your prize is on its way.',
    },
    delivered_pending_confirmation: {
      pill: 'Awaiting confirmation',
      host: 'Waiting for the winner to confirm they received it. Only they can close this.',
      winner: 'The host says it has arrived. Please confirm you received it.',
    },
    delivered: { pill: 'Delivered', host: 'Confirmed received by the winner.', winner: 'You confirmed you received this.' },
    disputed: {
      pill: 'Under review',
      host: 'An administrator is reviewing this.',
      winner: 'An administrator is reviewing this.',
    },
    expired: {
      pill: 'Under review',
      host: 'The claim window closed. An administrator is reviewing it — the prize has not been cancelled or redrawn.',
      winner: 'Your claim window closed. An administrator is reviewing it.',
    },
    cancelled: { pill: 'Closed', host: 'This claim was closed by an administrator.', winner: 'This claim was closed.' },
  };

  // Only transitions the current role may make from the current state.
  const CLAIM_ACTIONS = {
    claimed: { host: [['preparing_delivery', 'Start preparing']] },
    preparing_delivery: { host: [['shipped_or_arranged', 'Mark as sent or arranged']] },
    shipped_or_arranged: { host: [['delivered_pending_confirmation', 'Report as delivered']] },
    delivered_pending_confirmation: { winner: [['delivered', 'Confirm I received it']] },
  };

  const DISPUTABLE = ['claimed', 'preparing_delivery', 'shipped_or_arranged', 'delivered_pending_confirmation'];

  let currentClaim = null;

  async function renderClaim(g, isHost) {
    const panel = document.getElementById('claim-panel');
    const config = await api('/config').catch(() => ({}));

    // No claim workflow, no controls at all.
    if (!config.claims_enabled || g.status !== 'drawn') {
      panel.classList.add('is-hidden');
      return;
    }

    let claim;
    try {
      claim = await api(`/claims/giveaway/${id}`);
    } catch (err) {
      // Not the winner, host or an admin — or no claim exists. Either way there
      // is nothing here for this visitor.
      panel.classList.add('is-hidden');
      return;
    }

    currentClaim = claim;
    panel.classList.remove('is-hidden');

    const text = CLAIM_STATE_TEXT[claim.status] || { pill: claim.status, host: '', winner: '' };
    document.getElementById('claim-state-pill').textContent = text.pill;
    document.getElementById('claim-state-help').textContent =
      claim.role === 'winner' ? text.winner : text.host;

    // Delivery details: shown only when the server actually returned them,
    // which it does only for the host after consent and before erasure.
    const deliveryEl = document.getElementById('claim-delivery');
    if (claim.delivery && claim.delivery.available) {
      const d = claim.delivery.details;
      deliveryEl.classList.remove('is-hidden');
      deliveryEl.replaceChildren();
      const heading = document.createElement('strong');
      heading.textContent = t('detail.deliverTo');
      deliveryEl.appendChild(heading);
      [
        d.recipient_name,
        d.phone,
        d.address_line1,
        d.address_line2,
        [d.city, d.emirate].filter(Boolean).join(', '),
        d.notes ? `Note: ${d.notes}` : null,
      ]
        .filter(Boolean)
        .forEach((line) => {
          const p = document.createElement('div');
          // textContent, never innerHTML: these are values a winner typed.
          p.textContent = line;
          deliveryEl.appendChild(p);
        });
      const consent = document.createElement('p');
      consent.className = 'hint';
      consent.classList.add('js-flush');
      consent.textContent = t('detail.sharedWithConsentOn', {
        when: new Date(claim.delivery.consentedAt).toLocaleDateString(locale),
      });
      deliveryEl.appendChild(consent);
    } else {
      deliveryEl.classList.add('is-hidden');
    }

    // Actions valid for this state and this role, and nothing else.
    const actionsEl = document.getElementById('claim-actions');
    actionsEl.replaceChildren();
    const available = (CLAIM_ACTIONS[claim.status] || {})[claim.role] || [];
    available.forEach(([to, label]) => {
      const button = document.createElement('button');
      button.className = 'btn primary';
      button.textContent = label;
      button.onclick = () => moveClaim(to);
      actionsEl.appendChild(button);
    });

    const disputeBox = document.getElementById('claim-dispute-box');
    if (DISPUTABLE.includes(claim.status) && (claim.role === 'host' || claim.role === 'winner')) {
      const raise = document.createElement('button');
      raise.className = 'btn ghost';
      raise.textContent = t('detail.reportAProblem');
      raise.onclick = () => {
        disputeBox.classList.toggle('is-hidden');
      };
      actionsEl.appendChild(raise);
    } else {
      disputeBox.classList.add('is-hidden');
    }
  }

  async function moveClaim(to, note) {
    const errorEl = document.getElementById('claim-error');
    errorEl.classList.remove('show');
    try {
      await api(`/claims/${currentClaim.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to, note }),
      });
      load();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  }

  document.getElementById('claim-dispute-submit').addEventListener('click', () => {
    const reason = document.getElementById('claim-dispute-reason').value.trim();
    const errorEl = document.getElementById('claim-error');
    if (!reason) {
      errorEl.textContent = t('detail.pleaseDescribeTheProblem');
      errorEl.classList.add('show');
      return;
    }
    moveClaim('disputed', reason);
  });

  load();
})();
