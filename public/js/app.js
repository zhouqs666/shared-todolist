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
import { pickImage, pickImages, uploadTodoImage } from './image-utils.js';
import { checkForUpdate, setUpdateSupabase, notifyAppReady, getCurrentBundleInfo } from './update.js';
import confetti from './vendor/canvas-confetti.esm.min.js';
import { supabase } from './supabase.js';
import { showToast } from './toast.js';
import { rollRarity, isHidden, applyRarity, celebrateRarity, onRollRarity, RARITY_META } from './blindbox.js';
import { initStickerBook, handleStickerUnlocked } from './sticker-book.js';
// 图片全屏预览（lightbox）已从本文件拆出到 ./lightbox.js（技术清单第8条：app.js 过长）
// 通过 handlers 注入 attachImageToTodo / removeImageFromTodo，避免与 db/state 形成紧耦合
import { openImageLightbox } from './lightbox.js';
// 纪念日模块（在一起天数 + 倒计时面板）已拆出到 ./anniversary.js（技术清单第8条）
import { renderAnniversary, toggleAnniversaryPanel } from './anniversary.js';

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
  // 监听器治理（技术清单第5条）：保存返回值，beforeunload 时 cleanup
  let presence = null, lastSeenTimer = null, heartTintTimer = null;
  // （presence/lastSeenTimer 在下方 if(partnerId) 块内赋值，heartTintTimer 在紧跟其后，
  //   cleanup 需跨作用域访问，故提前用 let 声明在此）
  const realtimeCh = initRealtime({
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
  heartTintTimer = setInterval(applyHeartTint, 5 * 60 * 1000);

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
      presence = initPresence({
        userId: currentUser.id,
        partnerId,
        onPartnerOnline: setHeartExcited,
      });
    } catch (e) {
      console.warn('[presence] 启动失败:', e.message);
    }
    // last_seen 心跳：立即写一次 + 每 60s 写一次
    db.updateLastSeen(currentUser.id).catch((e) => console.warn('[db] last_seen 写入失败:', e.message));
    lastSeenTimer = setInterval(() => {
      db.updateLastSeen(currentUser.id).catch(() => {});
    }, 60 * 1000);
  }

  // 监听器治理（技术清单第5条）：beforeunload 时统一 cleanup，
  // 避免页面快速刷新/重载残留 Realtime channel 与定时器（资源泄漏 + 可能触发无效回调）。
  // 各项均判空：对应初始化若因条件不满足（如无 partnerId）而未执行，跳过即可。
  window.addEventListener('beforeunload', () => {
    try {
      if (realtimeCh && typeof realtimeCh.unsubscribe === 'function') realtimeCh.unsubscribe();
    } catch (e) { /* cleanup 失败不应阻塞卸载 */ }
    try {
      if (presence && typeof presence.unsubscribe === 'function') presence.unsubscribe();
    } catch (e) { /* 同上 */ }
    if (heartTintTimer) clearInterval(heartTintTimer);
    if (lastSeenTimer) clearInterval(lastSeenTimer);
  });

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

  // [热更新自检 v2.7.15] 仅 console 打日志，对 App 视觉/交互无任何影响。
  // 用于验证热更新链路：远程调试时在 console 看到 "v2.7.15" 即说明热更新已生效。
  console.log('%c有爱 v2.7.15 已加载', 'color:#f43f5e;font-weight:bold');

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
  // 预挂图按钮：选图存入 pendingImage，面板上方浮现缩略图预览（可 × 取消）
  if (attachBtn) {
    attachBtn.addEventListener('click', async () => {
      const file = await pickImage();
      if (!file) return;
      pendingImage = file;
      attachBtn.classList.add('add-panel__attach--has');
      renderAttachPreview(file);
    });
  }
}

/** 已选图片的本地预览 URL（× 取消/提交/关面板时 revoke，防内存泄漏） */
let attachPreviewUrl = null;

/** 渲染预挂图预览：缩略图 + × 取消（悬浮在添加面板上方） */
function renderAttachPreview(file) {
  const wrap = document.getElementById('attachPreview');
  if (!wrap) return;
  if (attachPreviewUrl) URL.revokeObjectURL(attachPreviewUrl);
  attachPreviewUrl = URL.createObjectURL(file);
  wrap.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'add-panel__preview-img';
  img.src = attachPreviewUrl;
  img.alt = '已选图片预览';
  wrap.appendChild(img);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'add-panel__preview-cancel';
  cancel.setAttribute('aria-label', '取消已选图片');
  cancel.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  cancel.addEventListener('click', resetPendingImage);
  wrap.appendChild(cancel);
  wrap.hidden = false;
}

/** 清空预挂图状态：pendingImage + 已选角标 + 预览（提交成功 / ×取消 / 关面板共用） */
function resetPendingImage() {
  pendingImage = null;
  if (attachBtn) attachBtn.classList.remove('add-panel__attach--has');
  const wrap = document.getElementById('attachPreview');
  if (wrap) {
    wrap.hidden = true;
    wrap.innerHTML = '';
  }
  if (attachPreviewUrl) {
    URL.revokeObjectURL(attachPreviewUrl);
    attachPreviewUrl = null;
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

/** 收起添加面板（未提交的预挂图一并清掉，避免残留到下一条待办） */
function closeAddPanel() {
  if (!addPanel || !addOverlay) return;
  addPanel.classList.remove('add-panel--show');
  addOverlay.classList.remove('add-overlay--show');
  resetPendingImage();
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
        // 走多图列 image_paths（统一存储；旧 image_path 列仅作历史回退读）
        await db.setImagePaths(todo.id, [url]);
        todo.imagePaths = [url];
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
    resetPendingImage(); // 提交成功才清预挂图（失败路径不清，保留以便重试）
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

async function toggleComplete(id, nextCompleted) {
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
  // 本端完成 → 庆祝动画（彩带/震动，特效开关默认常开）
  if (nextCompleted) celebrateCompletion(current);
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
 * 给已存在的待办配图/换图（长按菜单入口）。
 * 选图 → 压缩上传 → 写入 image_path（含旧图清理）→ 乐观更新本地。
 * 任一步失败：Toast 提示，不影响待办本身。
 * @param {string} id todo id
 * @param {string[]|null} prevPaths 旧图 URL 数组（追加时基于此扩展）
 */
async function attachImageToTodo(id, prevPaths) {
  const files = await pickImages();
  if (!files || files.length === 0) return; // 用户取消
  showLoading();
  try {
    // 串行上传（避免并发触发 Supabase 免费层限流；多图通常 2-3 张，可接受）
    const newUrls = [];
    for (const f of files) {
      newUrls.push(await uploadTodoImage(id, f));
    }
    const base = Array.isArray(prevPaths) ? prevPaths.slice() : [];
    const combined = base.concat(newUrls);
    const todo = await db.setImagePaths(id, combined);
    setTodos(sortTodos(getTodos().map((t) => (t.id === id ? todo : t))));
    showToast(files.length > 1 ? '已配 ' + files.length + ' 张图' : '已配图');
  } catch (err) {
    console.error('[app] 配图失败:', err);
    handleError(toAppError(err), '配图失败，请重试');
  } finally {
    hideLoading();
  }
}

/**
 * 删除已存在待办的当前图（lightbox 入口）。
 * 只解绑待办与该图的关系（从 image_paths 数组移除），Storage 文件保留作后路（软删除精神）。
 * db.setImagePaths(id, remaining) → 乐观更新本地。
 * @param {string} id todo id
 * @param {string} urlToRemove 要删除的图 URL
 * @param {string[]|null} prevPaths 旧图 URL 数组
 */
async function removeImageFromTodo(id, urlToRemove, prevPaths) {
  const base = Array.isArray(prevPaths) ? prevPaths.slice() : [];
  const remaining = base.filter((u) => u !== urlToRemove);
  showLoading();
  try {
    const todo = await db.setImagePaths(id, remaining);
    setTodos(sortTodos(getTodos().map((t) => (t.id === id ? todo : t))));
    showToast('已删除图片');
  } catch (err) {
    console.error('[app] 删图失败:', err);
    handleError(toAppError(err), '删除图片失败，请重试');
  } finally {
    hideLoading();
  }
}

/* ===== 完成备注：底部滑出输入面板（一次性模态，复用 add-panel 滑出风格）=====
 * 长按已完成待办 → 备注 → 弹此面板。覆盖语义：输入框预填原备注，可改可清空。
 * 不自动保存（必须点保存才写入，避免误触覆盖）。
 */
// 备注占位文案池：每次打开面板随机抽一条，诗意且贴备注场景（收尾交代/叮嘱留话）。
// 风格：短、留白，像两人之间给某件事留的便条，完成前后都适用。
const NOTE_PLACEHOLDERS = [
  '事毕，灯也熄了',
  '花浇过了，安心睡',
  '窗已关严，风进不来',
  '先搁着，等你回来再说',
  '信已寄出，风替我送',
  '这事我记下了',
  '路远，慢慢来不急',
  '雨大，今日不出门',
  '做完了，你先歇',
  '留半盏灯，等你回',
];
function pickNotePlaceholder() {
  return NOTE_PLACEHOLDERS[Math.floor(Math.random() * NOTE_PLACEHOLDERS.length)];
}
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
  textarea.placeholder = pickNotePlaceholder();
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

/* ===== 编辑待办文案：底部滑出输入面板（复用 note-panel 滑出风格）=====
 * 长按待办 → 编辑 → 弹此面板。预填原 text，可改；空文本不允许。
 */
function openEditPanel(todo) {
  if (document.querySelector('.note-input-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'note-input-overlay';
  const latest = getTodos().find((t) => t.id === todo.id) || todo;

  const panel = document.createElement('div');
  panel.className = 'note-input-panel';

  const handle = document.createElement('div');
  handle.className = 'note-input-panel__handle';
  panel.appendChild(handle);

  const label = document.createElement('div');
  label.className = 'note-input-panel__label';
  label.textContent = '编辑待办';
  panel.appendChild(label);

  const textarea = document.createElement('textarea');
  textarea.className = 'note-input-panel__textarea';
  textarea.maxLength = 200; // 与 todos.text 的 CHECK 一致
  textarea.rows = 2;
  textarea.value = latest.text || '';
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEditText(latest.id, textarea.value.trim());
    }
  });
  panel.appendChild(textarea);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'note-input-panel__save';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => saveEditText(latest.id, textarea.value.trim()));
  panel.appendChild(saveBtn);

  overlay.appendChild(panel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeNotePanel(); });
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => overlay.classList.add('note-input-overlay--show'));
  setTimeout(() => textarea.focus(), 280);
  document.addEventListener('keydown', onNoteEsc);
  function onNoteEsc(e) {
    if (e.key === 'Escape') {
      closeNotePanel();
      document.removeEventListener('keydown', onNoteEsc);
    }
  }
}

/**
 * 保存编辑后的待办文案（乐观更新 + 失败回滚）。
 * 空文本不允许（待办必须有内容）。
 */
async function saveEditText(id, text) {
  if (!text) { showToast('内容不能为空'); return; }
  const current = getTodos().find((t) => t.id === id);
  const prev = current && current.text;
  if (current) {
    current.text = text;
    setTodos(getTodos()); // 触发重渲染
  }
  closeNotePanel();
  try {
    await db.updateTodoText(id, text);
    showToast('已保存');
  } catch (err) {
    const target = getTodos().find((t) => t.id === id);
    if (target) target.text = prev;
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
// 已拆出到 ./anniversary.js（技术清单第8条），app.js 只保留调用点：
//   - init 时：setTimeout(renderAnniversary, 1000)
//   - 顶栏爱心 click/keydown + 面板 click：toggleAnniversaryPanel()
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
    // 品牌渐变大爱心（与顶栏桃心同款渐变，跨设备一致）
    const heart = document.createElement('div');
    heart.className = 'todo-list__empty-heart';
    heart.innerHTML =
      '<svg viewBox="0 0 24 24" width="52" height="52" aria-hidden="true">' +
      '<defs><linearGradient id="emptyHeartGrad" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#e11d48"/>' +
      '</linearGradient></defs>' +
      '<path d="M12 21s-7.5-4.7-7.5-10.2C4.5 7.6 7 5.5 9.8 5.5c1.4 0 2.7.7 3.2 1.8.5-1.1 1.8-1.8 3.2-1.8 2.8 0 5.3 2.1 5.3 5.3C21.5 16.3 12 21 12 21z" fill="url(#emptyHeartGrad)"/></svg>';
    const text = document.createElement('div');
    text.className = 'todo-list__empty-text';
    text.textContent = '这里空空的，像在等你';
    const sub = document.createElement('div');
    sub.className = 'todo-list__empty-sub';
    sub.textContent = '写下第一条，和 ta 一起开始';
    li.appendChild(heart);
    li.appendChild(text);
    li.appendChild(sub);
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
  let newCount = 0; // 本轮新建的卡片数（用于首屏阶梯入场）
  todos.forEach((todo) => {
    let el = existing.get(todo.id);
    if (el) {
      updateItem(el, todo); // 原地更新（无动画）
    } else {
      el = renderItem(todo); // 新增项：带入场动画
      // 首屏批量渲染时阶梯入场：前 8 张每张延迟 30ms（倾泻而下的节奏），
      // 之后的立即出现（视口外没必要等）；单张新增（用户添加/远端来一条）delay=0 即时入场
      if (newCount < 8) el.style.animationDelay = `${newCount * 30}ms`;
      newCount++;
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
  }
  // 备注：完成前后均可加，用「」包裹，像一句轻声的话，区别于其他 meta 信息
  if (todo.completedNote) {
    meta += ` ·「${todo.completedNote}」`;
  }
  return meta;
}

/**
 * 渲染/更新「有图」徽标（原地增删，绝不重建 li）。
 * 由 renderItem（新建）和 updateItem（更新）统一调用，与 renderReactions 同模式。
 *
 * 设计取舍（2026-08-04 改版）：图片不再默认展开（太占屏），改为一个小相纸图标徽标，
 * 紧跟主文案之后（headline 行内，不额外占行）。点击徽标 → 弹全屏 lightbox 查看大图，
 * lightbox 内含「删除图片」按钮。
 */
function renderImage(li, todo) {
  const shouldShow = !!todo.imagePath;
  const headline = li.querySelector('.todo__headline');
  const existing = li.querySelector('.todo__image-badge');

  if (shouldShow) {
    if (!existing && headline) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'todo__image-badge';
      badge.setAttribute('aria-label', '查看图片');
      badge.title = '查看图片';
      badge.innerHTML = ICONS.image;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const latest = getTodos().find((t) => t.id === todo.id);
        if (latest && latest.imagePath) openImageLightbox(latest, {
          onAddImage: attachImageToTodo,
          onRemoveImage: removeImageFromTodo,
        });
      });
      headline.appendChild(badge);
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

  // 轻点完成/取消完成（实时取 latest，竞态保护逻辑在 toggleComplete 内）。
  // 按住超过 350ms 的松手 click 不算轻点：长按已统一由卡片菜单接管，
  // 若不拦截，长按复选框弹菜单的同时松手 click 会误完成待办。
  let checkDownAt = 0;
  checkbox.addEventListener('pointerdown', () => { checkDownAt = Date.now(); });
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() - checkDownAt > 350) return;
    const latest = getTodos().find((t) => t.id === todo.id);
    toggleComplete(todo.id, latest ? !latest.completed : !todo.completed);
  });

  // 文本与元信息
  const body = document.createElement('div');
  body.className = 'todo__body';

  // headline：主文案 + 图片徽标同一行（徽标紧跟文案后边，不单独占行撑高卡片）
  const headline = document.createElement('div');
  headline.className = 'todo__headline';

  const textEl = document.createElement('div');
  textEl.className = 'todo__text';
  textEl.textContent = todo.text; // textContent 防注入
  headline.appendChild(textEl);

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

  body.appendChild(headline);
  body.appendChild(metaEl);

  li.appendChild(checkbox);
  li.appendChild(body);

  // 图片缩略图（有就显示，由 renderImage 统一管理）
  renderImage(li, todo);

  // 表情反应区（仅已完成时显示，由 reactions 模块管理）
  renderReactions(li, todo);

  // 隐藏款稀有度样式（背景渐变 + 角标，由 applyRarity 统一管理）
  applyRarity(li, todo);

  // 长按弹出操作菜单（移动端长按 / 桌面端右键，各走各路不冲突）
  let pressTimer = null;
  const startPress = (e) => {
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

/**
 * 显示待办操作菜单（底部 action sheet 风格）
 */
function showTodoMenu(todo, liEl) {
  // 关掉已存在的菜单
  closeTodoMenu();
  // 关键：从 state 取最新 todo，而非闭包里的旧引用。
  // 避免完成状态变化后，菜单仍按旧状态显示选项。
  const latest = getTodos().find((t) => t.id === todo.id);
  if (latest) todo = latest;

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

  // 编辑待办文案（改文字内容，不动 completed/created_by 等其他字段）
  const editBtn = mkIconBtn(ICONS.edit, '编辑');
  editBtn.addEventListener('click', () => {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    closeTodoMenu();
    openEditPanel(todo);
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
      openNotePanel(todo);
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
    await attachImageToTodo(todo.id, todo.imagePaths);
  });
  actions.appendChild(imageBtn);

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
  // 主文案：编辑待办后 text 会变，原地更新（不重建 li，避免动画/状态抖动）
  const textEl = li.querySelector('.todo__text');
  if (textEl && textEl.textContent !== todo.text) {
    textEl.textContent = todo.text;
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
  const primary = rootStyle.getPropertyValue('--color-primary').trim() || '#f43f5e';
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
