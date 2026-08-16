  const redirectTo = safeRedirect(new URLSearchParams(window.location.search).get('redirect')) || '/index.html';
  NaseebDom.setHref(
    document.getElementById('signup-link'),
    '/signup.html?redirect=' + encodeURIComponent(redirectTo)
  );

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    errorEl.classList.remove('show');
    try {
      // The response carries no session token — the server set an HttpOnly
      // cookie this page cannot read. What comes back is who you are and the
      // CSRF token to send with future writes, both held in memory only.
      const result = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });
      adoptSession(result);
      // Validated once when it was read out of the query string, and validated
      // again by navigate() before the browser is sent anywhere.
      if (!NaseebDom.navigate(redirectTo)) NaseebDom.navigate('/index.html');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });
