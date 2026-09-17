/**
 * 悄悄留言（阅后即焚）
 *
 * 重新定位：不是日常闲聊，而是「当面说不出口的话」——
 * 给对方的惊喜，或化解矛盾的剖白。极低频，一次性。
 *
 * 形态：
 *   - 写入口：藏在纪念日面板里，一个不违和的小图标（羽毛笔）
 *   - 提醒：顶栏一个神秘小图标，有对方留言时淡淡呼吸灯
 *   - 阅读：点开弹窗，看完点「收下了」即焚，不留存
 *
 * 数据语义：每条留言独立保留，互不覆盖。连发多条，对方全部可见。
 * 阅后即焚是逐条的：读一条焚一条，不碰其他留言。
 */

import { db } from './db.js';
import { textToHeart } from './text-to-heart.js';
import { showToast } from './toast.js';

/** @type {Object|null} 当前用户 */
let currentUser = null;
/** @type {Object} userId → { displayName } */
let userMap = {};

/** 全部留言（自己发的 + 对方发的） */
let notes = [];
/**
 * 「已由 Realtime 落地」的留言变更计数 —— 供 refreshNotes 判断某次补拉的快照是否已过时：
 * 拉取期间若有留言落地，那份快照就比本地旧，整份替换会把它抹掉（反而造成"铃铛不亮"）。
 */
let noteEventSeq = 0;

// DOM 引用
let bellEl = null;       // 顶栏神秘图标
let modalEl = null;      // 弹窗
let writePane = null;    // 写入态
let readPane = null;     // 阅读态
let inputEl = null;
let sendBtn = null;
let fromEl = null;
let contentEl = null;
let dismissBtn = null;
let countEl = null;       // 字数显示
let counterEl = null;     // 字数指示器容器
let echoEl = null;        // 送达回响文案
let dismissTextEl = null; // "阅/下一条" 文案节点

// ===== 长按珍藏状态 =====
const PRESS_DURATION = 600; // 长按阈值（ms），超过即珍藏
let pressTimer = null;
let isPressing = false;
let pressDismissed = false; // 防止 click 在长按成功后又触发

// ===== 草稿（按天 localStorage，关闭保留、发送清除）=====
let draftTimer = null;

// ===== 文案池 =====
const PLACEHOLDER_POOL = [
  '当面说不出口的话，轻轻留在 ta 的屏幕上…',
  '今天有什么想悄悄说的吗',
  'ta 打开时会看到这句话…',
  '写下来，就不算没说过',
];
const ECHO_POOL = [
  '心意已悄悄飞出去啦',
  '飞向 ta 的路上，请安心',
  '写下的每个字，都被小心收着',
];

/**
 * 初始化
 * @param {Object} opts.currentUser
 * @param {Object} opts.userMap
 */
export async function initMessages({ currentUser: user, userMap: map }) {
  currentUser = user;
  userMap = map || {};

  bellEl = document.getElementById('noteBell');
  modalEl = document.getElementById('noteModal');
  writePane = document.getElementById('noteWrite');
  readPane = document.getElementById('noteRead');
  inputEl = document.getElementById('noteInput');
  sendBtn = document.getElementById('noteSend');
  fromEl = document.getElementById('noteFrom');
  contentEl = document.getElementById('noteContent');
  dismissBtn = document.getElementById('noteDismiss');
  countEl = document.getElementById('noteCount');
  counterEl = document.getElementById('noteCounter');
  echoEl = document.getElementById('noteEcho');
  dismissTextEl = dismissBtn ? dismissBtn.querySelector('.note-read__dismiss-text') : null;
  if (!bellEl || !modalEl) return;

  // 绑定事件
  // 顶栏图标：点开 → 有对方未读留言则阅读（取最早一条），否则不响应
  bellEl.addEventListener('click', () => {
    const incoming = getIncomingNotes();
    if (incoming.length > 0) openReadMode(incoming[0]);
  });

  // 纪念日面板里的写入口
  const writeBtn = document.getElementById('writeNoteBtn');
  if (writeBtn) {
    writeBtn.addEventListener('click', () => {
      // 关掉纪念日面板，打开留言写入弹窗
      closeAnniPanelIfOpen();
      openWriteMode();
    });
  }

  // 写入态：字数计数（实时更新 + 接近上限暖橙提示）+ 草稿自动保存
  if (inputEl) {
    inputEl.addEventListener('input', () => {
      updateCounter();
      debouncedSaveDraft();
    });
  }

  // 写入态按钮
  sendBtn.addEventListener('click', submitNote);
  document.getElementById('noteCancel').addEventListener('click', closeModal);
  // "阅/下一条"：最后一条长按珍藏，多条时点按翻页（长按手势在下方单独绑定）
  document.getElementById('noteDismiss').addEventListener('click', onDismiss);

  // 点遮罩关闭
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeModal();
  });
  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
  });

  // 拉取留言（逐条保留，按时间正序）
  await refreshNotes();
}

/**
 * 重新拉取留言并刷新铃铛（冷启动 / 断线重连 / 回前台共用）。
 * 为什么需要：留言**只在冷启动拉这一次**，而 Realtime 的复制槽不重放历史 ——
 * 断线期间（切后台被系统挂起、切网络、隧道）对方写的「心里话」本端永远收不到，
 * 表现是**顶栏铃铛一直不亮**，用户根本不知道有留言。
 * 所以断线重连 / 回前台必须补拉一次。
 *
 * ⚠️ 「拉取期间有新留言落地」时必须放弃本次替换（见 noteEventSeq）：
 * 否则会把刚由 Realtime 推来的那条抹掉 —— 反而制造了本函数要修的那个症状（铃铛不亮）。
 */
export async function refreshNotes() {
  const seqAtIssue = noteEventSeq;
  try {
    const fresh = await db.listNotes();
    if (noteEventSeq !== seqAtIssue) {
      console.warn('[messages] 补拉期间收到新留言落地，放弃本次整份替换以免抹掉它');
      return notes;
    }
    notes = fresh;
    refreshBell();
    return notes;
  } catch (err) {
    console.error('[messages] 加载留言失败:', err);
    return null;
  }
}

/** 关闭纪念日面板（若开着）——app.js 的面板是同页，直接操作 DOM */
function closeAnniPanelIfOpen() {
  const panel = document.getElementById('anniPanel');
  if (!panel || panel.hidden) return;
  panel.classList.remove('anni-panel--show');
  setTimeout(() => { panel.hidden = true; }, 250);
}

/** 对方发来的、我还没读的留言（可能多条） */
function getIncomingNotes() {
  return notes.filter((n) => n.authorId !== (currentUser && currentUser.id));
}

/**
 * 刷新顶栏图标状态：
 *   - 有对方未读留言 → 显示 + 呼吸灯（神秘感）
 *   - 无对方留言 → 隐藏（自己发的不会亮自己的铃铛）
 */
function refreshBell() {
  if (!bellEl) return;
  const incoming = getIncomingNotes();
  if (incoming.length > 0) {
    bellEl.hidden = false;
    bellEl.classList.add('note-bell--glow');
    bellEl.setAttribute('aria-label', `ta 给你留了 ${incoming.length} 条话`);
  } else {
    bellEl.hidden = true;
    bellEl.classList.remove('note-bell--glow');
  }
}

// ===== 写入态 =====

function openWriteMode() {
  // 清理可能的 leaving 残留
  writePane.classList.remove('note-write--leaving');
  writePane.hidden = false;
  readPane.hidden = true;
  modalEl.hidden = false;
  requestAnimationFrame(() => modalEl.classList.add('note-modal--show'));
  if (inputEl) {
    // 回填当天草稿（没有则空）
    inputEl.value = loadDraft();
    // 轮换一句温柔的引导语
    inputEl.placeholder = PLACEHOLDER_POOL[Math.floor(Math.random() * PLACEHOLDER_POOL.length)];
    updateCounter();
    setTimeout(() => inputEl.focus(), 100);
  }
}

/** 实时更新字数指示器（≥180 暖橙提示） */
function updateCounter() {
  if (!inputEl || !countEl || !counterEl) return;
  const len = inputEl.value.length;
  countEl.textContent = len;
  counterEl.classList.toggle('note-write__counter--warn', len >= 180);
}

// ===== 草稿自动保存（按天 localStorage）=====
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `noteDraft_${y}${m}${day}`;
}
function loadDraft() {
  try { return localStorage.getItem(todayKey()) || ''; } catch { return ''; }
}
function debouncedSaveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { localStorage.setItem(todayKey(), inputEl.value); } catch {}
  }, 300);
}
function clearDraft() {
  try { localStorage.removeItem(todayKey()); } catch {}
}

async function submitNote() {
  if (!inputEl || !currentUser) return;
  const content = inputEl.value.trim();
  if (!content) return;

  sendBtn.disabled = true;
  // 按钮化作光点：点下瞬间立即淡出按钮 + 光点从按钮飞向桃心（不等网络）
  sendBtn.classList.add('note-write__send--gone');
  // 送达回响：按钮原位淡入一句温柔的话
  showEcho();
  writePane.classList.add('note-write--leaving');
  flyToHeart(sendBtn); // 光点飞向桃心（爱意送达），无需 done 回调

  try {
    const note = await db.sendNote(content, currentUser.id);
    // 本地追加（每条独立保留，连发多条互不覆盖）
    notes.push(note);
    notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    refreshBell(); // 自己发的不会亮铃铛
    clearDraft(); // 发送成功：清当天草稿
    // 发送成功：等光点飞完（约700ms）再关闭，保证动画完整
    await new Promise((r) => setTimeout(r, 700));
    writePane.hidden = true;
    writePane.classList.remove('note-write--leaving');
    sendBtn.classList.remove('note-write__send--gone');
    hideEcho();
    closeModal();
  } catch (err) {
    // 失败：恢复按钮和卡片
    sendBtn.classList.remove('note-write__send--gone');
    writePane.classList.remove('note-write--leaving');
    hideEcho();
    const detail = err && (err.message || err.code) ? `${err.code || ''} ${err.message}` : '未知错误';
    showToast(`发送失败：${detail}`, { urgent: true });
  } finally {
    sendBtn.disabled = false;
  }
}

/** 送达回响：按钮化作光点后，原位淡入一句随机的话 */
function showEcho() {
  if (!echoEl) return;
  echoEl.textContent = ECHO_POOL[Math.floor(Math.random() * ECHO_POOL.length)];
  echoEl.hidden = false;
  requestAnimationFrame(() => echoEl.classList.add('note-write__echo--show'));
}
function hideEcho() {
  if (!echoEl) return;
  echoEl.classList.remove('note-write__echo--show');
  setTimeout(() => { echoEl.hidden = true; }, 400);
}

/** 当前正在阅读的那条留言（阅后即焚时用它定位删除） */
let readingNote = null;

// ===== 阅读态（阅后即焚，逐条）=====

function openReadMode(note) {
  readingNote = note;
  // 清理可能的 leaving 残留（连续阅多条时），再显示
  readPane.classList.remove('note-read--leaving');
  // 时段氛围：按对方写下时的小时数切换（清旧态再加新态）
  // v2.7.51 P3.3：四档清理（dawn/noon/dusk/night）
  readPane.classList.remove('note-read--dawn', 'note-read--noon', 'note-read--dusk', 'note-read--night');
  const mood = moodForNote(note);
  if (mood) readPane.classList.add(mood);
  readPane.hidden = false;
  writePane.hidden = true;
  const author = userMap[note.authorId] || { displayName: 'ta' };
  // 显示还有几条未读（多条时给个轻提示）
  const remaining = getIncomingNotes().filter((n) => n.id !== note.id).length;
  if (fromEl) {
    fromEl.textContent = remaining > 0
      ? `${author.displayName} 悄悄对你说 · 还有 ${remaining} 条`
      : `${author.displayName} 悄悄对你说`;
  }
  if (contentEl) contentEl.textContent = note.content; // textContent 防注入
  // 按钮文案：还有下一条时显示「下一条」（点按翻页），最后一条显示「阅」（长按珍藏）
  // 只更新文案子节点，避免抹掉进度环结构
  const isLast = remaining === 0;
  if (dismissTextEl) dismissTextEl.textContent = isLast ? '长按珍藏' : '下一条';
  // 最后一条：长按手势；多条：点按翻页
  bindDismissGesture(isLast);
  modalEl.hidden = false;
  requestAnimationFrame(() => modalEl.classList.add('note-modal--show'));
}

/** 根据留言写下时的时段返回氛围 class
 *  v2.7.51 P3.3 纪念日时段配色微调：从二档（晨/夜）升级为四档（晨/午/昏/夜），覆盖 10-22 长段空白
 *   晨光 dawn（5-10）：金粉暖色调
 *   午间 noon（10-14）：阳光奶油调，更明亮
 *   黄昏 dusk（18-22）：暮色蜜桃调，更温柔
 *   星空 night（22-5）：深蓝夜幕 + 微光粒子
 */
function moodForNote(note) {
  if (!note || !note.createdAt) return '';
  const h = new Date(note.createdAt).getHours();
  if (h >= 5 && h < 10) return 'note-read--dawn';
  if (h >= 10 && h < 14) return 'note-read--noon';
  if (h >= 18 && h < 22) return 'note-read--dusk';
  if (h >= 22 || h < 5) return 'note-read--night';
  return '';
}

/**
 * 绑定"阅/下一条"手势：
 *   - 最后一条（isLast）：pointerdown 长按 600ms 才珍藏，进度环填满；松开取消回退
 *   - 多条：click 即翻页
 * 每次打开重绑（先移除旧监听），避免上一条的 handler 残留。
 */
function bindDismissGesture(isLast) {
  if (!dismissBtn) return;
  // 先清理上一条的监听 + 长按状态
  clearPress();
  dismissBtn.onpointerdown = null;
  dismissBtn.onpointerup = null;
  dismissBtn.onpointerleave = null;
  dismissBtn.onpointercancel = null;

  if (isLast) {
    // 长按珍藏（克制版：按住时留言文字柔柔发亮，按钮压暗；满阈值直接化光飞向桃心）
    dismissBtn.onpointerdown = () => {
      isPressing = true;
      pressDismissed = false;
      readPane.classList.add('note-read--pressing');
      dismissBtn.classList.add('note-read__dismiss--pressing');
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        if (isPressing) {
          pressDismissed = true; // 长按成功，抑制后续 click
          readPane.classList.remove('note-read--pressing');
          dismissBtn.classList.remove('note-read__dismiss--pressing');
          onCherish(); // 化光飞向桃心 + 即焚
        }
      }, PRESS_DURATION);
    };
    const release = () => {
      isPressing = false;
      clearTimeout(pressTimer);
      readPane.classList.remove('note-read--pressing');
      dismissBtn.classList.remove('note-read__dismiss--pressing');
    };
    dismissBtn.onpointerup = release;
    dismissBtn.onpointerleave = release;
    dismissBtn.onpointercancel = release;
  }
  // click handler 统一在 init 里绑过 onDismiss，多条时由它翻页；
  // 最后一条时若长按已成功（pressDismissed），onDismiss 里会跳过。
}

function clearPress() {
  clearTimeout(pressTimer);
  isPressing = false;
  if (readPane) readPane.classList.remove('note-read--pressing');
  if (dismissBtn) dismissBtn.classList.remove('note-read__dismiss--pressing');
}

/** 「阅/下一条」点击：多条翻页；最后一条由长按珍藏触发，长按成功后跳过此次 click */
function onDismiss() {
  // 长按刚刚成功触发了珍藏，跳过这次 click（pointerup 会紧接着触发 click）
  if (pressDismissed) { pressDismissed = false; return; }
  // 最后一条必须长按，单击不响应
  if (readingNote) {
    const remaining = getIncomingNotes().filter((n) => n.id !== readingNote.id).length;
    if (remaining === 0) return; // 最后一条：忽略单击
  }
  flipToNext();
}

/** 「下一条」点按翻页：即焚当前条（阅后即焚逐条语义），再看下一条 */
function flipToNext() {
  if (!readingNote) { closeModal(); return; }
  const current = readingNote;
  readingNote = null;
  // 阅后即焚：本地移除 + 后台即焚当前条
  notes = notes.filter((n) => n.id !== current.id);
  refreshBell();
  db.markNoteRead(current.id, currentUser.id)
    .then(() => db.deleteNote(current.id))
    .catch((err) => console.error('[messages] 阅后即焚失败:', err));
  // 还有下一条？淡出过渡后显示；否则关闭
  const next = getIncomingNotes()[0];
  if (next) {
    readPane.classList.add('note-read--leaving');
    setTimeout(() => {
      readPane.classList.remove('note-read--leaving');
      openReadMode(next);
    }, 300);
  } else {
    closeModal();
  }
}

/** 长按珍藏（最后一条）：留言文字化作心形飞向桃心，结束后即焚 */
function onCherish() {
  if (!readingNote) { closeModal(); return; }
  const current = readingNote;
  readingNote = null;

  // 珍藏仪式：卡片其余元素淡出让位，整张卡片成为文字化心的舞台
  readPane.classList.add('note-read--cherishing');
  textToHeart({
    textEl: contentEl,
    heartEl: document.getElementById('anniHeart'),
    onArrive: pulseHeart, // 心到达顶栏桃心时触发接收跳动
    done: () => {
      // 仪式结束：本地移除 + 后台删库（即焚）
      notes = notes.filter((n) => n.id !== current.id);
      refreshBell();
      db.markNoteRead(current.id, currentUser.id)
        .then(() => db.deleteNote(current.id))
        .catch((err) => console.error('[messages] 阅后即焚失败:', err));

      readPane.classList.remove('note-read--cherishing');
      readPane.hidden = true;
      closeModal();
    },
  });
}

// ===== 通用 =====

function closeModal() {
  if (!modalEl || modalEl.hidden) return;
  modalEl.classList.remove('note-modal--show');
  setTimeout(() => {
    modalEl.hidden = true;
    // 彻底重置两个 pane（防止关闭瞬间露出另一态）
    if (writePane) writePane.hidden = true;
    if (readPane) readPane.hidden = true;
  }, 300);
}

/**
 * 留言化作光点飞向桃心（爱意送达/珍藏的视觉隐喻）。
 * @param {HTMLElement} fromEl 飞行起点的元素（留言卡片中心）
 * @param {Function} done 飞行结束回调
 */
function flyToHeart(fromEl, done) {
  const heart = document.getElementById('anniHeart');
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 起点坐标（留言中心，屏幕坐标）
  const startRect = fromEl.getBoundingClientRect();
  const startX = startRect.left + startRect.width / 2;
  const startY = startRect.top + startRect.height / 2;

  // 终点坐标（桃心中心）
  let endX = startX, endY = 40;
  if (heart) {
    const endRect = heart.getBoundingClientRect();
    endX = endRect.left + endRect.width / 2;
    endY = endRect.top + endRect.height / 2;
  }

  // reduced-motion：直接结束，无飞行
  if (reduceMotion || !heart) {
    pulseHeart();
    if (done) done();
    return;
  }

  // 创建光点（rose 柔光小球，绝不硬边）
  const dot = document.createElement('div');
  dot.className = 'fly-dot';
  dot.style.left = startX + 'px';
  dot.style.top = startY + 'px';
  document.body.appendChild(dot);

  // 起点淡入，下一帧开始飞行
  requestAnimationFrame(() => {
    dot.classList.add('fly-dot--flying');
    // 用 CSS 变量传终点 + 弧度（贝塞尔感），通过 transform 位移
    dot.style.setProperty('--end-x', (endX - startX) + 'px');
    dot.style.setProperty('--end-y', (endY - startY) + 'px');
  });

  // 飞行途中（中段）让桃心准备接收；飞行结束触发接收跳动 + 清理
  setTimeout(() => {
    pulseHeart();
  }, 450);
  setTimeout(() => {
    if (dot.parentNode) dot.remove();
    if (done) done();
  }, 700);
}

/** 桃心接收跳动（爱意送达/珍藏，轻跳一下即停） */
function pulseHeart() {
  const heart = document.getElementById('anniHeart');
  if (!heart) return;
  heart.classList.remove('topbar__heart--receive');
  void heart.offsetWidth; // 强制 reflow 重启动画
  heart.classList.add('topbar__heart--receive');
  setTimeout(() => heart.classList.remove('topbar__heart--receive'), 600);
}

// ===== Realtime 回调（由 realtime.js 调用）=====

/** 有新留言（INSERT）—— 逐条保留，纯 id 去重 */
export function onNoteAdded(note) {
  if (!note) return;
  // id 去重（本端发送会回声）
  if (notes.some((n) => n.id === note.id)) return;
  noteEventSeq++; // 标记「本地已比任何在途补拉的快照更新」，见 refreshNotes
  notes.push(note);
  notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  refreshBell();
}

/** 留言被删除（阅后即焚 DELETE，或对方发新留言清掉了旧的） */
export function onNoteRemoved(id) {
  noteEventSeq++; // 同上：本地已更新，在途补拉的旧快照不许覆盖
  notes = notes.filter((n) => n.id !== id);
  refreshBell();
}

/** 留言被更新（标记已读 UPDATE）—— 发送方借此感知对方已读，但无需 UI 变化 */
export function onNoteUpdated(note) {
  if (!note) return;
  noteEventSeq++;
  notes = notes.map((n) => (n.id === note.id ? note : n));
  refreshBell();
}
