function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}

export default function TodoItem({ todo, onDelete }) {
  return (
    <li
      className={`todo-item${todo.completed ? ' is-completed' : ''}`}
      data-testid="todo-item"
    >
      <span className="todo-status" data-testid="todo-status">
        {todo.completed ? '已完成' : '进行中'}
      </span>
      <span className="todo-text" data-testid="todo-text">
        {todo.text}
      </span>
      <span className="todo-time" data-testid="todo-time">
        {formatTime(todo.created_at)}
      </span>
      <button
        type="button"
        className="btn btn-danger"
        data-testid="todo-delete-button"
        onClick={() => onDelete(todo)}
        aria-label={`删除待办：${todo.text}`}
      >
        删除
      </button>
    </li>
  );
}
