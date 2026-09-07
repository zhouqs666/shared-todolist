/**
 * 回收站模块（软删除的 UI 层）
 *
 * 从顶栏头像长按 → 账号菜单 → 「回收站」进入。
 * 展示所有已软删除（deleted_at 非空）的待办，支持：
 *   - 恢复：deleted_at 置 null，回到主列表
 *   - 永久删除：物理 DELETE + 清理图片 Storage（两段式确认防误触）
 *
 * 依赖注入（app.js 传入，避免本模块耦合 db/state）：
 *   - listDeleted(): Promise<todo[]>  拉取已删除列表
 *   - restoreTodo(id): Promise<todo>  恢复
 *   - forceDeleteTodo(id): Promise    永久删除
 *   - displayOf(userId): {name}        创建者显示名
 *   - onRestored(todo): 恢复成功后的回调（app.js 刷新主列表）
 */

import { showToast } from './toast.js';
import { formatRelativeTime } from './utils.js';

let deps = null;
let overlay = null;

/** 初始化回收站依赖 */
export function initTrash(d) {
  deps = d;
}

/** 打开回收站弹层 */
export function openTrash() {
  if (!deps) return;
  closeTrash();

  overlay = document.createElement('div');
  overlay.className = 'action-sheet__overlay action-sheet__overlay--show';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', '回收站');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTrash(); });

  const sheet = document.createElement('div');
  sheet.className = 'trash-sheet';

  // 头部：标题 + 关闭
  const header = document.createElement('div');
  header.className = 'trash-sheet__header';
  const title = document.createElement('h2');
  title.className = 'trash-sheet__title';
  title.textContent = '回收站';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'trash-sheet__close';
  close.setAttribute('aria-label', '关闭');
  close.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  close.addEventListener('click', closeTrash);
  header.appendChild(title);
  header.appendChild(close);
  sheet.appendChild(header);

  // 列表区
  const body = document.createElement('div');
  body.className = 'trash-sheet__body';
  body.innerHTML = '<div class="trash-sheet__loading">加载中…</div>';
  sheet.appendChild(body);

  // 底部提示
  const footer = document.createElement('div');
  footer.className = 'trash-sheet__footer';
  footer.textContent = '删除的待办会在这里保留，可随时恢复';
  sheet.appendChild(footer);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('action-sheet__overlay--show'));

  loadTrash(body);
}

/** 关闭回收站弹层 */
export function closeTrash() {
  if (!overlay) return;
  const el = overlay;
  overlay = null;
  el.classList.remove('action-sheet__overlay--show');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
}

/** 拉取并渲染已删除列表 */
async function loadTrash(body) {
  try {
    const items = await deps.listDeleted();
    renderTrash(body, items);
  } catch (err) {
    body.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'trash-sheet__empty';
    empty.textContent = '加载失败，请重试';
    body.appendChild(empty);
    console.error('[trash] 加载回收站失败:', err.message);
  }
}

/** 渲染回收站列表 */
function renderTrash(body, items) {
  body.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'trash-sheet__empty';
    empty.textContent = '回收站是空的';
    body.appendChild(empty);
    return;
  }

  items.forEach((todo) => {
    body.appendChild(renderTrashItem(body, todo));
  });
}

/** 渲染单条回收站条目 */
function renderTrashItem(body, todo) {
  const item = document.createElement('div');
  item.className = 'trash-item';

  // 文本
  const text = document.createElement('div');
  text.className = 'trash-item__text';
  text.textContent = todo.text;
  item.appendChild(text);

  // 元信息：创建者 + 删除时间
  const meta = document.createElement('div');
  meta.className = 'trash-item__meta';
  const creator = deps.displayOf ? deps.displayOf(todo.createdBy).name : '';
  meta.textContent = [creator, todo.deletedAt ? (formatRelativeTime(todo.deletedAt) + '删除') : ''].filter(Boolean).join(' · ');
  item.appendChild(meta);

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'trash-item__actions';

  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'trash-item__btn trash-item__btn--restore';
  restoreBtn.textContent = '恢复';
  restoreBtn.addEventListener('click', async () => {
    restoreBtn.disabled = true;
    try {
      const restored = await deps.restoreTodo(todo.id);
      item.classList.add('trash-item--leaving');
      setTimeout(() => item.remove(), 180);
      showToast('已恢复');
      if (deps.onRestored) deps.onRestored(restored);
      // 若恢复后列表空了，显示空状态
      if (!body.querySelector('.trash-item')) {
        renderTrash(body, []);
      }
    } catch (err) {
      restoreBtn.disabled = false;
      showToast('恢复失败，请重试');
      console.error('[trash] 恢复失败:', err.message);
    }
  });
  actions.appendChild(restoreBtn);

  const purgeBtn = document.createElement('button');
  purgeBtn.type = 'button';
  purgeBtn.className = 'trash-item__btn trash-item__btn--purge';
  purgeBtn.textContent = '彻底删除';
  let purgeArmed = false;
  let purgeArmTimer = null;
  purgeBtn.addEventListener('click', async () => {
    // 两段式确认：第一次点击变「确认删除？」，3 秒内再点才真正执行
    if (!purgeArmed) {
      purgeArmed = true;
      purgeBtn.textContent = '确认删除？';
      purgeBtn.classList.add('trash-item__btn--armed');
      purgeArmTimer = setTimeout(() => {
        purgeArmed = false;
        purgeBtn.textContent = '彻底删除';
        purgeBtn.classList.remove('trash-item__btn--armed');
      }, 3000);
      return;
    }
    clearTimeout(purgeArmTimer);
    purgeBtn.disabled = true;
    purgeBtn.textContent = '删除中…';
    try {
      await deps.forceDeleteTodo(todo.id);
      item.classList.add('trash-item--leaving');
      setTimeout(() => item.remove(), 180);
      showToast('已彻底删除');
      if (!body.querySelector('.trash-item')) {
        renderTrash(body, []);
      }
    } catch (err) {
      purgeBtn.disabled = false;
      purgeBtn.textContent = '彻底删除';
      purgeBtn.classList.remove('trash-item__btn--armed');
      showToast('删除失败，请重试');
      console.error('[trash] 彻底删除失败:', err.message);
    }
  });
  actions.appendChild(purgeBtn);

  item.appendChild(actions);
  return item;
}
