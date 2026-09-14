/**
 * 测试库 schema 契约检查（preflight）
 *
 * 为什么需要（2026-09-14 血泪教训）：
 *   测试库是生产 schema 的镜像。迁移只要漏执行到测试库，App 的查询就会**静默失败**——
 *   例如 todos 缺 pinned 列时 listTodos 的 ORDER BY 报 42703，整个列表请求失败，
 *   界面显示「空列表」。E2E 只会报「元素找不到 / 期望 true 收到 false」，
 *   极易被误判成元素定位或时序问题（实际排查烧了好几轮 CI）。
 *
 * 做法：从 supabase/*.sql 自动推导期望的表与列（不手写清单，新迁移自动纳入契约），
 *      与测试库实际 schema 比对；有漂移就打印清单 + 可直接粘贴执行的修复 SQL，
 *      并以非零码退出，让 CI 在几十秒内失败，而不是等模拟器跑完 15 分钟。
 *
 * 用法：node scripts/check-test-schema.mjs   （app-e2e 目录下）
 * 依赖：app-e2e/.env.test（E2E_SUPABASE_URL + E2E_SUPABASE_SERVICE_ROLE_KEY）
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_E2E = resolve(__dirname, '..');
const ROOT = resolve(APP_E2E, '..');
const SQL_DIR = join(ROOT, 'supabase');

function loadDotenv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const env = loadDotenv(join(APP_E2E, '.env.test'));
if (!env.E2E_SUPABASE_URL || !env.E2E_SUPABASE_SERVICE_ROLE_KEY) {
  console.error('✗ 缺少 E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY（检查 app-e2e/.env.test）');
  process.exit(1);
}

// ---------- 1. 从迁移 SQL 推导期望 schema ----------
// 期望列：table -> { col -> { def, file } }；def 是 ADD COLUMN 之后的完整定义文本
const expectedTables = new Map(); // table -> file
const expectedColumns = new Map(); // table -> Map(col -> {def, file})
const expectedFunctions = new Map(); // fn -> file

if (!existsSync(SQL_DIR)) {
  console.error(`✗ 找不到迁移目录 ${SQL_DIR}`);
  process.exit(1);
}

for (const file of readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  const raw = readFileSync(join(SQL_DIR, file), 'utf8');
  // 先剥离行注释：迁移文件里常有「表用 CREATE TABLE IF NOT EXISTS」这类
  // 说明性注释，不剥离会被当成真实建表语句，并让同一分块里的列解析被跳过。
  const sql = raw.replace(/--[^\n]*/g, '');

  for (const chunk of sql.split(';')) {
    const stmt = chunk.trim();
    if (!stmt) continue;

    // 表名：兼容 CREATE TABLE [IF NOT EXISTS] [public.]name
    const mTable = stmt.match(
      /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:["']?public["']?\s*\.\s*)?["']?([a-z_][a-z0-9_]*)["']?/i
    );
    if (mTable) {
      const t = mTable[1].toLowerCase();
      if (!expectedTables.has(t)) expectedTables.set(t, file);
    }

    // 列：同一分块可能既有建表又有加列，所以不做 continue，逐条独立匹配
    const mCol = stmt.match(
      /ALTER TABLE\s+(?:["']?public["']?\s*\.\s*)?["']?([a-z_][a-z0-9_]*)["']?\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([\s\S]+)$/i
    );
    if (mCol) {
      const t = mCol[1].toLowerCase();
      const col = mCol[2].toLowerCase();
      if (!expectedColumns.has(t)) expectedColumns.set(t, new Map());
      // 保留原始类型/默认值定义（去掉多余空白与换行）
      const def = mCol[3].replace(/\s+/g, ' ').trim();
      if (!expectedColumns.get(t).has(col)) expectedColumns.get(t).set(col, { def, file });
    }

    // RPC 函数：只取函数名。函数体里有分号（$$ ... $$），会被 split(';') 切开，
    // 但函数头（含 RETURNS 类型）总在第一个分块里，够用。
    // 排除 RETURNS TRIGGER：触发器函数 PostgREST 不暴露为 /rpc/*，校验它必然误报。
    const mFn = stmt.match(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:["']?public["']?\s*\.\s*)?["']?([a-z_][a-z0-9_]*)["']?\s*\([^)]*\)\s*RETURNS\s+([a-z_][a-z0-9_]*)/i
    );
    if (mFn && mFn[2].toLowerCase() !== 'trigger') {
      const fn = mFn[1].toLowerCase();
      if (!expectedFunctions.has(fn)) expectedFunctions.set(fn, file);
    }
  }
}

console.log(`📋 契约来源：supabase/*.sql（${expectedTables.size} 张表，${[...expectedColumns.values()].reduce((n, m) => n + m.size, 0)} 个列，${expectedFunctions.size} 个函数）`);

// ---------- 2. 例子外：测试库刻意不建的表 ----------
// 热更新相关的表。理由（铁律一）：App 冷启动会查 app_versions，若存在「启用」的版本，
// 就会从 Storage 下载 bundle 覆盖壳内资源——而这个 bundle 指向生产库，
// 于是 E2E 实际打在生产数据上。测试库不建这两张表 = 结构性保证
// 「测试环境永远不可能加载已发布 bundle」，比「建表但要求为空」更强（无法被误操作破坏）。
const INTENTIONALLY_ABSENT_TABLES = new Set([
  'app_versions',
  'app_native_versions',
  'app_updates',
]);

// ---------- 3. 与测试库实际 schema 比对 ----------
const client = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const missingTables = [];
const missingColumns = [];

for (const [table, file] of expectedTables) {
  if (INTENTIONALLY_ABSENT_TABLES.has(table)) continue;
  const { error } = await client.from(table).select('*').limit(1);
  if (error) {
    missingTables.push({ table, file });
    continue; // 表都不在，列检查无意义
  }
  const cols = expectedColumns.get(table);
  if (!cols) continue;
  for (const [col, meta] of cols) {
    const r = await client.from(table).select(col).limit(1);
    if (r.error) missingColumns.push({ table, col, ...meta });
  }
}

// 表存在但单独漏了列的情况（表不在 expectedTables 里时也要查）
for (const [table, cols] of expectedColumns) {
  if (expectedTables.has(table) || INTENTIONALLY_ABSENT_TABLES.has(table)) continue;
  const { error } = await client.from(table).select('*').limit(1);
  if (error) continue;
  for (const [col, meta] of cols) {
    const r = await client.from(table).select(col).limit(1);
    if (r.error) missingColumns.push({ table, col, ...meta });
  }
}

// ---------- 3b. RPC 函数契约 ----------
// 只读实现：读 PostgREST OpenAPI 的 /rest/v1/ 里 /rpc/* 路径清单，不调用函数。
// （不用「调用函数探测是否存在」——increment/consume 都是写操作，preflight 必须只读。）
// 背景：补齐 SQL 曾只加了 profiles 列、漏掉两个 RPC，检查器仍报「无漂移」（假绿），
//       直到 E2E 冷启动调用 increment_login_count 拿到 404 才暴露。
const missingFunctions = [];
{
  const base = env.E2E_SUPABASE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/rest/v1/`, {
    headers: {
      apikey: env.E2E_SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.E2E_SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    console.error(`⚠️ 读不到 PostgREST OpenAPI（HTTP ${res.status}），跳过函数契约检查`);
  } else {
    const spec = await res.json();
    const rpcNames = new Set(
      Object.keys(spec.paths || {})
        .filter((p) => p.startsWith('/rpc/'))
        .map((p) => p.slice('/rpc/'.length))
    );
    for (const [fn, file] of expectedFunctions) {
      if (!rpcNames.has(fn)) missingFunctions.push({ fn, file });
    }
  }
}

// ---------- 4. 安全断言：测试库不得存在「启用」的已发布版本 ----------
// 即使表是被手工建的，只要里面有启用行，App 就可能下载生产 bundle（铁律一）。
const safetyProblems = [];
{
  const { data, error } = await client
    .from('app_versions')
    .select('version')
    .eq('enabled', true)
    .limit(1);
  // error（表不存在）属预期：测试库刻意不建热更新表，忽略
  if (!error && data && data.length > 0) {
    safetyProblems.push(
      `app_versions 存在启用版本（如 ${data[0].version}）：App 冷启动可能下载已发布 bundle 覆盖测试配置，导致 E2E 打到生产数据`
    );
  }
}

// ---------- 5. 输出结果 ----------
if (missingTables.length === 0 && missingColumns.length === 0 && missingFunctions.length === 0 && safetyProblems.length === 0) {
  console.log('✅ 测试库 schema 与迁移一致，无漂移');
  process.exit(0);
}

if (safetyProblems.length > 0) {
  console.error('\n🛑 数据安全风险（铁律一）\n');
  for (const p of safetyProblems) console.error(`  ${p}`);
}

if (missingTables.length > 0 || missingColumns.length > 0 || missingFunctions.length > 0) {
  console.error('\n❌ 测试库 schema 落后于迁移（会导致 App 查询静默失败、E2E 假失败）\n');

  for (const { table, col, file } of missingColumns) {
    console.error(`  缺列：${table}.${col}   （定义来自 supabase/${file}）`);
  }
  for (const { table, file } of missingTables) {
    console.error(`  缺表：${table}   （请执行 supabase/${file}）`);
  }
  for (const { fn, file } of missingFunctions) {
    console.error(`  缺函数：${fn}()   （请执行 supabase/${file}）`);
  }

  const fixSql = [
    '-- 测试库 schema 补齐（幂等，可重复执行）',
    '-- 执行位置：测试项目 Supabase Dashboard → SQL Editor',
    ...missingColumns.map(
      (m) => `ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.col} ${m.def};`
    ),
    ...missingTables.map((m) => `-- 缺表 ${m.table}：请执行仓库内 supabase/${m.file}`),
    ...missingFunctions.map((m) => `-- 缺函数 ${m.fn}()：请执行仓库内 supabase/${m.file}`),
    '',
    '-- 完整版（含带注释的 RPC 定义）存档在 supabase/test-db-schema-sync.sql',
  ];

  console.error('\n--- 可复制的修复 SQL ---\n');
  console.error(fixSql.join('\n'));
  console.error('\n------------------------\n');
}

process.exit(1);
