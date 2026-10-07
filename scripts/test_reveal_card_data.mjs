/**
 * 开出卡片数据模块的结构守卫（无网络、无浏览器、无凭据，进 CI）。
 *
 * 守的是「已提交的产物」：reveal-card-data.js 是从 lab 机械提取的生成物
 * （scripts/extract-reveal-card-story.mjs + 提交记录里的 v1 提取），提取脚本在生成时已
 * 自证过；但任何**事后手改**（加一张卡、改漏一个渐变 id、贴一段带文案的 SVG）都绕过
 * 提取脚本 —— 本测试让这类改动在 CI 当场变红。
 *
 * 断言面（两册 24 张）：
 *   ① 结构 = 每册 3 档 × 4 张，序号 01-12 连续（数组空位/elision 在这里现形）
 *   ② SVG 红线：零文案（无 <text>）、零位图（无 <image>）、零外链（href/xlink/src），
 *      引用只允许 url(#…) —— 卡面是纯手绘艺术，文字一律来自 RARITY_META/STORY_META
 *   ③ 渐变 id 全文档唯一：v1 24 份 + story 24 份 SVG 内部互不冲突，且不与图鉴格子
 *      icon（story{n}*）冲突 —— 同一 DOM 文档会同时渲染多份 SVG，id 撞车 = 渐变串卡
 *   ④ 单一来源：story 卡序与 STORY_META 名称一一对应；cardPct 进度口径正确
 *
 * 浏览器全局 stub：blindbox.js 的 import 链会触达 window/document/localStorage（同
 * test_sticker_key.mjs），模块求值期空实现即可。
 */

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
}

const { REVEAL_SETS, cardPct } = await import('../public/js/reveal-card-data.js');
const { parseStickerKey, makeStickerKey, getStickerName } = await import('../public/js/blindbox.js');
const { STORY_META } = await import('../public/js/sticker-series-story.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  OK ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`); }
}

const SERIES = ['v1', 'story'];
const TIERS = ['rare', 'epic', 'legendary'];

console.log('=== ① 结构：两册 × 3 档 × 4 张，序号 01-12 连续 ===');
const allCards = [];
for (const series of SERIES) {
  const set = REVEAL_SETS[series];
  check(`${series} 册存在`, !!set);
  if (!set) continue;
  const flat = [];
  for (const tier of TIERS) {
    check(`${series}.${tier} = 4 张`, Array.isArray(set[tier]) && set[tier].length === 4,
      `实际 ${Array.isArray(set[tier]) ? set[tier].length : typeof set[tier]}`);
    if (Array.isArray(set[tier])) flat.push(...set[tier]);
  }
  check(`${series} 序号 01-12 连续`,
    flat.length === 12 && flat.map((c) => c && c.no).join(',') === '01,02,03,04,05,06,07,08,09,10,11,12',
    `实际 ${flat.map((c) => c && c.no).join(',')}`);
  flat.forEach((c, i) => check(`${series} 第 ${i + 1} 张 scene/hero 均为 SVG 字符串`,
    !!c && typeof c.scene === 'string' && c.scene.startsWith('<svg')
    && typeof c.hero === 'string' && c.hero.startsWith('<svg')));
  allCards.push(...flat.map((c) => ({ ...c, series })));
}

console.log('=== ② SVG 红线：零文案 / 零位图 / 零外链 ===');
for (const c of allCards) {
  for (const field of ['scene', 'hero']) {
    const svg = c[field];
    const banned = ['<text', '<image', 'href', 'xlink', 'src='].find((s) => svg.includes(s));
    check(`${c.series} No.${c.no}.${field} 无禁止元素`, !banned, banned ? `含 ${banned}` : '');
    check(`${c.series} No.${c.no}.${field} 引用仅 url(#…)`, !/url\((?!#)/.test(svg));
  }
}

console.log('=== ③ 渐变 id 全文档唯一（v1 + story + 图鉴格子） ===');
const idOwner = new Map();
let dupes = [];
for (const c of allCards) {
  for (const field of ['scene', 'hero']) {
    for (const m of c[field].matchAll(/id="([^"]+)"/g)) {
      if (idOwner.has(m[1])) dupes.push(`${m[1]}（${idOwner.get(m[1])} 与 ${c.series} No.${c.no}.${field}）`);
      else idOwner.set(m[1], `${c.series} No.${c.no}.${field}`);
    }
  }
}
check('48 份卡面 SVG 渐变 id 零重复', dupes.length === 0, dupes.slice(0, 3).join('；'));
const storyModuleSrc = (await import('node:fs')).readFileSync(
  new URL('../public/js/sticker-series-story.js', import.meta.url), 'utf8');
const gridIds = [...storyModuleSrc.matchAll(/id="(story\d+[a-z])"/g)].map((m) => m[1]);
const gridClash = gridIds.filter((id) => idOwner.has(id));
check(`图鉴格子 icon id（${gridIds.length} 个）与卡面零冲突`, gridClash.length === 0, gridClash.join('；'));

console.log('=== ④ 单一来源：卡序 ↔ STORY_META，进度口径 ===');
for (const tier of TIERS) {
  STORY_META[tier].stickerNames.forEach((name, i) => {
    const key = makeStickerKey('story', tier, i + 1);
    check(`story ${tier}_${i + 1} 名称「${name}」可按 key 取到`, getStickerName(key) === name,
      `实际 ${getStickerName(key)}`);
  });
}
check('cardPct("01") ≈ 8.3%', Math.abs(cardPct('01') - 100 / 12) < 0.01);
check('cardPct("12") = 100%', cardPct('12') === 100);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
