/**
 * 通用底部 action sheet（待办操作菜单 + 退出确认）
 *
 * 从 app.js 拆出（技术清单第8条：app.js 过长）。本模块负责：
 *   - ICONS：菜单按钮用的 SVG 图标集
 *   - mkIconBtn：构造纯图标按钮的工具
 *   - showTodoMenu / closeTodoMenu：待办操作菜单（编辑/备注/表情/配图/删除）
 *   - showLogoutConfirm / closeLogoutConfirm：退出登录确认条
 *   - bindLongPressLogout：头像长按 800ms 触发退出确认（移动端长按 / 桌面端右键兜底）
 *
 * 依赖注入：
 *   - 表情相关 API 直接 import 自 ./reactions.js（无 app.js 耦合）
 *   - 业务回调（onEdit / onNote / onAddImage / onDelete / onConfirm）通过参数注入
 *   - 不再依赖 app.js 的闭包变量，便于本模块独立演进与测试
 *
 * 行为零变化承诺：与原 app.js 内联实现完全等价（仅迁移 + handler 化）。
 */

import {
  REACTION_EMOJIS,
  isMyReaction,
  getReactionLabel,
  getReactionSvg,
  toggleReaction,
} from './reactions.js';

// ===== 菜单按钮用的 SVG 图标集 =====
// 导出供 app.js 的 renderImage 复用（badge.innerHTML = ICONS.image）
export const ICONS = {
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  undone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  // 图片：相册/相框线性图标（配图入口）
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  // 备注：聊天气泡（完成后的交代/收尾说明，语义=留句话）
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  // 编辑：铅笔（编辑待办文案）
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
};

/** 构造一个图标按钮（纯图标，无文案） */
function mkIconBtn(svgInner, ariaLabel, extraClass = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action-sheet__icon-btn ' + extraClass;
  btn.setAttribute('role', 'menuitem');
  btn.setAttribute('aria-label', ariaLabel);
  btn.innerHTML = svgInner;
  return btn;
}

// ===== 待办操作菜单（双 sheet 之一，互不干涉）=====
let currentActionSheet = null;

/**
 * 显示待办操作菜单（底部 action sheet 风格）
 * @param {Object} todo 待办对象
 * @param {Object} handlers 业务回调（app.js 注入，避免本模块直接耦合业务层）
 * @param {()=>Array} handlers.getTodos 拿最新 todo 列表（菜单打开时取最新版本）
 * @param {(todo)=>void} [handlers.onEdit] 编辑文案
 * @param {(todo)=>void} [handlers.onNote] 编辑备注
 * @param {(todoId:string, prevPaths:string[])=>void} [handlers.onAddImage] 配图/加图
 * @param {(todoId:string)=>void} [handlers.onDelete] 删除
 */
export function showTodoMenu(todo, handlers = {}) {
  // 关掉已存在的菜单
  closeTodoMenu();
  // 关键：从 state 取最新 todo，而非闭包里的旧引用。
  // 避免完成状态变化后，菜单仍按旧状态显示选项。
  if (handlers.getTodos) {
    const latest = handlers.getTodos().find((t) => t.id === todo.id);
    if (latest) todo = latest;
  }

  // 遮罩层（只有点遮罩空白处才关闭；菜单内按钮的点击会冒泡上来，不能一并关闭，
  // 否则"表情可连点"永远失效——点第一个表情菜单就没了）
  const overlay = document.createElement('div');
  overlay.className = 'action-sheet__overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTodoMenu(); });

  // 菜单容器
  const sheet = document.createElement('div');
  sheet.className = 'action-sheet';
  sheet.setAttribute('role', 'menu');

  // 待办文案预览
  const preview = document.createElement('div');
  preview.className = 'action-sheet__preview';
  preview.textContent = todo.text;
  sheet.appendChild(preview);

  // 图标按钮组（横向排列，无文案，aria-label 保留无障碍说明）
  const actions = document.createElement('div');
  actions.className = 'action-sheet__actions';

  // 取消完成（历史页回流入口）：仅当调用方提供 onUncomplete 时显示（历史列表项）。
  // 置顶显示，作为该场景的主操作。
  if (handlers.onUncomplete) {
    const undoneBtn = mkIconBtn(ICONS.undone, '取消完成', 'action-sheet__icon-btn--accent');
    undoneBtn.addEventListener('click', () => {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      closeTodoMenu();
      if (handlers.onUncomplete) handlers.onUncomplete(todo.id);
    });
    actions.appendChild(undoneBtn);
  }

  // 编辑待办文案（改文字内容，不动 completed/created_by 等其他字段）
  const editBtn = mkIconBtn(ICONS.edit, '编辑');
  editBtn.addEventListener('click', () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeTodoMenu();
    if (handlers.onEdit) handlers.onEdit(todo);
  });
  actions.appendChild(editBtn);

  // 备注（完成前后均可加：未完成时可留交代/叮嘱，完成后可留收尾说明）
  // 完成动作本身由复选框承担（点对勾=完成），菜单里不再放完成按钮，避免冗余入口
  {
    const hasNote = !!todo.completedNote;
    const noteBtn = mkIconBtn(ICONS.note, hasNote ? '修改备注' : '加备注', hasNote ? 'action-sheet__icon-btn--active' : '');
    noteBtn.addEventListener('click', () => {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      closeTodoMenu();
      if (handlers.onNote) handlers.onNote(todo);
    });
    actions.appendChild(noteBtn);
  }

  // 表情回应（仅已完成：三个表情，可连点）
  if (todo.completed) {
    REACTION_EMOJIS.forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-sheet__icon-btn action-sheet__icon-btn--reaction' + (isMyReaction(todo.id, key) ? ' action-sheet__icon-btn--mine' : '');
      btn.setAttribute('aria-label', getReactionLabel(key));
      btn.innerHTML = getReactionSvg(key);
      btn.addEventListener('click', () => {
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
        // 状态在点击时实时查（菜单开着连点时，打开时的快照早已过期）
        const mine = isMyReaction(todo.id, key);
        toggleReaction(todo.id, key);
        btn.classList.toggle('action-sheet__icon-btn--mine', !mine);
      });
      actions.appendChild(btn);
    });
  }

  // 配图 / 加图（唯一的图片入口；删图/换图都收敛在 lightbox 里——"看图的地方就是操作图的地方"）
  const hasImage = !!(todo.imagePaths && todo.imagePaths.length);
  const imageBtn = mkIconBtn(ICONS.image, hasImage ? '加图' : '配图', hasImage ? 'action-sheet__icon-btn--active' : '');
  imageBtn.addEventListener('click', async () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeTodoMenu();
    if (handlers.onAddImage) await handlers.onAddImage(todo.id, todo.imagePaths);
  });
  actions.appendChild(imageBtn);

  // 删除（垃圾桶，rose 危险色）
  const delBtn = mkIconBtn(ICONS.trash, '删除', 'action-sheet__icon-btn--danger');
  delBtn.addEventListener('click', () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeTodoMenu();
    if (handlers.onDelete) handlers.onDelete(todo.id);
  });
  actions.appendChild(delBtn);

  sheet.appendChild(actions);

  // 关闭按钮（底部）
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'action-sheet__close';
  closeBtn.textContent = '取消';
  closeBtn.addEventListener('click', closeTodoMenu);
  sheet.appendChild(closeBtn);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  // 下一帧触发动画
  requestAnimationFrame(() => overlay.classList.add('action-sheet__overlay--show'));

  // 存引用便于关闭
  currentActionSheet = overlay;
}

/** 关闭待办操作菜单 */
export function closeTodoMenu() {
  if (!currentActionSheet) return;
  const el = currentActionSheet;
  currentActionSheet = null;
  el.classList.remove('action-sheet__overlay--show');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
}

// ===== 退出登录确认（双 sheet 之二，互不干涉）=====
let currentLogoutSheet = null;

/**
 * 显示退出确认 action sheet
 * @param {()=>void} onConfirm 用户确认退出时的回调（app.js 传入 logout）
 */
export function showLogoutConfirm(onConfirm) {
  // 关掉已存在的
  closeLogoutConfirm();
  const overlay = document.createElement('div');
  overlay.className = 'action-sheet__overlay';
  overlay.addEventListener('click', closeLogoutConfirm);
  const sheet = document.createElement('div');
  sheet.className = 'action-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', '确认退出');

  const preview = document.createElement('div');
  preview.className = 'action-sheet__preview';
  preview.textContent = '要退出登录吗？';
  sheet.appendChild(preview);

  const actions = document.createElement('div');
  actions.className = 'action-sheet__actions';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'action-sheet__icon-btn action-sheet__icon-btn--danger';
  confirmBtn.setAttribute('aria-label', '确认退出');
  confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
  confirmBtn.addEventListener('click', () => { closeLogoutConfirm(); if (onConfirm) onConfirm(); });
  actions.appendChild(confirmBtn);
  sheet.appendChild(actions);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'action-sheet__close';
  closeBtn.textContent = '取消';
  closeBtn.addEventListener('click', closeLogoutConfirm);
  sheet.appendChild(closeBtn);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('action-sheet__overlay--show'));
  currentLogoutSheet = overlay;
}

/** 关闭退出确认条 */
export function closeLogoutConfirm() {
  if (!currentLogoutSheet) return;
  const el = currentLogoutSheet;
  currentLogoutSheet = null;
  el.classList.remove('action-sheet__overlay--show');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
}

// ===== 账号菜单（头像长按：回收站 + 退出登录）=====
let currentAccountSheet = null;

/**
 * 显示账号菜单（头像长按触发，替代直接弹退出确认）。
 * @param {Object} handlers 回调：{ onOpenTrash, onLogout }
 */
export function showAccountMenu(handlers = {}) {
  closeAccountMenu();
  closeLogoutConfirm();

  const overlay = document.createElement('div');
  overlay.className = 'action-sheet__overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAccountMenu(); });

  const sheet = document.createElement('div');
  sheet.className = 'action-sheet';
  sheet.setAttribute('role', 'menu');
  sheet.setAttribute('aria-label', '账号菜单');

  const preview = document.createElement('div');
  preview.className = 'action-sheet__preview';
  preview.textContent = '更多';
  sheet.appendChild(preview);

  const list = document.createElement('div');
  list.className = 'account-menu';

  // 回收站入口
  const trashBtn = document.createElement('button');
  trashBtn.type = 'button';
  trashBtn.className = 'account-menu__item';
  trashBtn.innerHTML = '<span class="account-menu__icon">' + ICONS.trash + '</span><span class="account-menu__label">回收站</span>';
  trashBtn.addEventListener('click', () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeAccountMenu();
    if (handlers.onOpenTrash) handlers.onOpenTrash();
  });
  list.appendChild(trashBtn);

  // 退出登录
  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'account-menu__item account-menu__item--danger';
  logoutBtn.innerHTML = '<span class="account-menu__icon">'
    + '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
    + '</span><span class="account-menu__label">退出登录</span>';
  logoutBtn.addEventListener('click', () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeAccountMenu();
    if (handlers.onLogout) handlers.onLogout();
  });
  list.appendChild(logoutBtn);

  sheet.appendChild(list);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'action-sheet__close';
  closeBtn.textContent = '取消';
  closeBtn.addEventListener('click', closeAccountMenu);
  sheet.appendChild(closeBtn);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('action-sheet__overlay--show'));
  currentAccountSheet = overlay;
}

/** 关闭账号菜单 */
export function closeAccountMenu() {
  if (!currentAccountSheet) return;
  const el = currentAccountSheet;
  currentAccountSheet = null;
  el.classList.remove('action-sheet__overlay--show');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
}

/**
 * 给头像绑定长按退出（移动端长按 800ms / 桌面端右键兜底）。
 * 按住时头像轻微缩放做"按压感"，到时触发确认条。
 * @param {HTMLElement} img 头像 img 元素
 * @param {()=>void} onLongPress 长按/右键触发的回调（app.js 注入，通常为 () => showLogoutConfirm(logout)）
 */
export function bindLongPressLogout(img, onLongPress) {
  let pressTimer = null;
  const PRESS_MS = 800;
  const startPress = () => {
    img.classList.add('topbar__avatar--pressing');
    pressTimer = setTimeout(() => {
      pressTimer = null;
      img.classList.remove('topbar__avatar--pressing');
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
      if (onLongPress) onLongPress();
    }, PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    img.classList.remove('topbar__avatar--pressing');
  };
  img.addEventListener('touchstart', startPress, { passive: true });
  img.addEventListener('touchmove', cancelPress, { passive: true });
  img.addEventListener('touchend', cancelPress);
  img.addEventListener('touchcancel', cancelPress);
  // 桌面端：右键兜底（无长按手势时）
  img.addEventListener('contextmenu', (e) => { e.preventDefault(); if (onLongPress) onLongPress(); });
}
