// Building the page without building an injection.
//
// Loaded before every other script on every page, because everything else uses
// it.
//
// The original pattern was a template literal assigned to innerHTML with
// escapeHtml() called by hand on each interpolation. Phase 2.2B replaced the
// hand-escaping with a tagged template that escaped by default. This amendment
// goes the rest of the way: **nothing that carries a runtime value produces
// markup any more.** Elements are created, text is set as text, attributes go
// through setters that know what context they are writing into, and URLs are
// validated by a function chosen for the place the URL is going.
//
// Why that is different in kind rather than degree: HTML escaping is correct for
// exactly one context — character data and quoted attribute values in HTML. It
// is not correct for a URL (`javascript:alert(1)` survives escaping intact), not
// correct for CSS, and not correct for an attribute name. A helper that escapes
// everything the same way is a helper that is wrong somewhere. Building nodes
// removes the parser from the path entirely, so there is no context to get
// wrong.
//
// A note on what this is not: it is not a sanitizer. Nothing here takes
// attacker-supplied markup and tries to make it safe — user-authored rich HTML
// is not a feature of this application and must not become one.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // URLs — one validator per context, because there is no general one
  // ---------------------------------------------------------------------------

  // Where media may come from, mirroring server/lib/mediaUrls.js. The server is
  // the authority — it refuses to store anything else — and this is the second
  // check, for rows written before that validation existed.
  var ALLOWED_MEDIA_ORIGINS = ['https://res.cloudinary.com'];

  function configureMediaOrigins(origins) {
    if (Array.isArray(origins) && origins.length) ALLOWED_MEDIA_ORIGINS = origins.slice();
  }

  // C0 controls and DEL. Browsers strip some of these before parsing a URL, so
  // "java\tscript:alert(1)" can become a working scheme — the string is refused
  // rather than cleaned, because cleaning is where the bugs live.
  var CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

  // A '%' that does not begin a valid escape. Malformed encoding means the
  // string will be decoded differently by different consumers, which is the
  // whole basis of a smuggling bug.
  var BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;

  function looksHostile(raw) {
    return (
      CONTROL_CHARACTERS.test(raw) ||
      BAD_PERCENT.test(raw) ||
      /\s/.test(raw) ||
      raw.indexOf('\\') !== -1
    );
  }

  // Returns a safe absolute media URL, or null. Null means "show the no-image
  // state" — never "render it anyway" and never "turn it into a link the visitor
  // can click", which is the same problem one step removed.
  function safeMediaUrl(value) {
    if (!value) return null;
    var raw = String(value).trim();
    if (looksHostile(raw)) return null;
    // Protocol-relative: inherits whatever scheme the page has and points at a
    // host we never checked.
    if (raw.indexOf('//') === 0) return null;
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    // Full-origin equality, deliberately. A suffix or substring test would
    // accept res.cloudinary.com.attacker.example and notres.cloudinary.com.
    if (ALLOWED_MEDIA_ORIGINS.indexOf(url.origin) === -1) return null;
    return url.href;
  }

  // Links this application generates to its own pages. Anything absolute,
  // protocol-relative, or carrying a scheme is refused — `javascript:` most
  // obviously, but also an off-site redirect dressed up as a local link.
  function safeInternalUrl(value) {
    if (!value) return null;
    var raw = String(value).trim();
    if (looksHostile(raw)) return null;
    if (raw.charAt(0) !== '/') return null;
    if (raw.indexOf('//') === 0) return null;
    return raw;
  }

  // The one place this application sends a visitor off-site: Stripe's hosted
  // checkout. The URL is built by Stripe and relayed by our API, which makes it
  // API-controlled rather than ours — so it is checked against the one origin it
  // is allowed to be, not merely trusted for having arrived over our own API.
  var ALLOWED_EXTERNAL_REDIRECTS = ['https://checkout.stripe.com'];

  function safeExternalRedirectUrl(value) {
    if (!value) return null;
    var raw = String(value).trim();
    if (looksHostile(raw)) return null;
    if (raw.indexOf('//') === 0) return null;
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (ALLOWED_EXTERNAL_REDIRECTS.indexOf(url.origin) === -1) return null;
    return url.href;
  }

  // An advertiser's own website — the one class of link that legitimately points
  // anywhere. "Anywhere" still means an http(s) URL with a host and no embedded
  // credentials: a `javascript:` destination is not a website, and this is
  // exactly where escaping used to be mistaken for validation.
  function safeExternalLinkUrl(value) {
    if (!value) return null;
    var raw = String(value).trim();
    if (looksHostile(raw)) return null;
    if (raw.indexOf('//') === 0) return null;
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return url.href;
  }

  // ---------------------------------------------------------------------------
  // Element construction
  // ---------------------------------------------------------------------------

  // Attributes that decide what code runs or where a request goes. None of them
  // may be set from data; each has a dedicated setter, or no setter at all.
  var FORBIDDEN_ATTRIBUTES = /^(on|xlink:|xmlns)|^(style|href|src|srcdoc|srcset|action|formaction|data|background|ping|http-equiv)$/i;

  // An id or a name becomes a property of `window` and of every enclosing form.
  // A value like "session" or "csrf" from a hostile row would shadow a real
  // reference — DOM clobbering — so ids are held to a fixed shape rather than
  // trusted to be harmless.
  var SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

  // Plain DOM properties. Assigning these never parses markup, so they are safe
  // to take from data; the browser coerces them to strings and nothing else.
  var SAFE_PROPERTIES = [
    'value', 'type', 'placeholder', 'disabled', 'required', 'checked', 'readOnly',
    'rows', 'cols', 'min', 'max', 'step', 'maxLength', 'htmlFor', 'title', 'alt',
    'colSpan', 'rowSpan', 'tabIndex', 'hidden', 'multiple', 'selected', 'autocomplete',
    'target', 'rel', 'loading', 'muted', 'autoplay', 'loop', 'playsInline', 'controls',
  ];

  function appendChild(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) { appendChild(parent, c); });
      return;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
      return;
    }
    // Anything else is text, and lands as text. This is the branch that used to
    // be an interpolation into a template literal.
    parent.appendChild(document.createTextNode(String(child)));
  }

  // el('a', { class: 'btn', text: g.title, href: '/giveaway.html?id=' + g.id },
  //    [el('span', { class: 'pill', text: status })])
  function el(tag, props, children) {
    var node = document.createElement(tag);
    var p = props || {};

    Object.keys(p).forEach(function (key) {
      var value = p[key];
      if (value === null || value === undefined) return;

      switch (key) {
        case 'class':
        case 'className':
          node.className = String(value);
          return;
        case 'text':
          node.textContent = String(value);
          return;
        case 'id':
        case 'name':
          if (!SAFE_IDENTIFIER.test(String(value))) {
            throw new Error('unsafe ' + key + ': ' + String(value).slice(0, 40));
          }
          node[key] = String(value);
          return;
        case 'href':
          setHref(node, value);
          return;
        case 'mediaSrc':
          setMediaSrc(node, value);
          return;
        case 'dataset':
          Object.keys(value).forEach(function (k) { node.dataset[k] = String(value[k]); });
          return;
        case 'aria':
          Object.keys(value).forEach(function (k) {
            node.setAttribute('aria-' + k, String(value[k]));
          });
          return;
        case 'on':
          Object.keys(value).forEach(function (evt) { node.addEventListener(evt, value[evt]); });
          return;
        case 'attrs':
          Object.keys(value).forEach(function (name) {
            if (FORBIDDEN_ATTRIBUTES.test(name)) {
              throw new Error('attribute must use its own setter: ' + name);
            }
            node.setAttribute(name, String(value[name]));
          });
          return;
        default:
          if (SAFE_PROPERTIES.indexOf(key) === -1) {
            throw new Error('unknown element property: ' + key);
          }
          node[key] = value;
      }
    });

    appendChild(node, children);
    return node;
  }

  function frag(children) {
    var f = document.createDocumentFragment();
    appendChild(f, children);
    return f;
  }

  function clear(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // Replaces a container's contents. The one-line replacement for
  // `container.innerHTML = …`, and the reason no page needs innerHTML.
  function mount(node, children) {
    if (!node) return node;
    clear(node);
    appendChild(node, children);
    return node;
  }

  function append(node, children) {
    if (node) appendChild(node, children);
    return node;
  }

  function setText(node, value) {
    if (node) node.textContent = value === null || value === undefined ? '' : String(value);
    return node;
  }

  // ---------------------------------------------------------------------------
  // URL setters — the only way a URL reaches an attribute
  // ---------------------------------------------------------------------------

  // A rejected link becomes inert rather than pointing somewhere else: the href
  // is removed, so it renders as text the visitor cannot click. Silently
  // rewriting it to "#" would still look like a link and still invite a click.
  function setHref(anchor, value) {
    if (!anchor) return false;
    var url = safeInternalUrl(value);
    if (!url) {
      anchor.removeAttribute('href');
      anchor.classList.add('is-inert-link');
      return false;
    }
    anchor.setAttribute('href', url);
    return true;
  }

  // An off-site link. Rejected destinations lose the href rather than becoming a
  // clickable "#": a link that still looks like a link still invites a click.
  function setExternalHref(anchor, value) {
    if (!anchor) return false;
    var url = safeExternalLinkUrl(value);
    if (!url) {
      anchor.removeAttribute('href');
      anchor.classList.add('is-inert-link');
      return false;
    }
    anchor.setAttribute('href', url);
    // Set here rather than left to each caller, because forgetting it on an
    // attacker-chosen destination is what makes reverse tabnabbing possible.
    anchor.setAttribute('rel', 'noopener noreferrer sponsored');
    return true;
  }

  // For <img>/<video>/<source>. Falls back to the local placeholder rather than
  // leaving a broken element, and never to the rejected URL.
  function setMediaSrc(element, value, fallback) {
    if (!element) return false;
    var url = safeMediaUrl(value);
    if (!url) {
      if (fallback) element.setAttribute('src', fallback);
      else element.removeAttribute('src');
      return false;
    }
    element.setAttribute('src', url);
    return true;
  }

  // Forms post to this application and nowhere else. Present so that a future
  // dynamic action has a validator waiting rather than an attribute assignment.
  function setAction(form, value) {
    if (!form) return false;
    var url = safeInternalUrl(value);
    if (!url) return false;
    form.setAttribute('action', url);
    return true;
  }

  // Navigation. Same validator as a link, because a redirect is a link the page
  // clicks for you — this is where a ?redirect= parameter ends up.
  function navigate(value) {
    var url = safeInternalUrl(value);
    if (!url) return false;
    window.location.href = url;
    return true;
  }

  function navigateToCheckout(value) {
    var url = safeExternalRedirectUrl(value);
    if (!url) return false;
    window.location.href = url;
    return true;
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------

  // Sets a background image through the CSSOM rather than a style attribute.
  //
  // `style-src-attr 'none'` governs the style attribute — markup, and
  // setAttribute('style', …) — not property assignments on element.style, so
  // this is permitted while the inline style string the card used to build is
  // not. Measured, not assumed: docs/CSP.md §7.
  //
  // The URL is validated first and re-checked for CSS metacharacters after,
  // because this string ends up inside a CSS value where a quote or a paren
  // would end the url() token early.
  function setBackgroundImage(element, value) {
    if (!element) return false;
    var url = safeMediaUrl(value);
    if (!url || url.indexOf('"') !== -1 || url.indexOf(')') !== -1 || url.indexOf('\\') !== -1) {
      element.style.backgroundImage = '';
      return false;
    }
    element.style.backgroundImage = 'url("' + url + '")';
    return true;
  }

  // ---------------------------------------------------------------------------
  // Static icons
  // ---------------------------------------------------------------------------

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  // The verified-business tick. Built rather than pasted as markup so that no
  // page needs an innerHTML assignment to show an icon.
  function verifiedBadgeIcon(label) {
    var title = svgEl('title');
    title.textContent = label || 'Verified business';
    return svgEl(
      'svg',
      { class: 'verified-badge', viewBox: '0 0 20 20', width: '14', height: '14', role: 'img' },
      [
        title,
        svgEl('circle', { cx: '10', cy: '10', r: '9', fill: '#C9A15A' }),
        svgEl('path', {
          d: 'M6 10.3l2.6 2.6L14 7.3',
          stroke: '#072925',
          'stroke-width': '2',
          fill: 'none',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      ]
    );
  }

  window.NaseebDom = {
    el: el,
    frag: frag,
    clear: clear,
    mount: mount,
    append: append,
    setText: setText,
    setHref: setHref,
    setExternalHref: setExternalHref,
    setMediaSrc: setMediaSrc,
    safeExternalLinkUrl: safeExternalLinkUrl,
    setAction: setAction,
    navigate: navigate,
    navigateToCheckout: navigateToCheckout,
    safeMediaUrl: safeMediaUrl,
    safeInternalUrl: safeInternalUrl,
    safeExternalRedirectUrl: safeExternalRedirectUrl,
    setBackgroundImage: setBackgroundImage,
    configureMediaOrigins: configureMediaOrigins,
    verifiedBadgeIcon: verifiedBadgeIcon,
  };
})();
