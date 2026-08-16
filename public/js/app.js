const API = '/api';

// Every page builds its DOM through these. Nothing in this file, or in any page
// script, assigns markup — see public/js/dom.js for why that is a different
// thing from escaping carefully.
const { el, frag, mount, append, clear, setText } = NaseebDom;

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
      // Owner-configured, arriving over our own API, and about to become the
      // src of a script tag — which makes it the highest-consequence string on
      // the site. It is held to the shape a measurement id actually has, and the
      // URL is assembled from a fixed origin plus an encoded parameter rather
      // than interpolated. CSP would refuse a script from anywhere else anyway;
      // this makes the code say so too.
      if (!/^G-[A-Z0-9]{4,24}$/i.test(String(config.ga_measurement_id || ''))) return;
      const script = document.createElement('script');
      script.async = true;
      script.src =
        'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(config.ga_measurement_id);
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
  NaseebDom.navigate('/login.html?redirect=' + encodeURIComponent(target));
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

function langSwitcher() {
  const lang = getLang();
  const button = (code, label) =>
    el('button', {
      type: 'button',
      class: 'lang-btn' + (lang === code ? ' active' : ''),
      text: label,
      dataset: { lang: code },
      on: { click: () => setLang(code) },
    });
  return el('span', { class: 'lang-switch', attrs: { role: 'group' }, aria: { label: 'Language' } }, [
    button('en', 'EN'),
    button('ar', 'عربي'),
  ]);
}

function navLink(href, label, props) {
  return el('a', Object.assign({ href, text: label }, props || {}));
}

function renderHeader() {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const user = getUser();

  if (user) {
    // The visitor's own name is set as text on its own node. It was previously
    // escaped and interpolated into a translation string, which worked, and
    // worked for the same reason a lock works while you remember to turn it.
    const greeting = el('span', { class: 'u-68433eba', text: t('nav.hi', { name: user.name }) });

    const logout = el('button', {
      id: 'logout-btn',
      text: t('nav.signOut'),
      on: {
        click: async (e) => {
          e.currentTarget.disabled = true;
          try {
            // Signing out is a server-side revocation, not a browser-side
            // delete. The old version removed the localStorage copy and left
            // the token valid for the rest of its thirty days.
            await api('/auth/logout', { method: 'POST' });
          } catch (err) {
            // The cookie is cleared by the response either way; if the request
            // never landed, the session still expires on its own.
          }
          forgetSession();
          NaseebDom.navigate('/index.html');
        },
      },
    });

    mount(nav, [
      navLink('/index.html', t('nav.browse')),
      navLink('/winners.html', t('nav.winners')),
      navLink('/about.html', t('nav.about')),
      navLink('/dashboard.html', t('nav.myGiveaways')),
      navLink('/pricing.html', t('nav.pricing')),
      user.is_admin ? navLink('/admin.html', t('nav.admin')) : null,
      user.is_admin ? navLink('/owner.html', t('nav.owner')) : null,
      navLink('/host-apply.html', t('nav.applyToHost'), {
        id: 'nav-host-cta',
        class: 'btn-gold u-ba0c32d8',
      }),
      greeting,
      logout,
      langSwitcher(),
    ]);
  } else {
    mount(nav, [
      navLink('/index.html', t('nav.browse')),
      navLink('/winners.html', t('nav.winners')),
      navLink('/about.html', t('nav.about')),
      navLink('/pricing.html', t('nav.pricing')),
      navLink('/login.html', t('nav.signIn')),
      navLink('/signup.html', t('nav.joinFree'), { class: 'btn-gold u-ba0c32d8' }),
      langSwitcher(),
    ]);
  }
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
      NaseebDom.setHref(cta, '/create.html');
      cta.textContent = t('nav.hostGiveaway');
    }
  } catch (err) {
    // Leave the safe default in place.
  }
}

function renderFooter() {
  const host = document.getElementById('site-footer');
  if (!host) return;
  const year = new Date().getFullYear();

  const brand = el('a', { href: '/index.html', class: 'brand u-da71aab0' }, [
    'Naseeb',
    el('span', { class: 'dot', text: '.' }),
  ]);

  mount(host, el('footer', { class: 'site' }, [
    el('div', { class: 'wrap footer-grid' }, [
      el('div', { class: 'footer-brand' }, [brand, el('p', { text: t('footer.tagline') })]),
      el('div', { class: 'footer-links' }, [
        el('span', { class: 'footer-heading', text: t('footer.explore') }),
        navLink('/index.html', t('footer.browseGiveaways')),
        navLink('/winners.html', t('footer.pastWinners')),
        navLink('/host-apply.html', t('nav.applyToHost')),
        navLink('/pricing.html', t('nav.pricing')),
        navLink('/about.html', t('footer.aboutNaseeb')),
        navLink('/advertise.html', t('footer.advertise')),
        navLink('/partners.html', t('footer.partners')),
      ]),
      el('div', { class: 'footer-links' }, [
        el('span', { class: 'footer-heading', text: t('footer.legal') }),
        navLink('/terms.html', t('footer.terms')),
        navLink('/privacy.html', t('footer.privacy')),
      ]),
    ]),
    el('div', { class: 'wrap footer-bottom', text: t('footer.bottom', { year }) }),
  ]));
}

// A ?redirect= parameter is a URL the page will navigate to on the visitor's
// behalf, so it gets the same validator a link does: same-site absolute paths
// only, no scheme, no protocol-relative host, no control characters or
// backslashes dressed up as a path.
function safeRedirect(path) {
  return NaseebDom.safeInternalUrl(path);
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
  return NaseebDom.verifiedBadgeIcon('Verified business');
}

// Purely a trust signal (see server/db.js) — visible wherever a drawn
// giveaway is shown, not just on the giveaway's own page, so it can't be
// quietly ignored.
function deliveryPill(g) {
  if (g.status !== 'drawn') return null;
  return g.prize_delivered
    ? el('span', { class: 'delivery-pill delivered', text: '✓ ' + t('delivery.delivered') })
    : el('span', { class: 'delivery-pill pending', text: t('delivery.pending') });
}

// The card the homepage, the dashboard and the winners page all render.
//
// Every value on it comes from the database and is host-controlled: the title,
// the prize text, the host's display name, and the image URL. None of them is
// interpolated into markup. The text values are set as text; the image URL goes
// through the media validator and lands in a CSS background, so a rejected URL
// leaves the placeholder showing rather than a broken or hostile image; and the
// only URL this card builds is its own link, from an id the server generated.
function giveawayCard(g) {
  const statusLabel = g.status === 'drawn' ? t('detail.winnerDrawn') : timeLeft(g.entry_deadline);
  const image = el('div', { class: 'img' }, [
    el('span', { class: 'status-pill' + (g.status === 'drawn' ? ' drawn' : ''), text: statusLabel }),
  ]);
  NaseebDom.setBackgroundImage(image, g.image_url);

  return el('a', { class: 'stub', href: '/giveaway.html?id=' + encodeURIComponent(g.id) }, [
    image,
    el('div', { class: 'body' }, [
      el('h3', { text: g.title }),
      el('p', { class: 'prize', text: g.prize_description }),
      el('div', { class: 'meta' }, [
        el('span', { class: 'num', text: t('detail.enteredCount', { n: g.entry_count }) }),
        el('span', {}, [
          t('winners.by', { name: g.host_name }),
          g.host_verified ? verifiedBadge() : null,
        ]),
      ]),
      deliveryPill(g),
    ]),
  ]);
}

function renderVerificationBanner() {
  const user = getUser();
  if (!user || user.email_verified) return;
  const header = document.querySelector('header.site');
  if (!header || document.querySelector('.verify-banner')) return;

  const resend = el('button', {
    id: 'resend-verify-btn',
    text: 'Resend email',
    on: {
      click: async (e) => {
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
      },
    },
  });

  const banner = el('div', { class: 'verify-banner' }, [
    el('div', { class: 'wrap' }, [
      el('span', { text: 'Verify your email to host or enter giveaways — check your inbox.' }),
      resend,
    ]),
  ]);
  header.insertAdjacentElement('afterend', banner);
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

    // Owner-configured free text, straight out of the settings table. Text node,
    // not markup — the owner is trusted to run the site, not to be the one
    // account whose typing is executed.
    const banner = el('div', { class: 'maintenance-banner' }, [
      el('div', { class: 'wrap' }, [
        el('span', { text: config.maintenance_message }),
        el('button', {
          id: 'dismiss-maintenance-btn',
          text: '×',
          aria: { label: 'Dismiss' },
          on: {
            click: () => {
              sessionStorage.setItem('naseeb_maintenance_dismissed', 'true');
              banner.remove();
            },
          },
        }),
      ]),
    ]);
    header.insertAdjacentElement('afterend', banner);
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
  return Array.from({ length: n }, () =>
    el('div', { class: 'stub skeleton-card' }, [
      el('div', { class: 'img skeleton-block' }),
      el('div', { class: 'body' }, [
        el('div', { class: 'skeleton-line u-77148b4e' }),
        el('div', { class: 'skeleton-line u-3801d6f9' }),
        el('div', { class: 'meta' }, [
          el('div', { class: 'skeleton-line u-91bb8b7c' }),
          el('div', { class: 'skeleton-line u-91bb8b7c' }),
        ]),
      ]),
    ])
  );
}

// The one shape every page's catch block renders. Centralised because an error
// message is not always ours: it can be a server string, and on a bad day it
// carries back something a visitor typed.
function errorNode(message, className) {
  return el('p', { class: className || 'form-error show', text: message });
}

function emptyNode(message) {
  return el('div', { class: 'empty', text: message });
}

// The admin and owner panels are mostly tables, and a table built by hand is
// where a "just this once" template literal reappears. These build the whole
// shape from cells, so a row is data rather than markup.
function td(value, className) {
  return el('td', { class: className || null, text: value === null || value === undefined ? '' : value });
}

function tdNode(children, className) {
  return el('td', { class: className || null }, children);
}

function dataTable(headings, rows, emptyText, wrapClass) {
  const body = rows.length
    ? rows
    : [el('tr', {}, td(emptyText || 'Nothing yet.', 'u-a2aae0fb'))];
  if (!rows.length) body[0].firstChild.colSpan = headings.length;

  return el('div', { class: wrapClass ? 'table-wrap ' + wrapClass : 'table-wrap' }, [
    el('table', { class: 'admin-table' }, [
      el('thead', {}, el('tr', {}, headings.map((h) => el('th', { text: h })))),
      el('tbody', {}, body),
    ]),
  ]);
}

// Inline elements that used to sit on separate lines inside a template literal
// were separated by a rendered space, and several of the button pairs in the
// admin tables rely on it for their gap. Appended nodes have no such space, so
// it is put back explicitly — changing the CSS instead would be a design change,
// and this amendment is not allowed to be one.
function spaced(nodes) {
  const out = [];
  nodes.filter(Boolean).forEach((node, i) => {
    if (i) out.push(' ');
    out.push(node);
  });
  return out;
}

function statCard(number, label) {
  return el('div', { class: 'admin-stat' }, [
    el('div', { class: 'admin-stat-num', text: number }),
    el('div', { class: 'admin-stat-label', text: label }),
  ]);
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
