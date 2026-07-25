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
      <a href="/about.html">About</a>
      <a href="/dashboard.html">My giveaways</a>
      <a href="/pricing.html">Pricing</a>
      ${user.is_admin ? '<a href="/admin.html">Admin</a>' : ''}
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
      <a href="/about.html">About</a>
      <a href="/pricing.html">Pricing</a>
      <a href="/login.html">Sign in</a>
      <a href="/signup.html" class="btn-gold" style="border-radius:100px;">Join free</a>
    `;
  }
}

function renderFooter() {
  const el = document.getElementById('site-footer');
  if (!el) return;
  const year = new Date().getFullYear();
  el.innerHTML = `
    <footer class="site">
      <div class="wrap footer-grid">
        <div class="footer-brand">
          <a href="/index.html" class="brand" style="font-size:1.2rem;">Naseeb<span class="dot">.</span></a>
          <p>Free-entry giveaways, always. No purchase is ever required or accepted to enter or to improve your odds.</p>
        </div>
        <div class="footer-links">
          <span class="footer-heading">Explore</span>
          <a href="/index.html">Browse giveaways</a>
          <a href="/create.html">Host a giveaway</a>
          <a href="/pricing.html">Pricing</a>
          <a href="/about.html">About Naseeb</a>
          <a href="/advertise.html">Advertise with us</a>
        </div>
        <div class="footer-links">
          <span class="footer-heading">Legal</span>
          <a href="/terms.html">Terms of Service</a>
          <a href="/privacy.html">Privacy Policy</a>
        </div>
      </div>
      <div class="wrap footer-bottom">© ${year} Naseeb. Every ticket is free.</div>
    </footer>
  `;
}

// Only allow same-site relative paths (e.g. "/create.html") so a crafted
// ?redirect= query param can't send someone off-site after login/signup.
function safeRedirect(path) {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// escapeHtml alone doesn't encode quotes, so it's not safe for values placed
// inside an HTML attribute (e.g. style="...${value}..."). This also encodes
// ' and " so a value can't break out of the surrounding quotes.
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function verifiedBadge() {
  return `<svg class="verified-badge" viewBox="0 0 20 20" width="14" height="14" role="img"><title>Verified business</title><circle cx="10" cy="10" r="9" fill="#C9A15A"/><path d="M6 10.3l2.6 2.6L14 7.3" stroke="#072925" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function giveawayCard(g) {
  const img = g.image_url || '';
  const statusLabel = g.status === 'drawn' ? 'Winner drawn' : timeLeft(g.entry_deadline);
  const statusClass = g.status === 'drawn' ? 'drawn' : '';
  return `
    <a class="stub" href="/giveaway.html?id=${g.id}">
      <div class="img" style="${img ? `background-image:url('${escapeAttr(img)}')` : ''}">
        <span class="status-pill ${statusClass}">${statusLabel}</span>
      </div>
      <div class="body">
        <h3>${escapeHtml(g.title)}</h3>
        <p class="prize">${escapeHtml(g.prize_description)}</p>
        <div class="meta">
          <span class="num">${g.entry_count} entered</span>
          <span>by ${escapeHtml(g.host_name)}${g.host_verified ? verifiedBadge() : ''}</span>
        </div>
      </div>
    </a>
  `;
}

function renderVerificationBanner() {
  const user = getUser();
  if (!user || user.email_verified) return;
  const header = document.querySelector('header.site');
  if (!header || document.querySelector('.verify-banner')) return;

  const banner = document.createElement('div');
  banner.className = 'verify-banner';
  banner.innerHTML = `
    <div class="wrap">
      <span>Verify your email to host or enter giveaways — check your inbox.</span>
      <button id="resend-verify-btn">Resend email</button>
    </div>
  `;
  header.insertAdjacentElement('afterend', banner);

  document.getElementById('resend-verify-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      btn.textContent = 'Sent — check your inbox';
    } catch (err) {
      btn.textContent = 'Resend email';
      btn.disabled = false;
      alert(err.message);
    }
  });
}

// A brief confetti burst for celebratory moments (e.g. a winner being drawn).
function celebrate() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const colors = ['#C9A15A', '#E4C078', '#DCEEE7', '#0B3B36'];
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:9999; overflow:hidden;';
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const color = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const width = 6 + Math.random() * 6;
    const height = width * 1.6;
    const duration = (2.2 + Math.random() * 1.4).toFixed(2);
    const delay = (Math.random() * 0.4).toFixed(2);
    const rotate = Math.floor(Math.random() * 360);
    piece.style.cssText = `left:${left}%; width:${width}px; height:${height}px; background:${color}; transform:rotate(${rotate}deg); animation-duration:${duration}s; animation-delay:${delay}s;`;
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 4200);
}

function skeletonCards(n) {
  return Array.from({ length: n }, () => `
    <div class="stub skeleton-card">
      <div class="img skeleton-block"></div>
      <div class="body">
        <div class="skeleton-line" style="width:70%; height:1.15rem;"></div>
        <div class="skeleton-line" style="width:90%;"></div>
        <div class="meta">
          <div class="skeleton-line" style="width:60px; margin:0;"></div>
          <div class="skeleton-line" style="width:60px; margin:0;"></div>
        </div>
      </div>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  renderHeader();
  renderFooter();
  renderVerificationBanner();
});
