/**
 * 只读守卫「结构性」检查：连数据库的 scripts/test_*.mjs 必须挂 _lib-readonly-guard。
 *
 * 为什么需要这个脚本（2026-09-14）：
 *   铁律二要求「Node 局部回归跑在生产服务（:3000）上，只读 —— 由 _lib-readonly-guard.mjs
 *   在网络层阻断写请求」。但这条保证当时**只是记忆与自觉**：实测 test_sticker_wiggle.mjs
 *   就没挂守卫（登录后 app 冷启动会 POST /rest/v1/rpc/increment_login_count，
 *   直接写生产库的业务计数）。铁律二的原文血泪教训已经说过一次同样的话 ——
 *   「脚本本意只读」挡不住事故，必须物理阻断。
 *   所以这里把「必须挂守卫」变成机器可判定的检查，接入 CI（required check 那个 job）。
 *
 * 判定规则：
 *   - 扫描 scripts/test_*.mjs
 *   - 只对**要连数据库/浏览器**的脚本要求守卫（import playwright 或 supabase-js）；
 *     纯逻辑脚本（不连网）不要求
 *   - 需要豁免时，在文件里写一行 `readonly-guard-exempt: <原因>`（原因至少 10 字），
 *     检查会把它作为警告打印出来 —— 豁免是显式且可审计的，不是默认放行
 *
 * 用法：node scripts/check-test-guards.mjs      # 退出码非 0 = 有脚本漏挂守卫
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');
const GUARD = '_lib-readonly-guard';

/** 判定「这个脚本会连数据库/浏览器」的特征（有其一即要求守卫） */
const NEEDS_GUARD = [/from ['"]playwright['"]/, /from ['"]@supabase\/supabase-js['"]/];

const files = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.startsWith('test_') && f.endsWith('.mjs'))
  .sort();

const violations = [];
const exempted = [];
let checked = 0;

for (const file of files) {
  const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
  if (!NEEDS_GUARD.some((re) => re.test(src))) continue; // 纯逻辑脚本，不涉及网络
  checked++;

  if (src.includes(GUARD)) continue;

  // 显式豁免：必须带原因，否则仍算违规（防「加个 marker 就绕过」）
  const m = src.match(/readonly-guard-exempt:\s*(.+)/);
  if (m && m[1].trim().length >= 10) {
    exempted.push(`${file} —— ${m[1].trim()}`);
    continue;
  }
  violations.push(file);
}

console.log(`\n🔍 只读守卫检查：${checked} 个脚本涉及数据库/浏览器\n`);

for (const e of exempted) console.log(`  ⚠️  显式豁免：${e}`);

if (violations.length === 0) {
  console.log(`  ✓ 全部已挂 ${GUARD}（改动的 ${checked} 个脚本里无漏网）\n`);
  process.exit(0);
}

console.error(`  ✗ 以下脚本会连数据库/浏览器，但没挂只读守卫：`);
for (const v of violations) console.error(`      scripts/${v}`);
console.error(`
  它们跑在生产服务（:3000）上，任何没被 mock 到的写请求都会**真的写进生产库**。
  修法（两行）：
      import { guardReadOnly } from './_lib-readonly-guard.mjs';
      const guard = guardReadOnly(page);   // 必须在脚本自己的 page.route 之前
      ...
      const ok = guard.assertClean();      // 结尾收口，并把它并进退出码
  确实不需要守卫的，在文件里写一行注释：readonly-guard-exempt: <原因>
`);
process.exit(1);
