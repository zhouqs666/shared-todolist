export default function ConfirmDialog({ todo, deleting, onCancel, onConfirm }) {
  return (
    <div className="dialog-overlay" data-testid="confirm-dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        data-testid="confirm-dialog"
      >
        <h2 className="dialog-title">确认删除</h2>
        <p className="dialog-message" data-testid="confirm-dialog-message">
          确定删除待办「{todo.text}」吗？此操作将移入回收站（软删除，可恢复）。
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="cancel-delete-button"
            onClick={onCancel}
            disabled={deleting}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-testid="confirm-delete-button"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}
