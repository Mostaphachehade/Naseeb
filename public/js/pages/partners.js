  async function loadStats() {
    try {
      const stats = await api('/giveaways/stats/summary');
      document.getElementById('stat-giveaways').textContent = stats.giveaways_hosted.toLocaleString();
      document.getElementById('stat-entries').textContent = stats.entries_submitted.toLocaleString();
      document.getElementById('stat-value').textContent = stats.value_listed_aed.toLocaleString();
    } catch (err) {
      // Non-critical — leave the placeholders.
    }
  }
  loadStats();
