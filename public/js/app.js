/**
 * 主页入口
 * M2：登录态、退出
 * M3：待办 CRUD
 * M4：实时同步（Socket.IO）
 */

import { api, ApiError } from './api.js';
import { formatRelativeTime, playDing } from './utils.js';
import {
  getTodos,
  setTodos,
  sortTodos,
  setRenderFn,
  setOnlineFn,
  setCompleteFn,
  notifyCompleted,
} from './state.js';
import { initSocket } from './socket.js';
import { initTheme, isFxEnabled } from './theme.js';
import confetti from './vendor/canvas-confetti.esm.min.js';

let currentUser = null;

const meEl = document.getElementById('me');
const logoutBtn = document.getElementById('logoutBtn');
const todoInput = document.getElementById('todoInput');
const addBtn = document.getElementById('addBtn');
const todoListEl = document.getElementById('todoList');
const offlineBar = document.getElementById('offlineBar');
const loadingBar = document.getElementById('loadingBar');

// ===== 加载进度条 =====
let loadingTimer = null;
function showLoading() {
  clearTimeout(loadingTimer);
  loadingBar.classList.remove('loading-bar--done');
  loadingBar.classList.add('loading-bar--active');
}
function hideLoading() {
  loadingBar.classList.remove('loading-bar--active');
  loadingBar.classList.add('loading-bar--done');
  loadingTimer = setTimeout(() => {
    loadingBar.classList.remove('loading-bar--done');
  }, 600);
}

// ===== 启动 =====
(async function init() {
  try {
    const resp = await fetch('/api/me');
    const data = await resp.json();
    if (!data.ok) {
      window.location.href = '/login';
      return;
    }
    currentUser = data.user;
    meEl.textContent = currentUser.displayName;
    meEl.classList.remove('topbar__me--placeholder');
  } catch (err) {
    console.error('[app] 获取用户信息失败:', err);
    meEl.textContent = '加载失败';
    return;
  }

  // 注册渲染与状态回调
  setRenderFn(render);
  setOnlineFn(updateOnlineUI);
  setCompleteFn(handleRemoteCompleted);

  // 启用输入区
  todoInput.disabled = false;
  addBtn.disabled = false;

  bindEvents();

  // 先拉一次列表（兜底，socket 连上后会用 todo:sync 全量覆盖）
  try {
    const { todos } = await api.listTodos();
    setTodos(sortTodos(todos));
  } catch (err) {
    handleError(err, '加载列表失败');
    render(getTodos());
  }

  // 初始化主题选择器
  initTheme();

  // 建立 socket 连接
  initSocket({
    getTodos,
    setTodos,
    setOnline: updateOnlineUI,
    notifyCompleted,
  });
})();

// ===== 事件绑定 =====
function bindEvents() {
  logoutBtn.addEventListener('click', logout);

  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTodo();
    }
  });
  addBtn.addEventListener('click', addTodo);
}

async function logout() {
  logoutBtn.disabled = true;
  logoutBtn.textContent = '退出中...';
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    console.error('[app] 退出失败:', err);
  } finally {
    window.location.href = '/login';
  }
}

// ===== 业务逻辑 =====
async function addTodo() {
  const text = todoInput.value.trim();
  if (!text) return;

  addBtn.disabled = true;
  todoInput.disabled = true;
  addBtn.classList.add('composer__btn--loading');
  showLoading();
  try {
    const { todo } = await api.createTodo(text);
    // socket 可能已经先把 todo 加进来了（广播快于 HTTP 响应），幂等处理
    const existing = getTodos();
    if (!existing.some((t) => t.id === todo.id)) {
      setTodos(sortTodos([...existing, todo]));
    }
    todoInput.value = '';
  } catch (err) {
    handleError(err, '添加失败');
  } finally {
    todoInput.disabled = false;
    addBtn.disabled = false;
    addBtn.classList.remove('composer__btn--loading');
    hideLoading();
    todoInput.focus();
  }
}

async function toggleComplete(id, nextCompleted) {
  const current = getTodos().find((t) => t.id === id);
  if (!current || current.completed === nextCompleted) return; // 幂等

  const prev = { ...current };
  Object.assign(current, {
    completed: nextCompleted,
    completedBy: nextCompleted ? currentUser.id : null,
    completedAt: nextCompleted ? new Date().toISOString() : null,
  });
  setTodos(sortTodos(getTodos()));
  // 本端完成 → 庆祝动画
  if (nextCompleted) celebrateCompletion(current.text);
  try {
    const { todo } = await api.updateTodo(id, nextCompleted);
    setTodos(sortTodos(getTodos().map((t) => (t.id === id ? todo : t))));
  } catch (err) {
    // 回滚
    const target = getTodos().find((t) => t.id === id);
    if (target) Object.assign(target, prev);
    setTodos(sortTodos(getTodos()));
    handleError(err, '操作失败');
  }
}

async function deleteTodo(id) {
  const target = getTodos().find((t) => t.id === id);
  if (!target) return;
  if (!confirm(`确定删除「${target.text}」？`)) return;

  // 先播放退出动画，再实际从 state 移除
  const liEl = todoListEl.querySelector(`[data-id="${id}"]`);
  if (liEl) {
    liEl.classList.add('todo--leaving');
    await new Promise((r) => setTimeout(r, 200));
  }
  setTodos(getTodos().filter((t) => t.id !== id));
  try {
    await api.deleteTodo(id);
  } catch (err) {
    setTodos(sortTodos([...getTodos(), target])); // 回滚
    handleError(err, '删除失败');
  }
}

// ===== 渲染 =====
function render() {
  const todos = getTodos();
  if (todos.length === 0) {
    todoListEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'todo-list__empty';
    const emoji = document.createElement('div');
    emoji.className = 'todo-list__empty-emoji';
    emoji.textContent = '🎉';
    const text = document.createElement('div');
    text.className = 'todo-list__empty-text';
    text.textContent = '暂无待办，添加第一条吧～';
    li.appendChild(emoji);
    li.appendChild(text);
    todoListEl.appendChild(li);
    updateCounter();
    return;
  }

  todoListEl.innerHTML = '';
  todos.forEach((todo) => {
    todoListEl.appendChild(renderItem(todo));
  });
  updateCounter();
}

/**
 * 更新今日完成计数器
 * 统计 completedAt 在今天的任务数
 */
function updateCounter() {
  const el = document.getElementById('completedToday');
  if (!el) return;
  const today = new Date().toDateString();
  const count = getTodos().filter(
    (t) =>
      t.completed &&
      t.completedAt &&
      new Date(t.completedAt).toDateString() === today
  ).length;
  el.textContent = '✓ ' + count;
  el.hidden = count === 0;
}

/**
 * 完成庆祝（彩带 + 音效 + 震动 + Toast）
 * 仅当特效开关开启时执行彩带/音效/震动；Toast 始终显示
 */
function celebrateCompletion(todoText) {
  // Toast 始终显示（不带特效也是一种反馈）
  showToast('✓ ' + (todoText || '完成').slice(0, 30));

  if (!isFxEnabled()) return;

  // 彩带（使用主题色）
  const rootStyle = getComputedStyle(document.documentElement);
  const primary = rootStyle.getPropertyValue('--color-primary').trim() || '#10b981';
  confetti({
    particleCount: 80,
    spread: 70,
    origin: { y: 0.6 },
    colors: [primary, '#fbbf24', '#f87171', '#60a5fa', '#fff'],
    scalar: 0.9,
    ticks: 150,
  });

  // 音效
  playDing();

  // 手机震动
  if (navigator.vibrate) {
    try {
      navigator.vibrate([30, 20, 30]);
    } catch (_) {}
  }
}

/**
 * 远端完成回调：对方完成了任务，本端也庆祝
 * @param {Object} todo 完成后的 todo
 */
function handleRemoteCompleted(todo) {
  if (!todo || !todo.completed) return;
  celebrateCompletion('对方完成了「' + (todo.text || '') + '」');
}

function renderItem(todo) {
  const li = document.createElement('li');
  li.className = 'todo' + (todo.completed ? ' todo--done' : '');
  li.dataset.id = todo.id;

  // checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'todo__checkbox';
  checkbox.checked = todo.completed;
  checkbox.addEventListener('change', () => {
    toggleComplete(todo.id, checkbox.checked);
  });

  // 文本与元信息
  const body = document.createElement('div');
  body.className = 'todo__body';

  const textEl = document.createElement('div');
  textEl.className = 'todo__text';
  textEl.textContent = todo.text; // textContent 防注入

  const metaEl = document.createElement('div');
  metaEl.className = 'todo__meta';
  const creatorName = displayOf(todo.createdBy);
  let meta = `${creatorName} · ${formatRelativeTime(todo.createdAt)}`;
  if (todo.completed) {
    meta += ` · ${displayOf(todo.completedBy)}完成`;
  }
  metaEl.textContent = meta;

  body.appendChild(textEl);
  body.appendChild(metaEl);

  // 删除按钮
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'todo__delete';
  delBtn.title = '删除';
  delBtn.setAttribute('aria-label', '删除');
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', () => deleteTodo(todo.id));

  li.appendChild(checkbox);
  li.appendChild(body);
  li.appendChild(delBtn);
  return li;
}

function displayOf(userId) {
  if (!userId) return '?';
  if (userId === currentUser.id) return currentUser.displayName;
  // 双人场景：不是自己就是对方
  return currentUser.id === 'u_a' ? 'Bob' : 'Alice';
}

// ===== UI 状态 =====
function updateOnlineUI(online) {
  if (!offlineBar) return;
  offlineBar.hidden = online;
}

function handleError(err, fallback) {
  console.error('[app] error:', err);
  let msg = fallback;
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK') msg = '网络异常，请稍后重试';
    else if (err.code === 'TOO_LONG') msg = '内容太长（最多 200 字）';
    else if (err.code === 'INVALID_INPUT') msg = '内容不能为空';
  }
  showToast(msg);
}

let toastTimer = null;
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('toast--show'), 2500);
}
