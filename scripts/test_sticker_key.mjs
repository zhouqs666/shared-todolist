/**
 * sticker_key 解析/构造的纯逻辑回归（无网络、无浏览器、无凭据，进 CI）。
 *
 * 背景（docs/sticker-book-roadmap.md §5.1，2026-10-04 批次 2）：key 采用语义前缀方案——
 * 第一册 v1 无前缀（历史数据形态），后续册带册短名前缀（如 `story_rare_1`）。
 * 解析收敛在 blindbox.js 的 parseStickerKey() 单点。本脚本把解析行为矩阵钉住：
 * 批次 3 给 key 加前缀 / 改造 rollRarity 时，任何破坏 v1 兼容的改动在这里当场变红。
 *
 * 浏览器全局 stub：blindbox.js 的 import 链会触达 window/document/localStorage，
 * 模块求值期只碰这些 API 的存在性，空实现即可。
 */

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
}

const { parseStickerKey, makeStickerKey, BASE_SERIES, getSeriesIds, getSeriesDef, getStickerIcon, getStickerFlavor } =
  await import('../public/js/blindbox.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  OK ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`); }
}

console.log('=== parseStickerKey：解析矩阵 ===');

// v1 无前缀（历史数据形态，本批次「零变化」的锚）
check("epic_3 → v1/epic/3",
  JSON.stringify(parseStickerKey('epic_3')) === JSON.stringify({ series: 'v1', rarity: 'epic', index: 3 }));
check("rare_1 → v1（前缀组回溯，不把 rare 当册名）",
  parseStickerKey('rare_1')?.series === 'v1' && parseStickerKey('rare_1')?.rarity === 'rare');
check("legendary_12 → v1/legendary/12",
  parseStickerKey('legendary_12')?.series === 'v1' && parseStickerKey('legendary_12')?.index === 12);

// 前缀形态（批次 3 story 册的形态；解析层不要求册已注册）
const sr = parseStickerKey('story_rare_1');
check("story_rare_1 → story/rare/1", !!sr && sr.series === 'story' && sr.rarity === 'rare' && sr.index === 1);
check("story_epic_12 → story/epic/12",
  parseStickerKey('story_epic_12')?.series === 'story' && parseStickerKey('story_epic_12')?.index === 12);

// 防歧义：以档位名开头的两段 key 归册名（注册表不含 → 构造/查询会被拒，见下）
check("rare_rare_1 的册名解析为 'rare'（禁用册名，仅注册表层拒绝）",
  parseStickerKey('rare_rare_1')?.series === 'rare');

// 畸形 key 一律 null（RLS 探针 'rls-probe'、空串、非贴纸格式等）
for (const bad of ['rls-probe', '_rare_1', 'epic_x', '', 'x_common_1', 'common_1', null, undefined]) {
  check(`畸形 ${JSON.stringify(bad)} → null`, parseStickerKey(bad) === null);
}

console.log('=== makeStickerKey：构造互逆 + 未注册册拒绝 ===');

check("make('v1','epic',3) === 'epic_3'（v1 输出与历史格式逐字相同）",
  makeStickerKey('v1', 'epic', 3) === 'epic_3');
let threw = false;
try { makeStickerKey('story', 'rare', 1); } catch { threw = true; }
check("make('story',…) 在册注册前 throw（批次 3 注册后才会放行）", threw);

console.log('=== 注册表：v1 唯一、无前缀、禁用名未占用 ===');

check("当前只注册 v1 一册（批次 2 口径）", JSON.stringify(getSeriesIds()) === JSON.stringify(['v1']));
check("v1 册 prefix 为空串", getSeriesDef('v1')?.prefix === '');
check("getSeriesDef('story') 未注册 → undefined", getSeriesDef('story') === undefined);
check("BASE_SERIES === 'v1'", BASE_SERIES === 'v1');

console.log('=== getStickerIcon / getStickerFlavor：v1 行为锚 ===');

check("icon('epic_3') 返回 SVG（含 <svg）", getStickerIcon('epic_3').includes('<svg'));
check("icon(畸形) 返回空串（原兜底行为）", getStickerIcon('rls-probe') === '');
check("icon(超界序号) 回退首张（原行为：|| stickerIcons[0]）",
  getStickerIcon('epic_99') === getStickerIcon('epic_1'));
check("flavor('rare_2') 返回非空短句", getStickerFlavor('rare_2').length > 0);
check("flavor(畸形) 返回空串", getStickerFlavor('nope') === '');

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
process.exit(0); // import 链（supabase/confetti）在 stub 下可能留悬挂句柄，显式收口
