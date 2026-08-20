  mount(document.getElementById('grid'), skeletonCards(6));
  const PAGE_SIZE = 12;
  let currentPage = 1;

  // Fills the empty ticket-stub outline in the hero with a real, animated
  // spotlight on the top live giveaway (hook, prize, countdown, CTA) —
  // falls back to the plain dashed outline (default CSS) if there's no
  // active giveaway to show yet.
  async function loadHeroPromo() {
    try {
      const { items } = await api('/giveaways?page=1&pageSize=1');
      const g = items[0];
      if (!g || g.status !== 'active') return;

      NaseebDom.setHref(
        document.getElementById('promo-cta-inner'),
        '/giveaway.html?id=' + encodeURIComponent(g.id)
      );
      if (g.image_url) {
        // Validated and set through the helper, which refuses anything that is
        // not https on an allowed media origin.
        NaseebDom.setBackgroundImage(document.getElementById('promo-ticket-img'), g.image_url);
      }
      document.getElementById('promo-ticket-label').textContent = `${g.entry_count} entered · open now`;
      document.getElementById('promo-ticket-title').textContent = g.title;
      if (g.estimated_value_aed) {
        document.getElementById('promo-ticket-value').textContent = `AED ${Number(g.estimated_value_aed).toLocaleString()} value`;
      } else {
        document.getElementById('promo-ticket-value').classList.add('is-hidden');
      }

      const deadline = new Date(g.entry_deadline).getTime();
      const days = Math.max(1, Math.ceil((deadline - Date.now()) / 86400000));
      document.getElementById('promo-countdown-num').textContent = days;

      document.getElementById('hero').classList.add('has-featured');
      runPromoLoop();
    } catch (err) {
      // Non-critical — the hero's decorative dashed outline stays as-is.
    }
  }

  function runPromoLoop() {
    const scenes = Array.from(document.querySelectorAll('.promo-scene'));
    const confetti = document.getElementById('promo-confetti');
    const colors = ['#C9A15A', '#E4C078', '#DCEEE7'];
    const SEQUENCE = [
      { n: 1, hold: 3600 },
      { n: 2, hold: 4000 },
      { n: 3, hold: 4000 },
      { n: 4, hold: 4400 },
    ];

    function spawnConfetti() {
      clear(confetti);
      for (let i = 0; i < 8; i++) {
        const s = document.createElement('span');
        s.className = 'promo-speck';
        // CSSOM property writes, which the policy permits — see docs/CSP.md §7.
        s.style.left = (6 + Math.random() * 88) + '%';
        s.style.background = colors[i % colors.length];
        s.style.animationDelay = (Math.random() * 1.6) + 's';
        confetti.appendChild(s);
      }
      confetti.classList.add('is-on');
    }

    function showScene(n) {
      scenes.forEach((s) => {
        const active = Number(s.dataset.pscene) === n;
        s.classList.toggle('is-exiting', s.classList.contains('is-active') && !active);
        s.classList.toggle('is-active', active);
      });
    }

    (async () => {
      // Pauses when scrolled out of view so it isn't burning CPU/battery
      // off-screen — resumes the loop next time it's visible.
      const frame = document.getElementById('promo-frame');
      let visible = true;
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
      }, { threshold: 0.15 }).observe(frame);

      while (true) {
        for (const step of SEQUENCE) {
          if (visible) {
            showScene(step.n);
            if (step.n === 4) spawnConfetti();
            if (step.n === 1) confetti.classList.remove('is-on');
          }
          await new Promise((r) => setTimeout(r, step.hold));
        }
      }
    })();
  }

  async function load(page = 1) {
    const grid = document.getElementById('grid');
    const loadMoreBtn = document.getElementById('load-more-btn');
    try {
      const { items, total } = await api(`/giveaways?page=${page}&pageSize=${PAGE_SIZE}`);
      if (page === 1 && items.length === 0) {
        mount(grid, el('div', { class: 'empty launch u-97294b20' }, [
          el('span', { class: 'mono eyebrow', text: t('empty.launchEyebrow') }),
          el('h3', { text: t('empty.launchTitle') }),
          el('p', { text: t('empty.launchBody') }),
          el('a', { class: 'btn primary', href: '/host-apply.html', text: t('empty.launchCta') }),
        ]));
        loadMoreBtn.classList.add('is-hidden');
        return;
      }
      if (page === 1) clear(grid);
      append(grid, items.map(giveawayCard));
      currentPage = page;
      loadMoreBtn.classList.toggle('is-hidden', page * PAGE_SIZE >= total);
    } catch (err) {
      mount(grid, errorNode(err.message));
      loadMoreBtn.classList.add('is-hidden');
    }
  }

  document.getElementById('load-more-btn').addEventListener('click', () => load(currentPage + 1));

  async function loadStats() {
    try {
      const stats = await api('/giveaways/stats/summary');
      // A trust bar reading "0 / 0 / 0" undermines the exact trust it's meant
      // to build, so it only appears once there's a real number to show.
      if (!stats.giveaways_hosted) {
        document.querySelector('.stats-bar').classList.add('is-hidden');
        return;
      }
      document.getElementById('stat-giveaways').textContent = stats.giveaways_hosted.toLocaleString();
      document.getElementById('stat-entries').textContent = stats.entries_submitted.toLocaleString();
      document.getElementById('stat-value').textContent = stats.value_listed_aed.toLocaleString();
    } catch (err) {
      // Non-critical — leave the placeholders rather than showing an error for a stats bar.
    }
  }

  async function loadAdBanner() {
    try {
      const ad = await api('/ads/active');
      if (!ad) return;

      // An advertiser's media URL used to be escaped and interpolated into a
      // src attribute. Escaping is the wrong tool here — it does nothing to a
      // scheme — so the URL goes through the media validator, and an ad whose
      // media is not on an allowed origin simply does not render.
      const media = ad.media_type === 'video'
        ? el('video', { autoplay: true, muted: true, loop: true, playsInline: true })
        : el('img', { alt: ad.business_name });
      if (!NaseebDom.setMediaSrc(media, ad.image_url)) return;

      mount(document.getElementById('ad-banner-slot'), el('div', { class: 'ad-banner-wrap' }, [
        el('span', { class: 'ad-banner-label', text: 'Advertisement' }),
        el('a', {
          class: 'ad-banner',
          href: '/api/ads/' + encodeURIComponent(ad.id) + '/click',
          target: '_blank',
          rel: 'noopener sponsored',
        }, [media]),
      ]));
    } catch (err) {
      // Non-critical — just don't show a banner if this fails.
    }
  }

  load();
  loadStats();
  loadAdBanner();
  loadHeroPromo();
