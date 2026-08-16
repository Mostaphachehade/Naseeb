  mount(document.getElementById('winners-grid'), skeletonCards(6));
  const PAGE_SIZE = 12;
  let currentPage = 1;

  // Same construction as giveawayCard: the winner's display name, the host's
  // display name, the title, the prize text and the image URL are all
  // database-controlled, and none of them becomes markup.
  function winnerCard(g) {
    const value = g.estimated_value_aed
      ? `AED ${Number(g.estimated_value_aed).toLocaleString()}`
      : null;
    const image = el('div', { class: 'img' }, [
      el('span', { class: 'status-pill drawn', text: t('detail.winnerDrawn') }),
    ]);
    NaseebDom.setBackgroundImage(image, g.image_url);

    return el('a', { class: 'stub', href: '/giveaway.html?id=' + encodeURIComponent(g.id) }, [
      image,
      el('div', { class: 'body' }, [
        el('h3', { text: g.title }),
        el('p', {
          class: 'prize',
          text: value ? `${g.prize_description} · ${value}` : g.prize_description,
        }),
        el('div', { class: 'meta' }, [
          el('span', { class: 'num', text: t('winners.wonBy', { name: g.winner_name }) }),
          el('span', {}, [
            t('winners.by', { name: g.host_name }),
            g.host_verified ? verifiedBadge() : null,
          ]),
        ]),
        deliveryPill(g),
      ]),
    ]);
  }

  function emptyState() {
    return el('div', { class: 'empty u-97294b20' }, [
      t('winners.emptyBefore'),
      el('a', { href: '/index.html', text: t('winners.emptyLink') }),
      t('winners.emptyAfter'),
    ]);
  }

  async function load(page = 1) {
    const grid = document.getElementById('winners-grid');
    const loadMoreBtn = document.getElementById('load-more-btn');
    try {
      const { items, total } = await api(`/giveaways/winners/all?page=${page}&pageSize=${PAGE_SIZE}`);
      if (page === 1 && items.length === 0) {
        mount(grid, emptyState());
        loadMoreBtn.classList.add('is-hidden');
        return;
      }
      if (page === 1) clear(grid);
      append(grid, items.map(winnerCard));
      currentPage = page;
      loadMoreBtn.classList.toggle('is-hidden', page * PAGE_SIZE >= total);
    } catch (err) {
      mount(grid, errorNode(err.message));
      loadMoreBtn.classList.add('is-hidden');
    }
  }

  document.getElementById('load-more-btn').addEventListener('click', () => load(currentPage + 1));

  load();
