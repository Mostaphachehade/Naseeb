const API = '/api';

// Skips the admin panel so the site owner's own visits don't skew traffic
// numbers. No-ops entirely if GA_MEASUREMENT_ID isn't set on the server.
(function loadAnalytics() {
  if (window.location.pathname === '/admin.html') return;
  fetch(`${API}/config`)
    .then((r) => r.json())
    .then((config) => {
      if (!config.ga_measurement_id) return;
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${config.ga_measurement_id}`;
      document.head.appendChild(script);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function gtag() { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      // Keep this in sync with the privacy policy's "we don't use it for
      // advertising" claim — without these, GA links data to Google's ad
      // products by default.
      window.gtag('config', config.ga_measurement_id, {
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      });
    })
    .catch(() => {});
})();

function getToken() { return localStorage.getItem('naseeb_token'); }
function getUser() {
  const raw = localStorage.getItem('naseeb_user');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Corrupted session data (e.g. a browser extension mangled localStorage)
    // — treat it as signed out rather than crashing every page's header.
    clearSession();
    return null;
  }
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

function langSwitcherHtml() {
  const lang = getLang();
  return `
    <span class="lang-switch" role="group" aria-label="Language">
      <button type="button" class="lang-btn ${lang === 'en' ? 'active' : ''}" data-lang="en">EN</button>
      <button type="button" class="lang-btn ${lang === 'ar' ? 'active' : ''}" data-lang="ar">عربي</button>
    </span>
  `;
}

function wireLangSwitcher() {
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
}

function renderHeader() {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const user = getUser();

  if (user) {
    nav.innerHTML = `
      <a href="/index.html">${t('nav.browse')}</a>
      <a href="/winners.html">${t('nav.winners')}</a>
      <a href="/about.html">${t('nav.about')}</a>
      <a href="/dashboard.html">${t('nav.myGiveaways')}</a>
      <a href="/pricing.html">${t('nav.pricing')}</a>
      ${user.is_admin ? `<a href="/admin.html">${t('nav.admin')}</a>` : ''}
      <a href="/create.html" class="btn-gold" style="border-radius:100px;">${t('nav.hostGiveaway')}</a>
      <span style="opacity:0.7;">${t('nav.hi', { name: escapeHtml(user.name) })}</span>
      <button id="logout-btn">${t('nav.signOut')}</button>
      ${langSwitcherHtml()}
    `;
    document.getElementById('logout-btn').addEventListener('click', () => {
      clearSession();
      window.location.href = '/index.html';
    });
  } else {
    nav.innerHTML = `
      <a href="/index.html">${t('nav.browse')}</a>
      <a href="/winners.html">${t('nav.winners')}</a>
      <a href="/about.html">${t('nav.about')}</a>
      <a href="/pricing.html">${t('nav.pricing')}</a>
      <a href="/login.html">${t('nav.signIn')}</a>
      <a href="/signup.html" class="btn-gold" style="border-radius:100px;">${t('nav.joinFree')}</a>
      ${langSwitcherHtml()}
    `;
  }
  wireLangSwitcher();
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
          <p>${t('footer.tagline')}</p>
        </div>
        <div class="footer-links">
          <span class="footer-heading">${t('footer.explore')}</span>
          <a href="/index.html">${t('footer.browseGiveaways')}</a>
          <a href="/winners.html">${t('footer.pastWinners')}</a>
          <a href="/create.html">${t('nav.hostGiveaway')}</a>
          <a href="/pricing.html">${t('nav.pricing')}</a>
          <a href="/about.html">${t('footer.aboutNaseeb')}</a>
          <a href="/advertise.html">${t('footer.advertise')}</a>
          <a href="/partners.html">${t('footer.partners')}</a>
        </div>
        <div class="footer-links">
          <span class="footer-heading">${t('footer.legal')}</span>
          <a href="/terms.html">${t('footer.terms')}</a>
          <a href="/privacy.html">${t('footer.privacy')}</a>
        </div>
      </div>
      <div class="wrap footer-bottom">${t('footer.bottom', { year })}</div>
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
  if (ms <= 0) return t('time.closed');
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return t('time.daysHoursLeft', { d: days, h: hours });
  const mins = Math.floor((ms % 3600000) / 60000);
  return t('time.hoursMinsLeft', { h: hours, m: mins });
}

function verifiedBadge() {
  return `<svg class="verified-badge" viewBox="0 0 20 20" width="14" height="14" role="img"><title>Verified business</title><circle cx="10" cy="10" r="9" fill="#C9A15A"/><path d="M6 10.3l2.6 2.6L14 7.3" stroke="#072925" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Purely a trust signal (see server/db.js) — visible wherever a drawn
// giveaway is shown, not just on the giveaway's own page, so it can't be
// quietly ignored.
function deliveryPill(g) {
  if (g.status !== 'drawn') return '';
  return g.prize_delivered
    ? `<span class="delivery-pill delivered">&check; ${t('delivery.delivered')}</span>`
    : `<span class="delivery-pill pending">${t('delivery.pending')}</span>`;
}

function giveawayCard(g) {
  const img = g.image_url || '';
  const statusLabel = g.status === 'drawn' ? t('detail.winnerDrawn') : timeLeft(g.entry_deadline);
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
          <span class="num">${t('detail.enteredCount', { n: g.entry_count })}</span>
          <span>${t('winners.by', { name: escapeHtml(g.host_name) })}${g.host_verified ? verifiedBadge() : ''}</span>
        </div>
        ${deliveryPill(g)}
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
