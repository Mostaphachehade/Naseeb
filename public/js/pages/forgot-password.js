  document.getElementById('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('error');
    const successEl = document.getElementById('success');
    errorEl.classList.remove('show');
    successEl.classList.remove('show');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const { message } = await api('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: document.getElementById('email').value }),
      });
      successEl.textContent = message;
      successEl.classList.add('show');
      e.target.reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('show');
    } finally {
      btn.disabled = false;
    }
  });
