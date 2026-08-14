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
  beginToggle,
  endToggle,
  getInFlightIntent,
  getStickers,
  setStickers,
  addOrUpdateSticker,
} from './state.js';
import { initRealtime, initPresence } from './realtime.js';
import { initTheme, isFxEnabled } from './theme.js';
import { initNotify, requestPermission, isNative } from './notify.js';
import { initMessages, onNoteAdded, onNoteRemoved, onNoteUpdated } from './messages.js';
import { initReactions, renderReactions, onReactionAdded, onReactionRemoved, REACTION_EMOJIS, isMyReaction, toggleReaction, getReactionSvg, getReactionLabel } from './reactions.js';
import { pickImage, uploadTodoImage } from './image-utils.js';
import { checkForUpdate, setUpdateSupabase, notifyAppReady, getCurrentBundleInfo } from './update.js';
import confetti from './vendor/canvas-confetti.esm.min.js';
import { supabase } from './supabase.js';
import { showToast } from './toast.js';
import { rollRarity, isHidden, applyRarity, celebrateRarity, onRollRarity, RARITY_META } from './blindbox.js';
import { initStickerBook, handleStickerUnlocked } from './sticker-book.js';

let currentUser = null;
/** @type {Object<string, string>} userId → displayName 映射（从 profiles 表拿） */
let userMap = {};
// 欢迎动画内存锁：同一次页面会话内防止重复播放
let welcomePlaying = false;

const meEl = document.getElementById('me');
const todoInput = document.getElementById('todoInput');
const addBtn = document.getElementById('addBtn');
const todoListEl = document.getElementById('todoList');
const offlineBar = document.getElementById('offlineBar');
const loadingBar = document.getElementById('loadingBar');
const fabBtn = document.getElementById('fabBtn');
const addPanel = document.getElementById('addPanel');
const addOverlay = document.getElementById('addOverlay');
const attachBtn = document.getElementById('attachBtn'); // 添加面板的"预挂图"按钮

// 预挂图：用户在添加面板里选好的图（提交时才上传）。null=无预挂图。
let pendingImage = null;

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

  // 更新完成欢迎动画：检测当前是否热更新 bundle（非 APK 壳内置），
  // 是就播欢迎动画。不依赖 localStorage（bundle 切换时 localStorage 不共享）。
  showUpdateWelcomeIfPending();

  // 热更新检查（仅原生 App 生效，浏览器 no-op）
  setUpdateSupabase(supabase);
  setTimeout(() => {
    checkForUpdate().catch((e) => console.warn('[update] 启动检查异常:', e && e.message));
  }, 1800);

  try {
    const user = await auth.getCurrentUser();
    if (!user) {
      window.location.href = '/login.html';
      return;
    }
    currentUser = user;
    renderMe();

    // 构建 userId → {displayName, avatar, lastSeenAt} 映射
    // lastSeenAt 用于 isPartnerVisitedToday() 判断"对方今天来过"→ 触发开场光晕
    try {
      const profiles = await db.listProfiles();
      userMap = {};
      profiles.forEach((p) => {
        userMap[p.id] = { displayName: p.displayName, avatar: p.avatar, lastSeenAt: p.lastSeenAt };
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

  // 添加待办：FAB 默认可用，面板按需展开
  // 随机一条 placeholder 文案（每次进主页换一条，增加一点小惊喜）
  refreshPlaceholder();

  // 核心交互尽早绑定（不依赖通知初始化，避免用户在通知加载期间点击无响应）
  bindEvents();

  // 初始化本地通知（APP 内弹系统通知；网页降级为 no-op）
  // 必须 await：initNotify 内部加载 Capacitor 脚本并确定 isNative，
  // 后续 SW 注册判断、requestPermission 都依赖它完成
  await initNotify();

  // 隐藏热更新 reload 期间显示的原生 SplashScreen（initNotify 已加载完 vendor 脚本）
  if (isNative && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SplashScreen) {
    window.Capacitor.Plugins.SplashScreen.hide({ fadeOutDuration: 300 }).catch(() => {});
  }
  // 登录成功后申请通知权限（安卓 13+ 需运行时申请）
  requestPermission().then((granted) => {
    if (!granted) console.info('[notify] 通知权限未授予');
  });

  // 初始化「任务表情反应」（必须在 listTodos 渲染前，确保首屏待办就有表情数据）
  await initReactions({
    currentUser,
    onRemoteReaction: pulseTodoOnRemoteReaction,
  });

  // 先拉一次列表兜底（弥补 Realtime 订阅期间的 INSERT 事件丢失）
  try {
    const todos = await db.listTodos();
    setTodos(sortTodos(todos));
  } catch (err) {
    handleError(toAppError(err), '加载列表失败');
    render(getTodos());
  }

  // 拉取图鉴全量（两人共享）+ 初始化图鉴模块（红点/弹层）
  // 容错：stickers 表可能未建（迁移未执行），失败静默，不影响主流程
  try {
    const stickers = await db.listStickers();
    setStickers(stickers);
  } catch (err) {
    console.warn('[app] 图鉴加载失败（已忽略）:', err.message);
  }
  initStickerBook({ onStickerUnlockedView: onStickerUnlockedView });

  // 建立 Realtime 订阅（含 todos / daily_notes / reactions / stickers 四表）
  initRealtime({
    getTodos,
    setTodos,
    setOnline: updateOnlineUI,
    notifyCompleted,
    getCurrentUserId: () => currentUser && currentUser.id,
    displayNameOf: (userId) => displayOf(userId).name,
    onNoteAdded,
    onNoteRemoved,
    onNoteUpdated,
    onReactionAdded,
    onReactionRemoved,
    // 隐藏款揭晓：对方开出的隐藏款首次推来，本端播惊喜提示
    onRarityReveal: handleRarityReveal,
    // 图鉴贴纸解锁：双端同步更新图鉴状态 + 红点 + 撒花
    onStickerUnlocked: handleStickerUnlockedFromRealtime,
    getInFlightIntent, // 完成切换竞态守卫：丢弃与本端意图相反的陈旧回声
  });

  // 初始化「每日留言板」（不阻塞主流程，异步加载）
  initMessages({ currentUser, userMap }).catch((err) =>
    console.error('[app] 留言板初始化失败:', err)
  );

  // 纪念日数字滚动动画：放在 init 末尾 + 延迟，确保开屏已淡出、
  // 用户能看到动画（放太早会被开屏盖住，慢网络下更明显）
  setTimeout(renderAnniversary, 1000);

  // ===== 顶栏爱心"会呼吸"初始化 =====
  // 1. 气色：立刻按当前时间上色 + 每 5 分钟刷新（跨时段自动变）
  applyHeartTint();
  setInterval(applyHeartTint, 5 * 60 * 1000);

  // 找对方的 userId（双人 APP：userMap 里除自己外的那一个）
  const partnerId = Object.keys(userMap).find((id) => id !== currentUser.id) || null;

  // 2. 浮动光点：对方"未读"的打开次数 N → 从爱心飘下 N 个光点，然后清零计数
  //    延迟到开屏淡出后播放，失败静默（是锦上添花，不能影响主流程）
  if (partnerId) {
    setTimeout(async () => {
      try {
        const count = await db.consumePartnerLoginCount(partnerId);
        if (count > 0) floatDots(Math.min(count, 8)); // 最多 8 个，克制
      } catch (e) {
        console.warn('[heart] 浮动光点失败:', e.message);
      }
    }, 1300);
  }

  // 3. 启动 presence（检测双方此刻是否同时在线 → 紧张心跳）
  //    同时维护 last_seen_at 心跳（每 60s 写一次，保证"今天来过"持久记录）
  if (partnerId) {
    try {
      initPresence({
        userId: currentUser.id,
        partnerId,
        onPartnerOnline: setHeartExcited,
      });
    } catch (e) {
      console.warn('[presence] 启动失败:', e.message);
    }
    // last_seen 心跳：立即写一次 + 每 60s 写一次
    db.updateLastSeen(currentUser.id).catch((e) => console.warn('[db] last_seen 写入失败:', e.message));
    setInterval(() => {
      db.updateLastSeen(currentUser.id).catch(() => {});
    }, 60 * 1000);
  }

  // 打开计数 +1：每次冷启动 App 都 +1（不依赖 partnerId，自己的打开次数独立累计）
  // 对方打开 App 时会看到对应次数的光晕，看完清零
  db.incrementLoginCount(currentUser.id).catch(() => {});

  // 注册 SW（PWA 离线外壳）
  // APP（Capacitor WebView）环境跳过：WebView 对 SW 支持不稳定，且资源已打包进 APK
  if (!isNative && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] 注册失败:', err.message);
    });
  }

  // 热更新回滚守卫：App 主体已正常启动（列表+Realtime 都初始化了），
  // 通知插件当前版本可用，避免下次启动被误判为崩溃而回滚
  notifyAppReady();

  // 监听 auth 状态变化（token 失效时自动跳登录）
  auth.onAuthChange((event) => {
    if (event === 'SIGNED_OUT') {
      window.location.href = '/login.html';
    }
  });
})();

// ===== 事件绑定 =====
function bindEvents() {
  // 顶栏桃心点击 → 切换纪念日面板
  const anniHeart = document.getElementById('anniHeart');
  if (anniHeart) {
    anniHeart.addEventListener('click', (e) => { e.stopPropagation(); toggleAnniversaryPanel(); });
    anniHeart.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAnniversaryPanel(); }
    });
  }
  // 点击面板空白处收起
  const anniPanel = document.getElementById('anniPanel');
  if (anniPanel) {
    anniPanel.addEventListener('click', (e) => {
      if (e.target === anniPanel) toggleAnniversaryPanel();
    });
  }

  // FAB 浮动按钮：点开展开式添加面板
  if (fabBtn) {
    fabBtn.addEventListener('click', openAddPanel);
  }
  // 遮罩点击收起
  if (addOverlay) {
    addOverlay.addEventListener('click', closeAddPanel);
  }
  // 输入框：回车提交
  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTodo();
    }
    // ESC 收起
    if (e.key === 'Escape') closeAddPanel();
  });
  addBtn.addEventListener('click', addTodo);
  // 预挂图按钮：选图存入 pendingImage，显示已选角标
  if (attachBtn) {
    attachBtn.addEventListener('click', async () => {
      const file = await pickImage();
      if (!file) return;
      pendingImage = file;
      attachBtn.classList.add('add-panel__attach--has');
    });
  }
}

/** 展开添加面板（从底部上滑） */
function openAddPanel() {
  if (!addPanel || !addOverlay) return;
  addOverlay.classList.add('add-overlay--show');
  addPanel.classList.add('add-panel--show');
  // 软键盘：聚焦输入框（等面板上滑动画启动后）
  setTimeout(() => todoInput.focus(), 200);
}

/** 收起添加面板 */
function closeAddPanel() {
  if (!addPanel || !addOverlay) return;
  addPanel.classList.remove('add-panel--show');
  addOverlay.classList.remove('add-overlay--show');
}

/** 清除预挂图按钮的"已选"角标（pendingImage 由调用方按需清） */
function clearAttachMark() {
  if (attachBtn) attachBtn.classList.remove('add-panel__attach--has');
}

async function logout() {
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
  addBtn.classList.add('add-panel__btn--loading');
  showLoading();
  // 暂存本次提交的预挂图（finally 里统一清状态，但失败时不清 pendingImage 以便重试）
  const imageToUpload = pendingImage;
  try {
    // 隐藏款盲盒：开奖决定本次待办的稀有度（85% 普通，15% 隐藏款）
    const rarity = rollRarity();
    // 先创建待办（拿 id），再上传图片挂到这条上。
    // 文字待办创建成功后，即使图片上传失败也保留待办 + 提示可长按补图。
    const todo = await db.createTodo(text, currentUser.id, null, rarity);
    if (imageToUpload) {
      try {
        const url = await uploadTodoImage(todo.id, imageToUpload);
        await db.setImage(todo.id, url);
        todo.imagePath = url;
      } catch (imgErr) {
        console.error('[app] 图片上传失败（待办已创建）:', imgErr);
        showToast('图片上传失败，可长按待办补图');
      }
    }
    // Realtime 也会推回来（幂等去重），这里直接加上不等回声
    setTodos(sortTodos([...getTodos(), todo]));
    // 隐藏款开奖庆祝：命中隐藏款时 Toast + 高稀有度撒花（待办已渲染，特效叠在卡片上）
    if (isHidden(todo.rarity)) {
      // 稍延迟让卡片先入场动画播完，再叠开奖特效
      setTimeout(() => celebrateRarity(todo.rarity, text), 60);
      // 开出即解锁图鉴贴纸（无需完成）。fire-and-forget，失败静默。
      onRollRarity(todo, currentUser.id).catch((e) =>
        console.warn('[app] 贴纸解锁失败（已忽略）:', e.message)
      );
    }
    todoInput.value = '';
    pendingImage = null; // 提交成功才清预挂图
    clearAttachMark();
    closeAddPanel(); // 提交成功收起面板
  } catch (err) {
    handleError(toAppError(err), '添加失败');
  } finally {
    addBtn.disabled = false;
    addBtn.classList.remove('add-panel__btn--loading');
    hideLoading();
  }
}

// 每个 id 的"最新意图"：解决连续点击竞态（用户在 API 返回前又改了）
const latestIntent = new Map(); // id → boolean

async function toggleComplete(id, nextCompleted, opts = {}) {
  const current = getTodos().find((t) => t.id === id);
  if (!current || current.completed === nextCompleted) return; // 幂等

  // 记录最新意图——后续如果有更早的 API 响应返回，会被忽略
  latestIntent.set(id, nextCompleted);
  // 登记飞行中操作：让 Realtime 自我回声守卫知道"本端正在改它"，
  // 避免乱序回声（如第一次完成延迟回声）覆盖掉后续的乐观更新
  beginToggle(id, nextCompleted);

  const prev = { ...current };
  Object.assign(current, {
    completed: nextCompleted,
    completedBy: nextCompleted ? currentUser.id : null,
    completedAt: nextCompleted ? new Date().toISOString() : null,
  });
  setTodos(sortTodos(getTodos()));
  // 本端完成 → 庆祝动画
  if (nextCompleted) celebrateCompletion(current);
  // 带感完成：完成动效之上叠加飞心 + 自动贴 heart（写库 + Realtime 推给对方）
  if (nextCompleted && opts.heartful) {
    // 隐藏款 + 带感：延迟飞心，等光环/金光主视觉演完（约 300ms）避免画面过满
    const flyDelay = isHidden(current.rarity) ? 300 : 0;
    setTimeout(() => {
      // 重新查询复选框（完成 rerender 后旧引用已脱离 DOM，getBoundingClientRect 会返回 0）
      const fromEl = document.querySelector(`.todo[data-id="${CSS.escape(id)}"] .todo__check`)
        || opts.fromEl;
      flyHeartToTopbar(fromEl);
      // 自动贴 heart（复用 reactions，对方端通过 Realtime 收到 → 卡片脉冲）
      try { toggleReaction(id, 'heart', false); } catch (e) { /* 静默，飞心已表达 */ }
    }, flyDelay);
  }
  // 首次引导：完成"对方创建的"待办时，提示一次"长按带感完成"
  if (nextCompleted && current.createdBy !== (currentUser && currentUser.id)) {
    showHeartfulHint(id);
  }
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
  } finally {
    // 无论成功/丢弃/回滚，这次飞行操作都收尾，解除 Realtime 回声守卫
    endToggle(id);
  }
}

/**
 * 轻轻提醒：给未完成待办加上/取消标记（克制提醒对方）。
 * @param {string} id todo id
 * @param {boolean} on true=标记, false=取消
 */
async function toggleNudge(id, on) {
  const current = getTodos().find((t) => t.id === id);
  if (!current) return;
  const prevNudge = current.nudgeBy;
  // 乐观更新
  current.nudgeBy = on ? (currentUser && currentUser.id) : null;
  setTodos(getTodos());
  try {
    const todo = await db.setNudge(id, on ? currentUser.id : null);
    setTodos(sortTodos(getTodos().map((t) => (t.id === id ? todo : t))));
  } catch (err) {
    // 回滚
    const target = getTodos().find((t) => t.id === id);
    if (target) target.nudgeBy = prevNudge;
    setTodos(getTodos());
    handleError(toAppError(err), '操作失败');
  }
}

/**
 * 给已存在的待办配图/换图（长按菜单入口）。
 * 选图 → 压缩上传 → 写入 image_path（含旧图清理）→ 乐观更新本地。
 * 任一步失败：Toast 提示，不影响待办本身。
 * @param {string} id todo id
 * @param {string|null} prevPath 旧图 URL（换图时用于清理旧文件）
 */
async function attachImageToTodo(id, prevPath) {
  const file = await pickImage();
  if (!file) return; // 用户取消
  showLoading();
  try {
    const url = await uploadTodoImage(id, file);
    const todo = await db.setImage(id, url, prevPath); // db 内部会清理旧图文件
    setTodos(sortTodos(getTodos().map((t) => (t.id === id ? todo : t))));
    showToast('已配图');
  } catch (err) {
    console.error('[app] 配图失败:', err);
    handleError(toAppError(err), '配图失败，请重试');
  } finally {
    hideLoading();
  }
}

/**
 * 删除已存在待办的图片（长按菜单 / lightbox 入口）。
 * db.setImage(id, null, prevPath) → 置空 image_path 并清理 Storage 旧文件 → 乐观更新本地。
 * @param {string} id todo id
 * @param {string} prevPath 旧图 URL（用于清理 Storage 文件）
 */
async function removeImageFromTodo(id, prevPath) {
  showLoading();
  try {
    const todo = await db.setImage(id, null, prevPath);
    setTodos(sortTodos(getTodos().map((t) => (t.id === id ? todo : t))));
    showToast('已删除图片');
  } catch (err) {
    console.error('[app] 删图失败:', err);
    handleError(toAppError(err), '删除图片失败，请重试');
  } finally {
    hideLoading();
  }
}

/* ===== 图片全屏预览（lightbox）=====
 * 点徽标打开：黑色全屏层 + 居中大图，点击空白/图片关闭。
 * 底部「删除图片」按钮（红，与"删除待办"区分）→ 调 removeImageFromTodo。
 * 一次只存在一个 lightbox，关闭即从 DOM 移除。
 */
function openImageLightbox(todo) {
  // 已打开则不重复
  if (document.querySelector('.img-lightbox')) return;

  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '图片预览');

  const img = document.createElement('img');
  img.className = 'img-lightbox__img';
  img.src = todo.imagePath;
  img.alt = '';
  overlay.appendChild(img);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'img-lightbox__close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  overlay.appendChild(closeBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'img-lightbox__del';
  delBtn.textContent = '删除图片';
  overlay.appendChild(delBtn);

  document.body.appendChild(overlay);
  // 锁滚动
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }

  const close = () => {
    overlay.remove();
    document.body.style.overflow = prevOverflow;
  };
  overlay.addEventListener('click', (e) => {
    // 点遮罩或图片本身都关（图片上 stopPropagation 避免误触删除按钮区）
    if (e.target === overlay || e.target === img) close();
  });
  closeBtn.addEventListener('click', close);
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    close();
    await removeImageFromTodo(todo.id, todo.imagePath);
  });
  // Esc 关闭（桌面端）
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  });
}

/* ===== 完成备注：底部滑出输入面板（一次性模态，复用 add-panel 滑出风格）=====
 * 长按已完成待办 → 备注 → 弹此面板。覆盖语义：输入框预填原备注，可改可清空。
 * 不自动保存（必须点保存才写入，避免误触覆盖）。
 */
function openNotePanel(todo) {
  // 已打开则不重复
  if (document.querySelector('.note-input-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'note-input-overlay';
  // 从 state 取最新 todo（避免闭包陈旧）
  const latest = getTodos().find((t) => t.id === todo.id) || todo;

  const panel = document.createElement('div');
  panel.className = 'note-input-panel';

  const handle = document.createElement('div');
  handle.className = 'note-input-panel__handle';
  panel.appendChild(handle);

  const label = document.createElement('div');
  label.className = 'note-input-panel__label';
  label.textContent = latest.completedNote ? '修改这句话' : '留句话给 ta';
  panel.appendChild(label);

  const textarea = document.createElement('textarea');
  textarea.className = 'note-input-panel__textarea';
  textarea.maxLength = 100;
  textarea.rows = 2;
  textarea.placeholder = '比如「蚊子已打死」';
  textarea.value = latest.completedNote || ''; // 预填原备注（覆盖语义）
  // 回车保存（移动端键盘的"完成"键也触发）
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveNote(latest.id, textarea.value.trim());
    }
  });
  panel.appendChild(textarea);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'note-input-panel__save';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => saveNote(latest.id, textarea.value.trim()));
  panel.appendChild(saveBtn);

  overlay.appendChild(panel);
  // 点遮罩关闭（不保存）
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeNotePanel(); });
  document.body.appendChild(overlay);
  // 锁滚动
  document.body.style.overflow = 'hidden';
  // 下一帧触发滑入动画
  requestAnimationFrame(() => overlay.classList.add('note-input-overlay--show'));
  // 聚焦输入框（等动画启动后，避免突兀）
  setTimeout(() => textarea.focus(), 280);
  // ESC 关闭
  document.addEventListener('keydown', onNoteEsc);
  function onNoteEsc(e) {
    if (e.key === 'Escape') {
      closeNotePanel();
      document.removeEventListener('keydown', onNoteEsc);
    }
  }
}

function closeNotePanel() {
  const overlay = document.querySelector('.note-input-overlay');
  if (!overlay) return;
  overlay.classList.remove('note-input-overlay--show');
  document.body.style.overflow = '';
  setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 280);
}

/**
 * 保存完成备注（乐观更新 + 失败回滚）。
 * 空字符串转 null（清除备注语义）。
 */
async function saveNote(id, text) {
  const note = text || null;
  // 乐观更新本地
  const current = getTodos().find((t) => t.id === id);
  const prev = current && current.completedNote;
  if (current) {
    current.completedNote = note;
    setTodos(getTodos()); // 触发重渲染，meta 行自动刷新
  }
  closeNotePanel();
  try {
    await db.setCompletedNote(id, note);
    showToast(note ? '已保存' : '已清除备注');
  } catch (err) {
    // 回滚
    const target = getTodos().find((t) => t.id === id);
    if (target) target.completedNote = prev;
    setTodos(getTodos());
    handleError(toAppError(err), '保存失败');
  }
}

async function deleteTodo(id) {
  const target = getTodos().find((t) => t.id === id);
  if (!target) return;
  // 软删除可恢复，不再需要二次确认（原生 confirm 已移除）

  // 先播放退出动画，再实际从 state 移除
  const liEl = todoListEl.querySelector(`[data-id="${id}"]`);
  if (liEl) {
    liEl.classList.add('todo--leaving');
    await new Promise((r) => setTimeout(r, 200));
  }
  setTodos(getTodos().filter((t) => t.id !== id));
  try {
    await db.deleteTodo(id);
    showToast('已移到回收站');
  } catch (err) {
    setTodos(sortTodos([...getTodos(), target])); // 回滚
    handleError(toAppError(err), '删除失败');
  }
}

// ===== 输入框 placeholder：随机文案 =====
const PLACEHOLDERS = [
  '一只小喵在想喵妈妈～',
  '一只小喵在想喵爸爸～',
  '小宝宝辛苦啦～',
  '大宝贝辛苦啦～',
  '大魔怪闪现！嗷～',
  '想到什么，记下来吧～',
  '今天还要做点什么呢？',
  '给 ta 留个任务吧 💕',
  '又有什么要一起完成？',
  '把小事写下来，一起消灭它～',
  '一件小事，也是爱的一步 🌱',
];

/** 从文案池随机选一条填进输入框 placeholder */
function refreshPlaceholder() {
  if (!todoInput || PLACEHOLDERS.length === 0) return;
  todoInput.placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
}

// ===== 纪念日：在一起 X 天（顶栏）+ 倒计时面板 =====
// 重要日期（硬编码，固定不变）
const ANNIVERSARY_DATE = new Date('2019-12-12T00:00:00');   // 相识
const WEDDING_DATE = new Date('2022-05-27T00:00:00');        // 结婚
const BIRTHDAY_XIAO = { month: 4, day: 19 };                 // 小宝宝生日（月从0开始，4=5月... 不，这里用人类月份）
const BIRTHDAY_DA = { month: 4, day: 11 };                   // 大宝贝生日

/** 计算在一起的天数（时区安全，正计时） */
function calcAnniversaryDays() {
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const anniMidnight = new Date(ANNIVERSARY_DATE.getFullYear(), ANNIVERSARY_DATE.getMonth(), ANNIVERSARY_DATE.getDate());
  return Math.max(0, Math.round((todayMidnight - anniMidnight) / (24 * 60 * 60 * 1000)));
}

/**
 * 计算到下一个年度纪念日的倒计时（年度循环）。
 * @param {number} month 人类月份（1-12）
 * @param {number} day 日期（1-31）
 * @returns {{days:number, isToday:boolean}} 距下个纪念日天数 + 是否就是今天
 */
function calcNextCountdown(month, day) {
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // 今年的纪念日（month 人类月份，Date 构造用 month-1）
  let target = new Date(today.getFullYear(), month - 1, day);
  if (target < todayMidnight) {
    // 今年已过，滚到明年
    target = new Date(today.getFullYear() + 1, month - 1, day);
  }
  const diffDays = Math.round((target - todayMidnight) / (24 * 60 * 60 * 1000));
  return { days: diffDays, isToday: diffDays === 0 };
}

/**
 * 数字滚动动画：从 0 缓动增长到目标值，停在最终天数。
 * ease-out 曲线，前快后慢，优雅不突兀。
 */
function animateDays(el, target) {
  if (!el) return;
  const duration = 1500; // 1.5 秒滚到目标
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    // ease-out cubic：1 - (1-t)^3
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(target * eased);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = target; // 确保最终精确
  }
  requestAnimationFrame(tick);
}

/** 计算并滚动填充"在一起 X 天"（顶栏） */
function renderAnniversary() {
  const daysEl = document.getElementById('anniDays');
  if (!daysEl) return;
  const days = calcAnniversaryDays();
  // 先归零，确保每次进入都能看到从 0 滚动的动画（而非直接停在目标值）
  daysEl.textContent = '0';
  animateDays(daysEl, days);
}

/**
 * 填充纪念日面板：相识天数（滚动）+ 结婚/生日倒计时（年度循环）
 */
function fillAnniversaryPanel() {
  // 相识天数（带滚动）
  const panelDays = document.getElementById('anniPanelDays');
  if (panelDays) {
    panelDays.textContent = '0';
    animateDays(panelDays, calcAnniversaryDays());
  }

  // 倒计时文案生成
  const fmt = (c) => c.isToday ? '🎉 就是今天' : `还有 ${c.days} 天`;

  const wedding = document.getElementById('anniPanelWedding');
  if (wedding) wedding.textContent = fmt(calcNextCountdown(WEDDING_DATE.getMonth() + 1, WEDDING_DATE.getDate()));

  const bd1 = document.getElementById('anniPanelBirthday1');
  if (bd1) bd1.textContent = fmt(calcNextCountdown(BIRTHDAY_XIAO.month, BIRTHDAY_XIAO.day));

  const bd2 = document.getElementById('anniPanelBirthday2');
  if (bd2) bd2.textContent = fmt(calcNextCountdown(BIRTHDAY_DA.month, BIRTHDAY_DA.day));
}

/**
 * 展开/收起纪念日详情面板
 */
let anniPanelIntroPlayed = false;  // 飘落入场只在每次冷启动后首次打开时播放
function toggleAnniversaryPanel() {
  const panel = document.getElementById('anniPanel');
  if (!panel) return;
  const open = !panel.hidden;
  if (open) {
    // 收起
    panel.classList.remove('anni-panel--show');
    setTimeout(() => { panel.hidden = true; }, 250);
  } else {
    // 先填充数据（在显示前，避免用户看到空数据闪烁）
    fillAnniversaryPanel();
    panel.hidden = false;
    // 首次打开播放飘落入场：加 --intro 触发，0.9s 播完移除（之后打开只心跳）
    if (!anniPanelIntroPlayed) {
      const heart = panel.querySelector('.anni-panel__heart');
      if (heart) {
        heart.classList.add('anni-panel__heart--intro');
       anniPanelIntroPlayed = true;
        // 飘落动画 0.9s，结束后移除 class，回归纯心跳
        setTimeout(() => { heart.classList.remove('anni-panel__heart--intro'); }, 950);
      }
    }
    // 下一帧触发动画（单层 RAF + 兜底，避免 WebView 偶发不触发）
    requestAnimationFrame(() => {
      panel.classList.add('anni-panel--show');
    });
    // 兜底：如果 RAF 没及时触发，强制显示
    setTimeout(() => { panel.classList.add('anni-panel--show'); }, 60);
  }
}

// ===== 顶栏"我"：只显示头像（昵称移除，更克制） =====
// 头像同时也是退出入口：长按 800ms → 确认条 → 退出（替代退出按钮）
function renderMe() {
  meEl.classList.remove('topbar__me--placeholder');
  meEl.textContent = '';
  const avatar = currentUser && currentUser.avatar;
  if (avatar) {
    const img = document.createElement('img');
    img.className = 'topbar__avatar';
    img.src = avatar;
    img.alt = currentUser ? currentUser.displayName : '';
    img.onerror = () => img.remove();
    bindLongPressLogout(img);
    meEl.appendChild(img);
  }
}

/**
 * 给头像绑定长按退出（移动端长按 800ms / 桌面端右键兜底）。
 * 按住时头像轻微缩放做"按压感"，到时触发确认条。
 */
function bindLongPressLogout(img) {
  let pressTimer = null;
  const PRESS_MS = 800;
  const startPress = () => {
    img.classList.add('topbar__avatar--pressing');
    pressTimer = setTimeout(() => {
      pressTimer = null;
      img.classList.remove('topbar__avatar--pressing');
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
      showLogoutConfirm();
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
  img.addEventListener('contextmenu', (e) => { e.preventDefault(); showLogoutConfirm(); });
}

/**
 * 退出确认条（底部 action-sheet 风格，复用 .action-sheet 样式）。
 * 长按头像触发，避免误触。
 */
function showLogoutConfirm() {
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
  confirmBtn.addEventListener('click', () => { closeLogoutConfirm(); logout(); });
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

let currentLogoutSheet = null;
function closeLogoutConfirm() {
  if (!currentLogoutSheet) return;
  const el = currentLogoutSheet;
  currentLogoutSheet = null;
  el.classList.remove('action-sheet__overlay--show');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
}

// ===== 顶栏爱心"会呼吸"：气色 + 光晕 + 在线心跳 =====
// 设计：同一个爱心，颜色讲"时间"，心跳节奏讲"我们此刻在不在一起"，开场光晕讲"ta 今天也来过"。
// 视觉元素零新增，全靠已有爱心的不同状态。

/**
 * 按当前小时返回爱心渐变配色 [stop0%, stop100%]。
 * 幅度刻意做小：不是"变色"，只是"色温偏移"，用户说不出的舒服。
 */
function getHeartTint(hour) {
  if (hour >= 6 && hour < 9) {
    // 清晨：暖橘偏移（晨光感）
    return ['#fb8a6b', '#e15a3b'];
  }
  if (hour >= 22 || hour < 6) {
    // 深夜：深 rose / 深紫（压低声音）
    return ['#9f1239', '#6b1d3a'];
  }
  // 白天/傍晚：原样（保持品牌色）
  return ['#fb7185', '#e11d48'];
}

/** 把配色应用到顶栏爱心的 SVG 渐变 */
function applyHeartTint() {
  const stops = document.querySelectorAll('#topHeartGrad stop');
  if (stops.length < 2) return;
  const [c1, c2] = getHeartTint(new Date().getHours());
  stops[0].setAttribute('stop-color', c1);
  stops[1].setAttribute('stop-color', c2);
}

/**
 * reload 后的"更新完成"欢迎动画。
 * 新版本启动时读 localStorage 标记，若有就播一个完整的庆祝动画。
 * 这是在新 WebView 里播的，用户绝对能看到。
 */
// 内存锁：同一次页面会话内防止重复播放（reload 后插件可能触发二次加载）
// 放在文件顶部已声明，这里直接引用（避免 TDZ）

async function showUpdateWelcomeIfPending() {
  // 内存锁：防止同一次会话内重入（reload 后的二次加载会触发第二次 init）
  if (welcomePlaying) return;

  // 检测当前是否热更新 bundle（非 APK 壳内置）
  const info = await getCurrentBundleInfo();
  if (!info || !info.hot) return; // 内置壳或检测失败：不播

  const version = info.version;

  // 只在"这个版本第一次打开时"播放：用 localStorage 记录已播过的版本号。
  // 进函数立刻写标记（不等动画播完），避免竞态导致重入时标记还没写入。
  const shownKey = 'welcomeShown_' + version;
  try {
    if (localStorage.getItem(shownKey)) return; // 这个版本已经播过了
    localStorage.setItem(shownKey, '1'); // 立刻写，防止重入
  } catch (_) { return; }

  welcomePlaying = true;

  // 查总更新次数（用于文案下方的"第 N 次更新"标注）
  let totalCount = 1;
  try {
    const { count } = await supabase
      .from('app_versions')
      .select('id', { count: 'exact', head: true })
      .eq('enabled', true);
    totalCount = count || 1;
  } catch (_) {}

  // 延迟到开屏 splash 淡出后播放（splash 是 1.2s + 0.5s 淡出）
  setTimeout(() => {
    const overlay = document.createElement('div');
    overlay.id = 'updateWelcome';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center',
      'background:linear-gradient(160deg,#fff1f2 0%,#ffe4e6 60%,#fecdd3 100%)',
      'opacity:0', 'transition:opacity 0.4s ease',
    ].join(';');

    // 文案池
    const messages = [
      '我藏在勾选框里的心意', '每一条，都是惦记', '写给你的，慢慢看',
      '你看，我又来过了', '小事，但记得', '未完成的事里，都藏着你',
      '清单很长，我的心意也是', '你勾掉的每一项，我都记着',
      '写下来的，都是想为你做的', '待办里没有的一条：想你',
      '惦记是看不见的清单', '我把心意，折进了每一行',
      '字不多，刚刚好', '藏起来的心思，最长久',
      '你看过的，我也刚看过', '同一个清单，同一种心意',
    ];
    const msg = messages[Math.floor(Math.random() * messages.length)];

    overlay.innerHTML = `
      <div style="width:90px;height:90px;margin-bottom:28px;animation:uw-pop 0.6s cubic-bezier(0.16,1,0.3,1) both, uw-beat 1s ease-in-out 0.6s infinite">
        <svg viewBox="0 0 512 512" width="90" height="90" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="uwh" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#e11d48"/>
            </linearGradient>
          </defs>
          <path d="M256 402s-110-66-110-140.6c0-36.4 28.8-63.4 63-63.4 22.6 0 41.4 11.6 47 28.2 5.6-16.6 24.4-28.2 47-28.2 34.2 0 63 27 63 63.4C366 336 256 402 256 402z" fill="url(#uwh)"/>
        </svg>
      </div>
      <div style="color:#9f1239;font-size:15px;font-weight:400;letter-spacing:2px;animation:uw-fade 0.5s ease 0.4s both">${msg}</div>
      <div style="position:fixed;bottom:18px;right:20px;color:#be123c;font-size:9px;font-weight:300;letter-spacing:4px;opacity:0.22;animation:uw-fade 0.5s ease 1s both">No.${totalCount}</div>
      <style>
        @keyframes uw-pop{0%{opacity:0;transform:scale(0.3) translateY(30px)}60%{opacity:1;transform:scale(1.1) translateY(0)}100%{opacity:1;transform:scale(1)}}
        @keyframes uw-beat{0%,100%{transform:scale(1)}15%{transform:scale(1.2)}30%{transform:scale(1)}45%{transform:scale(1.12)}60%{transform:scale(1)}}
        @keyframes uw-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @media(prefers-reduced-motion:reduce){#updateWelcome>div:first-child{animation:none!important;opacity:1}}
      </style>
    `;
    document.body.appendChild(overlay);

    // 淡入
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    // 2.6 秒后淡出移除（给足时间看清文案）
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 400);
    }, 2600);
  }, 1800);
}

/**
 * 浮动光点：从顶栏爱心位置飘下 N 个柔粉色光点，代表"对方来过 N 次"。
 * 每个光点随机左右偏移飘落 + 淡出，错开节奏，轻盈不密集。
 * @param {number} count 光点数量（已在外层限制 ≤8）
 */
function floatDots(count) {
  const heart = document.getElementById('anniHeart');
  if (!heart || count < 1) return;
  // 取爱心在屏幕上的位置作为光点起点
  const rect = heart.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;

  // 注入一次性的动画样式（用 class 标记避免重复注入）
  if (!document.getElementById('floatDotsStyle')) {
    const style = document.createElement('style');
    style.id = 'floatDotsStyle';
    style.textContent = `
      @keyframes fd-fall {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.3); }
        15% { opacity: 0.9; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(0.5); }
      }
      @media (prefers-reduced-motion: reduce) {
        .fd-dot { animation: none !important; opacity: 0 !important; }
      }
    `;
    document.head.appendChild(style);
  }

  // 逐个生成光点，每个间隔 350ms
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const dot = document.createElement('div');
      dot.className = 'fd-dot';
      // 随机水平偏移（-30px ~ 30px）和下落距离（50px ~ 90px）
      const dx = (Math.random() - 0.5) * 60;
      const dy = 50 + Math.random() * 40;
      const size = 6 + Math.random() * 4; // 6~10px 光点
      dot.style.cssText = [
        'position:fixed',
        `left:${startX}px`,
        `top:${startY}px`,
        `width:${size}px`,
        `height:${size}px`,
        'border-radius:50%',
        'background:radial-gradient(circle, rgba(251,113,133,0.95) 0%, rgba(251,113,133,0.3) 70%, transparent 100%)',
        'pointer-events:none',
        'z-index:9999',
        '--dx:' + dx + 'px',
        '--dy:' + dy + 'px',
        'animation:fd-fall 1.6s ease-out forwards',
      ].join(';');
      document.body.appendChild(dot);
      // 动画结束后移除
      setTimeout(() => { if (dot.parentNode) dot.parentNode.removeChild(dot); }, 1700);
    }, i * 350);
  }
}

/**
 * 切换"两人同时在线"的紧张心跳（1.2s 加速版）。
 * presence 检测到对方上下线时调用。
 */
function setHeartExcited(on) {
  const heart = document.getElementById('anniHeart');
  if (!heart) return;
  const has = heart.classList.contains('topbar__heart--excited');
  if (on && !has) {
    heart.classList.add('topbar__heart--excited');
  } else if (!on && has) {
    heart.classList.remove('topbar__heart--excited');
  }
}

// ===== 渲染 =====
// 已渲染过的 todo id 集合：让"新增"项才有入场动画，
// 避免 toggleComplete / Realtime 回声等触发的重渲染让整列重新淡入（闪烁根因）
const renderedIds = new Set();

function render() {
  const todos = getTodos();
  if (todos.length === 0) {
    todoListEl.innerHTML = '';
    renderedIds.clear();
    const li = document.createElement('li');
    li.className = 'todo-list__empty';
    // 自绘 rose 小爱心（非 emoji，跨设备一致 + 精致）
    const heart = document.createElement('div');
    heart.className = 'todo-list__empty-heart';
    heart.innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M12 21s-7.5-4.7-7.5-10.2C4.5 7.6 7 5.5 9.8 5.5c1.4 0 2.7.7 3.2 1.8.5-1.1 1.8-1.8 3.2-1.8 2.8 0 5.3 2.1 5.3 5.3C21.5 16.3 12 21 12 21z" fill="currentColor"/></svg>';
    const text = document.createElement('div');
    text.className = 'todo-list__empty-text';
    text.textContent = '这里空空的，像在等你';
    li.appendChild(heart);
    li.appendChild(text);
    todoListEl.appendChild(li);
    return;
  }

  // 清掉空状态占位 / 首屏骨架屏（如有）
  todoListEl.querySelectorAll('.todo-list__empty, .skeleton').forEach((el) => el.remove());

  // 增量渲染：复用已存在的 DOM 节点原地更新，只对真正新增的项建新节点（带动画）。
  // 这样 toggleComplete / 远端回声触发的重渲染不会重建整列，消除闪烁。
  const existing = new Map();
  Array.from(todoListEl.querySelectorAll('.todo[data-id]')).forEach((el) => {
    existing.set(el.dataset.id, el);
  });
  const currentIds = new Set(todos.map((t) => t.id));

  // 删除已不存在的元素
  existing.forEach((el, id) => {
    if (!currentIds.has(id)) {
      el.remove();
      renderedIds.delete(id);
    }
  });

  // 按排序顺序更新/创建，并用 DocumentFragment 重排（移动而非重建，不触发动画）
  const frag = document.createDocumentFragment();
  todos.forEach((todo) => {
    let el = existing.get(todo.id);
    if (el) {
      updateItem(el, todo); // 原地更新（无动画）
    } else {
      el = renderItem(todo); // 新增项：带入场动画
      renderedIds.add(todo.id);
    }
    frag.appendChild(el);
  });
  todoListEl.appendChild(frag);
}

/** 构建 meta 文本（创建者 · 时间 · 完成者完成于时间 · 备注） */
function buildMetaText(todo) {
  const creator = displayOf(todo.createdBy);
  const time = formatRelativeTime(todo.createdAt);
  let meta = `${creator.name} · ${time}`;
  if (todo.completed) {
    const completer = displayOf(todo.completedBy);
    meta += ` · ${completer.name}完成`;
    if (todo.completedAt) {
      meta += ` · ${formatRelativeTime(todo.completedAt)}`;
    }
    // 完成备注：用「」包裹，像一句轻声的话，区别于其他 meta 信息
    if (todo.completedNote) {
      meta += ` ·「${todo.completedNote}」`;
    }
  }
  return meta;
}

/**
 * 渲染/更新"问问进度"标记（原地增删小问号，绝不重建 li）。
 * 由 renderItem（新建）和 updateItem（更新）统一调用，保证两处逻辑一致。
 *
 * 规则：
 *   - nudgeBy 存在 + 未完成 → 显示小问号 + 加 todo--nudged class
 *   - 否则 → 移除小问号 + 去 class
 * 点击小问号取消标记（仅创建者本人可取消）。
 */
// nudge 提醒图标：twemoji 🤔 思考脸（CC-BY 4.0，彩色矢量，安卓 WebView 不变黑）。
// 表达"ta 在想进度啦 / 想问问"，比问号更生动温和。
const NUDGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" aria-hidden="true"><circle fill="#FFCB4C" cx="18" cy="17.018" r="17"/><path fill="#65471B" d="M14.524 21.036c-.145-.116-.258-.274-.312-.464-.134-.46.13-.918.59-1.021 4.528-1.021 7.577 1.363 7.706 1.465.384.306.459.845.173 1.205-.286.358-.828.401-1.211.097-.11-.084-2.523-1.923-6.182-1.098-.274.061-.554-.016-.764-.184z"/><ellipse fill="#65471B" cx="13.119" cy="11.174" rx="2.125" ry="2.656"/><ellipse fill="#65471B" cx="24.375" cy="12.236" rx="2.125" ry="2.656"/><path fill="#F19020" d="M17.276 35.149s1.265-.411 1.429-1.352c.173-.972-.624-1.167-.624-1.167s1.041-.208 1.172-1.376c.123-1.101-.861-1.363-.861-1.363s.97-.4 1.016-1.539c.038-.959-.995-1.428-.995-1.428s5.038-1.221 5.556-1.341c.516-.12 1.32-.615 1.069-1.694-.249-1.08-1.204-1.118-1.697-1.003-.494.115-6.744 1.566-8.9 2.068l-1.439.334c-.54.127-.785-.11-.404-.512.508-.536.833-1.129.946-2.113.119-1.035-.232-2.313-.433-2.809-.374-.921-1.005-1.649-1.734-1.899-1.137-.39-1.945.321-1.542 1.561.604 1.854.208 3.375-.833 4.293-2.449 2.157-3.588 3.695-2.83 6.973.828 3.575 4.377 5.876 7.952 5.048l3.152-.681z"/><path fill="#65471B" d="M9.296 6.351c-.164-.088-.303-.224-.391-.399-.216-.428-.04-.927.393-1.112 4.266-1.831 7.699-.043 7.843.034.433.231.608.747.391 1.154-.216.405-.74.546-1.173.318-.123-.063-2.832-1.432-6.278.047-.257.109-.547.085-.785-.042zm12.135 3.75c-.156-.098-.286-.243-.362-.424-.187-.442.023-.927.468-1.084 4.381-1.536 7.685.48 7.823.567.415.26.555.787.312 1.178-.242.39-.776.495-1.191.238-.12-.072-2.727-1.621-6.267-.379-.266.091-.553.046-.783-.096z"/></svg>';

function renderNudge(li, todo) {
  const shouldShow = !!todo.nudgeBy && !todo.completed;
  const existing = li.querySelector('.todo__nudge');

  if (shouldShow) {
    li.classList.add('todo--nudged');
    if (!existing) {
      // 新增小爱心（节点不存在才建，避免重复）
      const nudge = document.createElement('span');
      nudge.className = 'todo__nudge';
      nudge.setAttribute('aria-label', 'ta 想问问进度');
      nudge.innerHTML = NUDGE_SVG;
      // 点击取消（仅创建者本人）。用闭包捕获 todo id，避免 stale
      nudge.addEventListener('click', (e) => {
        e.stopPropagation();
        // 实时从 state 取最新 todo，而非闭包里的旧引用
        const latest = getTodos().find((t) => t.id === todo.id);
        if (latest && latest.nudgeBy === (currentUser && currentUser.id)) {
          toggleNudge(todo.id, false);
        }
      });
      li.appendChild(nudge);
    }
  } else {
    // 移除小爱心（存在才删）
    li.classList.remove('todo--nudged');
    if (existing) existing.remove();
  }
}

/**
 * 渲染/更新「有图」徽标（原地增删，绝不重建 li）。
 * 由 renderItem（新建）和 updateItem（更新）统一调用，与 renderNudge / renderReactions 同模式。
 *
 * 设计取舍（2026-08-04 改版）：图片不再默认展开（太占屏），改为一个小相纸图标徽标，
 * 挂在 meta 行末尾。点击徽标 → 弹全屏 lightbox 查看大图，lightbox 内含「删除图片」按钮。
 */
function renderImage(li, todo) {
  const shouldShow = !!todo.imagePath;
  const meta = li.querySelector('.todo__meta');
  const existing = li.querySelector('.todo__image-badge');

  if (shouldShow) {
    if (!existing && meta) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'todo__image-badge';
      badge.setAttribute('aria-label', '查看图片');
      badge.title = '查看图片';
      badge.innerHTML = ICONS.image;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const latest = getTodos().find((t) => t.id === todo.id);
        if (latest && latest.imagePath) openImageLightbox(latest);
      });
      meta.appendChild(badge);
    }
  } else {
    if (existing) existing.remove();
  }
}

/** 渲染单条（用 DOM API 而非 innerHTML，天然防 XSS） */
function renderItem(todo) {
  const li = document.createElement('li');
  li.className = 'todo' + (todo.completed ? ' todo--done' : '');
  li.dataset.id = todo.id;

  // 自绘圆形复选框（取代原生方框，精致度核心）
  // 用 button + ARIA role=checkbox 保无障碍；状态用 class 控制
  const checkbox = document.createElement('button');
  checkbox.type = 'button';
  checkbox.className = 'todo__check' + (todo.completed ? ' todo__check--done' : '');
  checkbox.setAttribute('role', 'checkbox');
  checkbox.setAttribute('aria-checked', String(todo.completed));
  checkbox.setAttribute('aria-label', todo.completed ? '标为未完成' : '标为已完成');
  // 对勾 SVG（stroke-dasharray 动画由 CSS 控制）
  checkbox.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ===== 手势区分：轻点=普通完成，长按=弹出居中蓄力层（带感完成）=====
  // 仅未完成态支持带感（完成态的复选框已隐藏，只能轻点取消）
  const LONG_PRESS_MS = 400; // 长按判定阈值（非蓄力时长）
  let chargePressTimer = null;
  let suppressClickUntil = 0; // 蓄力层触发后抑制随后的 click（防重复 toggle）

  // 轻点仍走 click（保留原实时取 latest 的竞态保护逻辑）
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() < suppressClickUntil) return;
    const latest = getTodos().find((t) => t.id === todo.id);
    toggleComplete(todo.id, latest ? !latest.completed : !todo.completed);
  });

  // 长按判定（仅未完成态）：按住超过 400ms → 弹出居中蓄力层
  if (!todo.completed) {
    const startChargePress = () => {
      clearTimeout(chargePressTimer);
      chargePressTimer = setTimeout(() => {
        // 判定为长按 → 弹出蓄力层，接管交互（遮罩挡住卡片长按菜单，消除冲突）
        suppressClickUntil = Date.now() + 800;
        openHeartfulCharge(todo, checkbox);
      }, LONG_PRESS_MS);
    };
    const cancelChargePress = () => { clearTimeout(chargePressTimer); };
    checkbox.addEventListener('pointerdown', startChargePress);
    checkbox.addEventListener('pointerup', cancelChargePress);
    checkbox.addEventListener('pointerleave', cancelChargePress);
    checkbox.addEventListener('pointercancel', cancelChargePress);
  }

  // 文本与元信息
  const body = document.createElement('div');
  body.className = 'todo__body';

  const textEl = document.createElement('div');
  textEl.className = 'todo__text';
  textEl.textContent = todo.text; // textContent 防注入

  const metaEl = document.createElement('div');
  metaEl.className = 'todo__meta';
  const creator = displayOf(todo.createdBy);

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
  metaText.className = 'todo__meta-text';
  metaText.textContent = buildMetaText(todo);
  metaEl.appendChild(metaText);

  body.appendChild(textEl);
  body.appendChild(metaEl);

  li.appendChild(checkbox);
  li.appendChild(body);

  // 轻轻提醒标记（由 renderNudge 统一管理：新建/更新都走它，保证一致）
  renderNudge(li, todo);

  // 图片缩略图（有就显示，由 renderImage 统一管理）
  renderImage(li, todo);

  // 表情反应区（仅已完成时显示，由 reactions 模块管理）
  renderReactions(li, todo);

  // 隐藏款稀有度样式（背景渐变 + 角标，由 applyRarity 统一管理）
  applyRarity(li, todo);

  // 长按弹出操作菜单（移动端长按 / 桌面端右键，各走各路不冲突）
  let pressTimer = null;
  const startPress = (e) => {
    // 排除点在复选框上（避免长按复选框误触菜单）
    if (e.target.closest && e.target.closest('.todo__check')) return;
    // 视觉进度反馈：卡片轻微缩放，让用户知道"再按一下就触发"
    li.classList.add('todo--pressing');
    pressTimer = setTimeout(() => {
      pressTimer = null;
      li.classList.remove('todo--pressing');
      // 触觉反馈（支持的设备）
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
      showTodoMenu(todo, li);
    }, 350); // 350ms 更跟手（原 500ms 偏长）
  };
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    li.classList.remove('todo--pressing');
  };
  // 移动端：touchstart 计时，移动/松开取消
  li.addEventListener('touchstart', startPress, { passive: true });
  li.addEventListener('touchmove', cancelPress, { passive: true });
  li.addEventListener('touchend', cancelPress);
  li.addEventListener('touchcancel', cancelPress);
  // 桌面端：右键触发（不再用 mousedown/mouseleave，避免悬停误触）
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); showTodoMenu(todo, li); });

  return li;
}

// 操作菜单用的线性图标（统一 stroke-width，跨设备一致）
const ICONS = {
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  undone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
  // ask：twemoji 🤔 思考脸（与右上角 nudge 标记同款，彩色矢量，安卓不变黑）
  ask: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="100%" height="100%"><circle fill="#FFCB4C" cx="18" cy="17.018" r="17"/><path fill="#65471B" d="M14.524 21.036c-.145-.116-.258-.274-.312-.464-.134-.46.13-.918.59-1.021 4.528-1.021 7.577 1.363 7.706 1.465.384.306.459.845.173 1.205-.286.358-.828.401-1.211.097-.11-.084-2.523-1.923-6.182-1.098-.274.061-.554-.016-.764-.184z"/><ellipse fill="#65471B" cx="13.119" cy="11.174" rx="2.125" ry="2.656"/><ellipse fill="#65471B" cx="24.375" cy="12.236" rx="2.125" ry="2.656"/><path fill="#F19020" d="M17.276 35.149s1.265-.411 1.429-1.352c.173-.972-.624-1.167-.624-1.167s1.041-.208 1.172-1.376c.123-1.101-.861-1.363-.861-1.363s.97-.4 1.016-1.539c.038-.959-.995-1.428-.995-1.428s5.038-1.221 5.556-1.341c.516-.12 1.32-.615 1.069-1.694-.249-1.08-1.204-1.118-1.697-1.003-.494.115-6.744 1.566-8.9 2.068l-1.439.334c-.54.127-.785-.11-.404-.512.508-.536.833-1.129.946-2.113.119-1.035-.232-2.313-.433-2.809-.374-.921-1.005-1.649-1.734-1.899-1.137-.39-1.945.321-1.542 1.561.604 1.854.208 3.375-.833 4.293-2.449 2.157-3.588 3.695-2.83 6.973.828 3.575 4.377 5.876 7.952 5.048l3.152-.681z"/><path fill="#65471B" d="M9.296 6.351c-.164-.088-.303-.224-.391-.399-.216-.428-.04-.927.393-1.112 4.266-1.831 7.699-.043 7.843.034.433.231.608.747.391 1.154-.216.405-.74.546-1.173.318-.123-.063-2.832-1.432-6.278.047-.257.109-.547.085-.785-.042zm12.135 3.75c-.156-.098-.286-.243-.362-.424-.187-.442.023-.927.468-1.084 4.381-1.536 7.685.48 7.823.567.415.26.555.787.312 1.178-.242.39-.776.495-1.191.238-.12-.072-2.727-1.621-6.267-.379-.266.091-.553.046-.783-.096z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  // 图片：相册/相框线性图标（配图入口）
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  // 备注：聊天气泡（完成后的交代/收尾说明，语义=留句话）
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
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

/**
 * 显示待办操作菜单（底部 action sheet 风格）
 */
function showTodoMenu(todo, liEl) {
  // 关掉已存在的菜单
  closeTodoMenu();
  // 关键：从 state 取最新 todo，而非闭包里的旧引用。
  // 避免完成/标记状态变化后，菜单仍按旧状态显示选项（如已完成还显示"轻轻提醒"）。
  const latest = getTodos().find((t) => t.id === todo.id);
  if (latest) todo = latest;

  // 遮罩层
  const overlay = document.createElement('div');
  overlay.className = 'action-sheet__overlay';
  overlay.addEventListener('click', closeTodoMenu);

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

  // 完成备注（仅已完成时：完成后的交代/收尾说明，如"蚊子已打死"）
  // 完成动作本身由复选框承担（点对勾=完成），菜单里不再放完成按钮，避免冗余入口
  if (todo.completed) {
    const hasNote = !!todo.completedNote;
    const noteBtn = mkIconBtn(ICONS.note, hasNote ? '修改备注' : '加备注', hasNote ? 'action-sheet__icon-btn--active' : '');
    noteBtn.addEventListener('click', () => {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      closeTodoMenu();
      openNotePanel(todo);
    });
    actions.appendChild(noteBtn);
  }

  // 表情回应（仅已完成：三个表情，可连点）
  if (todo.completed) {
    REACTION_EMOJIS.forEach((key) => {
      const isMine = isMyReaction(todo.id, key);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-sheet__icon-btn action-sheet__icon-btn--reaction' + (isMine ? ' action-sheet__icon-btn--mine' : '');
      btn.setAttribute('aria-label', getReactionLabel(key));
      btn.innerHTML = getReactionSvg(key);
      btn.addEventListener('click', () => {
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
        toggleReaction(todo.id, key, isMine);
        btn.classList.toggle('action-sheet__icon-btn--mine', !isMine);
      });
      actions.appendChild(btn);
    });
  }

  // 轻轻提醒（仅未完成 + 自己创建：问号图标，温和无逼迫感）
  if (!todo.completed && todo.createdBy === (currentUser && currentUser.id)) {
    const isNudged = !!todo.nudgeBy;
    const nudgeBtn = mkIconBtn(ICONS.ask, isNudged ? '取消询问' : '问问进度', isNudged ? 'action-sheet__icon-btn--active' : '');
    nudgeBtn.addEventListener('click', () => {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      toggleNudge(todo.id, !isNudged);
      closeTodoMenu();
    });
    actions.appendChild(nudgeBtn);
  }

  // 配图 / 换图（一条待办最多一张图，无图=配图，有图=换图）
  const hasImage = !!todo.imagePath;
  const imageBtn = mkIconBtn(ICONS.image, hasImage ? '换图' : '配图', hasImage ? 'action-sheet__icon-btn--active' : '');
  imageBtn.addEventListener('click', async () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeTodoMenu();
    await attachImageToTodo(todo.id, hasImage ? todo.imagePath : null);
  });
  actions.appendChild(imageBtn);

  // 删图（仅在有图时出现，红色危险色，与"删除待办"区分）
  if (hasImage) {
    const rmImgBtn = mkIconBtn(ICONS.image, '删图', 'action-sheet__icon-btn--danger');
    rmImgBtn.addEventListener('click', () => {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      closeTodoMenu();
      removeImageFromTodo(todo.id, todo.imagePath);
    });
    actions.appendChild(rmImgBtn);
  }

  // 删除（垃圾桶，rose 危险色）
  const delBtn = mkIconBtn(ICONS.trash, '删除', 'action-sheet__icon-btn--danger');
  delBtn.addEventListener('click', () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeTodoMenu();
    deleteTodo(todo.id);
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

let currentActionSheet = null;
function closeTodoMenu() {
  if (!currentActionSheet) return;
  const el = currentActionSheet;
  currentActionSheet = null;
  el.classList.remove('action-sheet__overlay--show');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
}

/**
 * 原地更新已存在的 todo 节点（只改变化的部分，不重建 DOM、不重播动画）
 * 用于 render() 增量渲染，避免完成/回声等操作导致整列闪烁
 */
function updateItem(li, todo) {
  // 完成态 class
  const doneClass = 'todo--done';
  if (todo.completed && !li.classList.contains(doneClass)) {
    li.classList.add(doneClass);
  } else if (!todo.completed && li.classList.contains(doneClass)) {
    li.classList.remove(doneClass);
  }
  // 自绘复选框状态（class + aria，不触发 click）
  const check = li.querySelector('.todo__check');
  if (check) {
    const isDone = check.classList.contains('todo__check--done');
    if (isDone !== todo.completed) {
      check.classList.toggle('todo__check--done', todo.completed);
      check.setAttribute('aria-checked', String(todo.completed));
      check.setAttribute('aria-label', todo.completed ? '标为未完成' : '标为已完成');
    }
  }
  // 轻轻提醒标记：原地增删小爱心（绝不重建 li，根治重复/闪烁）
  // 完成态变化也会走到这里，renderNudge 内部按 completed 决定显隐，
  // 所以"完成→未完成"会自动恢复小爱心（T6/T7/T8）
  renderNudge(li, todo);
  // 图片缩略图：配图/换图/删图时增删，绝不重建 li
  renderImage(li, todo);
  // 表情反应区：完成态变化时需要显隐，表情数量变化时需要刷新
  renderReactions(li, todo);
  // 隐藏款稀有度样式：Realtime 推来 rarity 时同步背景/角标（原地更新，绝不重建 li）
  applyRarity(li, todo);
  // meta 文本（时间/完成状态/备注可能变化）
  const metaText = li.querySelector('.todo__meta-text');
  if (metaText) {
    const next = buildMetaText(todo);
    if (metaText.textContent !== next) metaText.textContent = next;
  }
}

/** 根据 userId 返回 {name, avatar}（从 profiles 表查到，避免硬编码） */
function displayOf(userId) {
  if (!userId) return { name: '?', avatar: null };
  const p = userMap[userId];
  if (!p) return { name: '?', avatar: null };
  return { name: p.displayName, avatar: p.avatar };
}

// ===== UI 状态 =====
// 离线文案池：每次断线随机显示一条（≤8 字，诗意克制，把"断线"变成藏爱意的窗口）
const OFFLINE_MESSAGES = [
  '风急，信号慢', '断了线，没断念', '暂别片刻，即刻归', '网走了，我没走',
  '山高，信号远', '月隐，网也隐', '渡口无人，信号亦然', '纸短，路也短',
  '雨落，信号断', '云遮，路遥', '片刻静默，即刻重逢', '信号迟到，我没有',
  '雾起，路隐', '忽远忽近，不曾离', '风过，信号散', '风轻，信也轻',
  '潮退，网也退', '山路弯弯，信号缓', '暮色浓，信号淡', '雪落无声，网也静',
  '露重，网将晴', '舟停，心未停', '雾深，路还在', '云散，信号归',
  '风停，等你来', '舟迟，岸不急', '叶落，信号歇', '星隐，片刻静',
  '路远，心不远', '烟散，香暗留', '涛声乱，网也乱', '帘卷，信号散',
  '茶凉，续上', '墨淡，字还在', '弦断，曲未终', '灯花落，网重连',
  '雁过，信号迟', '梅落，香未散', '舟横，渡仍在', '钟停，时未停',
  '镜暗，影还在', '帘动，风知意', '砚干，墨将续', '棋停，局未散',
  '烛摇，光未灭', '铃哑，声将回', '曲歇，韵犹存', '书合，故事续',
  '门掩，人未远', '茶烟散，香气留',
];
let lastOfflineIdx = -1;
function pickOfflineMessage() {
  if (OFFLINE_MESSAGES.length <= 1) return OFFLINE_MESSAGES[0];
  let idx;
  do { idx = Math.floor(Math.random() * OFFLINE_MESSAGES.length); }
  while (idx === lastOfflineIdx); // 避免连续两次相同
  lastOfflineIdx = idx;
  return OFFLINE_MESSAGES[idx];
}

function updateOnlineUI(online) {
  if (!offlineBar) return;
  if (online) {
    offlineBar.classList.add('offline-bar--hidden');
  } else {
    // 文案写入 .offline-bar__text，三点是独立的 .offline-bar__dots
    const textEl = offlineBar.querySelector('.offline-bar__text');
    if (textEl) textEl.textContent = pickOfflineMessage();
    offlineBar.classList.remove('offline-bar--hidden');
  }
}

/**
 * 完成庆祝（粉色爱心粒子 + 音效 + 震动 + Toast）
 * 仅当特效开关开启时执行粒子/音效/震动；Toast 始终显示
 */
// 爱心 SVG path（标准心形，用于 confetti shapeFromPath，颜色由 colors 平涂，可控）
const HEART_PATH = 'M167 72c-30 0-55 24-55 55 0-31-25-55-55-55C16 72-31 119-31 188c0 90 143 168 143 168s143-78 143-168c0-69-47-116-88-116z';

// 缓存爱心形状（shapeFromPath 需要计算，只算一次）
let heartShape = null;
function getHeartShape() {
  if (heartShape) return heartShape;
  try {
    // canvas-confetti shapeFromPath：传入 SVG path，返回爱心形状对象。
    // 不依赖 emoji 渲染（避免安卓 WebView 把 ❤ 渲染成黑色），颜色由 colors 控制。
    heartShape = confetti.shapeFromPath ? confetti.shapeFromPath({ path: HEART_PATH }) : null;
  } catch (e) {
    console.warn('[fx] shapeFromPath 失败，回退默认形状:', e.message);
    heartShape = null;
  }
  return heartShape;
}

// 情感色常量（与 CSS --rose-* 同源，confetti 用）：mint 主色 + rose 情感色和谐共舞
const ROSE = ['#f43f5e', '#fb7185', '#fda4af'];

// 普通完成：鼓励文案随机池（无进度型，保持温度感）
const COMPLETE_PHRASES = [
  '太棒了！',
  '又搞定一个！',
  '干净利落！',
  '一步一步来，真稳。',
  '这就去掉了心头一件事。',
];

// 隐藏款完成：按稀有度的专属文案（替代普通鼓励池）
const RARITY_COMPLETE_TEXT = {
  rare: '✨ 稀有款，完成。',
  epic: '🌟 史诗款达成了，不简单。',
  legendary: '👑 传说款完成，这一刻值得记住。',
};

// 完成提示用的勾图标（白色，配 success 变体）
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

/**
 * 完成庆祝。
 * @param {Object|string} todo  待办对象（读 .rarity / .text 分支）；兼容旧字符串入参
 * @param {boolean} isRemote    true=对方完成（不发光环，避免重复打扰）
 */
function celebrateCompletion(todo, isRemote = false) {
  // 兼容旧的字符串入参（handleRemoteCompleted 早期传字符串）
  const obj = typeof todo === 'string' ? { text: todo } : (todo || {});
  const text = obj.text || '完成';
  const rarity = obj.rarity;

  if (isHidden(rarity)) {
    // ===== 隐藏款完成：专属文案 + 配色 toast + rarity 粒子 + 卡片光环 =====
    const meta = RARITY_META[rarity];
    const basePhrase = RARITY_COMPLETE_TEXT[rarity] || meta.toast;
    // 远端完成：带上对方 + 待办内容语义，不丢失信息
    const phrase = isRemote ? `${basePhrase}（${text}）` : basePhrase;
    // 贴纸图标作为 toast 图标（取该稀有度第一张贴纸）
    const icon = meta.stickerIcons ? meta.stickerIcons[0] : '';
    showToast(phrase, { variant: 'rarity', accent: meta.colors[0], icon, duration: 3000 });
    // 叠加 rarity 专属粒子（复用开奖配色：rare 克制不撒花 / epic 玫红 / legendary 金）
    celebrateRarity(rarity, text);
    // 卡片光环（仅本端完成时，卡片在视野内才发）
    if (!isRemote && obj.id) burstCardRing(obj.id, rarity);
    return;
  }

  // ===== 普通完成：随机鼓励文案 + 品牌色 toast =====
  const phrase = COMPLETE_PHRASES[Math.floor(Math.random() * COMPLETE_PHRASES.length)];
  showToast(phrase, { variant: 'success', icon: CHECK_ICON });

  if (!isFxEnabled()) return;
  // 尊重 prefers-reduced-motion：前庭敏感用户跳过粒子/音效/震动，只留 Toast
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // 配色：mint 主色 + rose 情感色，两套色在完成时刻和谐共舞
  const rootStyle = getComputedStyle(document.documentElement);
  const primary = rootStyle.getPropertyValue('--color-primary').trim() || '#10b981';
  const colors = [primary, ...ROSE, '#fbbf24'];

  const shape = getHeartShape();
  const baseOpts = {
    spread: 75,
    startVelocity: 42,
    ticks: 220,
    gravity: 1,
    decay: 0.92,
    scalar: 1.3,          // 爱心稍大一点更醒目
    flat: false,
    colors,
    shapes: shape ? [shape] : undefined,
  };

  // 中间一束（主）
  confetti({ ...baseOpts, particleCount: 45, origin: { y: 0.6 } });
  // 左右各补一束，更有层次
  setTimeout(() => confetti({ ...baseOpts, particleCount: 20, angle: 60, spread: 55, origin: { x: 0, y: 0.65 } }), 150);
  setTimeout(() => confetti({ ...baseOpts, particleCount: 20, angle: 120, spread: 55, origin: { x: 1, y: 0.65 } }), 150);

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
 * 隐藏款完成瞬间：卡片光环扩散（完成专属动作，开奖没有）。
 * 定位到完成的卡片，叠加 rarity 配色光环：rare 单圈 / epic 双圈错时 / legendary 三圈+卡片金光爆发。
 * 卡片不在 DOM（远端完成/已滚动离开）则静默跳过。
 */
function burstCardRing(todoId, rarity) {
  if (!todoId || !isHidden(rarity)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const li = document.querySelector(`.todo[data-id="${CSS.escape(todoId)}"]`);
  if (!li) return; // 卡片不在视野，静默跳过

  const color = (RARITY_META[rarity].colors || ['#fda4af'])[0];
  const ringCount = rarity === 'legendary' ? 3 : (rarity === 'epic' ? 2 : 1);

  for (let i = 0; i < ringCount; i++) {
    setTimeout(() => {
      const ring = document.createElement('span');
      ring.className = 'todo__burst-ring';
      ring.style.setProperty('--burst-color', color);
      li.appendChild(ring);
      // 下一帧启动动画（让浏览器先把元素画上）
      requestAnimationFrame(() => ring.classList.add('todo__burst-ring--go'));
      // 动画结束后清理
      setTimeout(() => { if (ring.parentNode) ring.remove(); }, 800);
    }, i * 150); // 错时扩散，层次感
  }

  // 传说款额外：卡片整体金光爆发
  if (rarity === 'legendary') {
    li.classList.add('todo--burst-legendary');
    setTimeout(() => li.classList.remove('todo--burst-legendary'), 750);
  }
}

/**
 * 带感完成居中蓄力层（长按复选框弹出）。
 * 半透明遮罩接管全屏交互（消除与卡片长按菜单的冲突），中央大爱心+进度环可见（不被手指挡）。
 * 松手即完成：蓄满=带感（飞心+贴heart），未蓄满=普通完成。
 */
const HEARTFUL_CHARGE_MS = 600; // 蓄力时长（进度环填满）
let heartfulEl = null;          // 蓄力层 DOM
let heartfulState = { active: false, charged: false, todo: null, fromEl: null, chargeTimer: null };
let heartfulDocHandlers = null; // document 级松手/触摸监听（蓄力期间）

function openHeartfulCharge(todo, fromEl) {
  if (heartfulState.active) return;
  heartfulEl = document.getElementById('heartfulCharge');
  if (!heartfulEl) return;
  heartfulState = { active: true, charged: false, todo, fromEl, chargeTimer: null };

  heartfulEl.hidden = false;
  // 下一帧启动进度环动画（让浏览器先画出元素）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => heartfulEl.classList.add('heartful-charge--charging'));
  });

  // 蓄力计时：到点标记 charged（爱心脉动提示"可以松手了"）
  heartfulState.chargeTimer = setTimeout(() => {
    if (heartfulState.active) {
      heartfulState.charged = true;
      heartfulEl.classList.add('heartful-charge--charged');
      if (navigator.vibrate) { try { navigator.vibrate(20); } catch (_) {} }
    }
  }, HEARTFUL_CHARGE_MS);

  // 遮罩点击 = 取消（不完成）
  const overlay = heartfulEl.querySelector('.heartful-charge__overlay');
  overlay.addEventListener('click', onHeartfulCancel, { once: true });

  // document 级松手监听：蓄力期间任何 pointerup/touchend → 按 charged 状态完成
  heartfulDocHandlers = {
    up: () => finishHeartfulCharge(),
    // pointercancel：系统打断（通知下拉等）。蓄满了仍完成（心意已表达），未满才取消
    cancel: () => finishHeartfulCharge(!heartfulState.charged),
  };
  document.addEventListener('pointerup', heartfulDocHandlers.up);
  document.addEventListener('touchend', heartfulDocHandlers.up);
  document.addEventListener('pointercancel', heartfulDocHandlers.cancel);
}

/** 松手完成：charged=带感，否则普通完成；fromCancel=取消（不完成） */
function finishHeartfulCharge(fromCancel = false) {
  if (!heartfulState.active) return;
  const { todo, charged, fromEl } = heartfulState;
  closeHeartfulCharge();
  if (!todo) return;
  // 取消（拖出/pointercancel）→ 不完成
  if (fromCancel) return;
  // 蓄满 → 带感完成（飞心起点用蓄力层爱心，fromEl 传它）；未蓄满 → 普通完成
  if (charged) {
    const heartIcon = heartfulEl ? heartfulEl.querySelector('.heartful-charge__icon') : fromEl;
    toggleComplete(todo.id, true, { heartful: true, fromEl: heartIcon || fromEl });
  } else {
    toggleComplete(todo.id, true);
  }
}

/** 取消（点遮罩） */
function onHeartfulCancel() {
  closeHeartfulCharge();
}

/** 关闭蓄力层 + 清理监听/计时 */
function closeHeartfulCharge() {
  if (heartfulState.chargeTimer) { clearTimeout(heartfulState.chargeTimer); }
  if (heartfulDocHandlers) {
    document.removeEventListener('pointerup', heartfulDocHandlers.up);
    document.removeEventListener('touchend', heartfulDocHandlers.up);
    document.removeEventListener('pointercancel', heartfulDocHandlers.cancel);
    heartfulDocHandlers = null;
  }
  if (heartfulEl) {
    heartfulEl.classList.remove('heartful-charge--charging', 'heartful-charge--charged');
    heartfulEl.hidden = true;
  }
  heartfulState = { active: false, charged: false, todo: null, fromEl: null, chargeTimer: null };
}

/**
 * 带感完成：一颗心从复选框飞向顶栏桃心（爱意送达的视觉隐喻）。
 * @param {HTMLElement} fromEl 飞行起点（复选框）
 */
function flyHeartToTopbar(fromEl) {
  const heart = document.getElementById('anniHeart');
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!fromEl || !heart) {
    if (heart) pulseTopbarHeart(heart);
    return;
  }

  const startRect = fromEl.getBoundingClientRect();
  const startX = startRect.left + startRect.width / 2;
  const startY = startRect.top + startRect.height / 2;
  const endRect = heart.getBoundingClientRect();
  const endX = endRect.left + endRect.width / 2;
  const endY = endRect.top + endRect.height / 2;

  // reduced-motion：跳过飞行，只让桃心跳一下
  if (reduceMotion) {
    pulseTopbarHeart(heart);
    return;
  }

  const fly = document.createElement('div');
  fly.className = 'fly-heart';
  fly.style.left = startX + 'px';
  fly.style.top = startY + 'px';
  document.body.appendChild(fly);

  requestAnimationFrame(() => {
    fly.classList.add('fly-heart--flying');
    fly.style.setProperty('--end-x', (endX - startX) + 'px');
    fly.style.setProperty('--end-y', (endY - startY) + 'px');
  });

  // 飞行中段让桃心准备接收；结束清理
  setTimeout(() => pulseTopbarHeart(heart), 520);
  setTimeout(() => { if (fly.parentNode) fly.remove(); }, 850);
}

/** 顶栏桃心接收跳动（带感完成的爱意送达） */
function pulseTopbarHeart(heart) {
  if (!heart) return;
  heart.classList.remove('topbar__heart--receive');
  void heart.offsetWidth; // 强制 reflow 重启动画
  heart.classList.add('topbar__heart--receive');
  setTimeout(() => heart.classList.remove('topbar__heart--receive'), 600);
}

/**
 * 带感完成首次引导：完成"对方创建的"待办时，复选框上方弹一次性气泡。
 * localStorage 记 flag，只提示一次，不反复打扰。
 */
function showHeartfulHint(todoId) {
  const KEY = 'heartfulHintShown';
  try { if (localStorage.getItem(KEY)) return; } catch { return; }

  const li = document.querySelector(`.todo[data-id="${CSS.escape(todoId)}"]`);
  if (!li) return;
  // 完成后卡片已下沉到已完成区，复选框已隐藏（opacity:0），用 li 定位气泡
  const hint = document.createElement('span');
  hint.className = 'todo__check-hint';
  hint.textContent = '长按 ○ 可以带着心意完成 →';
  li.appendChild(hint);
  requestAnimationFrame(() => hint.classList.add('todo__check-hint--show'));

  setTimeout(() => {
    hint.classList.remove('todo__check-hint--show');
    setTimeout(() => { if (hint.parentNode) hint.remove(); }, 300);
  }, 5000);

  try { localStorage.setItem(KEY, '1'); } catch {}
}

/**
 * 远端完成回调：对方完成了任务，本端也庆祝
 */
function handleRemoteCompleted(todo) {
  if (!todo || !todo.completed) return;
  // 对方完成：传 todo 对象（读 rarity），但 isRemote=true 不发光环（卡片可能不在视野/避免重复打扰）
  // 文案前缀加"对方完成了"，rarity 分支会在此基础上替换为隐藏款专属文案时保留对方语义
  celebrateCompletion({ ...todo, text: '对方完成了「' + (todo.text || '') + '」' }, true);
}

/**
 * 隐藏款揭晓回调：对方开出的隐藏款首次推来（raritySeen=false 且非自己创建）。
 * 本端播一次惊喜提示，然后回标 rarity_seen=true（避免重复提示）。
 */
function handleRarityReveal(todo) {
  if (!todo || !isHidden(todo.rarity)) return;
  const meta = RARITY_META[todo.rarity];
  const name = displayOf(todo.createdBy).name || '对方';
  showToast(`${meta.toast.replace(/[！]/g, '')}（${name} 开出的）`);
  // 高稀有度也撒花（和开奖同等仪式感）
  celebrateRarity(todo.rarity, todo.text);
  // 回标已看过，避免再次提示（失败静默）
  db.markRaritySeen(todo.id).catch(() => {});
}

/**
 * Realtime 图鉴解锁回调：贴纸被解锁（自己或对方触发），更新本地状态 + 红点 + 撒花。
 * state.addOrUpdateSticker 由 onRollRarity 内部已调；这里处理 Realtime 推来的（对方解锁）。
 */
function handleStickerUnlockedFromRealtime(sticker) {
  if (!sticker) return;
  // 增量更新本地图鉴状态（幂等）
  addOrUpdateSticker(sticker);
  // 触发图鉴模块的红点/弹层刷新 + 撒花视图反馈
  handleStickerUnlocked(sticker);
}

/**
 * 图鉴解锁的视图层撒花反馈（由 sticker-book 模块在解锁时回调）。
 */
function onStickerUnlockedView(sticker) {
  if (!sticker) return;
  if (!isFxEnabled()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = RARITY_META[sticker.rarity] ? RARITY_META[sticker.rarity].confettiColors : null;
  if (!colors) return;
  // 克制的单束撒花（图鉴解锁的仪式感，但不喧宾夺主）
  confetti({ particleCount: 25, spread: 60, startVelocity: 35, ticks: 180, colors, origin: { y: 0.5 }, scalar: 1.1 });
}

/**
 * 对方贴表情时，给对应待办一个轻量脉冲反馈（克制，不弹通知）
 */
function pulseTodoOnRemoteReaction(todoId) {
  const li = todoListEl.querySelector(`.todo[data-id="${todoId}"]`);
  if (!li) return;
  const wrap = li.querySelector('.todo__reactions');
  if (!wrap) return;
  wrap.classList.remove('todo__reactions--pulse');
  // 强制 reflow 以重启动画
  void wrap.offsetWidth;
  wrap.classList.add('todo__reactions--pulse');
  setTimeout(() => wrap.classList.remove('todo__reactions--pulse'), 700);
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
