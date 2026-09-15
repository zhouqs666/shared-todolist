/**
 * Web 通道全量回归运行器（4 个双账号 Playwright E2E）
 *
 * 为什么要有这个脚本，而不是在工作流里写个 for 循环：
 *   1. **逐文件独立的干净初态**：每个文件跑之前先归零测试库（硬删 E2E- 待办 + 贴纸）。
 *      跑 E2E 的通病是「上一个用例留下的数据污染下一个用例」；文件之间不该有隐含依赖。
 *   2. **flaky 治理要显式**：失败自动重试一次，但重试通过**不算通过** —— 记为 FLAKY 并
 *      打 ::warning:: 标注。行业做法是「重试是兜底、不是解药」（学习方案 §3.6）：
 *      静默重试会把真 bug 洗成绿灯，所以这里一定要留下痕迹，并把 flake 数写进 Run Summary。
 *   3. **一份能读懂的结果**：每个文件的耗时与结论汇总成表，CI 日志里一眼能看出
 *      「是哪个用例挂了、挂了多久」，而不是 2000 行滚动输出。
 *
 * 铁律一：只允许打在**测试库**上。连不上、或对方自证不是测试库 → 拒绝运行（fail-closed）。
 *   被测服务器 = `node scripts/serve-test.mjs`（端口 3100，改写 supabase.js 指向测试库）；
 *   本脚本绝不启动端口 3000 的那个（托管生产库）。
 *
 * 用法：
 *   node scripts/serve-test.mjs &            # 先起测试服务器（本脚本不会替你起，隔离必须显式）
 *   node scripts/run-web-e2e.mjs             # 跑全部 4 个
 *   node scripts/run-web-e2e.mjs --files test_trash,test_offline
 *   node scripts/run-web-e2e.mjs --keep-data # 失败现场保留（E2E_KEEP_DATA=1，不归零）
 *   node scripts/run-web-e2e.mjs --no-retry  # 关闭重试（排查 flaky 时用，看清楚第一次到底怎么挂的）
 *   node scripts/run-web-e2e.mjs --fail-on-flaky  # 有 flaky 也判失败（想要「零容忍」时开）
 *
 * 退出码：0 = 全部通过（含「第 1 次失败、重试通过」的 FLAKY，除非 --fail-on-flaky）；
 *         1 = 有文件重试后仍失败；2 = 隔离校验不通过（不碰任何测试）。
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const BASE = process.env.E2E_BASE || 'http://localhost:3100';
const PYTHON = process.env.PYTHON || 'python3';

/** 全量清单（顺序刻意稳定：先不写库的完成撤销，再回收站，再离线，最后盲盒） */
const ALL_FILES = ['test_undo_complete', 'test_trash', 'test_offline', 'test_blindbox'];

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const KEEP_DATA = hasFlag('--keep-data');
const RETRY = !hasFlag('--no-retry');
const FAIL_ON_FLAKY = hasFlag('--fail-on-flaky');

const requested = argValue('--files');
const files = requested ? requested.split(',').map((s) => s.trim()).filter(Boolean) : ALL_FILES;

// ===== 参数校验：只接受已知文件，避免 --files 手滑变成「什么都没跑」的假绿灯 =====
const unknown = files.filter((f) => !ALL_FILES.includes(f));
if (unknown.length) {
  console.error(`✗ 未知用例：${unknown.join(', ')}`);
  console.error(`  可用：${ALL_FILES.join(', ')}`);
  process.exit(2);
}

const bar = '='.repeat(64);
console.log(`\n${bar}`);
console.log('Web 通道全量回归（双账号 Playwright E2E）');
console.log(bar);
console.log(`  测试服务器：${BASE}`);
console.log(`  用例：${files.length} 个 → ${files.join(', ')}`);
console.log(`  失败重试：${RETRY ? '开（重试通过记为 FLAKY，不算通过）' : '关'}`);
console.log(`  初态：${KEEP_DATA ? '保留现场（不归零）' : '每个文件前归零测试库'}`);

// ===== 硬闸：先证明对方是测试库（fail-closed，铁律一）=====
function assertTestServer() {
  const r = spawnSync(
    process.execPath,
    ['-e', `fetch('${BASE}/__dbinfo').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(String(e));process.exit(1)})`],
    { encoding: 'utf8', timeout: 10000 }
  );
  if (r.status !== 0) {
    console.error(`\n✗ 连不上测试服务器 ${BASE}`);
    console.error('  请先启动：node scripts/serve-test.mjs   （端口 3100，连测试库）');
    console.error('  注意：绝不能用 npm start（3000，那是生产库）。\n');
    process.exit(2);
  }
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    console.error(`\n✗ ${BASE}/__dbinfo 未返回合法 JSON，无法自证隔离 → 拒绝运行\n`);
    process.exit(2);
  }
  if (info.project !== 'test' || info.isolated !== true || !info.prodUrl) {
    console.error(`\n✗ 对方自证不是隔离的测试库：${JSON.stringify(info)} → 拒绝运行\n`);
    process.exit(2);
  }
  console.log(`  测试库：${info.supabaseUrl}`);
  console.log(`  生产库：${info.prodUrl}  ← 本次运行绝不触碰`);
}

function runNode(script, { quiet = true } = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script)], {
    encoding: 'utf8',
    env: { ...process.env, ...(KEEP_DATA ? { E2E_KEEP_DATA: '1' } : {}) },
    timeout: 120000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (!quiet || r.status !== 0) process.stdout.write(out);
  return { ok: r.status === 0, out };
}

/** 跑一个用例文件一次；返回 { ok, seconds, output, tail } */
function runOnce(file) {
  const started = Date.now();
  const r = spawnSync(PYTHON, [join(SCRIPTS, `${file}.py`)], {
    encoding: 'utf8',
    env: { ...process.env, E2E_BASE: BASE, ...(KEEP_DATA ? { E2E_KEEP_DATA: '1' } : {}) },
    timeout: 300000,
  });
  const seconds = (Date.now() - started) / 1000;
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(output);
  if (r.error) {
    console.error(`\n✗ 无法执行 ${PYTHON}（${r.error.message}）`);
    console.error('  CI 上需要 pip install -r scripts/requirements-e2e.txt 并 playwright install chromium\n');
  }
  // 退出码非 0 = 失败；r.error（如命令不存在）也算失败，不让它静默变成「通过」
  return { ok: r.status === 0 && !r.error, seconds, output };
}

/** 从输出里抓最后一行「通过: X  失败: Y」，让汇总表能显示断言级结果 */
function summaryLine(output) {
  const lines = (output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(通过|Passed)[:：]/.test(lines[i]) || /通过.*失败/.test(lines[i])) return lines[i];
  }
  return '';
}

assertTestServer();

const results = [];
let aborted = false;

for (const [i, file] of files.entries()) {
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`[${i + 1}/${files.length}] ${file}.py`);
  console.log('-'.repeat(64));

  if (!KEEP_DATA) {
    const reset = runNode('reset-test-db.mjs');
    if (!reset.ok) {
      console.error(`✗ 测试库归零失败，无法保证干净初态 → 中止后续用例`);
      results.push({ file, attempt1: 'RESET-FAIL', attempt2: '-', seconds: 0, note: '' });
      aborted = true;
      break;
    }
    console.log('  → 测试库已归零');
  }

  console.log(`  → 第 1 次运行…`);
  const first = runOnce(file);

  if (first.ok) {
    results.push({ file, attempt1: 'PASS', attempt2: '-', seconds: first.seconds, note: summaryLine(first.output) });
    console.log(`  ✓ PASS（${first.seconds.toFixed(1)}s）`);
    continue;
  }

  const firstSummary = summaryLine(first.output);
  if (!RETRY) {
    results.push({ file, attempt1: 'FAIL', attempt2: '-', seconds: first.seconds, note: firstSummary });
    console.log(`  ✗ FAIL（${first.seconds.toFixed(1)}s）—— 未重试（--no-retry）`);
    continue;
  }

  console.log(`  ✗ 第 1 次失败（${first.seconds.toFixed(1)}s）。重试前再归零一次，排除上次残留的干扰…`);
  if (!KEEP_DATA) runNode('reset-test-db.mjs');
  console.log(`  → 第 2 次运行…`);
  const second = runOnce(file);

  if (second.ok) {
    results.push({
      file,
      attempt1: 'FAIL',
      attempt2: 'PASS',
      seconds: first.seconds + second.seconds,
      note: firstSummary,
    });
    console.log(`  ⚠️ FLAKY：第 1 次失败、重试通过 —— 这**不算通过**，必须查根因（学习方案 §3.6）`);
    console.log(`::warning title=flaky test::${file}.py 首次失败、重试通过（首次结果：${firstSummary || '见上方日志'}）`);
  } else {
    results.push({
      file,
      attempt1: 'FAIL',
      attempt2: 'FAIL',
      seconds: first.seconds + second.seconds,
      note: firstSummary,
    });
    console.log(`  ✗ FAIL：两次都失败`);
  }
}

// ===== 汇总 =====
const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(`\n${bar}`);
console.log('汇总');
console.log(bar);
console.log(`${pad('用例', 24)}${pad('第 1 次', 9)}${pad('第 2 次', 9)}${pad('耗时', 9)}结论`);
console.log('-'.repeat(64));
for (const r of results) {
  const verdict = r.attempt1 === 'PASS' ? 'PASS' : r.attempt2 === 'PASS' ? 'FLAKY' : r.attempt1 === 'RESET-FAIL' ? 'ABORT' : 'FAIL';
  console.log(`${pad(r.file + '.py', 24)}${pad(r.attempt1, 9)}${pad(r.attempt2, 9)}${pad(r.seconds.toFixed(1) + 's', 9)}${verdict}`);
}
console.log('-'.repeat(64));

const passed = results.filter((r) => r.attempt1 === 'PASS').length;
const flaky = results.filter((r) => r.attempt1 !== 'PASS' && r.attempt2 === 'PASS').length;
const failed = results.filter((r) => r.attempt1 !== 'PASS' && r.attempt2 !== 'PASS').length;
const totalSeconds = results.reduce((a, r) => a + r.seconds, 0);
const skipped = files.length - results.length;

console.log(`总耗时 ${totalSeconds.toFixed(1)}s ｜ ${passed} 直接通过 ／ ${flaky} flaky ／ ${failed} 失败` + (skipped ? ` ／ ${skipped} 未执行` : ''));

if (flaky) {
  console.log('\n⚠️ flaky 用例（首次失败、重试通过）：');
  for (const r of results.filter((x) => x.attempt1 !== 'PASS' && x.attempt2 === 'PASS')) {
    console.log(`   - ${r.file}.py ｜ 首次判定：${r.note || '见日志'}`);
  }
  console.log('   重试是兜底不是解药：请按「截图 → 复现原始请求 → 查环境契约」三步定位（见 CODE-REVIEW）。');
}

// ===== Run Summary（GitHub Actions 里渲染成表格，历史趋势就靠它）=====
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => {
    const verdict = r.attempt1 === 'PASS' ? '✅ PASS' : r.attempt2 === 'PASS' ? '⚠️ FLAKY' : r.attempt1 === 'RESET-FAIL' ? '⛔ ABORT' : '❌ FAIL';
    return `| ${r.file}.py | ${r.attempt1} | ${r.attempt2} | ${r.seconds.toFixed(1)}s | ${verdict} |`;
  });
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '## Web 全量回归（双账号 Playwright E2E）',
      '',
      `测试库：\`${BASE}\`（生产库由 \`/__dbinfo\` 自证隔离）`,
      '',
      '| 用例 | 第 1 次 | 第 2 次 | 耗时 | 结论 |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      `**${passed} 直接通过 ／ ${flaky} flaky ／ ${failed} 失败**（总耗时 ${totalSeconds.toFixed(1)}s）`,
      '',
      '> FLAKY = 首次失败、重试通过。它**不算通过**：每日全量回归的价值在于发现趋势，',
      '> 每次出现 flaky 都应当按「截图 → 复现被测应用的原始请求 → 查环境契约」三步定位根因。',
      '',
    ].join('\n')
  );
}

if (aborted || failed > 0 || (FAIL_ON_FLAKY && flaky > 0)) {
  console.log('\n✗ 有失败用例（或 flaky 被要求判失败），退出码 1\n');
  process.exit(1);
}
console.log('\n✅ 全部通过\n');
