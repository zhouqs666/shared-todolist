export default function SearchBar({ keyword, onChange }) {
  return (
    <div className="search-bar" data-testid="search-bar">
      <input
        type="search"
        className="search-input"
        data-testid="search-input"
        placeholder="搜索待办内容…"
        value={keyword}
        onChange={(e) => onChange(e.target.value)}
        aria-label="搜索待办"
      />
      {keyword && (
        <button
          type="button"
          className="search-clear"
          data-testid="search-clear"
          onClick={() => onChange('')}
          aria-label="清空搜索"
        >
          ×
        </button>
      )}
    </div>
  );
}
