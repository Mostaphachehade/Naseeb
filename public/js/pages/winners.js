  document.getElementById('winners-grid').innerHTML = skeletonCards(6);
  const PAGE_SIZE = 12;
  let currentPage = 1;

  function winnerCard(g) {
    const img = g.image_url || '';
    const value = g.estimated_value_aed ? `AED ${Number(g.estimated_value_aed).toLocaleString()}` : null;
    return `
      <a class="stub" href="/giveaway.html?id=${g.id}">
        <div class="img" data-bg="${escapeAttr(img)}">
          <span class="status-pill drawn">${t('detail.winnerDrawn')}</span>
        </div>
        <div class="body">
          <h3>${escapeHtml(g.title)}</h3>
          <p class="prize">${escapeHtml(g.prize_description)}${value ? ` · ${value}` : ''}</p>
          <div class="meta">
            <span class="num">${t('winners.wonBy', { name: escapeHtml(g.winner_name) })}</span>
            <span>${t('winners.by', { name: escapeHtml(g.host_name) })}${g.host_verified ? verifiedBadge() : ''}</span>
          </div>
          ${deliveryPill(g)}
        </div>
      </a>
    `;
  }

  async function load(page = 1) {
    const grid = document.getElementById('winners-grid');
    const loadMoreBtn = document.getElementById('load-more-btn');
    try {
      const { items, total } = await api(`/giveaways/winners/all?page=${page}&pageSize=${PAGE_SIZE}`);
      if (page === 1 && items.length === 0) {
        grid.innerHTML = `<div class="empty u-97294b20">${t('winners.emptyBody')}</div>`;
        loadMoreBtn.classList.add('is-hidden');
        return;
      }
      if (page === 1) grid.innerHTML = '';
      grid.insertAdjacentHTML('beforeend', items.map(winnerCard).join(''));
      applyCardImages(grid);
      currentPage = page;
      loadMoreBtn.classList.toggle('is-hidden', page * PAGE_SIZE >= total);
    } catch (err) {
      grid.innerHTML = `<p class="form-error show">${escapeHtml(err.message)}</p>`;
      loadMoreBtn.classList.add('is-hidden');
    }
  }

  document.getElementById('load-more-btn').addEventListener('click', () => load(currentPage + 1));

  load();
