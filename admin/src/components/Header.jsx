import { useAuth } from '../auth/AuthContext.jsx';

export default function Header({ user }) {
  const { logout } = useAuth();
  const name =
    user?.user_metadata?.display_name ||
    user?.user_metadata?.username ||
    user?.email ||
    '用户';

  return (
    <header className="header" data-testid="header">
      <h1 className="app-title" data-testid="app-title">
        有爱待办 · 管理后台
      </h1>
      <div className="header-right">
        <span className="current-user" data-testid="current-user">
          {name}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="logout-button"
          onClick={logout}
        >
          退出登录
        </button>
      </div>
    </header>
  );
}
