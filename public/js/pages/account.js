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
      text: t('account.saveName'),
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
      return card(t('account.eligibility'), [
        el('p', {
          text: t('account.youConfirmedOn', {
            when: new Date(e.attested_at).toLocaleDateString(locale),
          }),
        }),
        el('p', { class: 'hint', attrs: { 'data-lang-exempt': 'attestation-wording' }, text: e.limitation }),
      ]);
    }

    const box = el('input', { id: 'age-confirm', type: 'checkbox' });
    const note = feedback();

    return card(t('account.eligibility'), [
      el('p', { text: t('account.createdBeforeAttestation') }),
      // The declaration itself stays in English, and is marked as deliberately
      // so rather than left to look like an oversight.
      //
      // server/lib/eligibility.js holds the exact sentence and records which
      // VERSION of it a person agreed to, precisely so that the words read and
      // the words recorded cannot drift apart. Rendering an Arabic sentence
      // while recording the English version would break that on purpose: the
      // audit trail would say somebody agreed to a sentence they never saw.
      //
      // An Arabic declaration needs its own version identifier and a decision on
      // which language governs — a counsel question, recorded as B16/B19 in
      // docs/UAE_COUNSEL_REVIEW.md — not a translation.
      el('label', { class: 'u-age-attest', htmlFor: 'age-confirm', attrs: { 'data-lang-exempt': 'attestation-wording' } }, [
        box,
        el('span', { text: e.wording }),
      ]),
      el('p', { class: 'hint', attrs: { 'data-lang-exempt': 'attestation-wording' }, text: e.limitation }),
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: t('account.confirm'),
        on: {
          click: async (evt) => {
            const btn = evt.currentTarget;
            if (!box.checked) {
              show(note, t('account.tickTheBox'), false);
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
      return card(t('account.changeYourEmailAddress'), [
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
          text: t('account.cancelThisChange'),
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

    return card(t('account.changeYourEmailAddress'), [
      el('label', { htmlFor: 'new-email', text: t('account.newEmailAddress') }),
      newEmail,
      el('label', { htmlFor: 'email-password', text: t('account.yourCurrentPassword') }),
      password,
      el('p', {
        class: 'hint',
        text: t('account.yourAddressDoesNot'),
      }),
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: t('account.sendConfirmation'),
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
    return card(t('account.signedInDevices'), [
      el('p', { text: t('account.signOutEverywhereIncluding') }),
      el('button', {
        class: 'btn ghost u-e21d2b9e u-8a359a76',
        type: 'button',
        text: t('account.signOutEverywhere'),
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

    return card(t('account.downloadYourData'), [
      el('p', { text: t('account.aJsonFileWith') }),
      el('p', {
        class: 'hint',
        text: t('account.itDoesNotInclude'),
      }),
      el('label', { htmlFor: 'export-password', text: t('account.yourCurrentPassword') }),
      password,
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: t('account.download'),
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

  // Keys, resolved at render time. A map of finished sentences built at module
  // scope would be evaluated before applyI18n() has run and would freeze the
  // page in whatever language loaded first.
  const REQUEST_LABELS = {
    access: 'account.requestAccess',
    correction: 'account.requestCorrection',
    deletion: 'account.requestDeletion',
    objection: 'account.requestObjection',
  };

  function requestsCard() {
    const type = el('select', { id: 'request-type' });
    Object.keys(REQUEST_LABELS).forEach((key) => {
      type.appendChild(el('option', { value: key, text: t(REQUEST_LABELS[key]) }));
    });
    const message = el('textarea', { id: 'request-message', maxLength: 4000, rows: 4 });
    const note = feedback();

    const existing = (state.privacy_requests || []).map((r) =>
      el('div', { class: 'u-request-row' }, [
        el('p', { class: 'u-1da9facb' }, [
          el('strong', { text: r.reference }),
          // The status is the server's own machine value, shown as-is. Inventing
          // a translation namespace for a set this file does not define would be
          // a dictionary nobody maintains against a list nobody enumerated.
          ` · ${REQUEST_LABELS[r.type] ? t(REQUEST_LABELS[r.type]) : r.type} · ${r.status.replace(/_/g, ' ')}`,
        ]),
        el('p', {
          class: 'u-a2aae0fb',
          text: t('account.submittedOn', { when: new Date(r.submitted_at).toLocaleDateString(locale) }),
        }),
        r.your_message
          ? el('p', { class: 'u-a2aae0fb', text: t('account.youWrote', { message: isolate(r.your_message) }) })
          : null,
        // The outcome sentence the server chose from its allowlist. Never an
        // administrator's working notes.
        r.outcome ? el('p', { class: 'js-mint-box', text: r.outcome }) : null,
        r.blockers && r.blockers.length
          ? el('ul', { class: 'u-a2aae0fb' }, r.blockers.map((b) => el('li', { text: b.note })))
          : null,
      ])
    );

    return card(t('account.askUsToDo'), [
      el('label', { htmlFor: 'request-type', text: t('account.whatWouldYouLike') }),
      type,
      el('label', { htmlFor: 'request-message', text: t('account.anythingYouWantTo') }),
      message,
      el('p', {
        class: 'hint',
        text: t('account.aDeletionRequestIs'),
      }),
      // Said before the request is sent, not discovered afterwards. Somebody
      // asking to be deleted deserves to know today's answer is "not yet"
      // rather than finding out weeks later.
      el('p', {
        class: 'hint',
        text: t('account.toBeStraightWith'),
      }),
      el('button', {
        class: 'btn primary u-8a359a76',
        type: 'button',
        text: t('account.sendRequest'),
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
        ? el('div', { class: 'u-680b5a65' }, [el('p', { class: 'u-5bf9ad33', text: t('account.yourRequests') }), existing])
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
        el('strong', { text: t(p.id === 'terms' ? 'footer.terms' : 'footer.privacy') }),
        // The version identifier is isolated, not translated: it is the string
        // that names the document, and a translated one names nothing.
        t('account.policyStatusLine', {
          status: t('policy.status.' + p.status) === 'policy.status.' + p.status
            ? p.status.toUpperCase()
            : t('policy.status.' + p.status),
          version: isolate(p.version),
        }),
        p.acceptable ? t('account.policyInForce') : t('account.policyNotInForce'),
      ])
    );

    mount(policyState, [
      rows,
      el('p', {
        class: 'hint',
        text: t('account.bothDocumentsAreDrafts'),
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
