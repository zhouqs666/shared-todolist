/**
 * 开出卡片 · 第二册「我们的故事」提取脚本（批次 4）
 *
 * 从设计真值 docs/design-todo-v2/reveal-card-lab.html 的 SETS2 机械提取 12 张
 * 专属内容卡（scene/hero/no），写进 public/js/reveal-card-data.js 的
 * REVEAL_SETS.story（STORY_BEGIN/STORY_END 标记区，幂等可重跑）。
 *
 * 单一来源约束（同第一册，技术方案 §2）：
 *   - 名称/短句断言与 sticker-series-story.js STORY_META 逐字一致（不一致即失败）
 *   - 本脚本只搬运卡面专属艺术，不产生任何新文案
 *
 * 防回流断言（批次 3 教训：机械生成数据必须对「生成产物」断言——双逗号数组空位
 * 曾让卡面整体错位一位且无任何报错，node --check 与 grep 数数都发现不了）：
 *   ① 写入后重新 import 产物文件，断言 REVEAL_SETS.story 结构（3 档 × 4 张、
 *      序号 01-12 连续、与 lab 逐字一致）
 *   ② 渐变 id 全局唯一：story 24 份 SVG 内部互不冲突，且与 v1 卡、图鉴格子
 *      icon（story{n}*）不冲突——同一文档会同时渲染多份 SVG
 *   ③ SVG 结构红线：无 <text>（卡面零文案，文字一律来自 RARITY_META/STORY_META）、
 *      无 <image>、无外链（href/src），引用只允许 url(#…)
 *
 * 用法：node scripts/extract-reveal-card-story.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAB = resolve(ROOT, 'docs/design-todo-v2/reveal-card-lab.html');
const DATA = resolve(ROOT, 'public/js/reveal-card-data.js');
const STORY_MODULE = resolve(ROOT, 'public/js/sticker-series-story.js');

const TIER_ORDER = ['rare', 'epic', 'legendary'];
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };
const ok = (msg) => console.log('✓ ' + msg);

// ---------- ① 从 lab 提取 SETS2（对象字面量求值，内容全部为字符串/数字字面量） ----------

const lab = readFileSync(LAB, 'utf8');
const anchor = lab.indexOf('var SETS2 = {');
if (anchor < 0) fail('lab 中找不到 var SETS2');
let depth = 0, end = -1;
for (let i = anchor + 'var SETS2 = '.length; i < lab.length; i++) {
  if (lab[i] === '{') depth++;
  else if (lab[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) fail('SETS2 花括号不配对');
// 花括号计数会被字符串里的 { } 干扰吗——SVG 字符串里没有裸 { }（id/路径均无），此处成立；
// 若将来 SETS2 里出现带 {} 的字符串，这里会提前截断 → ② 的逐字断言会失败兜底。
const sets2 = new Function(`var STAR = 'M0-4Q1-1 4 0 1 1 0 4-1 1-4 0-1-1 0-4Z'; return (${lab.slice(anchor + 'var SETS2 ='.length, end)});`)();

for (const tier of TIER_ORDER) {
  if (!Array.isArray(sets2[tier]) || sets2[tier].length !== 4) fail(`SETS2.${tier} 不是 4 张`);
}
ok('SETS2 结构 = 3 档 × 4 张');

// ---------- ② 单一来源：名称/短句与 STORY_META 逐字一致 ----------

const { STORY_META } = await import(pathToFileURL(STORY_MODULE).href);
for (const tier of TIER_ORDER) {
  sets2[tier].forEach((item, i) => {
    if (item.name !== STORY_META[tier].stickerNames[i]) {
      fail(`${tier}[${i}] 名称与 STORY_META 不一致: lab="${item.name}" vs meta="${STORY_META[tier].stickerNames[i]}"`);
    }
    if (item.flavor !== STORY_META[tier].stickerFlavors[i]) {
      fail(`${tier}[${i}] 短句与 STORY_META 不一致（单一来源约束，lab 需同步 sticker-series-story.js）`);
    }
  });
}
ok('12 张名称/短句与 STORY_META 逐字一致');

// ---------- ③ SVG 结构红线 + 渐变 id 唯一性 ----------

const noItems = [];
let n = 0;
for (const tier of TIER_ORDER) {
  for (const item of sets2[tier]) {
    n += 1;
    const no = String(n).padStart(2, '0');
    if (item.no !== no) fail(`卡序号不连续: 期望 ${no} 实得 ${item.no}（${item.name}）`);
    for (const field of ['scene', 'hero']) {
      const svg = item[field];
      if (typeof svg !== 'string' || !svg.startsWith('<svg')) fail(`${no}.${field} 不是 SVG 字符串`);
      for (const banned of ['<text', '<image', 'href', 'xlink', 'src=']) {
        if (svg.includes(banned)) fail(`${no}.${field} 含禁止元素 ${banned}（卡面零文案/零外链红线）`);
      }
      if (/url\((?!#)/.test(svg)) fail(`${no}.${field} 含非 url(#…) 引用`);
    }
    noItems.push(item);
  }
}
ok('序号 01-12 连续；无 text/image/外链');

const storyIds = noItems.flatMap((it) => [...it.scene.matchAll(/id="([^"]+)"/g), ...it.hero.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const dup = storyIds.find((id, i) => storyIds.indexOf(id) !== i);
if (dup) fail(`story 渐变 id 重复: ${dup}`);

const dataBefore = readFileSync(DATA, 'utf8');
const v1Ids = [...dataBefore.matchAll(/id="(sc\d+[a-z]|h\d+[a-z])"/g)].map((m) => m[1]);
const storyModuleSrc = readFileSync(STORY_MODULE, 'utf8');
const gridIds = [...storyModuleSrc.matchAll(/id="(story\d+[a-z])"/g)].map((m) => m[1]);
const clash = storyIds.find((id) => v1Ids.includes(id) || gridIds.includes(id));
if (clash) fail(`story 渐变 id 与 v1 卡/图鉴格子冲突: ${clash}`);
ok(`渐变 id 全局唯一（story ${storyIds.length} 个，与 v1 ${v1Ids.length} 个、格子 ${gridIds.length} 个零冲突）`);

// ---------- ④ 写入 reveal-card-data.js 标记区 ----------

const fmtCard = (item) => {
  return '    { no: \'' + item.no + '\',\n'
    + '      scene: ' + JSON.stringify(item.scene) + ',\n'
    + '      hero: ' + JSON.stringify(item.hero) + ' },';
};
const storyBlock = '  // >>> STORY_BEGIN（此标记区由 scripts/extract-reveal-card-story.mjs 从 lab SETS2 机械提取生成，勿手改 SVG）\n'
  + '  story: {\n'
  + TIER_ORDER.map((tier) => '    ' + tier + ': [\n' + sets2[tier].map(fmtCard).join('\n') + '\n    ],').join('\n')
  + '\n  },\n  // >>> STORY_END';

const BEGIN = '  // >>> STORY_BEGIN';
const END_MARK = '  // >>> STORY_END';
let out;
if (dataBefore.includes(BEGIN)) {
  const b = dataBefore.indexOf(BEGIN);
  const e = dataBefore.indexOf(END_MARK);
  if (e < 0) fail('reveal-card-data.js 缺 STORY_END 标记');
  out = dataBefore.slice(0, b) + storyBlock + dataBefore.slice(e + END_MARK.length);
} else {
  // 首次生成：插在 REVEAL_SETS 对象收尾 `};` 之前（v1 项之后）
  const objClose = dataBefore.indexOf('\n};');
  if (objClose < 0) fail('reveal-card-data.js 找不到 REVEAL_SETS 收尾');
  out = dataBefore.slice(0, objClose) + '\n' + storyBlock + dataBefore.slice(objClose);
}
writeFileSync(DATA, out);
ok('reveal-card-data.js 已写入 STORY 标记区');

// ---------- ⑤ 生成产物自证（重新 import，对产物断言——批次 3 教训） ----------

const { cwd } = await import('node:process');
const { execFileSync } = await import('node:child_process');
const expected = JSON.stringify({
  rare: sets2.rare.map(({ no, scene, hero }) => ({ no, scene, hero })),
  epic: sets2.epic.map(({ no, scene, hero }) => ({ no, scene, hero })),
  legendary: sets2.legendary.map(({ no, scene, hero }) => ({ no, scene, hero })),
});
const checkScript = `
  const m = await import(${JSON.stringify(pathToFileURL(DATA).href)});
  const s = m.REVEAL_SETS.story;
  if (!s) { console.error('REVEAL_SETS.story 不存在'); process.exit(1); }
  const got = JSON.stringify({ rare: s.rare.map(({ no, scene, hero }) => ({ no, scene, hero })),
    epic: s.epic.map(({ no, scene, hero }) => ({ no, scene, hero })),
    legendary: s.legendary.map(({ no, scene, hero }) => ({ no, scene, hero })) });
  if (got !== ${JSON.stringify(expected)}) { console.error('产物与 lab 不一致'); process.exit(1); }
  const flat = [...s.rare, ...s.epic, ...s.legendary];
  if (flat.length !== 12 || flat.map((x) => x.no).join(',') !== '01,02,03,04,05,06,07,08,09,10,11,12') {
    console.error('产物序号不连续（疑似数组空位/elision）'); process.exit(1);
  }
  console.log('product-ok');
`;
try {
  const r = execFileSync(process.execPath, ['--input-type=module', '-e', checkScript], { cwd: ROOT, encoding: 'utf8' });
  if (!r.includes('product-ok')) fail('产物自证未通过');
} catch (e) {
  fail('产物自证失败: ' + (e.stderr || e.message));
}
ok('生成产物重新 import 自证通过（3×4、序号连续、与 lab 逐字一致）');
console.log('\n完成。第二册 12 张专属内容卡已同步进 reveal-card-data.js。');
