const API = '/api';

// Skips the admin panel so the site owner's own visits don't skew traffic
// numbers. No-ops entirely if GA_MEASUREMENT_ID isn't set on the server.
(function loadAnalytics() {
  if (window.location.pathname === '/admin.html') return;
  // Never on the claim page. The claim token arrives in a URL fragment and is
  // erased before this file loads, but analytics scripts read location, title
  // and referrer, and a third-party script on a page whose whole purpose is a
  // one-time credential is a risk with nothing on the other side of it.
  if (window.location.pathname === '/claim.html') return;
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

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
//
// There is no token in this file, and there is nowhere in the browser it could
// be kept. Authentication is an HttpOnly cookie the server sets and this script
// cannot read, cannot copy and cannot accidentally log. What used to live here
// was a 30-day JWT in localStorage plus an Authorization header built by hand —
// readable by any script that ever ran on any page of this site.
//
// What is held in memory is who you are (for rendering) and a CSRF token (for
// sending). Both die with the page. Neither is a credential on its own: the
// CSRF token is useless without the cookie, and the cookie is useless
// cross-site without the token.

let session = { authenticated: false, user: null, csrf: null };

// Anything left over from the old scheme is removed on sight, and never
// exchanged for a session. A token found here has been sitting in a place we
// now consider unsafe, possibly for a month; the only correct thing to do with
// it is throw it away. Everyone signs in once after this ships.
(function purgeLegacyTokens() {
  try {
    ['naseeb_token', 'naseeb_user'].forEach((key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
  } catch (err) {
    // Storage can be disabled entirely. Nothing here depends on it.
  }
})();

// Resolved once per page load, before anything renders. Every page that needs
// to know whether somebody is signed in awaits this rather than reading storage.
const sessionReady = (async function loadSession() {
  try {
    const res = await fetch(`${API}/auth/session`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return session;
    const data = await res.json();
    session = {
      authenticated: Boolean(data.authenticated),
      user: data.user || null,
      csrf: data.csrf_token || null,
    };
  } catch (err) {
    // Offline or a server blip. Renders as signed out, which is the safe
    // direction — no page grants anything on the strength of this.
  }
  return session;
})();

function getUser() { return session.user; }
function isSignedIn() { return session.authenticated; }

// Sends the browser to the sign-in page if there is no session, and resolves
// only when there is one. Replaces the `if (!getToken()) location.href = ...`
// that every authenticated page used to open with — which was synchronous
// because the token was synchronous, and cannot be any more.
async function requireSession(redirectTo) {
  await sessionReady;
  if (session.authenticated) return session;
  const target = redirectTo || window.location.pathname + window.location.search;
  window.location.href = `/login.html?redirect=${encodeURIComponent(target)}`;
  // Never resolves: the page is navigating away, and callers should not
  // continue rendering a screen the visitor is not entitled to see.
  return new Promise(() => {});
}

// Adopts the session a login or signup response just established. Stores
// nothing — the cookie is already set by the server, and this only records what
// to render and which CSRF token to send.
function adoptSession(payload) {
  session = {
    authenticated: true,
    user: payload.user || null,
    csrf: payload.csrf_token || null,
  };
}

function forgetSession() {
  session = { authenticated: false, user: null, csrf: null };
}

const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  // The CSRF token travels in a custom header and only there. Never a query
  // string (it would reach access logs and Referer headers), never a form
  // field, never storage.
  if (UNSAFE_METHODS.includes(method)) {
    await sessionReady;
    if (session.csrf) headers['X-CSRF-Token'] = session.csrf;
  }

  const res = await fetch(`${API}${path}`, {
    ...options,
    headers,
    // Sends the session cookie on same-origin requests and nothing else.
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // A session that ended server-side (expired, revoked, password reset,
    // account suspended) should stop the page pretending otherwise.
    if (res.status === 401) forgetSession();
    throw new Error(data.error || 'Something went wrong. Please try again.');
  }
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
      ${user.is_admin ? `<a href="/admin.html">${t('nav.admin')}</a><a href="/owner.html">${t('nav.owner')}</a>` : ''}
      <a href="/host-apply.html" id="nav-host-cta" class="btn-gold u-ba0c32d8">${t('nav.applyToHost')}</a>
      <span class="u-68433eba">${t('nav.hi', { name: escapeHtml(user.name) })}</span>
      <button id="logout-btn">${t('nav.signOut')}</button>
      ${langSwitcherHtml()}
    `;
    document.getElementById('logout-btn').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        // Signing out is a server-side revocation, not a browser-side delete.
        // The old version removed the localStorage copy and left the token
        // valid for the rest of its thirty days.
        await api('/auth/logout', { method: 'POST' });
      } catch (err) {
        // The cookie is cleared by the response either way; if the request
        // never landed, the session still expires on its own.
      }
      forgetSession();
      window.location.href = '/index.html';
    });
  } else {
    nav.innerHTML = `
      <a href="/index.html">${t('nav.browse')}</a>
      <a href="/winners.html">${t('nav.winners')}</a>
      <a href="/about.html">${t('nav.about')}</a>
      <a href="/pricing.html">${t('nav.pricing')}</a>
      <a href="/login.html">${t('nav.signIn')}</a>
      <a href="/signup.html" class="btn-gold u-ba0c32d8">${t('nav.joinFree')}</a>
      ${langSwitcherHtml()}
    `;
  }
  wireLangSwitcher();
  syncHostCta();
}

// Hosting is a closed beta, so the header cannot assume a signed-in account may
// host. It starts as "Apply to host" — the safe, true default for a brand new
// account — and only becomes "Host a giveaway" once the server says this
// account is approved (or is an administrator).
//
// host_status is deliberately not in the session token: the JWT lives for 30
// days and would keep asserting a status long after an administrator changed
// it. The server re-checks on every host-only request regardless of what this
// renders.
async function syncHostCta() {
  const cta = document.getElementById('nav-host-cta');
  if (!cta || !isSignedIn()) return;
  try {
    const state = await api('/host-applications/me');
    if (state.can_host) {
      cta.href = '/create.html';
      cta.textContent = t('nav.hostGiveaway');
    }
  } catch (err) {
    // Leave the safe default in place.
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
          <a href="/index.html" class="brand u-da71aab0">Naseeb<span class="dot">.</span></a>
          <p>${t('footer.tagline')}</p>
        </div>
        <div class="footer-links">
          <span class="footer-heading">${t('footer.explore')}</span>
          <a href="/index.html">${t('footer.browseGiveaways')}</a>
          <a href="/winners.html">${t('footer.pastWinners')}</a>
          <a href="/host-apply.html">${t('nav.applyToHost')}</a>
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

// Applies validated media URLs to every card that has just been rendered.
//
// The URL travels in a data-bg attribute and is set through the CSSOM, not an
// inline style attribute — style-src 'self' blocks the latter, and a media URL
// interpolated into a CSS string is exactly the kind of thing a policy should
// block. NaseebDom.setBackgroundImage refuses anything that is not an https URL
// on an allowed media origin, and leaves the card's placeholder showing instead
// of rendering a broken or hostile image.
function applyCardImages(root) {
  (root || document).querySelectorAll('[data-bg]').forEach((el) => {
    NaseebDom.setBackgroundImage(el, el.getAttribute('data-bg'));
    el.removeAttribute('data-bg');
  });
}

function giveawayCard(g) {
  const img = g.image_url || '';
  const statusLabel = g.status === 'drawn' ? t('detail.winnerDrawn') : timeLeft(g.entry_deadline);
  const statusClass = g.status === 'drawn' ? 'drawn' : '';
  return `
    <a class="stub" href="/giveaway.html?id=${g.id}">
      <div class="img" data-bg="${escapeAttr(img)}">
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

// Owner-toggled, informational only — doesn't block any functionality,
// just tells visitors something might be flaky right now. Dismissible per
// browser tab (sessionStorage) so it doesn't nag on every page nav.
async function renderMaintenanceBanner() {
  if (sessionStorage.getItem('naseeb_maintenance_dismissed') === 'true') return;
  try {
    const config = await fetch('/api/config').then((r) => r.json());
    if (!config.maintenance_mode) return;
    const header = document.querySelector('header.site');
    if (!header || document.querySelector('.maintenance-banner')) return;

    const banner = document.createElement('div');
    banner.className = 'maintenance-banner';
    banner.innerHTML = `
      <div class="wrap">
        <span>${escapeHtml(config.maintenance_message)}</span>
        <button id="dismiss-maintenance-btn" aria-label="Dismiss">&times;</button>
      </div>
    `;
    header.insertAdjacentElement('afterend', banner);

    document.getElementById('dismiss-maintenance-btn').addEventListener('click', () => {
      sessionStorage.setItem('naseeb_maintenance_dismissed', 'true');
      banner.remove();
    });
  } catch (err) {
    // Non-critical — no banner is better than a broken page over this.
  }
}

// A brief confetti burst for celebratory moments (e.g. a winner being drawn).
function celebrate() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Per-piece randomness is written through the CSSOM, one property at a time.
  // `style-src-attr 'none'` governs the style *attribute* — markup, and
  // setAttribute('style', …) — not property assignments on element.style, which
  // is measured in docs/CSP.md §7. The container's fixed layout is a class
  // because it never varies; these values do, sixty different ways.
  const colors = ['#C9A15A', '#E4C078', '#DCEEE7', '#0B3B36'];
  const container = document.createElement('div');
  container.className = 'confetti-layer';
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const width = 6 + Math.random() * 6;
    piece.style.left = Math.random() * 100 + '%';
    piece.style.width = width + 'px';
    piece.style.height = width * 1.6 + 'px';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.transform = 'rotate(' + Math.floor(Math.random() * 360) + 'deg)';
    piece.style.animationDuration = (2.2 + Math.random() * 1.4).toFixed(2) + 's';
    piece.style.animationDelay = (Math.random() * 0.4).toFixed(2) + 's';
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 4200);
}

function skeletonCards(n) {
  return Array.from({ length: n }, () => `
    <div class="stub skeleton-card">
      <div class="img skeleton-block"></div>
      <div class="body">
        <div class="skeleton-line u-77148b4e"></div>
        <div class="skeleton-line u-3801d6f9"></div>
        <div class="meta">
          <div class="skeleton-line u-91bb8b7c"></div>
          <div class="skeleton-line u-91bb8b7c"></div>
        </div>
      </div>
    </div>
  `).join('');
}

// The header cannot be drawn until the server has said who this is — there is
// no synchronous copy of that answer any more, which is the point.
document.addEventListener('DOMContentLoaded', async () => {
  renderFooter();
  renderMaintenanceBanner();
  await sessionReady;
  renderHeader();
  renderVerificationBanner();
});
