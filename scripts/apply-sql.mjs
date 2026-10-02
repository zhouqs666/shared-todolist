#!/usr/bin/env node
/**
 * SQL 应用器：把 supabase/*.sql 幂等迁移应用到指定项目（测试/生产），告别 Dashboard 手工粘贴。
 *
 * 背景（2026-10-02 调研定型）：
 *   service_role key 只走 PostgREST/Storage API，执行不了任意 SQL（DDL 更不行）——
 *   这就是「SQL 改动要手工复制到 SQL Editor」的结构性原因。Supabase Management API 的
 *   `POST /v1/projects/{ref}/database/query` 补上了这条通道，凭据是**个人访问令牌（PAT）**，
 *   不是 service key。端点官方标注 experimental/Beta，但它就是 CLI `db query --linked`
 *   底层走的同一条路。
 *
 * 一次性 setup（只能账号本人做）：
 *   1. Dashboard → Account → Access Tokens（https://supabase.com/dashboard/account/tokens）
 *      生成**作用域受限** PAT（sbp_fc_ 开头）：只勾两个项目的 Database Read + Write，
 *      其余权限一律不给 —— PAT 是账号级资产，泄露影响面 = 它勾选的权限。
 *   2. 令牌放 .env 的 SUPABASE_ACCESS_TOKEN（已 gitignore；将来 CI 用时同步进 GitHub Secrets）。
 *      泄露/怀疑泄露 → Dashboard 撤销重发，换 .env 一行即可。
 *
 * 用法：
 *   node scripts/apply-sql.mjs supabase/xxx.sql --project test            # 预演（默认 dry-run）
 *   node scripts/apply-sql.mjs supabase/xxx.sql --project test --apply    # 应用到测试项目
 *   node scripts/apply-sql.mjs supabase/xxx.sql --project prod --apply \
 *        --confirm supabase/xxx.sql                                       # 写生产需逐字确认
 *   node scripts/apply-sql.mjs --project test --query "select 1"          # 只读探针（read_only）
 *
 * 安全设计（铁律一 + 发布审批文化）：
 *   - fail-closed 定目标：测试/生产 ref 从既有 env 派生，拿不到或与 --project 不符 → 拒绝
 *   - 默认 dry-run；显式 --apply 才执行；**写生产必须 --confirm 逐字等于文件名**（对齐 CD 审批门）
 *   - 幂等自证：--apply 成功后自动**再跑第二遍**——第二遍失败 = 文件违反「迁移必须幂等」铁律，
 *     exit 1（⚠️ 第一遍已生效且 DDL 不自动回滚，修的是文件不是库）
 *   - --query 恒走 read_only:true，物理只读
 *   - 令牌只从 env 读、永不打印；错误输出统一脱敏
 *
 * 退出码：0 = 成功/dry-run；1 = 执行失败（含幂等自证失败）；2 = 被守卫拒绝（参数/凭据/目标）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { loadEnv, ROOT } from './_lib-env.mjs';

const API = 'https://api.supabase.com';
const argv = process.argv.slice(2);

/** 解析 app-e2e/.env.test（与 serve-test.mjs 同源的键；不经 loadEnv 以免与 .env 混淆） */
function loadTestEnv() {
  const p = join(ROOT, 'app-e2e', '.env.test');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  return out;
}

/** 从 Supabase URL 提取 project ref（https://<ref>.supabase.co → <ref>） */
function refFromUrl(url) {
  const m = String(url || '').match(/^https:\/\/([a-z0-9]{20})\.supabase\.(co|net)/i);
  return m ? m[1] : null;
}

/** 错误输出脱敏：任何 sbp_ 令牌片段都不该出现在日志里 */
function redact(s) {
  return String(s).replace(/sbp_[a-z0-9]+/gi, 'sbp_***');
}

function fail(msg, code = 2) {
  console.error(`✗ ${redact(msg)}`);
  process.exit(code);
}

// ===== 参数解析 =====
const hasFlag = (f) => argv.includes(f);
const argValue = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const project = argValue('--project');
const confirm = argValue('--confirm');
const query = argValue('--query');
// 位置参数（SQL 文件名）= 不带 -- 的项，且排除各选项的值（--query 的查询文本本身
// 不以 -- 开头，不排除会被误认成文件名 —— 首跑验证时踩到）
const optValues = [argValue('--project'), confirm, query].filter(Boolean);
const sqlFile = argv.find((a) => !a.startsWith('--') && !optValues.includes(a));
const apply = hasFlag('--apply');

if (project !== 'test' && project !== 'prod') {
  fail('必须显式指定 --project test|prod（不设默认目标 —— 写错项目=改错库）');
}
if (query && (sqlFile || apply || confirm !== undefined)) {
  fail('--query 是只读探针，不能与 SQL 文件 / --apply / --confirm 组用');
}
if (!query && !sqlFile) {
  fail('用法：node scripts/apply-sql.mjs <supabase/xxx.sql> --project test|prod [--apply] | --project X --query "<sql>"');
}

loadEnv();
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token || !/^sbp_[a-z0-9]+$/i.test(token)) {
  fail('缺少 SUPABASE_ACCESS_TOKEN（.env 或环境变量，sbp_ 开头的作用域受限 PAT）。\n' +
    '  setup 见本文件头部注释：https://supabase.com/dashboard/account/tokens');
}

// ===== 定目标（fail-closed）：ref 必须能从既有凭据派生出来 =====
const prodUrl = process.env.SUPABASE_URL;
const testEnv = loadTestEnv();
const testUrl = process.env.E2E_SUPABASE_URL || testEnv.E2E_SUPABASE_URL;
const targetUrl = project === 'prod' ? prodUrl : testUrl;
const ref = refFromUrl(targetUrl);
if (!ref) {
  fail(`无法从 ${project === 'prod' ? '.env 的 SUPABASE_URL' : 'app-e2e/.env.test 的 E2E_SUPABASE_URL'} 派生 project ref` +
    `（got: ${targetUrl ? redact(targetUrl) : '缺失'}）—— 目标不明，拒绝执行`);
}
// 铁律一自证：test 目标绝不能等于生产 URL
if (project === 'test' && prodUrl && testUrl && testUrl === prodUrl) {
  fail('测试 URL 与生产 URL 相同（铁律一）');
}

console.log(`目标：${project} 项目（ref=${ref}）`);
if (query) {
  // 失败必须非零退出：探针的价值就在它的退出码（假绿灯比没有探针更糟）
  const ok = await runQuery(query, true);
  process.exit(ok ? 0 : 1);
}

// ===== 文件模式守卫：只允许 supabase/ 目录下的 .sql =====
const filePath = resolve(sqlFile);
const allowedDir = resolve(join(ROOT, 'supabase')) + sep;
if (!filePath.startsWith(allowedDir) || !filePath.endsWith('.sql')) {
  fail(`只允许应用 supabase/ 目录下的 .sql 文件（got: ${sqlFile}）`);
}
if (!existsSync(filePath)) fail(`文件不存在：${sqlFile}`);
const sql = readFileSync(filePath, 'utf8');
const relName = filePath.slice(allowedDir.length);

if (project === 'prod' && apply && confirm !== relName) {
  fail(`写生产需要 --confirm ${relName}（逐字一致）—— 预演通过后人工确认，对齐 CD 审批门`);
}

console.log(`文件：${relName}（${sql.length} 字节，${sql.split('\n').length} 行）`);
if (!apply) {
  console.log('--- 内容预览（前 30 行）---');
  console.log(sql.split('\n').slice(0, 30).join('\n'));
  console.log('---');
  console.log('未执行（默认 dry-run）。确认无误后加 --apply 执行；应用成功会自动再跑第二遍做幂等自证。');
  process.exit(0);
}

// ===== 执行：跑两遍，第二遍 = 幂等自证 =====
for (let run = 1; run <= 2; run++) {
  const label = run === 1 ? '第 1 遍（应用）' : '第 2 遍（幂等自证）';
  const ok = await runQuery(sql, false, label);
  if (!ok) {
    if (run === 2) {
      console.error('✗ 幂等自证失败：本文件违反「迁移 SQL 必须幂等」铁律 —— 修文件（第 1 遍已生效，DDL 不自动回滚）');
      process.exit(1);
    }
    process.exit(1);
  }
  if (run === 1) await new Promise((r) => setTimeout(r, 1000));
}
console.log(`✅ 已应用到 ${project} 项目（ref=${ref}），且幂等自证通过`);

/** 调 Management API 执行 SQL。read_only=true 时物理只读。返回是否成功。 */
async function runQuery(sqlText, readOnly, label = '查询') {
  let res;
  try {
    res = await fetch(`${API}/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sqlText, read_only: readOnly }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    console.error(`✗ ${label}网络失败：${redact(e.message)}`);
    return false;
  }
  const raw = await res.text();
  if (res.status === 429) {
    console.error('✗ 429 限流：稍等几秒重跑（Management API 有速率限制）');
    return false;
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`✗ ${res.status}：令牌无效或作用域不足（需要目标项目的 Database write 权限）。` +
      ' 到 Dashboard 检查/重发 PAT。');
    return false;
  }
  if (!res.ok) {
    console.error(`✗ ${label}失败 HTTP ${res.status}：${redact(raw.slice(0, 800))}`);
    return false;
  }
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    rows = raw; // 非 JSON（理论上不该出现），原样截断展示
  }
  const n = Array.isArray(rows) ? rows.length : null;
  console.log(`  ✓ ${label} OK${n !== null ? `（返回 ${n} 行）` : ''}`);
  if (readOnly && Array.isArray(rows) && rows.length) {
    console.log('  结果：');
    for (const row of rows.slice(0, 50)) console.log(`    ${JSON.stringify(row)}`);
    if (rows.length > 50) console.log(`    …（共 ${rows.length} 行）`);
  }
  return true;
}
