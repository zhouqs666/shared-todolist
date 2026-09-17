/**
 * E2E 凭证键「结构性」检查：三处必须一致
 *
 * 为什么需要（2026-09-14 批次 C 踩过一次真的）：
 *   4 个双账号 Playwright E2E（scripts/test_*.py）要进 CI 时才发现 —— **CI 生成的
 *   `app-e2e/.env.test` 里没有 E2E_TEST_USERNAME**（只有 E2E_TEST_EMAIL）。而 App 的登录框
 *   收的是**用户名**，python 侧直接读 E2E_TEST_USERNAME → 在 CI 上必然拿不到凭证。
 *   这类「本地能过、CI 挂」的最常见成因就是**环境键少了一个**，而且它不会在本地暴露：
 *   本地那个 .env.test 是手写的、什么都有。
 *
 * 检查三方的凭证键集合是否一致（`E2E_SUPABASE_*` / `E2E_TEST_*`）：
 *   A. 被读取方：app-e2e/** 与 scripts/*.py、scripts/e2e_common.py 里出现的键
 *   B. 模板：app-e2e/.env.test.example（新同学照它填）
 *   C. 生成方：工作流里 printf 出来的 .env.test 键（CI 真正用的）
 * 三者不一致 → 非零退出。凡是「代码要读的键」，模板与**每个**生成它的工作流都必须有。
 *
 * ⚠️ 2026-09-17 起生成方只剩一个（`e2e-web-full.yml`）—— `e2e-app.yml` 已从 CI 移除
 *    （模拟器套件改按需手动跑）。若将来恢复设备测试的自动触发，把它的路径加回下面的列表。
 *
 * 刻意只管凭证类键（前缀 `E2E_SUPABASE_` / `E2E_TEST_`）：
 *   E2E_BASE / E2E_KEEP_DATA 这类是**运行期开关**（不是凭证、不进 .env.test），
 *   拉进来只会制造误报，而误报会让人开始无视这个检查 —— 那比没有检查更糟。
 *
 * 用法：node scripts/check-e2e-env-keys.mjs      # 退出码非 0 = 三处不一致
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_RE = /E2E_(?:SUPABASE|TEST)_[A-Z0-9_]+/g;
const KEYS = (text) => new Set(text.match(KEY_RE) || []);

/**
 * 只认**赋值行**里的键（整行注释直接跳过）。
 *
 * 为什么必须区分注释：第一版这里用的是「全文匹配」，负向用例当场漏判 ——
 * 把模板里的 `E2E_TEST_EMAIL=...` 真删掉之后检查仍然报「覆盖了全部键」，
 * 因为文件头部的**注释**里提到了这个键名。一个会被注释满足的检查等于没有检查
 * （同 ACTIONLINT「规则被静默跳过」那个坑：要验证的是「它真的查了」）。
 */
const ASSIGNED_KEYS = (text) => {
  const out = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    for (const k of KEYS(t)) out.add(k);
  }
  return out;
};

// ---------- A. 代码要读的键（读取方）----------
const readers = [
  'scripts/e2e_common.py',
  ...readdirSync(join(ROOT, 'scripts')).filter((f) => /^test_.*\.py$/.test(f)).map((f) => `scripts/${f}`),
  ...readdirSync(join(ROOT, 'app-e2e', 'utils')).map((f) => `app-e2e/utils/${f}`),
  'scripts/serve-test.mjs',
  'scripts/reset-test-db.mjs',
];

const used = new Map(); // key -> 第一个读到它的文件
for (const rel of readers) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  for (const k of KEYS(readFileSync(abs, 'utf8'))) {
    if (!used.has(k)) used.set(k, rel);
  }
}

// ---------- B. 模板（只认赋值行：注释里提到键名不算声明）----------
const examplePath = join(ROOT, 'app-e2e', '.env.test.example');
const declared = ASSIGNED_KEYS(readFileSync(examplePath, 'utf8'));

// ---------- C. 生成 .env.test 的工作流列表 ----------
const workflows = ['.github/workflows/e2e-web-full.yml'];
const generated = new Map();
for (const rel of workflows) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    generated.set(rel, null); // 文件不存在 → 视为缺失（下面会报）
    continue;
  }
  // 只取「生成 .env.test 那个 step」里的赋值行：形如 "E2E_XXX=${{ secrets.E2E_XXX }}"
  const inFile = new Set();
  for (const line of readFileSync(abs, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (!/\$\{\{\s*secrets\./.test(t)) continue;
    for (const k of KEYS(t)) inFile.add(k);
  }
  generated.set(rel, inFile);
}

let problems = 0;
const fail = (m) => { problems++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

console.log('\n=== E2E 凭证键一致性检查 ===\n');
console.log(`  代码读取的键：${[...used.keys()].sort().join(', ')}`);

for (const [rel, keys] of generated) {
  if (keys === null) {
    fail(`找不到工作流 ${rel}`);
    continue;
  }
  const missing = [...used.keys()].filter((k) => !keys.has(k)).sort();
  if (missing.length) {
    fail(`${rel} 生成的 .env.test 缺少：${missing.join(', ')}`);
    missing.forEach((k) => console.log(`        （被 ${used.get(k)} 读取 —— CI 上会直接拿不到值）`));
  } else {
    ok(`${rel} 覆盖了全部 ${used.size} 个键`);
  }
}

const notInExample = [...used.keys()].filter((k) => !declared.has(k)).sort();
if (notInExample.length) {
  fail(`app-e2e/.env.test.example 缺少：${notInExample.join(', ')}（新同学照模板填会漏）`);
} else {
  ok('app-e2e/.env.test.example 覆盖了全部键');
}

const unusedInExample = [...declared].filter((k) => !used.has(k)).sort();
if (unusedInExample.length) {
  console.log(`  ⚠️  模板里有但代码没读的键（可能是历史残留，确认后可删）：${unusedInExample.join(', ')}`);
}

console.log('');
if (problems) {
  console.log(`✗ 共 ${problems} 处不一致：CI 会在运行到一半时才失败，请先修这里。\n`);
  process.exit(1);
}
console.log('✅ 三方（代码读取 / 模板 / 工作流生成）凭证键一致\n');
