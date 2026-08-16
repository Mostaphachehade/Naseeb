  const redirectTo = safeRedirect(new URLSearchParams(window.location.search).get('redirect')) || '/index.html';
  NaseebDom.setHref(
    document.getElementById('login-link'),
    '/login.html?redirect=' + encodeURIComponent(redirectTo)
  );

  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    errorEl.classList.remove('show');
    try {
      const result = await api('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('name').value,
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
          // Only true counts. The server refuses anything else, so an
          // unticked box cannot become an attestation on the way through.
          age_confirmed: document.getElementById('age_confirmed').checked === true,
        }),
      });
      adoptSession(result);
      if (!NaseebDom.navigate(redirectTo)) NaseebDom.navigate('/index.html');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });
