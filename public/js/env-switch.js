/**
 * 双环境切换（一个包，测试/生产环境可切换；2026-10-06）
 *
 * 入口：长按头像 → 账号菜单「切换环境」（action-sheet.js 通过 handlers.onSwitchEnv 注入，
 * 本模块不 import action-sheet——避免与 app.js 的接线形成环）。
 *
 * 流程：确认弹条（用 action-sheet 的样式类，自建 DOM）→ 取消全部本地提醒
 * （提醒属于当前环境的 todo，切走后不该再弹；切回时开机对账会按新环境数据重新调度）
 * → 写 localStorage['app_env'] → location.reload()。
 *
 * 为什么 reload 而不是热切：supabase 单例、Realtime 订阅、登录态、飞行请求都挂在
 * 当前环境上；重载让一切从头初始化，状态干净。离线队列按环境分键（offline-queue.js），
 * 两边各自的草稿互不串——否则测试环境入队的待办会在切回生产后重放写进生产库（铁律一形状）。
 *
 * 角标（安全件不是装饰）：测试环境时登录页 + 顶栏显示「测试环境」徽标——
 * 这个方案里「以为在测试、其实在生产」是唯一危险形态，判据就是看角标。
 *
 * session：vendor supabase-js 的 storageKey 按项目 ref 分仓，切回曾登录过的环境免登录。
 */

import { CURRENT_ENV, ENV_OVERRIDE_KEY } from './supabase.js';
import { cancelAllReminders } from './reminder.js';

/** 当前环境（'prod' | 'test'） */
export function getEnv() {
  return CURRENT_ENV;
}

export function isTestEnv() {
  return CURRENT_ENV === 'test';
}

function envLabel(env) {
  return env === 'test' ? '测试环境' : '生产环境';
}

/**
 * 应用环境角标：页面上带 data-env-badge 的元素（登录页 + 顶栏各一）——
 * 测试环境显示，生产环境隐藏。data 值即徽标文案（顶栏短写「测试」，登录页「测试环境」）。
 */
export function applyEnvBadges() {
  const test = isTestEnv();
  document.querySelectorAll('[data-env-badge]').forEach((el) => {
    el.textContent = el.getAttribute('data-env-badge') || '测试环境';
    el.hidden = !test;
  });
}

// ===== 切换确认弹条（复用 action-sheet 样式类，DOM 自建避免模块环）=====
let currentSwitchSheet = null;

function closeSwitchConfirm() {
  if (!currentSwitchSheet) return;
  const el = currentSwitchSheet;
  currentSwitchSheet = null;
  el.classList.remove('action-sheet__overlay--show');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
}

/**
 * 发起环境切换：弹确认条；确认后取消提醒 → 写标记 → 重载。
 * 当前已在目标环境的反面（切换永远是 test↔prod 二选一），无需幂等判断。
 */
export function requestEnvSwitch() {
  const target = CURRENT_ENV === 'test' ? 'prod' : 'test';
  closeSwitchConfirm();

  const overlay = document.createElement('div');
  overlay.className = 'action-sheet__overlay';
  overlay.addEventListener('click', closeSwitchConfirm);

  const sheet = document.createElement('div');
  sheet.className = 'action-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', `切换到${envLabel(target)}`);

  const preview = document.createElement('div');
  preview.className = 'action-sheet__preview';
  preview.textContent = `切换到${envLabel(target)}？`;
  sheet.appendChild(preview);

  const hint = document.createElement('div');
  hint.className = 'action-sheet__hint';
  hint.textContent = '将取消当前环境的提醒并重新加载；离线草稿按环境各自保留';
  sheet.appendChild(hint);

  const actions = document.createElement('div');
  actions.className = 'action-sheet__actions';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'action-sheet__icon-btn';
  confirmBtn.setAttribute('aria-label', `确认切换到${envLabel(target)}`);
  confirmBtn.setAttribute('data-testid', 'confirm-switch-env');
  // 双向箭头：切换语义（与退出图钉/退出图标区分）
  confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4"/><path d="M21 7H8"/><path d="M7 21l-4-4 4-4"/><path d="M3 17h13"/></svg>';
  confirmBtn.addEventListener('click', () => { closeSwitchConfirm(); doEnvSwitch(target); });
  actions.appendChild(confirmBtn);
  sheet.appendChild(actions);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'action-sheet__close';
  closeBtn.textContent = '取消';
  closeBtn.addEventListener('click', closeSwitchConfirm);
  sheet.appendChild(closeBtn);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('action-sheet__overlay--show'));
  currentSwitchSheet = overlay;
}

async function doEnvSwitch(target) {
  // 1) 取消当前环境的全部本地提醒（await 的是插件方法返回值，铁律八合规）
  try {
    await cancelAllReminders();
  } catch (e) {
    console.warn('[env] 切换前取消提醒失败（已忽略，切回后对账会自愈）:', e && e.message);
  }
  // 2) 写环境标记（reload 后 supabase.js 按它选库）
  try {
    localStorage.setItem(ENV_OVERRIDE_KEY, target);
  } catch (e) {
    console.warn('[env] 写环境标记失败:', e && e.message);
    return; // 写不进去就不 reload——否则切了等于没切，还会白登一次
  }
  // 3) 重载：单例/订阅/登录态全部按新环境重建
  window.location.reload();
}
