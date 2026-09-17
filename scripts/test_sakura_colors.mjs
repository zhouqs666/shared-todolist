/**
 * E2E（只读）：樱白粉色板一致性验证（scripts/test_sakura_colors.mjs）
 *
 * 验证目标：
 *   1. :root token 层全为新樱白粉值（主色/背景/边框/阴影基色）
 *   2. login 页关键组件 computed style 使用新色（body 底色、卡片描边）
 *   3. index 页 CSS 同源（:root token 一致，心跳时段色为樱粉系）
 *   4. 全程无页面 JS 错误
 *   5. 【v2.7.75 新增】静态色值全形态扫描 —— 退役色板残留清零
 *   6. 【v2.7.75 新增】暖色相漂移网（允许清单显式声明）
 *
 * 为什么要有 5/6（2026-09-17 血泪教训）：
 *   原实现只做「hex 字面量白名单」字符串包含检查：
 *       FORBIDDEN_HEX.filter((hex) => text.toLowerCase().includes(hex))
 *   CSS 里写的是 `rgba(47, 40, 32, 0.92)`，**永远匹配不上** hex 串 `#2f2820`。
 *   于是 6 处退役色值（骨架屏暖蜜桃、焦糖玫瑰光晕、暖棕 Toast 底…）在 v2.7.61
 *   全局换色后潜伏了 20+ 个版本，其中骨架屏是每次冷启动都可见的。
 *   ⇒ 教训：色板检查必须**解析颜色本身**，不能靠拼字符串。
 *     并加一条色相区间兜底，用来抓「不在已知清单里的新暖色」（清单总会漏）。
 *
 * 数据安全（铁律一）：纯只读，不登录不写库；加载 login.html / index.html 静态资源即可。
 *
 * 用法：先 node scripts/serve.mjs 3000，再 node scripts/test_sakura_colors.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { guardReadOnly } from './_lib-readonly-guard.mjs';

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

/**
 * 退役色板（跨 CSS/JS/HTML 全形态禁止）
 *   · v2.7.48 焦糖玫瑰：主色 #c2410c
 *   · v2.7.53 暖蜜桃（骨架屏 shimmer 用过）：#f9e3d4 / #f1c4a8
 *   · v2.7.59 暖米色板 + 暖棕 stone-900 #2f2820 + 暖灰 #8f8782
 */
const RETIRED_PALETTE = [
  '#c2410c',
  '#f9e3d4', '#f1c4a8',
  '#e8561d', '#d4460f', '#b23a10', '#eb9058', '#f2b894', '#f8d6c2',
  '#fdeee3', '#fffbf8', '#fefdfb', '#f0e6d6', '#ddcdae', '#6b6051',
  '#2f2820', '#8f8782',
];

/**
 * Tailwind pink/rose 离线条：**仅 CSS 禁止**
 * （JS 侧 blindbox.js 的贴纸插画渐变、confetti 粒子配色是刻意的高饱和美术色，不在管辖内）
 */
const OFF_BRAND_IN_CSS = ['#f472b6', '#fb7185', '#9f1239', '#ec4899', '#fecdd3'];

/**
 * 暖色相漂移网的允许清单 —— 每条都必须写清「为什么刻意保留」。
 * 未列入此表且命中暖色相(5°–70°)的色值 = 新的漂移，测试会红。
 */
const WARM_HUE_ALLOWLIST = [
  { value: '#ea580c', reason: '留言字数接近上限的警示橙（style.css 原地注释已声明刻意）' },
];

/**
 * 原生侧色值白名单（**本批不动**，但要能被看见）。
 *
 * 为什么单独列：这几个值不在 web 色板体系内（web 的 --color-bg 是 #fffbfc），
 * 且**改了也要走通道 B（打 APK）才生效**，而原生开屏底色还可能被 drawable/splash.png
 * 盖住 —— 要改必须先真机核对。所以登记成「已知待办」而不是「已修」。
 * 扫描这些文件的价值在于：**下次换色板时它们会出现在报告里**，而不是继续隐形。
 */
const NATIVE_TARGETS = [
  'capacitor.config.json',
  'android/app/src/main/res/values/styles.xml',
  'android/app/src/main/res/drawable/splash_background.xml',
  'android/app/src/main/res/drawable/ic_launcher_background.xml',
  'android/app/src/main/res/values/ic_launcher_background.xml',
];
const NATIVE_ALLOWLIST = new Set(['#ffe4e6', '#e11d48', '#be123c']);

// ===== 颜色解析工具 =====

/** 去注释但**保留行结构**（否则行号会整体偏移，报错定位不准） */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const RE_HEX = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const RE_RGB = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)/g;

/** 抽出文本里所有颜色字面量（hex 三/六/八位 + rgb/rgba），带真实行号 */
function collectColors(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(RE_HEX)) {
      let h = m[1];
      if (h.length === 8) h = h.slice(0, 6);        // #RRGGBBAA：忽略 alpha，只判色相
      else if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      out.push({
        raw: m[0], line: i + 1,
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      });
    }
    for (const m of line.matchAll(RE_RGB)) {
      out.push({
        raw: m[0], line: i + 1,
        r: +m[1], g: +m[2], b: +m[3],
      });
    }
  });
  return out;
}

const toRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];

/** rgb → HSL（h 0-360, s/l 0-100） */
function toHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

const fmt = (c) => `${c.raw} @${c.line}行`;

/**
 * 全形态禁止色检查：把每个字面量归一化成 RGB 三元组再比对。
 * 这样 `#2f2820`、`rgba(47,40,32,.92)`、`rgb(47, 40, 32)` 会被一视同仁地抓住
 * —— 原实现的字符串包含做不到这一点，正是 6 处漏改的直接原因。
 */
function findForbidden(colors, forbiddenHexes) {
  const set = new Set(forbiddenHexes.map((h) => toRgb(h).join(',')));
  return colors.filter((c) => set.has([c.r, c.g, c.b].join(',')));
}

/**
 * 暖色相漂移网：只抓「能看出是暖色」的（近黑近白/中性灰跳过），
 * 金/琥珀语义色与时段氛围（色相 25°–55° 且饱和 ≥35%）整体放行。
 */
function findWarmDrift(colors) {
  const allow = new Set(WARM_HUE_ALLOWLIST.map((a) => a.value.toLowerCase()));
  return colors.filter((c) => {
    const { h, s, l } = toHsl(c.r, c.g, c.b);
    if (l < 12 || l > 99) return false;        // 近黑/近白：色相不可辨（如遮罩 rgba(20,15,14)）
    if (s < 10) return false;                   // 中性灰：无彩度
    if (h >= 25 && h <= 55 && s >= 35) return false; // 金/琥珀语义色 + 晨昏氛围色
    if (!(h >= 5 && h <= 70)) return false;     // 只关心暖色相
    return !allow.has(c.raw.toLowerCase());
  }).map((c) => {
    const { h, s, l } = toHsl(c.r, c.g, c.b);
    return `${fmt(c)} hue${Math.round(h)}° sat${Math.round(s)}% light${Math.round(l)}%`;
  });
}

const browser = await chromium.launch();
// 本脚本跑在生产服务（:3000）上：只读守卫保证它永远不会写生产库
const guard = guardReadOnly();
try {
  const newPage = async (opts) => guard.attach(await browser.newPage(opts));

  /**
   * 同源抓取静态资源文本（走服务端 = 校验真正会被下发的字节）。
   * 必须先落到一个页面上，`fetch('/x')` 才有 origin 可解析。
   */
  const fetchText = async (page, url) => {
    if (!page.url().startsWith(BASE)) {
      await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    }
    return page.evaluate((u) => fetch(u).then((r) => r.text()), BASE + url);
  };

  // ===== login.html：token + 组件 computed style =====
  {
    const page = await newPage({ viewport: { width: 390, height: 844 } });
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

  // ===== index.html：加载无错 + 心跳色静态校验 =====
  {
    const page = await newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // 未登录时 index.html 会重定向到 login.html（属预期）——这里要的是 index.html
    // 自己那段 <head> 内联脚本能无错执行完，重定向本身不算失败。
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    check('index.html 加载无页面 JS 错误（未登录重定向属预期）',
      errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // ===== index.html 心跳色：静态文本校验 =====
  // ⚠️ 这里刻意**不**用 DOM 查询：未登录时页面已重定向到 login.html，#topHeartGrad
  // 不存在，`[].every(...)` 会恒为 true —— 原实现就是这么「假绿」的（空数组通过断言）。
  // 改为直接校验下发的 HTML 文本，并断言 stop 数量，杜绝空集通过。
  {
    const page = await newPage();
    const html = await fetchText(page, '/index.html');

    const themeColor = (html.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/) || [])[1];
    check('index.html theme-color = #fffbfc', themeColor === '#fffbfc', `got ${themeColor}`);

    // 静态心跳渐变（首帧兜底值，随后被 <head> 内联脚本按时段覆写）
    const grad = html.match(/id="topHeartGrad"[\s\S]*?<\/linearGradient>/);
    const stops = grad ? [...grad[0].matchAll(/stop-color="([^"]+)"/g)].map((m) => m[1]) : [];
    check('index.html 静态心跳渐变有 2 个 stop（防空集假绿）', stops.length === 2,
      `got ${stops.length}：${JSON.stringify(stops)}`);
    check(`index.html 静态心跳 stop 为樱粉系（${JSON.stringify(stops)}）`,
      stops.length === 2 && stops.every((c) => /^#(f3b9cd|ee9cba|d46e94|e884a8|f9d6e2)$/i.test(c)));

    // <head> 内联时段色脚本：三档都必须是樱粉/梅紫系
    const inline = (html.match(/var c1, c2;[\s\S]*?document\.head\.appendChild/) || [''])[0];
    const inlineHexes = [...inline.matchAll(/'#([0-9a-fA-F]{6})'/g)].map((m) => m[1].toLowerCase());
    check('index.html 内联时段色脚本可解析到 6 个色值（3 档 × 2）',
      inlineHexes.length === 6, `got ${inlineHexes.length}：${JSON.stringify(inlineHexes)}`);
    const SAKURA = /^(f3b9cd|ee9cba|d46e94|e884a8|f9d6e2|83305a|571c3a)$/;
    const bad = inlineHexes.filter((h) => !SAKURA.test(h));
    check('index.html 内联时段色全为樱粉/梅紫系', inlineHexes.length === 6 && bad.length === 0,
      bad.length ? `离线条：${bad.join(', ')}` : '');
    await page.close();
  }

  // ===== 首屏骨架屏 shimmer：渲染值实测（v2.7.75，原始 bug 的直接回归）=====
  // 为什么要在浏览器里实测而不是只扫源码：本次事故的原始形态就是「源码里的字面量
  // 没跟着色板走」，光扫源码只能证明「没有旧值」，证明不了「渲染出来是新的」。
  // login.html 与主页共用同一份 style.css，所以在登录页挂一个骨架屏节点，
  // 拿到的就是主页首屏真实会渲染的那个值。
  {
    const page = await newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.login__card', { timeout: 10000 });
    const bg = await page.evaluate(() => {
      const box = document.createElement('div');
      box.className = 'skeleton__box';
      box.style.cssText = 'position:fixed;left:-9999px;width:100px;height:20px';
      document.body.appendChild(box);
      const v = getComputedStyle(box).backgroundImage;
      box.remove();
      return v;
    });
    // rose-100 #fdf0f5 = rgb(253,240,245)；rose-200 #f9d6e2 = rgb(249,214,226)
    check('骨架屏 shimmer 渲染值为樱粉 rose-100/200（原始 bug 的直接回归）',
      /253,\s*240,\s*245/.test(bg) && /249,\s*214,\s*226/.test(bg), `got ${bg}`);
    check('骨架屏 shimmer 渲染值不含退役暖蜜桃 #f9e3d4/#f1c4a8',
      !/249,\s*227,\s*212/.test(bg) && !/241,\s*196,\s*168/.test(bg), `got ${bg}`);
    await page.close();
  }

  // ===== 静态色值：退役色板全形态清零 =====
  {
    const page = await newPage();
    // CSS/JS/HTML 一律查「退役色板」；离线条只在 CSS 里查（JS 侧有刻意的高饱和美术色）
    const targets = [
      { url: '/css/style.css', css: true },
      { url: '/css/login.css', css: true },
      { url: '/js/app.js', css: false },
      { url: '/js/notify.js', css: false },
      { url: '/index.html', css: false },
      { url: '/login.html', css: false },
    ];

    let scanned = 0;
    for (const { url, css } of targets) {
      const raw = await fetchText(page, url);
      const colors = collectColors(stripComments(raw));
      scanned += colors.length;

      // 逐文件非空断言：只兜「正则整体失效」会漏掉「某个文件静默 0 命中」
      // （0 命中时下面几条会因为空数组而假绿）
      check(`${url} 解析到颜色字面量（${colors.length} 个）`, colors.length > 0,
        '该文件 0 命中，颜色解析可能对它失效');

      const retired = findForbidden(colors, RETIRED_PALETTE);
      check(`${url} 无退役色板残留（全形态）`, retired.length === 0,
        retired.map(fmt).join('、'));

      if (css) {
        const offBrand = findForbidden(colors, OFF_BRAND_IN_CSS);
        check(`${url} 无 Tailwind 离线条色值`, offBrand.length === 0,
          offBrand.map(fmt).join('、'));

        const drift = findWarmDrift(colors);
        check(`${url} 无未登记的暖色相漂移`, drift.length === 0,
          drift.length ? `${drift.join('、')} —— 若属刻意保留，请登记进 WARM_HUE_ALLOWLIST 并写明理由` : '');
      }
    }

    // 扫描自检：正则写坏导致「一个都没扫到」时，前面几条会因为空数组而假绿
    check(`色值扫描非空（共扫到 ${scanned} 个字面量）`, scanned >= 100,
      `只扫到 ${scanned} 个，颜色解析正则可能已失效`);
    await page.close();
  }

  // ===== 原生侧色值：必须「可见」（登记制，不是清零）=====
  // 这些文件不在 public/ 下（服务端不下发），所以从磁盘读。
  // 目的不是现在改掉它们（改原生色要走通道 B + 真机核对），而是让它们**出现在报告里** ——
  // 早先它们既不在扫描清单里、也没有任何测试覆盖，等于对色板迁移完全隐形。
  {
    const rootDir = new URL('..', import.meta.url).pathname;
    for (const rel of NATIVE_TARGETS) {
      let text = '';
      try { text = readFileSync(rootDir + rel, 'utf8'); }
      catch (e) { check(`原生文件可读：${rel}`, false, e.message); continue; }

      const colors = collectColors(text);
      check(`原生文件解析到颜色：${rel}（${colors.length} 个）`, colors.length > 0);

      const offPalette = colors.filter((c) => {
        const hex = '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('');
        if (NATIVE_ALLOWLIST.has(hex)) return false;          // 已登记的待办项
        const ret = findForbidden([c], RETIRED_PALETTE);
        return ret.length > 0;
      });
      check(`${rel} 无「未登记的」退役色值（原生待办已登记 ${NATIVE_ALLOWLIST.size} 个）`,
        offPalette.length === 0,
        offPalette.length ? `${offPalette.map(fmt).join('、')} —— 新增的原生色请登记进 NATIVE_ALLOWLIST 并说明是否需要同步改` : '');
    }
  }

  // ===== 悬空 token 回归：--color-accent 已清理 =====
  {
    const page = await newPage();
    const css = await fetchText(page, '/css/style.css');
    check('style.css 不再引用未定义的 --color-accent / --color-accent-soft',
      !/var\(--color-accent/.test(css));
    await page.close();
  }
} finally {
  await browser.close();
}

const clean = guard.assertClean();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail || !clean ? 1 : 0);
