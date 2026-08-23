
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    document.getElementById('error').textContent = t('resetpassword.missingToken');
    document.getElementById('error').classList.add('show');
    document.getElementById('reset-form').querySelector('button').disabled = true;
  }

  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    errorEl.classList.remove('show');
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password: document.getElementById('password').value }),
      });
      document.getElementById('reset-form').classList.add('is-hidden');
      document.getElementById('success-card').classList.remove('is-hidden');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    }
  });
