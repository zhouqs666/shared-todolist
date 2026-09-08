import TodoItem from './TodoItem.jsx';

export default function TodoList({ todos, total, loading, error, onDelete }) {
  if (loading) {
    return (
      <p className="list-hint" data-testid="todo-loading">
        加载中…
      </p>
    );
  }
  if (error) {
    return (
      <p className="list-error" data-testid="todo-error" role="alert">
        {error}
      </p>
    );
  }
  if (todos.length === 0) {
    return (
      <p className="list-hint" data-testid="todo-empty">
        {total === 0 ? '暂无待办' : '没有匹配的待办'}
      </p>
    );
  }
  return (
    <ul className="todo-list" data-testid="todo-list">
      {todos.map((todo) => (
        <TodoItem key={todo.id} todo={todo} onDelete={onDelete} />
      ))}
    </ul>
  );
}
