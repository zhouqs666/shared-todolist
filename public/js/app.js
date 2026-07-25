/**
 * 主页入口（V2 / PWA + Supabase 版）
 *
 * 改造点（相对 V1）：
 *   - 登录态：fetch /api/me → auth.getCurrentUser()（基于 Supabase session）
 *   - 数据访问：api.* → db.*（直连 Supabase，无后端）
 *   - 实时：initSocket → initRealtime（Supabase Realtime postgres_changes）
 *   - 自我回声：服务端不再排除 sender，前端用 id 幂等去重
 *
 * 保留：所有 UI、CSS、动画、主题、state 形状、todo 字段名。
 */

import { db } from './db.js';
import { auth } from './auth.js';
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
import { initRealtime } from './realtime.js';
import { initTheme, isFxEnabled } from './theme.js';
import confetti from './vendor/canvas-confetti.esm.min.js';

let currentUser = null;
/** @type {Object<string, string>} userId → displayName 映射（从 profiles 表拿） */
let userMap = {};

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
  // 主题先初始化（不依赖任何数据/网络，越早越好，避免用户感知延迟）
  initTheme();

  try {
    const user = await auth.getCurrentUser();
    if (!user) {
      window.location.href = '/login.html';
      return;
    }
    currentUser = user;
    renderMe();

    // 构建 userId → {displayName, avatar} 映射（用于 render 时显示创建者/完成者）
    try {
      const profiles = await db.listProfiles();
      userMap = {};
      profiles.forEach((p) => {
        userMap[p.id] = { displayName: p.displayName, avatar: p.avatar };
      });
    } catch (err) {
      console.error('[app] 加载 profiles 失败:', err);
    }
  } catch (err) {
    console.error('[app] 获取用户信息失败:', err);
    meEl.textContent = '加载失败';
    meEl.classList.remove('topbar__me--placeholder');
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

  // 先拉一次列表兜底（弥补 Realtime 订阅期间的 INSERT 事件丢失）
  try {
    const todos = await db.listTodos();
    setTodos(sortTodos(todos));
  } catch (err) {
    handleError(toAppError(err), '加载列表失败');
    render(getTodos());
  }

  // 建立 Realtime 订阅
  initRealtime({
    getTodos,
    setTodos,
    setOnline: updateOnlineUI,
    notifyCompleted,
  });

  // 注册 SW（PWA 离线外壳）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] 注册失败:', err.message);
    });
  }

  // 监听 auth 状态变化（token 失效时自动跳登录）
  auth.onAuthChange((event) => {
    if (event === 'SIGNED_OUT') {
      window.location.href = '/login.html';
    }
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
    await auth.logout();
  } catch (err) {
    console.error('[app] 退出失败:', err);
  } finally {
    window.location.href = '/login.html';
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
    const todo = await db.createTodo(text, currentUser.id);
    // Realtime 也会推回来（幂等去重），这里直接加上不等回声
    setTodos(sortTodos([...getTodos(), todo]));
    todoInput.value = '';
  } catch (err) {
    handleError(toAppError(err), '添加失败');
  } finally {
    todoInput.disabled = false;
    addBtn.disabled = false;
    addBtn.classList.remove('composer__btn--loading');
    hideLoading();
    todoInput.focus();
  }
}

// 每个 id 的"最新意图"：解决连续点击竞态（用户在 API 返回前又改了）
const latestIntent = new Map(); // id → boolean

async function toggleComplete(id, nextCompleted) {
  const current = getTodos().find((t) => t.id === id);
  if (!current || current.completed === nextCompleted) return; // 幂等

  // 记录最新意图——后续如果有更早的 API 响应返回，会被忽略
  latestIntent.set(id, nextCompleted);

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
    const todo = await db.setCompleted(id, nextCompleted, currentUser.id);
    // 竞态保护：如果在 await 期间用户又改了意图，丢弃这个响应
    if (latestIntent.get(id) !== nextCompleted) {
      return; // 已被后续操作覆盖
    }
    setTodos(sortTodos(getTodos().map((t) => (t.id === id ? todo : t))));
  } catch (err) {
    // 回滚（仅在意图未变时）
    if (latestIntent.get(id) === nextCompleted) {
      const target = getTodos().find((t) => t.id === id);
      if (target) Object.assign(target, prev);
      setTodos(sortTodos(getTodos()));
      handleError(toAppError(err), '操作失败');
    }
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
    await db.deleteTodo(id);
  } catch (err) {
    setTodos(sortTodos([...getTodos(), target])); // 回滚
    handleError(toAppError(err), '删除失败');
  }
}

// ===== 顶栏"我"：头像 + 昵称 =====
function renderMe() {
  meEl.classList.remove('topbar__me--placeholder');
  meEl.textContent = '';
  const avatar = currentUser && currentUser.avatar;
  if (avatar) {
    const img = document.createElement('img');
    img.className = 'topbar__avatar';
    img.src = avatar;
    img.alt = '';
    img.onerror = () => img.remove();
    meEl.appendChild(img);
  }
  const name = document.createElement('span');
  name.className = 'topbar__me-name';
  name.textContent = currentUser ? currentUser.displayName : '';
  meEl.appendChild(name);
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

/** 渲染单条（用 DOM API 而非 innerHTML，天然防 XSS） */
function renderItem(todo) {
  const li = document.createElement('li');
  li.className = 'todo' + (todo.completed ? ' todo--done' : '');
  li.dataset.id = todo.id;

  // checkbox：用 change 事件（仅用户交互触发，DOM 重建不会触发）
  // toggleComplete 内有幂等保护，防止重复请求
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
  const creator = displayOf(todo.createdBy);
  const time = formatRelativeTime(todo.createdAt);
  const completer = todo.completed ? displayOf(todo.completedBy) : null;

  if (creator.avatar) {
    const img = document.createElement('img');
    img.className = 'todo__avatar';
    img.src = creator.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    metaEl.appendChild(img);
  } else {
    const dot = document.createElement('span');
    dot.className = 'todo__avatar-dot';
    metaEl.appendChild(dot);
  }

  const metaText = document.createElement('span');
  let meta = `${creator.name} · ${time}`;
  if (completer) meta += ` · ${completer.name}完成`;
  metaText.textContent = meta;
  metaEl.appendChild(metaText);

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

/** 根据 userId 返回 {name, avatar}（从 profiles 表查到，避免硬编码） */
function displayOf(userId) {
  if (!userId) return { name: '?', avatar: null };
  const p = userMap[userId];
  if (!p) return { name: '?', avatar: null };
  return { name: p.displayName, avatar: p.avatar };
}

// ===== UI 状态 =====
function updateOnlineUI(online) {
  if (!offlineBar) return;
  offlineBar.hidden = online;
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
 */
function handleRemoteCompleted(todo) {
  if (!todo || !todo.completed) return;
  celebrateCompletion('对方完成了「' + (todo.text || '') + '」');
}

/**
 * 把 db / auth 抛出的错误规整成统一的 AppError 形态
 * （沿用旧 api.js 的错误码语义：NETWORK / TOO_LONG / INVALID_INPUT）
 */
function toAppError(err) {
  if (!err) return { code: 'UNKNOWN', message: '未知错误' };
  // 已经是包装过的（db.js 抛出的）
  if (err.code) return err;
  // TypeError 通常是 fetch 失败
  if (err instanceof TypeError) return { code: 'NETWORK', message: '网络异常', original: err };
  return { code: 'UNKNOWN', message: err.message || '未知错误', original: err };
}

function handleError(err, fallback) {
  console.error('[app] error:', err);
  let msg = fallback;
  const code = err?.code;
  if (code === 'NETWORK') msg = '网络异常，请稍后重试';
  else if (code === 'TOO_LONG') msg = '内容太长（最多 200 字）';
  else if (code === 'INVALID_INPUT') msg = '内容不能为空';
  else if (code === 'INVALID_CREDENTIALS') msg = '用户名或密码错误';
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
