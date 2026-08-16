  // Cosmetic only. Every route this page calls re-reads users.is_admin from
  // Postgres on the request, so reaching this page without being an
  // administrator produces a screen full of 403s rather than an admin panel.
  const ready = requireSession('/admin.html');


  async function loadStats() {
    const content = document.getElementById('stats-content');
    try {
      const s = await api('/admin/stats');
      const cards = [
        { num: s.pending_host_applications, label: 'Pending applications', attention: s.pending_host_applications > 0 },
        { num: s.pending_ad_inquiries, label: 'Pending ad inquiries', attention: s.pending_ad_inquiries > 0 },
        { num: s.live_giveaways, label: 'Live giveaways' },
        { num: s.total_hosts, label: 'Total hosts' },
        { num: s.verified_hosts, label: 'Verified hosts' },
        { num: s.approved_hosts, label: 'Approved hosts' },
        { num: s.suspended_hosts, label: 'Suspended hosts', attention: s.suspended_hosts > 0 },
        // The advertiser's business name, inside a label. Text, like every
        // other value on this page.
        {
          num: s.active_ad ? s.active_ad.click_count : '—',
          label: s.active_ad ? `Clicks — ${s.active_ad.business_name}` : 'No active ad',
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
      text: 'Review',
      on: { click: () => openApplication(a.id, detailRow, detailCell) },
    });

    // Closes, never deletes. The row, its submission time, the account it
    // belongs to and its status events all stay exactly where they are — "it was
    // only spam" is a judgement that becomes unreviewable the moment the
    // evidence for it is gone.
    const closeBtn = a.status === 'pending'
      ? el('button', {
          class: 'btn ghost app-close-btn u-51820e15',
          text: 'Close without deciding',
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
        a.user_id ? null : el('span', { class: 'u-73c3c8ab', text: 'Legacy enquiry — no account attached' }),
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
          placeholder: 'Why this decision?',
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
          el('label', { class: 'u-1964b55e', text: 'Reason (recorded against this decision, and shown to the applicant)' }),
          reasonInput,
          el('div', { class: 'u-d8a81eac' }, [
            decide('approved', 'Approve to host', 'btn primary decide-btn u-14da4875'),
            decide('rejected', 'Do not approve', 'btn ghost decide-btn u-a716ef8e'),
          ]),
          el('p', {
            class: 'hint u-b1ecc496',
            text: 'Approving is the only thing that grants host access. Nothing else on this page does.',
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
        mount(content, emptyNode('No applications yet.'));
        return;
      }
      mount(content, dataTable(
        ['Type', 'Who', 'Status', 'Submitted', 'Decided', 'Actions'],
        applications.flatMap(appRow),
        'No applications yet.'
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
      text: 'Delete',
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          if (!confirm('Delete this inquiry? This cannot be undone.')) return;
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
        mount(content, emptyNode('No ad inquiries yet.'));
        return;
      }
      mount(content, dataTable(
        ['Business', 'Contact', 'Message', 'Submitted', 'Actions'],
        inquiries.map(adInquiryRow),
        'No ad inquiries yet.'
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
      text: 'Delete',
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          if (!confirm('Delete this ad? This cannot be undone.')) return;
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
        mount(content, emptyNode('No ads yet. Add one above.'));
        return;
      }
      mount(content, dataTable(
        ['Banner', 'Business', 'Destination', 'Clicks', 'Status', 'Actions'],
        ads.map(adRow),
        'No ads yet. Add one above.'
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
        mount(content, emptyNode('No giveaways yet.'));
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

    const deleteBtn = u.is_admin
      ? el('span', { class: 'u-c2238623', text: '—' })
      : el('button', {
          class: 'btn ghost user-delete-btn u-54750247',
          text: 'Delete',
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              if (!confirm('Delete this host account? This cannot be undone.')) return;
              btn.disabled = true;
              try {
                await api(`/admin/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' });
                loadUsers();
                loadStats();
              } catch (err) {
                alert(err.message);
                btn.disabled = false;
              }
            },
          },
        });

    return el('tr', {}, [
      tdNode([u.name, u.is_admin ? ' ' : null, u.is_admin ? pill('admin', 'company') : null]),
      td(u.email),
      td(u.giveaways_hosted, 'mono'),
      td(shortDate(u.created_at)),
      tdNode(verifiedToggle),
      tdNode(hostStatusCell(u)),
      tdNode(spaced([hostActions(u), deleteBtn]), 'u-a9efa544'),
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
      u.is_admin ? el('span', { class: 'u-5e8e7900', text: 'admin — this gate does not apply' }) : null,
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
      class: 'btn ghost host-status-btn u-51820e15',
      text: label,
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
        mount(content, emptyNode('No accounts yet.'));
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
      document.getElementById('ad-image-url-hint').textContent = 'Upload a file above, or paste a media URL.';
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
    statusEl.textContent = 'Uploading…';
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
        statusEl.textContent = 'Upload returned a media address we do not accept.';
        return;
      }
      document.getElementById('ad_image_url').value = data.secure_url;
      target.classList.remove('is-hidden');
      other.classList.add('is-hidden');
      statusEl.textContent = 'Uploaded.';
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
    claimed: { to: 'preparing_delivery', label: 'Mark preparing delivery' },
    preparing_delivery: { to: 'shipped_or_arranged', label: 'Mark shipped / arranged' },
    shipped_or_arranged: { to: 'delivered_pending_confirmation', label: 'Report delivered — winner confirms' },
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
          text: 'Open delivery details',
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
      : el('span', { class: 'u-73c3c8ab', text: 'no details available' });

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
          text: 'Nothing for you to do here — this one is waiting on the winner.',
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
        mount(content, emptyNode('No suspended host has an unfinished claim.'));
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
        empty.textContent = 'Nothing waiting. Disputes and expired claims appear here.';
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
        open.textContent = 'Open case';
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
      label.textContent = 'Delivery details (opened deliberately, for this case)';
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
        error.textContent = 'A reason is required — it is recorded against the claim.';
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
      reissue.textContent = 'Reissue claim link to the same winner';
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
      close.textContent = 'Close claim';
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
        empty.textContent = 'None — every drawn giveaway has a claim.';
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
        button.textContent = 'Issue claim to that winner';
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

  ready.then(() => {
    loadStats();
    loadClaims();
    loadRescueQueue();
    loadMissingClaims();
    load();
    loadAdInquiries();
    loadAds();
    loadGiveaways();
    loadUsers();
  });
