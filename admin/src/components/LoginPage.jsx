import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(username, password);
      // 登录成功后由 AuthContext 的 onAuthStateChange 自动切到 Dashboard
    } catch (err) {
      setError(err.message || '登录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page" data-testid="login-page">
      <form className="login-form" data-testid="login-form" onSubmit={handleSubmit}>
        <h1 className="login-title">有爱待办 · 管理后台</h1>
        <p className="login-subtitle">登录后可查看和管理待办数据</p>

        <label className="field">
          <span className="field-label">账号</span>
          <input
            type="text"
            data-testid="login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名（小宝宝 / 大宝贝）"
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span className="field-label">密码</span>
          <input
            type="password"
            data-testid="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <p className="login-error" data-testid="login-error" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          data-testid="login-submit"
          disabled={submitting}
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
