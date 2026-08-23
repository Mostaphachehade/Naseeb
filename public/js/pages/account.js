  const locale = window.NaseebI18n.getLang() === 'ar' ? 'ar-AE' : 'en-GB';

  // The account centre.
  //
  // Everything rendered here is the signed-in person's own data, and every node
  // is built rather than parsed — the same DOM-safe layer the rest of the site
  // uses. That matters more here than anywhere: this page shows text the account
  // holder typed, text an administrator wrote back, and an email address.
  const ready = requireSession('/account.html');

  const content = document.getElementById('account-content');
  const dataContent = document.getElementById('data-content');
  const policyState = document.getElementById('policy-state');

  let state = null;

  function card(title, children) {
    return el('div', { class: 'card narrow u-34caecf2' }, [
      el('h3', { class: 'u-291b7bbb', text: title }),
      children,
    ]);
  }

  function feedback() {
    return el('p', { class: 'form-error' });
  }

  function show(node, message, ok) {
    node.textContent = message;
    node.className = ok ? 'form-success show' : 'form-error show';
  }

  // ---- account details -----------------------------------------------------

  function detailsCard() {
    const nameInput = el('input', { id: 'account-name', value: state.account.name, maxLength: 100 });
    const note = feedback();

    const save = el('button', {
      class: 'btn primary u-8a359a76',
      type: 'button',
      text: 'Save name',
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api('/account/me', {
              method: 'PATCH',
              body: JSON.stringify({ name: nameInput.value }),
            });
            show(note, 'Saved.', true);
            await load();
          } catch (err) {
            show(note, err.message, false);
          } finally {
            btn.disabled = false;
          }
        },
      },
    });

    return card(t('account.yourDetails'), [
      el('label', { htmlFor: 'account-name', text: t('account.displayName') }),
      nameInput,
      el('p', { class: 'hint', text: t('account.displayNameHint') }),
      save,
      note,
      el('p', { class: 'u-680b5a65' }, [
        el('strong', { text: t('account.emailLabel') }),
        // An address is a Latin run inside an Arabic line; without isolation the
        // trailing punctuation ends up at the wrong end of it.
        isolate(state.account.email),
        state.account.email_verified ? t('account.verifiedSuffix') : t('account.notVerifiedSuffix'),
      ]),
      el('p', {
        class: 'u-a2aae0fb',
        text: t('account.accountCreated', {
          when: new Date(state.account.created_at).toLocaleDateString(locale),
        }),
      }),
    ]);
  }

  // ---- eligibility ---------------------------------------------------------

  function eligibilityCard() {
    const e = state.eligibility;
    if (!e.needs_attestation) {
      return card('Eligibility', [
        el('p', { text: `You confirmed you are 18 or older on ${new Date(e.attested_at).toLocaleDateString()}.` }),
        el('p', { class: 'hint', text: e.limitation }),
      ]);
    }

    const box = el('input', { id: 'age-confirm', type: 'checkbox' });
    const note = feedback();

    return card('Eligibility', [
      el('p', {
        text: 'Your account was created before we started asking this, so we have no answer on file. Please confirm before entering a giveaway or hosting one.',
      }),
      el('label', { class: 'u-age-attest', htmlFor: 'age-confirm' }, [box, el('span', { text: e.wording })]),
      el('p', { class: 'hint', text: e.limitation }),
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: 'Confirm',
        on: {
          click: async (evt) => {
            const btn = evt.currentTarget;
            if (!box.checked) {
              show(note, 'Tick the box to confirm.', false);
              return;
            }
            btn.disabled = true;
            try {
              await api('/account/eligibility', {
                method: 'POST',
                body: JSON.stringify({ confirmed: true }),
              });
              await load();
            } catch (err) {
              show(note, err.message, false);
              btn.disabled = false;
            }
          },
        },
      }),
      note,
    ]);
  }

  // ---- email change --------------------------------------------------------

  function emailCard() {
    const note = feedback();

    if (state.pending_email_change) {
      const pending = state.pending_email_change;
      return card('Change your email address', [
        el('p', { class: 'js-mint-box' }, [
          'A change to ',
          el('strong', { text: pending.new_email }),
          ' is waiting to be confirmed. Your account email has not changed. Check that inbox — the link expires ',
          new Date(pending.expires_at).toLocaleString(),
          '. If it does not arrive we will keep trying, and each new attempt sends a fresh link — an older one will stop working.',
        ]),
        el('button', {
          class: 'btn ghost u-e21d2b9e u-8a359a76',
          type: 'button',
          text: 'Cancel this change',
          on: {
            click: async (e) => {
              e.currentTarget.disabled = true;
              try {
                await api('/account/email-change/cancel', { method: 'POST', body: '{}' });
                await load();
              } catch (err) {
                show(note, err.message, false);
              }
            },
          },
        }),
        note,
      ]);
    }

    const newEmail = el('input', { id: 'new-email', type: 'email' });
    const password = el('input', { id: 'email-password', type: 'password', autocomplete: 'current-password' });

    return card('Change your email address', [
      el('label', { htmlFor: 'new-email', text: 'New email address' }),
      newEmail,
      el('label', { htmlFor: 'email-password', text: 'Your current password' }),
      password,
      el('p', {
        class: 'hint',
        text: 'Your address does not change until you confirm it from the new inbox. We will tell your current address once it does, and you will be signed out everywhere at that point. If the confirmation email does not arrive, we keep retrying — each attempt sends a new link and stops the previous one working, so use the most recent email.',
      }),
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: 'Send confirmation',
        on: {
          click: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await api('/account/email-change', {
                method: 'POST',
                body: JSON.stringify({ new_email: newEmail.value, password: password.value }),
              });
              password.value = '';
              await load();
            } catch (err) {
              show(note, err.message, false);
            } finally {
              btn.disabled = false;
            }
          },
        },
      }),
      note,
    ]);
  }

  // ---- sessions ------------------------------------------------------------

  function sessionsCard() {
    const note = feedback();
    return card('Signed-in devices', [
      el('p', { text: 'Sign out everywhere, including here. Use this if you think somebody else has access.' }),
      el('button', {
        class: 'btn ghost u-e21d2b9e u-8a359a76',
        type: 'button',
        text: 'Sign out everywhere',
        on: {
          click: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api('/account/sessions/revoke-all', { method: 'POST', body: '{}' });
              forgetSession();
              NaseebDom.navigate('/login.html');
            } catch (err) {
              show(note, err.message, false);
            }
          },
        },
      }),
      note,
    ]);
  }

  // ---- export --------------------------------------------------------------

  function exportCard() {
    const password = el('input', { id: 'export-password', type: 'password', autocomplete: 'current-password' });
    const note = feedback();

    return card('Download your data', [
      el('p', { text: 'A JSON file with your account, your entries, giveaways you host, your applications, your claims and your requests.' }),
      el('p', {
        class: 'hint',
        text: 'It does not include passwords, session or login links, other people’s data, internal notes, or the technical signals used to spot entry abuse. Delivery details you gave for a prize stay in the claim itself.',
      }),
      el('label', { htmlFor: 'export-password', text: 'Your current password' }),
      password,
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: 'Download',
        on: {
          click: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const res = await fetch('/api/account/export', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': (await sessionReady).csrf || '',
                },
                body: JSON.stringify({ password: password.value }),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Could not build the export.');
              }
              const text = await res.text();
              password.value = '';
              // Shown in the page rather than saved by script: the CSP sandbox
              // blocks a script-initiated download, and a visible copy is
              // honest about what is in the file.
              show(note, 'Ready — your data is shown below.', true);
              mount(document.getElementById('export-output'), el('pre', { class: 'js-history', text }));
            } catch (err) {
              show(note, err.message, false);
            } finally {
              btn.disabled = false;
            }
          },
        },
      }),
      note,
      el('div', { id: 'export-output' }),
    ]);
  }

  // ---- privacy requests ----------------------------------------------------

  const REQUEST_LABELS = {
    access: 'Ask for a copy of my data',
    correction: 'Ask for something to be corrected',
    deletion: 'Ask for my data to be deleted',
    objection: 'Object to how something is used',
  };

  function requestsCard() {
    const type = el('select', { id: 'request-type' });
    Object.keys(REQUEST_LABELS).forEach((key) => {
      type.appendChild(el('option', { value: key, text: REQUEST_LABELS[key] }));
    });
    const message = el('textarea', { id: 'request-message', maxLength: 4000, rows: 4 });
    const note = feedback();

    const existing = (state.privacy_requests || []).map((r) =>
      el('div', { class: 'u-request-row' }, [
        el('p', { class: 'u-1da9facb' }, [
          el('strong', { text: r.reference }),
          ` · ${REQUEST_LABELS[r.type] || r.type} · ${r.status.replace(/_/g, ' ')}`,
        ]),
        el('p', { class: 'u-a2aae0fb', text: `Submitted ${new Date(r.submitted_at).toLocaleDateString()}` }),
        r.your_message ? el('p', { class: 'u-a2aae0fb', text: `You wrote: ${r.your_message}` }) : null,
        // The outcome sentence the server chose from its allowlist. Never an
        // administrator's working notes.
        r.outcome ? el('p', { class: 'js-mint-box', text: r.outcome }) : null,
        r.blockers && r.blockers.length
          ? el('ul', { class: 'u-a2aae0fb' }, r.blockers.map((b) => el('li', { text: b.note })))
          : null,
      ])
    );

    return card('Ask us to do something', [
      el('label', { htmlFor: 'request-type', text: 'What would you like?' }),
      type,
      el('label', { htmlFor: 'request-message', text: 'Anything you want to add (optional)' }),
      message,
      el('p', {
        class: 'hint',
        text: 'A deletion request is a request for review by a person, not an instant erase. Some records — an open prize claim, a payment record, an audit trail — cannot simply be removed, and we will tell you which.',
      }),
      // Said before the request is sent, not discovered afterwards. Somebody
      // asking to be deleted deserves to know today's answer is "not yet"
      // rather than finding out weeks later.
      el('p', {
        class: 'hint',
        text: 'To be straight with you about deletion specifically: we have not finished deciding which records can be erased, which can be anonymised, and which we are obliged to keep. Until that is settled we will not carry out an erasure, and we will not close your request as done while nothing has been done. It stays open with us.',
      }),
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: 'Send request',
        on: {
          click: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await api('/account/privacy-requests', {
                method: 'POST',
                body: JSON.stringify({ request_type: type.value, message: message.value }),
              });
              message.value = '';
              await load();
            } catch (err) {
              show(note, err.message, false);
            } finally {
              btn.disabled = false;
            }
          },
        },
      }),
      note,
      existing.length
        ? el('div', { class: 'u-680b5a65' }, [el('p', { class: 'u-5bf9ad33', text: 'Your requests' }), existing])
        : null,
      existing.length
        ? el('p', { class: 'hint', text: state.privacy_requests[0].timing_note })
        : null,
    ]);
  }

  // ---- policies ------------------------------------------------------------

  function renderPolicies() {
    const rows = Object.values(state.policies).map((p) =>
      el('p', { class: 'u-1da9facb' }, [
        el('strong', { text: p.id === 'terms' ? 'Terms of Service' : 'Privacy Policy' }),
        ` — ${p.status.toUpperCase()}, version ${p.version}. `,
        p.acceptable
          ? 'In force.'
          : 'Not in force, and cannot be accepted. Nothing you do on this site records agreement to it.',
      ])
    );

    mount(policyState, [
      rows,
      el('p', {
        class: 'hint',
        text: 'Both documents are drafts pending owner information and qualified UAE counsel review. There is no acceptance recorded against your account, and none will be until a document is genuinely in force.',
      }),
      (state.policies_outstanding || []).length
        ? el('p', { class: 'js-mint-box', text: `Outstanding: ${state.policies_outstanding.map((p) => `${p.policy_id} ${p.version}`).join(', ')}` })
        : null,
    ]);
  }

  async function load() {
    try {
      state = await api('/account/me');
    } catch (err) {
      mount(content, errorNode(err.message));
      return;
    }
    mount(content, [detailsCard(), eligibilityCard(), emailCard(), sessionsCard()]);
    mount(dataContent, [exportCard(), requestsCard()]);
    renderPolicies();
  }

  ready.then(load);
