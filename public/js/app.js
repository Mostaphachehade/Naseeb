const API = '/api';

function getToken() { return localStorage.getItem('naseeb_token'); }
function getUser() {
  const raw = localStorage.getItem('naseeb_user');
  return raw ? JSON.parse(raw) : null;
}
function setSession(token, user) {
  localStorage.setItem('naseeb_token', token);
  localStorage.setItem('naseeb_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('naseeb_token');
  localStorage.removeItem('naseeb_user');
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function renderHeader() {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const user = getUser();

  if (user) {
    nav.innerHTML = `
      <a href="/index.html">Browse</a>
      <a href="/dashboard.html">My giveaways</a>
      <a href="/pricing.html">Pricing</a>
      <a href="/create.html" class="btn-gold" style="border-radius:100px;">Host a giveaway</a>
      <span style="opacity:0.7;">Hi, ${escapeHtml(user.name)}</span>
      <button id="logout-btn">Sign out</button>
    `;
    document.getElementById('logout-btn').addEventListener('click', () => {
      clearSession();
      window.location.href = '/index.html';
    });
  } else {
    nav.innerHTML = `
      <a href="/index.html">Browse</a>
      <a href="/pricing.html">Pricing</a>
      <a href="/login.html">Sign in</a>
      <a href="/signup.html" class="btn-gold" style="border-radius:100px;">Join free</a>
    `;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeLeft(deadlineIso) {
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (ms <= 0) return 'Entries closed';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h left`;
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m left`;
}

function giveawayCard(g) {
  const img = g.image_url || '';
  const statusLabel = g.status === 'drawn' ? 'Winner drawn' : timeLeft(g.entry_deadline);
  const statusClass = g.status === 'drawn' ? 'drawn' : '';
  return `
    <a class="stub" href="/giveaway.html?id=${g.id}">
      <div class="img" style="${img ? `background-image:url('${img}')` : ''}">
        <span class="status-pill ${statusClass}">${statusLabel}</span>
      </div>
      <div class="body">
        <h3>${escapeHtml(g.title)}</h3>
        <p class="prize">${escapeHtml(g.prize_description)}</p>
        <div class="meta">
          <span class="num">${g.entry_count} entered</span>
          <span>by ${escapeHtml(g.host_name)}</span>
        </div>
      </div>
    </a>
  `;
}

document.addEventListener('DOMContentLoaded', renderHeader);
