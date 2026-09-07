/**
 * 登录页交互（V2 / PWA + Supabase 版）
 * 改用 auth.login() 直连 Supabase Auth，无后端。
 */

import { auth } from './auth.js';

(async function init() {
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

  // 已经登录直接跳主页（避免重复登录）
  try {
    const user = await auth.getCurrentUser();
    if (user) {
      window.location.href = '/';
      return;
    }
  } catch (_) {
    // 忽略，继续显示登录页
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
      await auth.login(username, password);
      // 登录成功，跳主页
      window.location.href = '/';
    } catch (err) {
      console.error('[login] error:', err);
      const msg =
        err?.code === 'INVALID_INPUT' ? err.message :
        err?.code === 'INVALID_CREDENTIALS' ? '用户名或密码错误' :
        err instanceof TypeError ? '网络异常，请检查网络后重试' :
        '登录失败，请稍后重试';
      showError(msg);
      passwordInput.value = '';
      passwordInput.focus();
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
