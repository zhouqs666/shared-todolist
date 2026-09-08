export default function StatsBar({ todos }) {
  const total = todos.length;
  const completed = todos.filter((t) => t.completed).length;
  const active = total - completed;

  return (
    <div className="stats" data-testid="stats">
      <div className="stat" data-testid="stat-total">
        <span className="stat-value">{total}</span>
        <span className="stat-label">全部</span>
      </div>
      <div className="stat" data-testid="stat-active">
        <span className="stat-value">{active}</span>
        <span className="stat-label">进行中</span>
      </div>
      <div className="stat" data-testid="stat-completed">
        <span className="stat-value">{completed}</span>
        <span className="stat-label">已完成</span>
      </div>
    </div>
  );
}
