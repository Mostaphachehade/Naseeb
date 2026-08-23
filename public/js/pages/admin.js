
  // Cosmetic only. Every route this page calls re-reads users.is_admin from
  // Postgres on the request, so reaching this page without being an
  // administrator produces a screen full of 403s rather than an admin panel.
  const ready = requireSession('/admin.html');


  async function loadStats() {
    const content = document.getElementById('stats-content');
    try {
      const s = await api('/admin/stats');
      const cards = [
        { num: s.pending_host_applications, label: t('admin.statPendingApplications'), attention: s.pending_host_applications > 0 },
        { num: s.pending_ad_inquiries, label: t('admin.statPendingAdInquiries'), attention: s.pending_ad_inquiries > 0 },
        { num: s.live_giveaways, label: t('admin.statLiveGiveaways') },
        { num: s.total_hosts, label: t('admin.statTotalHosts') },
        { num: s.verified_hosts, label: t('admin.statVerifiedHosts') },
        { num: s.approved_hosts, label: t('admin.statApprovedHosts') },
        { num: s.suspended_hosts, label: t('admin.statSuspendedHosts'), attention: s.suspended_hosts > 0 },
        // The advertiser's business name, inside a label. Text, like every
        // other value on this page.
        {
          num: s.active_ad ? s.active_ad.click_count : '—',
          label: s.active_ad
            ? t('admin.statClicksFor', { business: isolate(s.active_ad.business_name) })
            : t('admin.statNoActiveAd'),
        },
      ];
      mount(content, cards.map((c) => el('div', { class: c.attention ? 'admin-stat attention' : 'admin-stat' }, [
        el('div', { class: 'admin-stat-num', text: c.num }),
        el('div', { class: 'admin-stat-label', text: c.label }),
      ])));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  // The queue deliberately carries no email address, no phone number, no trade
  // licence and no free-text message. A list is a screen that gets left open and
  // scrolled past; none of those fields help decide which application to open.
  // They arrive with the detail fetch below, when an administrator opens one.
  const STATUS_LABELS = {
    pending: 'Waiting for review',
    approved: 'Approved',
    rejected: 'Not approved',
    withdrawn: 'Withdrawn',
  };

  function shortDate(value) {
    return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function pill(text, extraClass) {
    return el('span', { class: extraClass ? 'pill-badge ' + extraClass : 'pill-badge', text });
  }

  // Returns { row, detailRow } rather than a string, so the handlers below close
  // over the actual elements. Nothing looks a row up again by an interpolated
  // selector — `tr[data-detail-for="${id}"]` was a CSS selector built from a
  // database value, which is its own small injection surface even when the value
  // happens to be a UUID today.
  function appRow(a) {
    const detailCell = el('td', { colSpan: 6 });
    const detailRow = el('tr', { class: 'app-detail-row u-c8be1ccb is-hidden' }, detailCell);

    const openBtn = el('button', {
      class: 'btn ghost app-open-btn u-51820e15',
      text: t('admin.review'),
      on: { click: () => openApplication(a.id, detailRow, detailCell) },
    });

    // Closes, never deletes. The row, its submission time, the account it
    // belongs to and its status events all stay exactly where they are — "it was
    // only spam" is a judgement that becomes unreviewable the moment the
    // evidence for it is gone.
    const closeBtn = a.status === 'pending'
      ? el('button', {
          class: 'btn ghost app-close-btn u-51820e15',
          text: t('admin.closeWithoutDeciding'),
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              const reason = prompt('Why is this application being closed without a decision? Recorded against the application.');
              if (reason === null) return;
              if (!reason.trim()) { alert('A short reason is required.'); return; }
              btn.disabled = true;
              try {
                await api(`/admin/host-applications/${encodeURIComponent(a.id)}/close`, {
                  method: 'POST',
                  body: JSON.stringify({ reason }),
                });
                load();
                loadStats();
              } catch (err) {
                alert(err.message);
                btn.disabled = false;
              }
            },
          },
        })
      : null;

    const row = el('tr', { class: a.status !== 'pending' ? 'contacted' : null }, [
      tdNode(pill(a.applicant_type, a.applicant_type === 'company' ? 'company' : null)),
      tdNode([
        a.display_name || '—',
        a.user_id ? null : el('br'),
        a.user_id ? null : el('span', { class: 'u-73c3c8ab', text: t('admin.legacyEnquiryNoAccount') }),
      ]),
      tdNode(pill(STATUS_LABELS[a.status] || a.status)),
      td(shortDate(a.created_at)),
      tdNode(a.decided_at
        ? shortDate(a.decided_at) + (a.decided_by_name ? ` by ${a.decided_by_name}` : '')
        : el('span', { class: 'u-a2aae0fb', text: '—' })),
      tdNode(spaced([openBtn, closeBtn]), 'u-a9efa544'),
    ]);

    return [row, detailRow];
  }

  async function openApplication(id, row, cell) {
    if (!row.classList.contains('is-hidden')) {
      row.classList.add('is-hidden');
      return;
    }
    row.classList.remove('is-hidden');
    setText(cell, 'Loading…');
    try {
      const a = await api(`/admin/host-applications/${encodeURIComponent(id)}`);
      const decided = a.status !== 'pending';

      // Every field below was typed by the applicant: the business name, the
      // contact name, the phone number, the trade licence, the free-text
      // message. They are the reason this panel exists, and none of them is
      // parsed as markup.
      const contactLine = [
        a.account_email || a.contact_email || '—',
        a.contact_phone ? ` · ${a.contact_phone}` : '',
        a.trade_license ? ` · licence ${a.trade_license}` : '',
      ].join('');

      let decisionBlock;
      if (decided) {
        decisionBlock = el('p', {
          class: 'u-45314556',
          text: `${STATUS_LABELS[a.status] || a.status} on ${new Date(a.decided_at).toLocaleString()}`
            + (a.decided_by_name ? ` by ${a.decided_by_name}` : '')
            + (a.decision_reason ? ` — "${a.decision_reason}"` : ''),
        });
      } else {
        const reasonInput = el('input', {
          class: 'decision-reason',
          maxLength: 1000,
          placeholder: t('admin.whyThisDecision'),
        });
        const decide = (decision, label, className) => el('button', {
          class: className,
          text: label,
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              if (!reasonInput.value.trim()) {
                alert('A short reason is required — it is recorded against the decision.');
                return;
              }
              btn.disabled = true;
              try {
                await api(`/admin/host-applications/${encodeURIComponent(a.id)}/decision`, {
                  method: 'POST',
                  body: JSON.stringify({ decision, reason: reasonInput.value }),
                });
                load();
                loadStats();
              } catch (err) {
                alert(err.message);
                btn.disabled = false;
              }
            },
          },
        });

        decisionBlock = frag([
          el('label', { class: 'u-1964b55e', text: t('admin.reasonRecordedAgainstThis') }),
          reasonInput,
          el('div', { class: 'u-d8a81eac' }, [
            decide('approved', 'Approve to host', 'btn primary decide-btn u-14da4875'),
            decide('rejected', 'Do not approve', 'btn ghost decide-btn u-a716ef8e'),
          ]),
          el('p', {
            class: 'hint u-b1ecc496',
            text: t('admin.approvingIsTheOnly'),
          }),
        ]);
      }

      mount(cell, el('div', { class: 'u-1b074808' }, [
        el('p', { class: 'u-a353e69c' }, [
          el('strong', { text: a.business_name || a.full_name }),
          a.business_name ? ` — contact: ${a.full_name}` : null,
        ]),
        el('p', { class: 'u-3e786f67', text: contactLine }),
        a.plan
          ? el('p', {
              class: 'u-06519697',
              text: `Submitted against the withdrawn "${a.plan}" plan, before hosting plans were removed.`,
            })
          : null,
        a.message ? el('p', { class: 'u-f06aec11', text: a.message }) : null,
        el('p', { class: 'u-acb85f03' }, [
          'Account host status: ',
          el('strong', { text: a.host_status || 'no account' }),
        ]),
        decisionBlock,
      ]));
    } catch (err) {
      mount(cell, el('span', { class: 'form-error show', text: err.message }));
    }
  }

  async function load() {
    const content = document.getElementById('content');
    try {
      const applications = await api('/admin/host-applications');
      if (applications.length === 0) {
        mount(content, emptyNode(t('admin.noApplicationsYet')));
        return;
      }
      mount(content, dataTable(
        [t('admin.colType'), t('admin.colWho'), t('admin.colStatus'), t('admin.colSubmitted'), t('admin.colDecided'), t('admin.colActions')],
        applications.flatMap(appRow),
        t('admin.noApplicationsYet')
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  // Advertising inquiries are submitted by anyone who fills in the public form —
  // the least-trusted data on this page. Business name, contact email, phone and
  // the free-text message are all text nodes.
  function adInquiryRow(a) {
    const toggle = el('button', {
      class: 'btn ghost inquiry-contacted-btn u-51820e15',
      text: a.contacted ? 'Mark not contacted' : 'Mark contacted',
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api(`/admin/ad-inquiries/${encodeURIComponent(a.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ contacted: !a.contacted }),
            });
            loadAdInquiries();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        },
      },
    });

    const remove = el('button', {
      class: 'btn ghost inquiry-delete-btn u-54750247',
      text: t('admin.delete'),
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          if (!confirm(t('admin.deleteThisInquiry'))) return;
          btn.disabled = true;
          try {
            await api(`/admin/ad-inquiries/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
            loadAdInquiries();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        },
      },
    });

    return el('tr', { class: a.contacted ? 'contacted' : null }, [
      td(a.business_name),
      tdNode([
        a.contact_email,
        a.contact_phone ? el('br') : null,
        a.contact_phone ? el('span', { class: 'u-c2238623', text: a.contact_phone }) : null,
      ]),
      tdNode(a.message || el('span', { class: 'u-a2aae0fb', text: '—' }), 'u-71b5af5d'),
      td(shortDate(a.created_at)),
      tdNode(spaced([toggle, remove]), 'u-a9efa544'),
    ]);
  }

  async function loadAdInquiries() {
    const content = document.getElementById('ad-inquiries-content');
    try {
      const inquiries = await api('/admin/ad-inquiries');
      if (inquiries.length === 0) {
        mount(content, emptyNode(t('admin.noAdInquiriesYet')));
        return;
      }
      mount(content, dataTable(
        [t('owner.colBusiness'), t('admin.colContact'), t('admin.colMessage'), t('admin.colSubmitted'), t('admin.colActions')],
        inquiries.map(adInquiryRow),
        t('admin.noAdInquiriesYet')
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  function adStatusCell(a) {
    if (a.paid) {
      // starts_at/ends_at arrive as full ISO datetime strings (Postgres
      // DATE values serialize with a time component in JSON) — slice to
      // the date portion before comparing or displaying.
      const startsAt = a.starts_at.slice(0, 10);
      const endsAt = a.ends_at.slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const isLive = startsAt <= today && endsAt >= today;
      const label = isLive ? 'live' : (startsAt > today ? 'upcoming' : 'finished');
      return [
        pill('paid · ' + label, 'company'),
        el('br'),
        el('span', {
          class: 'hint u-b98cacf2',
          text: `${startsAt} – ${endsAt} · AED ${Number(a.amount_aed).toLocaleString()}`,
        }),
      ];
    }
    if (a.stripe_session_id) return pill('checkout pending');
    return a.active ? pill('active', 'company') : pill('inactive');
  }

  function adRow(a) {
    // The banner itself. Escaping a URL and dropping it into a src is what this
    // used to do; the media validator is what it does now, and an ad whose media
    // is not on an allowed origin shows no thumbnail rather than fetching from
    // wherever the URL pointed.
    const thumb = a.media_type === 'video'
      ? el('video', { muted: true, class: 'u-6e0bccff' })
      : el('img', { alt: '', class: 'u-6e0bccff' });
    NaseebDom.setMediaSrc(thumb, a.image_url);

    // The destination is advertiser-supplied and genuinely off-site, so it gets
    // the external-link validator rather than the internal one. A rejected
    // destination is shown as plain text with no href — visible to the
    // administrator reviewing it, and not clickable.
    const destination = el('a', { target: '_blank', text: a.target_url });
    NaseebDom.setExternalHref(destination, a.target_url);

    // Self-serve paid bookings are scheduled by date, not hand-toggled —
    // only manually-created admin ads get the activate/deactivate button.
    const isManual = !a.paid && !a.stripe_session_id;
    const toggle = isManual
      ? el('button', {
          class: 'btn ghost ad-toggle-btn u-cc20b935',
          text: a.active ? 'Deactivate' : 'Activate',
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                await api(`/admin/ads/${encodeURIComponent(a.id)}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ active: !a.active }),
                });
                loadAds();
              } catch (err) {
                alert(err.message);
                btn.disabled = false;
              }
            },
          },
        })
      : null;

    const remove = el('button', {
      class: 'btn ghost ad-delete-btn u-162e4030',
      text: t('admin.delete'),
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          if (!confirm(t('admin.deleteThisAd'))) return;
          btn.disabled = true;
          try {
            await api(`/admin/ads/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
            loadAds();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        },
      },
    });

    return el('tr', {}, [
      tdNode(thumb),
      tdNode([a.business_name, ' ', a.media_type === 'video' ? pill('video') : null]),
      tdNode(destination, 'u-9f5261ae'),
      td(a.click_count, 'mono'),
      tdNode(adStatusCell(a)),
      tdNode(spaced([toggle, remove])),
    ]);
  }

  async function loadAds() {
    const content = document.getElementById('ads-content');
    try {
      const ads = await api('/admin/ads');
      if (ads.length === 0) {
        mount(content, emptyNode(t('admin.noAdsYet')));
        return;
      }
      mount(content, dataTable(
        [t('admin.colBanner'), t('owner.colBusiness'), t('admin.colDestination'), t('admin.colClicks'), t('admin.colStatus'), t('admin.colActions')],
        ads.map(adRow),
        t('admin.noAdsYet')
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  const GIVEAWAY_STATUS_CLASS = { active: 'company', cancelled: '', drawn: '' };

  function giveawayRow(g) {
    const statusChange = (status, label, className, confirmText) => el('button', {
      class: className,
      text: label,
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          if (confirmText && !confirm(confirmText)) return;
          btn.disabled = true;
          try {
            await api(`/admin/giveaways/${encodeURIComponent(g.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ status }),
            });
            loadGiveaways();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        },
      },
    });

    let action = el('span', { class: 'u-c2238623', text: '—' });
    if (g.status === 'active') {
      action = statusChange('cancelled', 'Cancel', 'btn ghost giveaway-cancel-btn u-162e4030',
        'Cancel this giveaway? Entrants will no longer be able to enter.');
    } else if (g.status === 'cancelled') {
      action = statusChange('active', 'Reinstate', 'btn ghost giveaway-reinstate-btn u-cc20b935');
    }

    return el('tr', {}, [
      td(g.title),
      tdNode([g.host_name, el('br'), el('span', { class: 'u-c2238623', text: g.host_email })]),
      td(g.entry_count, 'mono'),
      td(shortDate(g.entry_deadline)),
      tdNode(pill(g.status, GIVEAWAY_STATUS_CLASS[g.status] || null)),
      tdNode(action),
    ]);
  }

  async function loadGiveaways() {
    const content = document.getElementById('giveaways-content');
    try {
      const giveaways = await api('/admin/giveaways');
      if (giveaways.length === 0) {
        mount(content, emptyNode(t('admin.noGiveawaysYet')));
        return;
      }
      mount(content, dataTable(
        ['Title', 'Host', 'Entries', 'Deadline', 'Status', 'Actions'],
        giveaways.map(giveawayRow),
        'No giveaways yet.'
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  function userRow(u) {
    const verifiedToggle = el('input', {
      type: 'checkbox',
      class: 'verified-toggle',
      // Named per row. A column header is not an accessible name: somebody
      // moving through the table cell by cell hears "checkbox, not checked"
      // with no indication of WHOSE verified badge is about to be toggled.
      // aria: { label }, not 'aria-label'. el() routes 'aria' through
      // setAttribute and THROWS on any other unrecognised key, so the direct
      // form did not add an accessible name — it aborted the render of every
      // row in this table. It was invisible because the admin table only builds
      // for a signed-in administrator, which axe never is.
      aria: { label: t('admin.verifiedBadgeFor', { who: isolate(u.name || u.email || t('admin.thisAccount')) }) },
      checked: Boolean(u.is_verified_business),
      on: {
        change: async (e) => {
          const box = e.currentTarget;
          const is_verified_business = box.checked;
          box.disabled = true;
          try {
            await api(`/admin/users/${encodeURIComponent(u.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ is_verified_business }),
            });
          } catch (err) {
            box.checked = !is_verified_business;
            alert(err.message);
          } finally {
            box.disabled = false;
          }
        },
      },
    });

    // There is no delete control, and the route behind the one that used to be
    // here is gone. Removing an account is not an administrative convenience:
    // it sidesteps the reviewed privacy workflow, and it is the one action on
    // this page that cannot be undone or explained afterwards. Suspension,
    // session revocation and a privacy request cover every legitimate reason
    // somebody reached for it. See docs/PRIVACY_AND_RIGHTS.md §8.

    return el('tr', {}, [
      tdNode([u.name, u.is_admin ? ' ' : null, u.is_admin ? pill('admin', 'company') : null]),
      td(u.email),
      td(u.giveaways_hosted, 'mono'),
      td(shortDate(u.created_at)),
      tdNode(verifiedToggle),
      tdNode(hostStatusCell(u)),
      tdNode(hostActions(u), 'u-a9efa544'),
    ]);
  }

  const HOST_STATUS_LABELS = {
    not_requested: 'Never applied',
    pending: 'Waiting for review',
    approved: 'Approved',
    rejected: 'Not approved',
    suspended: 'Suspended',
  };

  function hostStatusCell(u) {
    return [
      pill(HOST_STATUS_LABELS[u.host_status] || u.host_status || '—'),
      u.host_status_changed_at ? el('br') : null,
      u.host_status_changed_at
        ? el('span', {
            class: 'u-5e8e7900',
            text: new Date(u.host_status_changed_at).toLocaleDateString(),
          })
        : null,
      u.is_admin ? el('br') : null,
      u.is_admin ? el('span', { class: 'u-5e8e7900', text: t('admin.adminThisGateDoes') }) : null,
    ];
  }

  // Suspending and reinstating both need a reason, so both go through the same
  // prompt. Neither deletes anything.
  function hostActions(u) {
    const status = u.host_status === 'approved' ? 'suspended' : 'approved';
    const label = u.host_status === 'approved'
      ? 'Suspend hosting'
      : u.host_status === 'suspended' ? 'Reinstate' : 'Grant hosting';

    return el('button', {
      // `on-light`: this ghost button sits on the white admin table, where
      // `.btn`'s paper text measures 1.11:1. See public/css/style.css.
      class: 'btn ghost on-light host-status-btn u-51820e15',
      text: label,
      // "Suspend hosting" is unambiguous only if you can see which row it is in.
      aria: { label: t('admin.actionForAccount', { action: label, who: isolate(u.name || u.email || t('admin.thisAccount')) }) },
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          const reason = prompt(
            status === 'suspended'
              ? 'Why is hosting being suspended? This is recorded against the change and shown to the account.'
              : 'Why is hosting being granted? This is recorded against the change and shown to the account.'
          );
          if (reason === null) return;
          if (!reason.trim()) {
            alert('A short reason is required.');
            return;
          }
          btn.disabled = true;
          try {
            const result = await api(`/admin/hosts/${encodeURIComponent(u.id)}/status`, {
              method: 'POST',
              body: JSON.stringify({ status, reason }),
            });
            if (result.open_claims_affected > 0) {
              alert(
                `${result.open_claims_affected} open prize claim(s) for this host are now handled by an administrator. ` +
                'Nothing was deleted — the winner can raise a dispute and an administrator resolves it.'
              );
            }
            loadUsers();
            loadStats();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        },
      },
    });
  }

  async function loadUsers() {
    const content = document.getElementById('users-content');
    try {
      const users = await api('/admin/users');
      if (users.length === 0) {
        mount(content, emptyNode(t('admin.noAccountsYet')));
        return;
      }
      mount(content, dataTable(
        ['Name', 'Email', 'Hosted', 'Joined', 'Verified', 'Host access', 'Actions'],
        users.map(userRow),
        'No accounts yet.'
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  let cloudinaryConfig = null;
  let adMediaType = 'image';

  fetch('/api/config').then((r) => r.json()).then((config) => {
    if (config.cloudinary_cloud_name && config.cloudinary_upload_preset) {
      cloudinaryConfig = config;
      document.getElementById('ad-image-upload-row').classList.remove('is-hidden');
      document.getElementById('ad-image-url-hint').textContent = t('admin.uploadAFileAbove');
    }
  }).catch(() => {});

  document.querySelectorAll('#ad-media-type-toggle .segmented-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      adMediaType = btn.dataset.value;
      document.querySelectorAll('#ad-media-type-toggle .segmented-option').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      const isVideo = adMediaType === 'video';
      document.getElementById('ad-file-label').textContent = isVideo ? 'Banner video' : 'Banner image';
      document.getElementById('ad_image_file').accept = isVideo ? 'video/*' : 'image/*';
      document.getElementById('ad_image_file').value = '';
      document.getElementById('ad_image_url').value = '';
      document.getElementById('ad-image-preview').classList.add('is-hidden');
      document.getElementById('ad-video-preview').classList.add('is-hidden');
      document.getElementById('ad-upload-status').textContent = '';
    });
  });

  document.getElementById('ad_image_file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !cloudinaryConfig) return;
    const statusEl = document.getElementById('ad-upload-status');
    statusEl.textContent = t('admin.uploading');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', cloudinaryConfig.cloudinary_upload_preset);
    const resourceType = adMediaType === 'video' ? 'video' : 'image';
    try {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudinary_cloud_name}/${resourceType}/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Upload failed.');
      const imgPreview = document.getElementById('ad-image-preview');
      const videoPreview = document.getElementById('ad-video-preview');
      const target = adMediaType === 'video' ? videoPreview : imgPreview;
      const other = adMediaType === 'video' ? imgPreview : videoPreview;
      if (!NaseebDom.setMediaSrc(target, data.secure_url)) {
        statusEl.textContent = t('admin.uploadReturnedAMedia');
        return;
      }
      document.getElementById('ad_image_url').value = data.secure_url;
      target.classList.remove('is-hidden');
      other.classList.add('is-hidden');
      statusEl.textContent = t('admin.uploaded');
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  document.getElementById('ad-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('ad-create-error');
    errorEl.classList.remove('show');
    try {
      await api('/admin/ads', {
        method: 'POST',
        body: JSON.stringify({
          business_name: document.getElementById('ad_business_name').value,
          image_url: document.getElementById('ad_image_url').value,
          target_url: document.getElementById('ad_target_url').value,
          media_type: adMediaType,
        }),
      });
      e.target.reset();
      document.getElementById('ad-image-preview').classList.add('is-hidden');
      document.getElementById('ad-video-preview').classList.add('is-hidden');
      loadAds();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });

  function wireSearch(inputId, containerId) {
    document.getElementById(inputId).addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase();
      document.querySelectorAll(`#${containerId} tbody tr`).forEach((row) => {
        row.classList.toggle('is-hidden', !row.textContent.toLowerCase().includes(term));
      });
    });
  }
  wireSearch('applications-search', 'content');
  wireSearch('hosts-search', 'users-content');

  function ageLabel(since) {
    if (!since) return '';
    const days = Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'} old`;
    const hours = Math.floor((Date.now() - new Date(since).getTime()) / 3600000);
    return `${hours} hour${hours === 1 ? '' : 's'} old`;
  }

  // ------------------------------------------------------------------
  // Suspended-host claim rescue
  // ------------------------------------------------------------------

  // What a rescuer may do from each state. Mirrors the server table in
  // server/lib/claimStateMachine.js; the server refuses anything else outright,
  // so this only decides which button to draw.
  const RESCUE_NEXT = {
    claimed: { to: 'preparing_delivery', label: t('admin.markPreparingDelivery') },
    preparing_delivery: { to: 'shipped_or_arranged', label: t('admin.markShippedArranged') },
    shipped_or_arranged: { to: 'delivered_pending_confirmation', label: t('admin.reportDeliveredWinnerConfirms') },
  };

  const CLAIM_STATE_LABELS = {
    awaiting_claim: 'Waiting for the winner to claim',
    claimed: 'Claimed — waiting on the host',
    preparing_delivery: 'Preparing delivery',
    shipped_or_arranged: 'Shipped or arranged',
    delivered_pending_confirmation: 'Waiting for the winner to confirm receipt',
    disputed: 'Disputed',
    expired: 'Claim window expired',
  };

  function rescueRow(r) {
    const detailCell = el('td', { colSpan: 4 });
    const detailRow = el('tr', { class: 'u-c8be1ccb is-hidden' }, detailCell);

    const next = r.action_available ? RESCUE_NEXT[r.claim_status] : null;
    const stepBtn = next
      ? el('button', {
          class: 'btn primary rescue-step u-51820e15',
          text: next.label,
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              const reason = prompt('Why are you taking this step for the host? Recorded in the claim history.');
              if (reason === null) return;
              if (!reason.trim()) { alert('A short reason is required.'); return; }
              btn.disabled = true;
              try {
                await api(`/claims/${encodeURIComponent(r.claim_id)}/rescue/transition`, {
                  method: 'POST',
                  body: JSON.stringify({ to: next.to, reason }),
                });
                loadRescueQueue();
                loadClaims();
              } catch (err) {
                alert(err.message);
                btn.disabled = false;
              }
            },
          },
        })
      : null;

    // A winner's address and phone number. Opened only on this deliberate
    // click, for one claim, with a recorded reason — and rendered one field per
    // element, as text. Nothing about a delivery address should ever be able to
    // reach a parser.
    const detailsBtn = r.delivery_available
      ? el('button', {
          class: 'btn ghost rescue-details u-51820e15',
          text: t('admin.openDeliveryDetails'),
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              if (!detailRow.classList.contains('is-hidden')) {
                detailRow.classList.add('is-hidden');
                clear(detailCell);
                return;
              }
              const reason = prompt("Why do you need the winner's address? This is recorded against the claim.");
              if (reason === null) return;
              if (!reason.trim()) { alert('A short reason is required.'); return; }
              btn.disabled = true;
              try {
                const result = await api(`/claims/${encodeURIComponent(r.claim_id)}/rescue/delivery-details`, {
                  method: 'POST',
                  body: JSON.stringify({ reason }),
                });
                const d = result.delivery.details;
                detailRow.classList.remove('is-hidden');
                mount(detailCell, el('div', { class: 'u-1b074808' }, [
                  el('p', {
                    class: 'u-06519697',
                    text: `Opened for fulfilment and recorded in this claim's history. Winner consented ${new Date(result.delivery.consentedAt).toLocaleDateString()} (${result.delivery.consentVersion}).`,
                  }),
                  el('p', { class: 'u-1da9facb', text: `${d.recipient_name} · ${d.phone}` }),
                  el('p', {
                    class: 'u-1da9facb',
                    text: d.address_line2 ? `${d.address_line1}, ${d.address_line2}` : d.address_line1,
                  }),
                  el('p', { class: 'u-1da9facb', text: `${d.city}, ${d.emirate}` }),
                  d.notes ? el('p', { class: 'u-f1d2a576', text: d.notes }) : null,
                ]));
              } catch (err) {
                alert(err.message);
              } finally {
                btn.disabled = false;
              }
            },
          },
        })
      : el('span', { class: 'u-73c3c8ab', text: t('admin.noDetailsAvailable') });

    const row = el('tr', {}, [
      tdNode([
        r.title,
        el('br'),
        el('span', { class: 'u-a76e0798', text: `host: ${r.host_name} · winner: ${r.winner_name}` }),
      ]),
      tdNode(pill(CLAIM_STATE_LABELS[r.claim_status] || r.claim_status)),
      tdNode([
        new Date(r.opened_at).toLocaleDateString(),
        el('br'),
        // The reason an administrator typed when suspending the host.
        el('span', { class: 'u-a76e0798', text: r.opened_reason || '' }),
      ]),
      tdNode(spaced([
        stepBtn,
        detailsBtn,
        next ? null : el('span', {
          class: 'u-c2238623',
          text: t('admin.nothingForYouTo'),
        }),
      ]), 'u-a9efa544'),
    ]);

    return [row, detailRow];
  }

  async function loadRescueQueue() {
    const content = document.getElementById('rescue-content');
    try {
      const rows = await api('/claims/admin/rescue-queue');
      if (rows.length === 0) {
        mount(content, emptyNode(t('admin.noSuspendedHostClaim')));
        return;
      }
      mount(content, dataTable(
        ['Giveaway', 'Claim state', 'In the queue since', 'Actions'],
        rows.flatMap(rescueRow),
        'No suspended host has an unfinished claim.'
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  async function loadClaims() {
    const box = document.getElementById('claims-content');
    try {
      const rows = await api('/claims/admin/review');
      if (!rows.length) {
        box.replaceChildren();
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = t('admin.nothingWaitingDisputesAnd');
        box.appendChild(empty);
        return;
      }

      box.replaceChildren();
      rows.forEach((row) => {
        const card = document.createElement('div');
        card.className = 'card narrow';
        card.classList.add('js-card-block');

        const head = document.createElement('div');
        head.classList.add('js-row-between');
        const title = document.createElement('strong');
        title.textContent = row.title;
        const pill = document.createElement('span');
        pill.className = 'pill-badge';
        pill.textContent = row.status === 'disputed' ? 'Disputed' : 'Claim expired';
        head.append(title, pill);

        const meta = document.createElement('p');
        meta.className = 'hint';
        meta.textContent = `Winner: ${row.winner_name} · Host: ${row.host_name} · ${ageLabel(row.disputed_at || row.expired_at)}`;

        const action = document.createElement('p');
        action.classList.add('js-muted-note');
        action.textContent =
          row.status === 'disputed'
            ? 'Needs a decision: mark delivered, send back for redelivery, or close it. A reason is required either way.'
            : 'Needs a decision: reissue the claim link to the same winner, or close it.';

        const controls = document.createElement('div');
        controls.classList.add('js-button-row');

        const open = document.createElement('button');
        open.className = 'btn ghost';
        open.textContent = t('admin.openCase');
        // Delivery details are loaded only here, on a deliberate click by an
        // authenticated administrator — never as part of the list above.
        open.onclick = () => openCase(row, card);
        controls.appendChild(open);

        card.append(head, meta, action, controls);
        box.appendChild(card);
      });
    } catch (err) {
      box.textContent = err.message;
    }
  }

  async function openCase(row, card) {
    if (card.querySelector('.case-detail')) return;

    const detail = document.createElement('div');
    detail.className = 'case-detail';
    detail.classList.add('js-detail-panel');
    card.appendChild(detail);

    let claim;
    try {
      claim = await api(`/claims/giveaway/${row.giveaway_id}`);
    } catch (err) {
      detail.textContent = err.message;
      return;
    }

    const history = document.createElement('div');
    history.classList.add('js-history');
    claim.history.forEach((event) => {
      const line = document.createElement('div');
      line.textContent = `${new Date(event.created_at).toLocaleString()} — ${event.to_status.replace(/_/g, ' ')} by ${event.actor_role}${event.note ? `: ${event.note}` : ''}`;
      history.appendChild(line);
    });
    detail.appendChild(history);

    if (claim.delivery && claim.delivery.available) {
      const d = claim.delivery.details;
      const box = document.createElement('div');
      box.classList.add('js-mint-box');
      const label = document.createElement('strong');
      label.textContent = t('admin.deliveryDetailsOpenedDeliberately');
      box.appendChild(label);
      [d.recipient_name, d.phone, d.address_line1, d.address_line2, [d.city, d.emirate].filter(Boolean).join(', ')]
        .filter(Boolean)
        .forEach((line) => {
          const p = document.createElement('div');
          p.textContent = line;
          box.appendChild(p);
        });
      detail.appendChild(box);
    }

    const reason = document.createElement('textarea');
    reason.placeholder = 'Reason for your decision — recorded against this claim.';
    reason.maxLength = 500;
    reason.classList.add('js-spaced-input');
    detail.appendChild(reason);

    const error = document.createElement('p');
    error.className = 'form-error';

    const act = async (to) => {
      error.classList.remove('show');
      if (!reason.value.trim()) {
        error.textContent = t('admin.aReasonIsRequired');
        error.classList.add('show');
        return;
      }
      try {
        await api(`/claims/${claim.id}/transition`, {
          method: 'POST',
          body: JSON.stringify({ to, note: reason.value.trim() }),
        });
        loadClaims();
      } catch (err) {
        error.textContent = err.message;
        error.classList.add('show');
      }
    };

    const buttons = document.createElement('div');
    buttons.classList.add('js-button-row');

    if (row.status === 'disputed') {
      [['delivered', 'Mark delivered'], ['preparing_delivery', 'Send back for redelivery'], ['cancelled', 'Close claim']].forEach(
        ([to, label]) => {
          const b = document.createElement('button');
          b.className = 'btn ghost';
          b.textContent = label;
          b.onclick = () => act(to);
          buttons.appendChild(b);
        }
      );
    } else {
      const reissue = document.createElement('button');
      reissue.className = 'btn primary';
      reissue.textContent = t('admin.reissueClaimLinkTo');
      reissue.onclick = async () => {
        error.classList.remove('show');
        try {
          await api(`/claims/${claim.id}/admin/reissue`, {
            method: 'POST',
            body: JSON.stringify({ note: reason.value.trim() || 'reissued after review' }),
          });
          loadClaims();
        } catch (err) {
          error.textContent = err.message;
          error.classList.add('show');
        }
      };
      buttons.appendChild(reissue);

      const close = document.createElement('button');
      close.className = 'btn ghost';
      close.textContent = t('admin.closeClaim');
      close.onclick = () => act('cancelled');
      buttons.appendChild(close);
    }

    detail.append(buttons, error);
  }

  async function loadMissingClaims() {
    const box = document.getElementById('missing-claims-content');
    try {
      const rows = await api('/claims/admin/missing-claims');
      box.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = t('admin.noneEveryDrawnGiveaway');
        box.appendChild(empty);
        return;
      }
      rows.forEach((row) => {
        const card = document.createElement('div');
        card.className = 'card narrow';
        card.classList.add('js-summary-card');
        const label = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = row.title;
        const who = document.createElement('div');
        who.className = 'hint';
        who.textContent = `Winner already drawn: ${row.winner_name}`;
        label.append(title, who);

        const button = document.createElement('button');
        button.className = 'btn primary';
        button.textContent = t('admin.issueClaimToThat');
        button.onclick = async () => {
          button.disabled = true;
          try {
            await api(`/claims/admin/backfill/${row.giveaway_id}`, { method: 'POST' });
            loadMissingClaims();
            loadClaims();
          } catch (err) {
            who.textContent = err.message;
            button.disabled = false;
          }
        };
        card.append(label, button);
        box.appendChild(card);
      });
    } catch (err) {
      box.textContent = err.message;
    }
  }

  // ------------------------------------------------------------------
  // Entry integrity
  // ------------------------------------------------------------------

  const INTEGRITY_STATUS_LABELS = {
    eligible: 'Eligible',
    under_review: 'Under review',
    disqualified: 'Disqualified',
  };

  // What each signal category means in words, next to the signal itself, so a
  // reviewer is reminded that a shared network is usually a household.
  const SIGNAL_LABELS = {
    shared_network_new_accounts: 'Several new accounts, one network',
    rapid_entry_velocity: 'Rapid entries from one network',
  };

  function integrityRow(r) {
    const detailCell = el('td', { colSpan: 6 });
    const detailRow = el('tr', { class: 'u-c8be1ccb is-hidden' }, detailCell);

    const openBtn = el('button', {
      class: 'btn ghost u-51820e15',
      text: t('admin.open'),
      on: { click: () => openIntegrityEntry(r.entry_id, detailRow, detailCell) },
    });

    const signals = (r.signal_categories || []).map((code) =>
      pill(SIGNAL_LABELS[code] || code)
    );

    return [
      el('tr', {}, [
        tdNode([
          r.giveaway_title,
          el('br'),
          el('span', {
            class: 'u-a76e0798',
            text: `ticket #${r.ticket_number} · account ${r.account_ref} · ${r.account_age_days}d old`,
          }),
        ]),
        tdNode([
          pill(INTEGRITY_STATUS_LABELS[r.status] || r.status),
          r.is_winner ? ' ' : null,
          r.is_winner ? pill('winner', 'company') : null,
        ]),
        tdNode(signals.length ? spaced(signals) : el('span', { class: 'u-a2aae0fb', text: '—' })),
        td(new Date(r.entered_at).toLocaleDateString()),
        tdNode(
          r.case_open
            ? pill(r.case_post_draw ? 'case open · post-draw' : 'case open')
            : el('span', { class: 'u-a2aae0fb', text: '—' })
        ),
        tdNode(openBtn, 'u-a9efa544'),
      ]),
      detailRow,
    ];
  }

  async function openIntegrityEntry(entryId, row, cell) {
    if (!row.classList.contains('is-hidden')) {
      row.classList.add('is-hidden');
      clear(cell);
      return;
    }
    row.classList.remove('is-hidden');
    setText(cell, 'Loading…');

    let data;
    try {
      data = await api(`/admin/integrity/entries/${encodeURIComponent(entryId)}`);
    } catch (err) {
      mount(cell, el('span', { class: 'form-error show', text: err.message }));
      return;
    }

    // Two fields, because they go to two different audiences.
    //
    // The notes are internal: evidence, other accounts, what a signal showed.
    // The code chooses a fixed sentence the entrant reads, and the preview below
    // shows exactly which one — so nobody has to guess what a stranger will be
    // told about them.
    const notesInput = el('textarea', {
      class: 'js-spaced-input',
      maxLength: 4000,
      placeholder: t('admin.administratorNotesInternalEvidence'),
    });
    const error = el('p', { class: 'form-error' });
    const preview = el('p', { class: 'hint js-flush' });

    const codeSelect = el('select', { class: 'js-spaced-input' });
    function fillCodes(status) {
      clear(codeSelect);
      (data.reason_codes[status] || []).forEach((code) => {
        codeSelect.appendChild(el('option', { value: code, text: code.replace(/_/g, ' ') }));
      });
      setText(preview, 'The entrant will read: ' + (data.entrant_copy[codeSelect.value] || ''));
    }
    codeSelect.addEventListener('change', () => {
      setText(preview, 'The entrant will read: ' + (data.entrant_copy[codeSelect.value] || ''));
    });

    const decide = (status, label, className) => el('button', {
      class: className,
      text: label,
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          error.classList.remove('show');
          fillCodes(status);
          if (!notesInput.value.trim()) {
            error.textContent = t('admin.administratorNotesAreRequired');
            error.classList.add('show');
            return;
          }
          if (!codeSelect.value) {
            error.textContent = t('admin.chooseTheExplanationThe');
            error.classList.add('show');
            return;
          }
          btn.disabled = true;
          try {
            await api(`/admin/integrity/entries/${encodeURIComponent(entryId)}/status`, {
              method: 'POST',
              body: JSON.stringify({
                status,
                reason_code: codeSelect.value,
                admin_notes: notesInput.value.trim(),
                // The version this screen was drawn from. A decision made from a
                // stale screen is refused rather than silently applied last.
                version: data.entry.version,
              }),
            });
            loadIntegrity();
          } catch (err) {
            error.textContent = err.message;
            error.classList.add('show');
            btn.disabled = false;
          }
        },
      },
    });

    const actions = [];
    if (data.entry.status !== 'under_review') {
      actions.push(decide('under_review', 'Place under review', 'btn ghost u-51820e15'));
    }
    if (data.entry.status !== 'disqualified' && !data.entry.is_winner) {
      actions.push(decide('disqualified', 'Disqualify', 'btn ghost u-54750247'));
    }
    if (data.entry.status !== 'eligible') {
      actions.push(decide('eligible', 'Reinstate', 'btn primary u-14da4875'));
    }

    // A drawn winner cannot be disqualified from here. Replacing a winner is a
    // policy decision this platform does not make automatically.
    const winnerNote = data.entry.is_winner
      ? el('p', {
          class: 'hint u-b1ecc496',
          text: t('admin.thisEntryWonIt'),
        })
      : null;

    const caseBtn = el('button', {
      class: 'btn ghost u-51820e15',
      text: t('admin.openIntegrityCasePauses'),
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          error.classList.remove('show');
          if (!notesInput.value.trim()) {
            error.textContent = t('admin.administratorNotesAreRequired2');
            error.classList.add('show');
            return;
          }
          btn.disabled = true;
          try {
            await api('/admin/integrity/cases', {
              method: 'POST',
              body: JSON.stringify({
                giveaway_id: data.giveaway.id,
                entry_id: data.entry.id,
                admin_notes: notesInput.value.trim(),
              }),
            });
            loadIntegrity();
          } catch (err) {
            error.textContent = err.message;
            error.classList.add('show');
            btn.disabled = false;
          }
        },
      },
    });

    // A blocked case is still live. It stays here, and it stays blocking.
    const openCase = (data.cases || []).find(
      (c) => c.status === 'open' || c.status === 'upheld_blocked'
    );
    const blockedCase = openCase && openCase.status === 'upheld_blocked';
    const resolveButtons = openCase && !blockedCase
      ? ['reinstated', 'upheld', 'no_action'].map((resolution) =>
          el('button', {
            class: 'btn ghost u-51820e15',
            text:
              resolution === 'reinstated'
                ? 'Reinstate and resume fulfilment'
                : resolution === 'upheld'
                  ? 'Uphold — keeps fulfilment blocked'
                  : 'No action needed — resume',
            on: {
              click: async (e) => {
                const btn = e.currentTarget;
                error.classList.remove('show');
                if (!notesInput.value.trim()) {
                  error.textContent = t('admin.administratorNotesAreRequired3');
                  error.classList.add('show');
                  return;
                }
                btn.disabled = true;
                try {
                  await api(`/admin/integrity/cases/${encodeURIComponent(openCase.id)}/resolve`, {
                    method: 'POST',
                    body: JSON.stringify({
                      resolution,
                      admin_notes: notesInput.value.trim(),
                      version: openCase.version,
                    }),
                  });
                  loadIntegrity();
                } catch (err) {
                  error.textContent = err.message;
                  error.classList.add('show');
                  btn.disabled = false;
                }
              },
            },
          })
        )
      : [];

    mount(cell, el('div', { class: 'u-1b074808' }, [
      el('p', { class: 'u-a353e69c' }, [
        el('strong', { text: data.account.name }),
        ` · ${data.account.email}`,
        data.account.email_verified ? ' · verified' : ' · unverified',
      ]),
      el('p', {
        class: 'u-3e786f67',
        text: `Account created ${new Date(data.account.created_at).toLocaleDateString()} · entered ${new Date(data.entry.entered_at).toLocaleString()} · ticket #${data.entry.ticket_number}`,
      }),

      el('p', { class: 'u-5bf9ad33', text: t('admin.signals') }),
      data.signals.length
        ? el('div', { class: 'js-history' }, data.signals.map((sig) =>
            el('div', {
              text: `${SIGNAL_LABELS[sig.code] || sig.code} · ${sig.severity} · seen ${new Date(sig.observed_at).toLocaleString()} · expires ${new Date(sig.expires_at).toLocaleDateString()}`,
            })
          ))
        : el('p', { class: 'hint js-flush', text: t('admin.noSignalsRecordedFor') }),
      el('p', {
        class: 'hint u-b1ecc496',
        text: t('admin.signalsAreIndicatorsNot'),
      }),

      el('p', { class: 'u-5bf9ad33', text: t('admin.history') }),
      data.history.length
        ? el('div', { class: 'js-history' }, data.history.map((ev) =>
            el('div', {
              text: `${new Date(ev.created_at).toLocaleString()} — ${ev.from_status || 'new'} → ${ev.to_status} (${ev.reason_code}) by ${ev.actor_name || ev.actor_role}${ev.reason ? `: ${ev.reason}` : ''}`,
            })
          ))
        : el('p', { class: 'hint js-flush', text: t('admin.noDecisionsRecordedYet') }),

      openCase
        ? el('p', {
            class: 'js-mint-box',
            text: blockedCase
              ? `UPHELD and blocked since ${new Date(openCase.resolved_at || openCase.opened_at).toLocaleString()}. Fulfilment stays paused and this case stays in the queue. Cancelling, replacing the winner or redrawing is not available here — it needs an owner and legal decision. Notes: ${openCase.resolution_reason || openCase.opened_reason}`
              : `Case open since ${new Date(openCase.opened_at).toLocaleString()}${openCase.post_draw ? ' (post-draw — fulfilment is paused)' : ''}. Notes: ${openCase.opened_reason}`,
          })
        : null,

      winnerNote,
      el('label', { class: 'u-1964b55e', text: t('admin.administratorNotesInternalNever') }),
      notesInput,
      el('label', { class: 'u-1964b55e', text: t('admin.explanationTheEntrantWill') }),
      codeSelect,
      preview,
      el('div', { class: 'js-button-row' }, spaced([...actions, openCase ? null : caseBtn, ...resolveButtons])),
      error,
    ]));
  }

  // ------------------------------------------------------------------
  // Privacy requests
  // ------------------------------------------------------------------

  const PRIVACY_TYPE_LABELS = {
    access: 'Access',
    correction: 'Correction',
    deletion: 'Deletion',
    objection: 'Objection',
  };

  const PRIVACY_STATUS_LABELS = {
    submitted: 'Submitted',
    in_review: 'In review',
    awaiting_information: 'Awaiting information',
    awaiting_policy: 'Awaiting retention policy',
    completed: 'Completed',
    declined: 'Declined',
    unable_to_complete: 'Unable to complete',
  };

  const BLOCKER_LABELS = {
    open_prize_claim: 'Open prize claim',
    active_giveaway_hosted: 'Hosting an open giveaway',
    open_dispute: 'Open dispute',
    open_integrity_case: 'Open integrity case',
    audit_records: 'Audit records',
    deletion_policy_pending: 'Retention rules not approved',
  };

  function privacyRow(r) {
    const detailCell = el('td', { colSpan: 6 });
    const detailRow = el('tr', { class: 'u-c8be1ccb is-hidden' }, detailCell);

    const openBtn = el('button', {
      class: 'btn ghost u-51820e15',
      text: t('admin.open'),
      on: { click: () => openPrivacyRequest(r.id, detailRow, detailCell) },
    });

    return [
      el('tr', {}, [
        tdNode([
          el('strong', { text: r.reference }),
          el('br'),
          el('span', { class: 'u-a76e0798', text: `account ${r.account_ref}` }),
        ]),
        td(PRIVACY_TYPE_LABELS[r.type] || r.type),
        tdNode(pill(PRIVACY_STATUS_LABELS[r.status] || r.status)),
        td(`${r.age_days}d`),
        tdNode(
          (r.blocking || []).length
            ? spaced(r.blocking.map((c) => pill(BLOCKER_LABELS[c] || c)))
            : el('span', { class: 'u-a2aae0fb', text: '—' })
        ),
        tdNode(openBtn, 'u-a9efa544'),
      ]),
      detailRow,
    ];
  }

  async function openPrivacyRequest(requestId, row, cell) {
    if (!row.classList.contains('is-hidden')) {
      row.classList.add('is-hidden');
      clear(cell);
      return;
    }
    row.classList.remove('is-hidden');
    setText(cell, 'Loading…');

    let data;
    try {
      data = await api(`/admin/privacy-requests/${encodeURIComponent(requestId)}`);
    } catch (err) {
      mount(cell, el('span', { class: 'form-error show', text: err.message }));
      return;
    }

    const req = data.request;
    const error = el('p', { class: 'form-error' });
    const preview = el('p', { class: 'hint js-flush' });

    // Same two-field split as entry integrity, for the same reason: the notes
    // are the internal record and may name another account or an open dispute;
    // the code chooses a fixed sentence the requester reads.
    const notesInput = el('textarea', {
      class: 'js-spaced-input',
      maxLength: 4000,
      placeholder: t('admin.administratorNotesInternalWhat'),
    });

    // Offered by the server, not assumed here. A deletion request has a shorter
    // list while erasure is not implemented, and showing a "Completed" option
    // that the next call refuses with a 409 teaches an administrator to ignore
    // refusals.
    const statusSelect = el('select', { class: 'js-spaced-input' });
    (data.allowed_statuses || ['in_review', 'awaiting_information', 'completed', 'declined', 'unable_to_complete'])
      .forEach((s) => {
        statusSelect.appendChild(el('option', { value: s, text: PRIVACY_STATUS_LABELS[s] || s }));
      });

    // Evidence of what was actually carried out. Shown only for a status that
    // claims something happened, because that is the only status it belongs to.
    const erasedInput = el('input', {
      class: 'js-spaced-input',
      maxLength: 500,
      placeholder: t('admin.categoriesErasedCommaSeparated'),
    });
    const anonymisedInput = el('input', {
      class: 'js-spaced-input',
      maxLength: 500,
      placeholder: t('admin.categoriesAnonymisedCommaSeparated'),
    });
    const retainedInput = el('textarea', {
      class: 'js-spaced-input',
      maxLength: 2000,
      rows: 3,
      placeholder: t('admin.categoriesRetainedOnePer'),
    });
    const summaryInput = el('input', {
      class: 'js-spaced-input',
      maxLength: 1000,
      placeholder: t('admin.whatWasProvidedSent'),
    });
    const evidenceBlock = el('div', { class: 'is-hidden' }, [
      el('p', {
        class: 'hint',
        text: t('admin.aRequestIsOnly'),
      }),
      el('label', { class: 'u-1964b55e', text: t('admin.whatWasProvidedOr') }),
      summaryInput,
      el('label', { class: 'u-1964b55e', text: t('admin.categoriesErased') }),
      erasedInput,
      el('label', { class: 'u-1964b55e', text: t('admin.categoriesAnonymised') }),
      anonymisedInput,
      el('label', { class: 'u-1964b55e', text: t('admin.categoriesRetainedAndWhy') }),
      retainedInput,
    ]);

    function toggleEvidence() {
      evidenceBlock.classList.toggle('is-hidden', statusSelect.value !== 'completed');
    }

    // Parses "category — reason" or "category: reason" per line. A line with no
    // reason is left without one deliberately, so the server refuses it rather
    // than this screen inventing one.
    function parseRetained() {
      return retainedInput.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s*(?:—|--|:)\s*/);
          return { category: parts[0], reason: parts.slice(1).join(' — ') };
        });
    }

    const splitList = (value) =>
      value.split(',').map((v) => v.trim()).filter(Boolean);

    const codeSelect = el('select', { class: 'js-spaced-input' });
    function fillCodes() {
      const codes = data.outcome_codes[statusSelect.value] || [];
      clear(codeSelect);
      if (!codes.length) {
        codeSelect.appendChild(el('option', { value: '', text: t('admin.noOutcomeForThis') }));
        setText(preview, 'The requester will not be given an outcome sentence for this status.');
        return;
      }
      codes.forEach((code) => {
        codeSelect.appendChild(el('option', { value: code, text: code.replace(/_/g, ' ') }));
      });
      setText(preview, 'The requester will read: ' + (data.outcome_copy[codeSelect.value] || ''));
    }
    statusSelect.addEventListener('change', () => {
      fillCodes();
      toggleEvidence();
    });
    codeSelect.addEventListener('change', () => {
      setText(preview, 'The requester will read: ' + (data.outcome_copy[codeSelect.value] || ''));
    });
    fillCodes();
    toggleEvidence();

    const submit = el('button', {
      class: 'btn primary u-51820e15',
      text: t('admin.recordDecision'),
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          error.classList.remove('show');
          if (!notesInput.value.trim()) {
            error.textContent = t('admin.administratorNotesAreRequired4');
            error.classList.add('show');
            return;
          }
          btn.disabled = true;
          try {
            await api(`/admin/privacy-requests/${encodeURIComponent(requestId)}/decision`, {
              method: 'POST',
              body: JSON.stringify({
                status: statusSelect.value,
                outcome_code: codeSelect.value || null,
                admin_notes: notesInput.value,
                // Read from the detail fetch. A screen left open while somebody
                // else decided is refused with a 409 rather than overwriting it.
                version: req.version,
                execution_evidence: statusSelect.value === 'completed'
                  ? {
                      categories_erased: splitList(erasedInput.value),
                      categories_anonymised: splitList(anonymisedInput.value),
                      categories_retained: parseRetained(),
                      summary: summaryInput.value,
                      // No actor is sent. The server attributes the execution to
                      // the authenticated session, so this screen cannot put
                      // somebody else's name against a decision.
                    }
                  : null,
              }),
            });
            row.classList.add('is-hidden');
            clear(cell);
            loadPrivacyRequests();
    loadEmailNotifications();
          } catch (err) {
            error.textContent = err.message;
            error.classList.add('show');
            btn.disabled = false;
          }
        },
      },
    });

    const blockers = (data.blockers || []).map((b) =>
      el('li', { text: `${BLOCKER_LABELS[b.category] || b.category}${b.count ? ` (${b.count})` : ''} — ${b.note}` })
    );

    const history = (data.history || []).map((h) =>
      el('p', { class: 'u-a76e0798' }, [
        `${new Date(h.created_at).toLocaleString()} · ${h.from_status || '—'} → ${h.to_status}`,
        h.actor_name ? ` · ${h.actor_name}` : ` · ${h.actor_role}`,
        h.admin_notes ? el('br') : null,
        h.admin_notes ? h.admin_notes : null,
      ])
    );

    mount(cell, el('div', { class: 'u-1b074808' }, [
      el('p', {}, [
        el('strong', { text: req.reference }),
        ` · ${PRIVACY_TYPE_LABELS[req.type] || req.type} · ${PRIVACY_STATUS_LABELS[req.status] || req.status} · opened ${new Date(req.created_at).toLocaleString()}`,
      ]),
      el('p', { class: 'u-a76e0798', text: `${data.account.name} · ${data.account.email} · account created ${new Date(data.account.created_at).toLocaleDateString()}` }),
      req.user_message
        ? el('p', { class: 'js-mint-box', text: `They wrote: ${req.user_message}` })
        : el('p', { class: 'u-a2aae0fb', text: t('admin.theyDidNotAdd') }),

      blockers.length
        ? el('div', {}, [
            el('p', { class: 'u-5bf9ad33', text: t('admin.whatCurrentlyStandsIn') }),
            el('ul', { class: 'u-a2aae0fb' }, blockers),
          ])
        : null,

      req.requester_sees
        ? el('p', { class: 'hint', text: `Currently shown to them: ${req.requester_sees}` })
        : null,

      el('label', { class: 'u-1964b55e', text: t('admin.administratorNotesInternalNever2') }),
      notesInput,
      el('label', { class: 'u-1964b55e', text: t('admin.status') }),
      statusSelect,
      el('label', { class: 'u-1964b55e', text: t('admin.outcomeTheRequesterWill') }),
      codeSelect,
      preview,
      evidenceBlock,
      // Said on the screen where the mistake would be made.
      el('p', {
        class: 'hint',
        text: t('admin.recordingADecisionHere'),
      }),
      req.type === 'deletion' && !data.deletion_execution_implemented
        ? el('p', {
            class: 'js-mint-box',
            text: t('admin.thisIsADeletion'),
          })
        : null,
      (data.executions || []).length
        ? el('div', { class: 'u-680b5a65' }, [
            el('p', { class: 'u-5bf9ad33', text: t('admin.whatWasCarriedOut') }),
            data.executions.map((ex) =>
              el('p', { class: 'u-a76e0798' }, [
                `${new Date(ex.executed_at).toLocaleString()} · ${ex.action_kind} · by ${ex.executed_by || ex.executed_by_job}`,
                el('br'),
                `erased: ${(ex.categories_erased || []).join(', ') || 'none'}`,
                el('br'),
                `anonymised: ${(ex.categories_anonymised || []).join(', ') || 'none'}`,
                el('br'),
                `retained: ${(ex.categories_retained || []).map((r) => `${r.category} (${r.reason})`).join('; ') || 'none'}`,
                ex.summary ? el('br') : null,
                ex.summary ? ex.summary : null,
              ])
            ),
          ])
        : null,
      el('div', { class: 'js-button-row' }, submit),
      error,
      history.length
        ? el('div', { class: 'u-680b5a65' }, [el('p', { class: 'u-5bf9ad33', text: t('admin.history') }), history])
        : null,
    ]));
  }

  async function loadPrivacyRequests() {
    const content = document.getElementById('privacy-content');
    try {
      const rows = await api('/admin/privacy-requests');
      if (!rows.length) {
        mount(content, emptyNode(t('admin.noPrivacyRequests')));
        return;
      }
      mount(content, dataTable(
        ['Reference', 'Type', 'Status', 'Age', 'Blockers', 'Actions'],
        rows.flatMap(privacyRow),
        'No privacy requests.'
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  // ------------------------------------------------------------------
  // Email-change delivery outbox
  // ------------------------------------------------------------------

  const NOTIFICATION_KIND_LABELS = {
    verification: 'Verification (to new address)',
    old_address_warning: 'Warning (to old address)',
  };

  const NOTIFICATION_STATUS_LABELS = {
    pending: 'Queued',
    sent: 'Delivered',
    failed: 'Gave up',
    cancelled: 'Cancelled',
  };

  function notificationRow(n) {
    const detailCell = el('td', { colSpan: 6 });
    const detailRow = el('tr', { class: 'u-c8be1ccb is-hidden' }, detailCell);

    const openBtn = el('button', {
      class: 'btn ghost u-51820e15',
      text: t('admin.history'),
      on: { click: () => openNotification(n, detailRow, detailCell) },
    });

    // Only a failed notification is retryable, and only deliberately. A queued
    // one is already being retried; a delivered one must not be resent.
    const retryBtn = n.status === 'failed'
      ? el('button', {
          class: 'btn ghost u-51820e15',
          text: t('admin.retry'),
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              const reason = prompt('Why is this being retried? Recorded against the notification.');
              if (reason === null) return;
              if (!reason.trim()) { alert('A short reason is required.'); return; }
              btn.disabled = true;
              try {
                await api(`/admin/email-change-notifications/${encodeURIComponent(n.id)}/retry`, {
                  method: 'POST',
                  body: JSON.stringify({ reason }),
                });
                loadEmailNotifications();
              } catch (err) {
                alert(err.message);
                btn.disabled = false;
              }
            },
          },
        })
      : null;

    return [
      el('tr', {}, [
        td(NOTIFICATION_KIND_LABELS[n.kind] || n.kind),
        tdNode([
          pill(NOTIFICATION_STATUS_LABELS[n.status] || n.status),
          n.in_flight ? ' ' : null,
          n.in_flight ? pill('in flight') : null,
        ]),
        td(String(n.attempts)),
        tdNode(
          n.last_error_category
            ? pill(n.last_error_category)
            : el('span', { class: 'u-a2aae0fb', text: '—' })
        ),
        td(shortDate(n.created_at)),
        tdNode(spaced([openBtn, retryBtn]), 'u-a9efa544'),
      ]),
      detailRow,
    ];
  }

  async function openNotification(n, row, cell) {
    if (!row.classList.contains('is-hidden')) {
      row.classList.add('is-hidden');
      clear(cell);
      return;
    }
    row.classList.remove('is-hidden');
    setText(cell, 'Loading…');

    let events;
    try {
      events = await api(`/admin/email-change-notifications/${encodeURIComponent(n.id)}/events`);
    } catch (err) {
      mount(cell, el('span', { class: 'form-error show', text: err.message }));
      return;
    }

    mount(cell, el('div', { class: 'u-1b074808' }, [
      el('p', { class: 'u-a76e0798' }, [
        `Change is ${n.change_status || 'gone'}`,
        n.change_expires_at ? ` · link window ends ${new Date(n.change_expires_at).toLocaleString()}` : '',
        n.next_attempt_at && n.status === 'pending'
          ? ` · next attempt ${new Date(n.next_attempt_at).toLocaleString()}`
          : '',
        n.cancelled_reason ? ` · cancelled: ${n.cancelled_reason}` : '',
      ]),
      el('p', {
        class: 'hint',
        text: t('admin.thisRecordHoldsNo'),
      }),
      events.map((ev) =>
        el('p', { class: 'u-a76e0798' }, [
          `${new Date(ev.created_at).toLocaleString()} · ${ev.event.replace(/_/g, ' ')}`,
          ev.attempt ? ` · attempt ${ev.attempt}` : '',
          ev.error_category ? ` · ${ev.error_category}` : '',
          ev.actor_name ? ` · ${ev.actor_name}` : ` · ${ev.actor_role}`,
          ev.note ? el('br') : null,
          ev.note ? ev.note : null,
        ])
      ),
    ]));
  }

  async function loadEmailNotifications() {
    const content = document.getElementById('email-notifications-content');
    try {
      const rows = await api('/admin/email-change-notifications');
      if (!rows.length) {
        mount(content, emptyNode(t('admin.noEmailChangeNotifications')));
        return;
      }
      mount(content, dataTable(
        ['Message', 'Status', 'Attempts', 'Last error', 'Created', 'Actions'],
        rows.flatMap(notificationRow),
        'No email-change notifications.'
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  async function loadIntegrity() {
    const content = document.getElementById('integrity-content');
    try {
      const rows = await api('/admin/integrity/queue');
      if (!rows.length) {
        mount(content, emptyNode(t('admin.nothingToReviewLong')));
        return;
      }
      mount(content, dataTable(
        [t('admin.colGiveawayEntry'), t('admin.colStatus'), t('admin.colSignals'), t('admin.colEntered'), t('admin.colCase'), t('admin.colActions')],
        rows.flatMap(integrityRow),
        t('admin.nothingToReview')
      ));
    } catch (err) {
      mount(content, emptyNode(err.message));
    }
  }

  ready.then(() => {
    loadStats();
    loadIntegrity();
    loadClaims();
    loadRescueQueue();
    loadPrivacyRequests();
    loadEmailNotifications();
    loadMissingClaims();
    load();
    loadAdInquiries();
    loadAds();
    loadGiveaways();
    loadUsers();
  });
