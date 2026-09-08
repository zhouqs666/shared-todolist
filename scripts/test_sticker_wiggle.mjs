/**
 * E2E：图鉴"贴纸可以戳"轻晃演示（scripts/test_sticker_wiggle.mjs）
 *
 * 覆盖分支：
 *   1. 从未点过 + 次数未达上限 → 打开图鉴后第一张已解锁贴纸轻晃（--wiggle 类）
 *   2. 轻晃只出现一次、自动摘类（0.8s 后）
 *   3. 点贴纸 → 弹故事卡 + TAP_EVER 落库 + --wiggle 类被摘掉
 *   4. 点过后重开 → 永不再晃
 *   5. 次数达上限（3 次）→ 不再晃（从未点过的场景）
 *   6. 计数器只在真正演示时 +1
 *   7. 图鉴为空（无已解锁）→ 不晃也不计数
 *   8. prefers-reduced-motion → 类照加但动画被 CSS 禁掉
 *
 * 数据安全（铁律一）：不向生产库写任何数据。stickers 查询被路由拦截，
 * 返回纯客户端 mock；登录只产生 session（读操作）。
 *
 * 用法：先 node scripts/serve.mjs 3000，再 node scripts/test_sticker_wiggle.mjs
 */

import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const SHOT_DIR = '/tmp/sticker-wiggle-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const MOCK_STICKERS = [
  { id: 'e2e-1', sticker_key: 'rare_1', rarity: 'rare', unlocked_by: 'e2e', todo_id: null, unlocked_at: '2026-08-01T10:00:00+00:00' },
  { id: 'e2e-2', sticker_key: 'epic_2', rarity: 'epic', unlocked_by: 'e2e', todo_id: null, unlocked_at: '2026-08-02T10:00:00+00:00' },
  { id: 'e2e-3', sticker_key: 'legendary_3', rarity: 'legendary', unlocked_by: 'e2e', todo_id: null, unlocked_at: '2026-08-03T10:00:00+00:00' },
];

/** 拦截 stickers 查询（GET → mock 数组），其余请求放行 */
async function mockStickers(page, rows = MOCK_STICKERS) {
  await page.route('**/rest/v1/stickers**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
      body: JSON.stringify(rows),
    });
  });
}

/** 登录（固定测试账号，项目既有双账号之一） */
async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', '小宝宝');
  await page.fill('#password', '5201314');
  await page.click('#submitBtn');
  await page.waitForSelector('#stickerEntry', { state: 'visible', timeout: 20000 });
}

/** 清空引导相关 localStorage */
function resetAffordanceState(page) {
  return page.evaluate(() => {
    localStorage.removeItem('stickerTapEver');
    localStorage.removeItem('stickerWiggleOpens');
  });
}

async function openBook(page) {
  await page.click('#stickerEntry');
  await page.waitForSelector('#stickerModal:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('.sticker-cell--unlocked', { timeout: 15000 });
}

async function closeBook(page) {
  await page.click('#stickerModalClose');
  await page.waitForSelector('#stickerModal.hidden', { timeout: 15000 });
  await page.waitForTimeout(150); // 等关闭清理 + 挂起的 timer 窗口过去
}

/** 等待 --wiggle 类出现（出现=true）或超时（false） */
async function waitWiggle(page, timeout = 2600) {
  try {
    await page.waitForSelector('.sticker-cell--wiggle', { timeout });
    return true;
  } catch { return false; }
}

const browser = await chromium.launch();
try {
  // ===== 场景 1-4：首次用户完整流程 =====
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockStickers(page);
    await login(page);
    await resetAffordanceState(page);

    // 1. 首次打开 → 轻晃出现
    await openBook(page);
    const wiggled = await waitWiggle(page);
    check('首次打开：第一张已解锁贴纸轻晃出现', wiggled);
    const wiggleCellIsFirst = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.sticker-cell--unlocked')];
      return cells[0]?.classList.contains('sticker-cell--wiggle');
    });
    check('轻晃落在第一张已解锁贴纸上', wiggleCellIsFirst);
    const opensAfter1 = await page.evaluate(() => localStorage.getItem('stickerWiggleOpens'));
    check('演示计数 +1（=1）', opensAfter1 === '1', `got ${opensAfter1}`);
    await page.screenshot({ path: SHOT_DIR + '/1-wiggle-on-open.png' });

    // 2. 晃一次自动摘类（0.8s 摘类；留 1s 余量）
    const removed = await page.evaluate(() => new Promise((res) => {
      const cell = document.querySelector('.sticker-cell--wiggle');
      if (!cell) return res(true);
      const ob = new MutationObserver(() => {
        if (!cell.classList.contains('sticker-cell--wiggle')) { ob.disconnect(); res(true); }
      });
      ob.observe(cell, { attributes: true, attributeFilter: ['class'] });
      setTimeout(() => res(false), 2500);
    }));
    check('轻晃只晃一次、类被自动摘掉', removed);
    await closeBook(page);

    // 3. 重开（仍未点过，计数=1 < 3）→ 再晃一次
    await openBook(page);
    check('第 2 次打开（未点过）仍会演示', await waitWiggle(page));
    await closeBook(page);

    // 4. 点贴纸 → 故事卡 + 永久退场
    await openBook(page);
    await waitWiggle(page);
    await page.click('.sticker-cell--unlocked');
    await page.waitForSelector('#stickerFlavor.sticker-modal__flavor--show', { timeout: 15000 });
    const flavorText = await page.textContent('#stickerFlavor');
    check('点击后故事卡弹出（含专属短句）', (flavorText || '').length > 5, flavorText || '(empty)');
    const tapEver = await page.evaluate(() => localStorage.getItem('stickerTapEver'));
    check('点过 → stickerTapEver 落库', tapEver === '1');
    const wiggleGone = await page.evaluate(() => !document.querySelector('.sticker-cell--wiggle'));
    check('点击瞬间 --wiggle 类被摘掉（不与弹跳冲突）', wiggleGone);
    await page.screenshot({ path: SHOT_DIR + '/2-flavor-after-tap.png' });
    await closeBook(page);

    // 5. 点过后重开 → 永不再晃
    await openBook(page);
    check('点过后重开：不再轻晃（永久退场）', !(await waitWiggle(page)));
    const opensUnchanged = await page.evaluate(() => localStorage.getItem('stickerWiggleOpens'));
    check('退场后计数不再累加', opensUnchanged === '3', `got ${opensUnchanged}`);
    await page.screenshot({ path: SHOT_DIR + '/3-reopen-after-tap-no-wiggle.png' });
    await closeBook(page);
    check('全程无页面 JS 错误', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // ===== 场景 5：从未点过但次数达上限 =====
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mockStickers(page);
    await login(page);
    await page.evaluate(() => {
      localStorage.removeItem('stickerTapEver');
      localStorage.setItem('stickerWiggleOpens', '3');
    });
    await openBook(page);
    check('达上限（3 次）后不再轻晃', !(await waitWiggle(page)));
    const opensStill3 = await page.evaluate(() => localStorage.getItem('stickerWiggleOpens'));
    check('达上限后计数不再 +1', opensStill3 === '3', `got ${opensStill3}`);
    await closeBook(page);
    await page.close();
  }

  // ===== 场景 6：空图鉴（无已解锁）不演示不计数 =====
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mockStickers(page, []);
    await login(page);
    await resetAffordanceState(page);
    await page.click('#stickerEntry');
    await page.waitForSelector('#stickerModal:not(.hidden)', { timeout: 15000 });
    await page.waitForSelector('.sticker-cell:not(.sticker-cell--unlocked)', { timeout: 15000 });
    check('空图鉴（全未解锁）不轻晃', !(await waitWiggle(page)));
    const opens = await page.evaluate(() => localStorage.getItem('stickerWiggleOpens'));
    check('空图鉴不消耗演示次数', opens === null, `got ${opens}`);
    await closeBook(page);
    await page.close();
  }

  // ===== 场景 7：prefers-reduced-motion → 类照加、动画被禁 =====
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await mockStickers(page);
    await login(page);
    await resetAffordanceState(page);
    await openBook(page);
    const classAdded = await waitWiggle(page);
    check('reduced-motion 下类逻辑照常', classAdded);
    const animName = await page.evaluate(() => {
      const cell = document.querySelector('.sticker-cell--wiggle');
      return cell ? getComputedStyle(cell).animationName : '(none)';
    });
    check('reduced-motion 下动画被 CSS 禁用（animationName=none）', animName === 'none', `got ${animName}`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
