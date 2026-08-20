  // Runs BEFORE any other script on this page, and the ordering is the point.
  //
  // The confirmation token arrives in the URL *fragment*. Fragments are never
  // sent to a server, so it does not reach this application, a reverse proxy or
  // any access log on the way in — unlike a query string, which would be written
  // into every one of them.
  //
  // It is read once, erased from the address bar immediately, and then held only
  // in memory. Erasing it first means it is gone before analytics could
  // initialise and before any request this page makes can carry it in a Referer.
  window.__emailChangeToken = null;
  (function captureEmailChangeToken() {
    var hash = window.location.hash || '';
    var match = hash.match(/(?:^#|&)token=([^&]+)/);
    if (!match) return;
    window.__emailChangeToken = decodeURIComponent(match[1]);
    window.history.replaceState({}, document.title, window.location.pathname);
  })();
