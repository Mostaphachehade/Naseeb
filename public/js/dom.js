// Building HTML without building an injection.
//
// Loaded before every other script on every page, because everything else uses
// it.
//
// The old pattern was a template literal assigned to innerHTML with
// escapeHtml() called by hand on each interpolation. That works right up until
// somebody forgets one — and "did the author remember on every line" is not a
// property you can check by looking at a diff. The `html` tag below escapes
// every interpolation by default, so forgetting is not an available mistake.
// Opting out takes the explicit word `trusted`.
//
// A note on what this is not: it is not a sanitizer. Nothing here takes
// attacker-supplied markup and tries to make it safe — user-controlled rich HTML
// is not a feature of this application and must not become one. This escapes
// text so it renders as text, which is a much smaller and much more reliable
// job.

(function () {
  'use strict';

  function escapeHtmlText(value) {
    // Covers text content and quoted attribute values in one pass. Both quote
    // characters are encoded, so an interpolation cannot break out of either
    // attr="…" or attr='…'.
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Marks a string as already-safe markup. Every use is a place a reviewer
  // should look at, which is why it has to be written out rather than happening
  // by default.
  function trusted(markup) {
    return { __safeMarkup: String(markup) };
  }

  function isTrusted(value) {
    return value && typeof value === 'object' && typeof value.__safeMarkup === 'string';
  }

  // html`<p>${userText}</p>` — every ${} is escaped unless it is trusted(),
  // an array of trusted values, null/undefined (rendered as nothing), or a
  // number/boolean.
  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
      out += render(values[i]) + strings[i + 1];
    }
    return trusted(out);
  }

  function render(value) {
    if (value === null || value === undefined || value === false) return '';
    if (isTrusted(value)) return value.__safeMarkup;
    if (Array.isArray(value)) return value.map(render).join('');
    return escapeHtmlText(value);
  }

  // The only place markup reaches the DOM. Refuses a bare string outright, so
  // `setHtml(el, someUserValue)` cannot compile by accident.
  function setHtml(element, value) {
    if (!element) return;
    if (!isTrusted(value)) {
      throw new TypeError('setHtml expects html`…` or trusted(…), not a plain string');
    }
    element.innerHTML = value.__safeMarkup;
  }

  // ---------------------------------------------------------------------------
  // URLs
  // ---------------------------------------------------------------------------

  // Where media may come from, mirroring server/lib/mediaUrls.js. The server is
  // the authority — it refuses to store anything else — and this is the second
  // check, for rows written before that validation existed.
  var ALLOWED_MEDIA_ORIGINS = ['https://res.cloudinary.com'];

  function configureMediaOrigins(origins) {
    if (Array.isArray(origins) && origins.length) ALLOWED_MEDIA_ORIGINS = origins.slice();
  }

  // Returns a safe absolute URL, or null. Null means "show the no-image state" —
  // never "render it anyway" and never "turn it into a link the visitor can
  // click", which would be the same problem one step removed.
  function safeMediaUrl(value) {
    if (!value) return null;
    var raw = String(value).trim();
    if (/[\x00-\x1f\x7f]/.test(raw)) return null;
    if (raw.indexOf('//') === 0) return null;
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (ALLOWED_MEDIA_ORIGINS.indexOf(url.origin) === -1) return null;
    return url.href;
  }

  // Links the application generates to its own pages. Anything absolute,
  // protocol-relative, or carrying a scheme is refused — `javascript:` most
  // obviously, but also an off-site redirect dressed up as a local link.
  function safeInternalUrl(value) {
    if (!value) return null;
    var raw = String(value).trim();
    if (raw.indexOf('/') !== 0 || raw.indexOf('//') === 0) return null;
    if (/[\x00-\x1f\x7f]/.test(raw)) return null;
    return raw;
  }

  // Sets a background image through the CSSOM rather than a style attribute.
  //
  // `style-src-attr 'none'` governs the style attribute — markup, and
  // setAttribute('style', …) — not property assignments on element.style, so
  // this is permitted while the inline style string the card used to build is
  // not. Measured, not assumed: docs/CSP.md §7.
  function setBackgroundImage(element, value) {
    if (!element) return false;
    var url = safeMediaUrl(value);
    if (!url) {
      element.style.backgroundImage = '';
      return false;
    }
    // CSS.escape is not for URLs; quoting and rejecting quotes is. safeMediaUrl
    // has already parsed this, so it cannot contain an unescaped quote — but
    // belt and braces, because this string ends up inside a CSS value.
    if (url.indexOf('"') !== -1 || url.indexOf(')') !== -1) {
      element.style.backgroundImage = '';
      return false;
    }
    element.style.backgroundImage = 'url("' + url + '")';
    return true;
  }

  window.NaseebDom = {
    html: html,
    trusted: trusted,
    isTrusted: isTrusted,
    setHtml: setHtml,
    escapeHtmlText: escapeHtmlText,
    safeMediaUrl: safeMediaUrl,
    safeInternalUrl: safeInternalUrl,
    setBackgroundImage: setBackgroundImage,
    configureMediaOrigins: configureMediaOrigins,
  };
})();
