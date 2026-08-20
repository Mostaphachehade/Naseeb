  // Runs BEFORE any other script on this page, and the ordering is the point.
  //
  // The token arrives in the URL *fragment*. Fragments are never sent to a
  // server, so it does not reach this application, a reverse proxy, or any
  // access log on the way in — unlike a query string, which would be written
  // into every one of them.
  //
  // It is read once, immediately erased from the address bar, and then held
  // only in memory. Erasing it before anything else loads means it is gone
  // before analytics initialises, before any third-party script can read
  // location.href, and before any request this page makes can carry it in a
  // Referer header.
  window.__claimToken = null;
  (function captureClaimToken() {
    var hash = window.location.hash || '';
    var match = hash.match(/(?:^#|&)token=([^&]+)/);
    if (!match) return;
    window.__claimToken = decodeURIComponent(match[1]);
    // replaceState rather than assigning location.hash: no new history entry,
    // and nothing left behind for the back button to restore.
    window.history.replaceState({}, document.title, window.location.pathname);
  })();
