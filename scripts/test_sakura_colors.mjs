/**
 * E2E（只读）：v2.7.61 樱白粉换色验证（scripts/test_sakura_colors.mjs）
 *
 * 验证目标：
 *   1. :root token 层全为新樱白粉值（主色/背景/边框/阴影基色）
 *   2. login 页关键组件 computed style 使用新色（body 底色、卡片描边）
 *   3. index 页 CSS 同源（:root token 一致，心跳时段色为樱粉系）
 *   4. 全程无页面 JS 错误
 *
 * 数据安全（铁律一）：纯只读，不登录不写库；加载 login.html / index.html 静态资源即可。
 *
 * 用法：先 node scripts/serve.mjs 3000，再 node scripts/test_sakura_colors.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const EXPECT = {
  '--color-primary': '#e884a8',
  '--rose-500': '#e884a8',
  '--rose-600': '#d46e94',
  '--rose-700': '#b85a7c',
  '--color-bg': '#fffbfc',
  '--stone-200': '#f5e2e9',
  '--stone-900': '#352530',
  '--cream-50': '#fffbfc',
  '--color-primary-rgb': '232, 132, 168',
};

const FORBIDDEN_HEX = [
  '#e8561d', '#d4460f', '#b23a10', '#eb9058', '#f2b894', '#f8d6c2',
  '#fdeee3', '#fffbf8', '#fefdfb', '#f0e6d6', '#ddcdae', '#6b6051', '#2f2820',
];

const browser = await chromium.launch();
try {
  // ===== login.html：token + 组件 computed style =====
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.login__card', { timeout: 10000 });

    // 1. token 层
    for (const [prop, want] of Object.entries(EXPECT)) {
      const got = await page.evaluate(
        (p) => getComputedStyle(document.documentElement).getPropertyValue(p).trim(), prop);
      check(`login.html token ${prop} = ${want}`, got === want, `got ${got}`);
    }

    // 2. 组件 computed style
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    check('login body 背景渐变为樱白粉冷白（含 #fffbfc / rgb(255,251,252)）',
      /fffbfc|255,\s*251,\s*252/i.test(bodyBg), `got ${bodyBg.slice(0, 100)}`);

    const cardBorder = await page.evaluate(() => getComputedStyle(document.querySelector('.login__card')).borderColor);
    check('login 卡片描边为樱粉系 rgba(232, 132, 168)',
      cardBorder.includes('232, 132, 168'), `got ${cardBorder}`);

    const submitBg = await page.evaluate(
      () => getComputedStyle(document.querySelector('.login__submit')).backgroundImage);
    check('login 提交按钮背景含樱粉主色 #e884a8 / rgb(232, 132, 168)',
      /e884a8|232,\s*132,\s*168/i.test(submitBg), `got ${submitBg.slice(0, 80)}`);

    check('login.html 无页面 JS 错误', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: '/tmp/sakura-shots/login.png' });
    await page.close();
  }

  // ===== index.html：token 同源 + 心跳时段色 =====
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500); // 等首屏与跳转逻辑稳定

    for (const [prop, want] of [['--rose-500', '#e884a8'], ['--color-bg', '#fffbfc']]) {
      const got = await page.evaluate(
        (p) => getComputedStyle(document.documentElement).getPropertyValue(p).trim(), prop);
      check(`index.html token ${prop} = ${want}`, got === want, `got ${got}`);
    }

    // 心跳渐变 stop 色应为樱粉/梅紫系（按时段）
    const stops = await page.evaluate(() =>
      [...document.querySelectorAll('#topHeartGrad stop')].map((s) => s.getAttribute('stop-color')));
    const h = new Date().getHours();
    const isNight = h >= 22 || h < 6;
    const okStops = isNight
      ? stops.every((c) => /^#(83305a|571c3a)$/i.test(c || ''))
      : stops.every((c) => /^#(f9d6e2|f3b9cd|ee9cba|d46e94|e884a8)$/i.test(c || ''));
    check(`顶栏心跳时段色为樱粉/梅紫系（${isNight ? '夜' : '昼'} ${JSON.stringify(stops)}）`, okStops);

    check('index.html 无页面 JS 错误', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: '/tmp/sakura-shots/index.png' });
    await page.close();
  }

  // ===== 静态资源：旧色值清零 =====
  {
    const page = await browser.newPage();
    for (const css of ['/css/style.css', '/css/login.css']) {
      const text = await (await page.goto(BASE + css)).text();
      const hits = FORBIDDEN_HEX.filter((hex) => text.toLowerCase().includes(hex));
      check(`${css} 无旧暖橙色残留`, hits.length === 0, `残留 ${hits.join(', ')}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
