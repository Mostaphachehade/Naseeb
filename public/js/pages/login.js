  const redirectTo = safeRedirect(new URLSearchParams(window.location.search).get('redirect')) || '/index.html';
  document.getElementById('signup-link').href = `/signup.html?redirect=${encodeURIComponent(redirectTo)}`;

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
      window.location.href = redirectTo;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });
