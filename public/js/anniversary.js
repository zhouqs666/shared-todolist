/**
 * 纪念日模块：在一起天数 + 结婚/生日倒计时
 *
 * 从 app.js 拆出（技术清单第8条：app.js 过长）。本模块自洽：
 *   - 仅依赖 DOM 元素（#anniDays / #anniPanel / #anniPanelDays 等）
 *   - 无 db / state / supabase 依赖
 *   - 内部维护 anniPanelIntroPlayed 状态，对外只暴露两个入口函数
 *
 * 已知未解决问题（不在本次拆分范围内）：
 *   - 日期硬编码（相识/结婚/生日），换用户失效（技术清单第11条）
 *   - 应改为可配置，但本次只做模块拆分，行为零变化
 */

// 重要日期（硬编码，固定不变）
// 注意：BIRTHDAY_*.month 的语义沿用 app.js 原值（原注释自相矛盾「月从0开始,4=5月…不,人类月份」，
//   实际通过 calcNextCountdown(month, day) 内部 month-1 转换，所以 month:4 实际生效为 4 月。
//   本次拆分严格保留原值原行为，不解歧义——配置化改造另立任务，不在本拆分范围内。）
const ANNIVERSARY_DATE = new Date('2019-12-12T00:00:00');   // 相识
const WEDDING_DATE = new Date('2022-05-27T00:00:00');       // 结婚
const BIRTHDAY_XIAO = { month: 4, day: 19 };                 // 小宝宝生日
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
export function renderAnniversary() {
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
export function toggleAnniversaryPanel() {
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
