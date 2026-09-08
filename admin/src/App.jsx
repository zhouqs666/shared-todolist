import { useAuth } from './auth/AuthContext.jsx';
import LoginPage from './components/LoginPage.jsx';
import Dashboard from './components/Dashboard.jsx';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="app-loading" data-testid="app-loading">
        加载中…
      </div>
    );
  }

  return user ? <Dashboard user={user} /> : <LoginPage />;
}
