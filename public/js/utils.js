/**
 * 前端工具函数
 */

/**
 * 相对时间格式化：「刚刚 / 3分钟前 / 2小时前 / 昨天 / 7月15日」
 * @param {string} iso
 */
export function formatRelativeTime(iso) {
  if (!iso) return '';
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)}小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  // 超过一周显示日期
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 简易 HTML 转义（兜底，主要靠 textContent 渲染） */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 播放短促"叮"声（Web Audio API 生成，无需音频文件）
 * 失败时静默（不影响功能）
 */
let audioCtx = null;
export function playDing() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    // 浏览器自动播放策略：上下文可能被暂停，需要恢复
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, now); // A5
    o.frequency.exponentialRampToValueAtTime(1320, now + 0.1); // 上滑到 E6
    g.gain.setValueAtTime(0.001, now);
    g.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    o.start(now);
    o.stop(now + 0.4);
  } catch (e) {
    /* 静默失败 */
  }
}
