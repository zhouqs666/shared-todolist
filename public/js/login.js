/**
 * 登录页交互
 */
(function init() {
  const form = document.getElementById('loginForm');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const errorEl = document.getElementById('errorMsg');
  const submitBtn = document.getElementById('submitBtn');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showError('请输入用户名和密码');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '登录中...';

    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json();

      if (!data.ok) {
        // PRD §4.2 F-01：统一返回「用户名或密码错误」
        showError('用户名或密码错误');
        passwordInput.value = '';
        passwordInput.focus();
        return;
      }

      // 登录成功，跳主页
      window.location.href = '/';
    } catch (err) {
      console.error('[login] error:', err);
      showError('网络异常，请稍后重试');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '登录';
    }
  });

  // 输入时清掉错误提示
  [usernameInput, passwordInput].forEach((el) => {
    el.addEventListener('input', clearError);
  });

  // 自动聚焦用户名
  usernameInput.focus();
})();
