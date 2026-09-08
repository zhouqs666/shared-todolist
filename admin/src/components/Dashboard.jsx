import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';
import Header from './Header.jsx';
import StatsBar from './StatsBar.jsx';
import SearchBar from './SearchBar.jsx';
import TodoList from './TodoList.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

/**
 * 后台主页：查看待办列表 + 搜索 + 软删除 + 统计。
 * 数据来源：Supabase `todos` 表（过滤软删除 deleted_at IS NULL）。
 */
export default function Dashboard({ user }) {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchTodos = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error } = await supabase
      .from('todos')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) {
      setError('加载待办失败：' + error.message);
      setTodos([]);
    } else {
      setTodos(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const { error } = await supabase
      .from('todos')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', pendingDelete.id);
    setDeleting(false);
    if (error) {
      setError('删除失败：' + error.message);
    } else {
      setTodos((prev) => prev.filter((t) => t.id !== pendingDelete.id));
    }
    setPendingDelete(null);
  }

  const keywordLower = keyword.trim().toLowerCase();
  const filtered = todos.filter((t) =>
    (t.text || '').toLowerCase().includes(keywordLower)
  );

  return (
    <div className="dashboard" data-testid="dashboard">
      <Header user={user} />
      <main className="dashboard-body">
        <StatsBar todos={todos} />
        <SearchBar keyword={keyword} onChange={setKeyword} />
        <TodoList
          todos={filtered}
          total={todos.length}
          loading={loading}
          error={error}
          onDelete={setPendingDelete}
        />
      </main>

      {pendingDelete && (
        <ConfirmDialog
          todo={pendingDelete}
          deleting={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
