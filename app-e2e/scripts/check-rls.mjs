/**
 * RLS 生效自检（安全 preflight，铁律一 / 铁律二）
 *
 * 为什么需要（2026-09-16，Supabase 安全顾问告警）：
 *   测试项目 loveListTest 被报 CRITICAL `rls_disabled_in_public`：
 *   「Anyone with your project URL can read, edit, and delete all data in this table
 *     because Row-Level Security is not enabled.」—— 被命中的是 `profiles`。
 *   而仓库 supabase/schema.sql 里 profiles 一直写着 ENABLE ROW LEVEL SECURITY。
 *   ⇒ 这不是「仓库漏写」，是**项目上被手工改过、而没有任何回读校验**（同一时期那个
 *     项目里还留着仓库里不存在的 `create_test_user` RPC，可佐证跑过 ad-hoc SQL）。
 *   ⇒ 于是把「RLS 真的开着」变成机器判定 —— 本脚本。
 *
 * 判据（关键设计：**用一个必然违反外键的 INSERT 去问数据库「策略拦不拦」**）
 *   用 anon key（不带登录态 = 「拿到项目 URL 的任何人」，anon key 是公开的）对每张业务表
 *   发一个 payload，其中外键指向一个必定不存在的 UUID：
 *     · 42501 `new row violates row-level security policy` → 策略在干活 ✅
 *     · 23503 / 23505 / 23514 等**约束错误** → 请求已穿过策略层 ⇒ **RLS 没开** 🔴
 *
 *   为什么这个「写请求」是安全的（不必担心铁律一）：
 *     ① payload 的外键/主键必然不存在 ⇒ 无论 RLS 开没开，**都不可能落行**；
 *     ② 即便先插入后被外键回滚，也仍在同一语句的隐式事务里，不会留下数据。
 *     （对比：`reset-test-db.mjs` 真的删数据，所以它必须 fail-closed；本脚本不写数据，
 *       所以拿不到生产 URL 时只警告、不阻断 —— 风险是「判断错对象」而不是「误改数据」。）
 *
 * 姊妹脚本分工（不要重复实现）：
 *   隔离自检 → scripts/check-test-env.mjs
 *   schema 漂移（表/列/函数）→ app-e2e/scripts/check-test-schema.mjs
 *   RLS 是否真的生效（本文件）
 *
 * 用法：node app-e2e/scripts/check-rls.mjs        # 或在 app-e2e 下：node scripts/check-rls.mjs
 * 退出码：0 = 全部生效；1 = 有表 RLS 未生效（打印修复 SQL）；2 = 环境缺失或测试库=生产库
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_E2E = resolve(__dirname, '..');
const ROOT = resolve(APP_E2E, '..');

/** 简单的 .env 解析（不覆盖已存在的 process.env：CI 走环境变量注入） */
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

/**
 * 「必然不存在」的 UUID。用**固定值**而不是随机值：探测要可复现、日志要可搜索，
 * 而且固定值本身就是个标记 —— 万一哪天真在库里看到它，一眼就知道来源。
 */
const GHOST_UUID = '00000000-0000-0000-0000-0000000000de';

/**
 * 每张业务表一个探针。
 * 规则：payload 必须**只**违反外键（指向 GHOST_UUID），不违反别的约束 ——
 * 这样「返回什么错」才只由「RLS 是否拦下」决定，结论唯一。
 */
export const PROBES = [
  {
    table: 'profiles',
    // id 既是主键也是 → auth.users(id) 的外键，一个字段就能承担探针
    row: () => ({ id: GHOST_UUID, username: 'rls-probe', display_name: 'rls-probe' }),
    anonReadMustBeEmpty: true, // 收紧后 anon 不该读到任何行（测试库恒有两个测试账号）
  },
  { table: 'todos', row: () => ({ text: 'rls-probe', created_by: GHOST_UUID }) },
  { table: 'daily_notes', row: () => ({ content: 'rls-probe', author_id: GHOST_UUID }) },
  { table: 'reactions', row: () => ({ todo_id: GHOST_UUID, user_id: GHOST_UUID, emoji: 'x' }) },
  { table: 'stickers', row: () => ({ sticker_key: 'rls-probe', rarity: 'rare', unlocked_by: GHOST_UUID }) },
];

/** RLS 放行时数据库会回报的「约束类」错误码 —— 见到它们就等于「策略没拦住」 */
const CONSTRAINT_CODES = new Set(['23502', '23503', '23505', '23514', '22P02']);
const RLS_VIOLATION = '42501';

async function req(url, key, path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

/**
 * 核心探测：对每张业务表问一次「anon 的写请求会被策略拦下吗」。
 *
 * @param {{url: string, anonKey: string}} opts
 * @returns {Promise<{ results: Array<object>, problems: Array<object> }>}
 */
export async function probeRls({ url, anonKey }) {
  const results = [];
  const problems = [];

  for (const probe of PROBES) {
    const { status, body } = await req(url, anonKey, probe.table, {
      method: 'POST',
      body: JSON.stringify([probe.row()]),
      headers: { Prefer: 'return=minimal' },
    });

    const code = body?.code || '';
    const message = body?.message || '';

    if (status === 404 || code === 'PGRST205') {
      // 表不存在 → 交给 schema 契约检查去报，这里不误报
      results.push({ table: probe.table, verdict: 'skip', detail: '表不存在（schema 漂移交给 check-test-schema.mjs）' });
      continue;
    }

    if (code === RLS_VIOLATION || /row-level security/i.test(message)) {
      results.push({ table: probe.table, verdict: 'pass', detail: `anon 写被策略拦下（${RLS_VIOLATION}）` });
    } else if (CONSTRAINT_CODES.has(code)) {
      results.push({
        table: probe.table,
        verdict: 'fail',
        detail: `anon 越过了策略层（拿到约束错误 ${code}）⇒ RLS 未生效`,
      });
      problems.push({ table: probe.table, code, message });
    } else if (status >= 200 && status < 300) {
      // 理论上不可能走到这里（外键必然不存在）；真出现说明探针前提被破坏，按失败处理
      results.push({ table: probe.table, verdict: 'fail', detail: `anon 写入竟然"成功"（HTTP ${status}）—— 探针前提已破，请人工核查` });
      problems.push({ table: probe.table, code: `HTTP ${status}`, message: '写入未被任何约束或策略阻止' });
    } else {
      // 看不懂的响应 → fail-closed（宁可误报让人来看一眼，也不要静默放过）
      results.push({ table: probe.table, verdict: 'fail', detail: `无法判定（HTTP ${status} ${code} ${message.slice(0, 60)}）` });
      problems.push({ table: probe.table, code: code || `HTTP ${status}`, message });
    }
  }

  // 附加断言：anon 直接读也不能拿到行（能读到 ⇒ 策略过宽，例如漏写 `TO authenticated`）。
  // 局限（写清楚，免得被当成万能的）：表为空时 `[]` 是**空表假通过** —— 这也是为什么
  // 主断言用 INSERT 探针（与表里有没有数据无关）。测试库的 profiles 恒有两个测试账号，
  // 所以这一行在测试库里是真信号。
  for (const probe of PROBES.filter((p) => p.anonReadMustBeEmpty)) {
    const { status, body } = await req(url, anonKey, `${probe.table}?select=id&limit=1`);
    const rows = Array.isArray(body) ? body.length : 0;
    if (status === 200 && rows > 0) {
      results.push({
        table: probe.table,
        verdict: 'fail',
        detail: `anon 读到了 ${rows} 行（策略过宽：SELECT 缺少 TO authenticated）`,
      });
      problems.push({ table: probe.table, code: 'POLICY_TOO_BROAD', message: 'anon 可读' });
    } else {
      results.push({ table: probe.table, verdict: 'pass', detail: 'anon 读不到任何行' });
    }
  }

  return { results, problems };
}

/** 打印报告 + 修复指引；返回是否全部通过 */
export function reportRls(results, problems, out = console) {
  out.log('\n=== RLS 生效自检（anon 视角）===');
  out.log('  探针：anon + 必然违反外键的 INSERT —— 42501 = 策略拦下了；约束错误 = RLS 没开\n');
  for (const r of results) {
    const mark = r.verdict === 'pass' ? '✓' : r.verdict === 'skip' ? '·' : '✗';
    out.log(`  ${mark} ${r.table.padEnd(13)} ${r.detail}`);
  }

  if (!problems.length) {
    out.log('\n✅ 所有业务表的 RLS 均生效，anon 无法读写业务数据\n');
    return true;
  }

  out.error('\n🛑 有表的 RLS 没拦住 anon（= 拿到项目 URL 的任何人可读可写）\n');
  for (const p of problems) out.error(`  ${p.table}：${p.code} ${String(p.message).slice(0, 80)}`);
  out.error('\n修复：到该项目 Supabase Dashboard → SQL Editor，执行仓库内');
  out.error('     supabase/migration-rls-hardening.sql（幂等，可重复执行）');
  out.error('     执行完重跑本脚本，应输出「所有业务表的 RLS 均生效」。\n');
  return false;
}

// ---------- 直接运行（作为 CLI）----------
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const testEnv = loadDotenv(join(APP_E2E, '.env.test'));
  const prodEnv = loadDotenv(join(ROOT, '.env'));

  const testUrl = process.env.E2E_SUPABASE_URL || testEnv.E2E_SUPABASE_URL;
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY || testEnv.E2E_SUPABASE_ANON_KEY;
  const prodUrl = process.env.SUPABASE_URL || prodEnv.SUPABASE_URL;

  if (!testUrl || !anonKey) {
    console.error('✗ 缺少 E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY（检查 app-e2e/.env.test）');
    process.exit(2);
  }
  // 硬闸：测试库 URL 与生产库相同 → 直接拒绝（铁律一）。这是唯一必须 fail-closed 的情形。
  if (prodUrl && prodUrl === testUrl) {
    console.error('\n✗ 拒绝执行：E2E_SUPABASE_URL 与生产库 .env 的 SUPABASE_URL 相同（铁律一）\n');
    process.exit(2);
  }
  if (!prodUrl) {
    console.log('ℹ️ 拿不到生产库 URL（无 .env / 无 SUPABASE_URL）→ 无法自证隔离；本脚本不写数据，继续执行');
  }

  console.log(`\n目标库：${testUrl}`);
  if (prodUrl) console.log(`生产库：${prodUrl}  ← 绝不触碰`);

  const { results, problems } = await probeRls({ url: testUrl, anonKey });
  const ok = reportRls(results, problems);
  process.exit(ok ? 0 : 1);
}
