/**
 * 安全 preflight：表 RLS + 函数执行权限（铁律一 / 铁律二）
 *
 * 查两件事（都是「anon 视角」——不带登录态，等于拿到项目 URL 的任何人，
 * 因为 anon key 是公开的、硬编码在 public/js/supabase.js 里随 APK 分发）：
 *   ① 表的 RLS 是否真的拦得住 anon
 *   ② RPC 是否只对登录用户开放，且暴露面上没有"来历不明"的函数
 *
 * 为什么需要（2026-09-16，Supabase 安全顾问告警 + 顺着线索的审计）：
 *   测试项目被报 CRITICAL `rls_disabled_in_public`：`profiles` 的 RLS 没开
 *   ——「未登录可读可写」。而仓库 supabase/schema.sql 里 profiles 一直是
 *   `ENABLE ROW LEVEL SECURITY` ⇒ **不是仓库漏写，是项目上被手工改过、且没有任何回读校验**。
 *   顺着同一条线索还查出两件事：项目里有个仓库里查不到的 `create_test_user` RPC
 *   （anon 能调 ⇒ 可任意建账号），以及 App 自己的两个 SECURITY DEFINER 计数函数
 *   也对 anon 开放（⇒ 未登录能写 profiles）。三件都是「手工 SQL 会漂移」的同一根因。
 *
 * 判据（表探针：**用一个必然违反外键的 INSERT 去问数据库「策略拦不拦」**）
 *   对每张业务表发一个 payload，其中外键指向一个必定不存在的 UUID：
 *     · 42501 `new row violates row-level security policy` → 策略在干活 ✅
 *     · 23503 / 23505 / 23514 等**约束错误** → 请求已穿过策略层 ⇒ **RLS 没开** 🔴
 *
 * 判据（函数探针：**anon 调 RPC 必须被拒**）
 *   同样用「必然不存在的 UUID」做参数，保证零写入（两个函数的返回值/影响行数都已实测为 0）。
 *
 *   为什么这些「写请求」是安全的（不必担心铁律一）：
 *     ① payload 的外键/主键必然不存在 ⇒ 无论 RLS 开没开，**都不可能落行**；
 *     ② 即便先插入后被外键回滚，也仍在同一语句的隐式事务里，不会留下数据；
 *     ③ 每次跑完都该回读一遍（见文件末尾的「零写入自证」），不信"理论上不写"。
 *     （对比：`reset-test-db.mjs` 真的删数据，所以它必须 fail-closed；本脚本不写数据，
 *       所以拿不到生产 URL 时只警告、不阻断 —— 风险是「判断错对象」而不是「误改数据」。）
 *
 * 姊妹脚本分工（不要重复实现）：
 *   隔离自检 → scripts/check-test-env.mjs
 *   schema 漂移（表/列/函数）→ app-e2e/scripts/check-test-schema.mjs
 *   RLS / 函数权限是否真的生效（本文件）
 *
 * 用法：node app-e2e/scripts/check-rls.mjs        # 或在 app-e2e 下：node scripts/check-rls.mjs
 * 退出码：0 = 全部生效；1 = 有表 RLS 未生效或 anon 能调函数（打印修复 SQL）；2 = 环境缺失或测试库=生产库
 *
 * 零写入自证（复核用，service_role 只读）：
 *   curl -s "$E2E_SUPABASE_URL/rest/v1/profiles?select=username,login_count_for_partner" \
 *     -H "apikey: $E2E_SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $E2E_SUPABASE_SERVICE_ROLE_KEY"
 *   跑脚本前后各看一次，数值应一字未变。
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

/**
 * 函数执行权限探针（2026-09-16 追加，起因见文件末尾「为什么还查函数」）。
 *
 * 判据与表探针同构：**anon 调用必须被拒（42501）**。
 * 零写入的保证：传一个必然不存在的 UUID ——
 *   · `increment_login_count`：`UPDATE … WHERE id = <ghost>` ⇒ 0 行受影响；
 *   · `consume_login_count`：函数体先 `SELECT … INTO`，取不到就直接 `RETURN 0` ⇒ 提前返回。
 * 两者都在测试库实测过「调用前后 login_count_for_partner 一字未变」。
 */
export const RPC_PROBES = [
  {
    name: 'increment_login_count',
    args: () => ({ target_uid: GHOST_UUID }),
    why: 'SECURITY DEFINER，函数体是 UPDATE profiles（未登录可刷/清零对方的打开计数）',
  },
  {
    name: 'consume_login_count',
    args: () => ({ target_uid: GHOST_UUID }),
    why: 'SECURITY DEFINER，函数体是读并清零 profiles.login_count_for_partner',
  },
];

/**
 * PostgREST 暴露的 RPC 白名单：**出现白名单外的函数就失败**。
 *
 * 为什么值得单列一条（2026-09-16 实测）：测试项目里曾长期存在一个
 * `create_test_user(p_email, p_password, p_username, p_display_name)` ——
 * 仓库、git 全历史、本机 agent 历史里都查不到它，是某次手工粘进 SQL Editor 的调试片段。
 * 它带着 Supabase 给 public schema 函数的默认权限（EXECUTE 授予 PUBLIC）⇒
 * **任何人拿公开的 anon key 就能建账号**，而在本项目的 RLS 模型下"有账号"≈"能读写全部数据"。
 * 它是靠人工翻函数清单才发现的 —— 这条白名单把它变成机器判定：
 * 暴露面上多出任何函数，都必须在这里登记 + 写清用途（同 readonly-guard 的豁免风格）。
 */
export const RPC_ALLOWLIST = new Map([
  ['increment_login_count', 'App 冷启动给自己的计数 +1（登录后调用，见 app.js:368）'],
  ['consume_login_count', '读并清零对方的计数，用于爱心光晕（登录后调用，见 db.js:348）'],
]);

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
 * 核心探测：① 每张业务表的 RLS 是否真的拦得住 anon；② 每个 RPC 是否只对登录用户开放；
 * ③ 暴露出来的 RPC 是否都在白名单里。
 *
 * @param {{url: string, anonKey: string, serviceKey?: string}} opts
 *   serviceKey 仅用于读 PostgREST 的函数清单（读 OpenAPI 需要 service_role，anon 会 401）；
 *   拿不到就跳过第 ③ 项，并在报告里注明 —— 不静默当通过。
 * @returns {Promise<{ results: Array<object>, problems: Array<object> }>}
 */
export async function probeRls({ url, anonKey, serviceKey }) {
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
      results.push({ label: probe.table, verdict: 'skip', detail: '表不存在（schema 漂移交给 check-test-schema.mjs）' });
      continue;
    }

    if (code === RLS_VIOLATION || /row-level security/i.test(message)) {
      results.push({ label: probe.table, verdict: 'pass', detail: `anon 写被策略拦下（${RLS_VIOLATION}）` });
    } else if (CONSTRAINT_CODES.has(code)) {
      results.push({
        label: probe.table,
        verdict: 'fail',
        detail: `anon 越过了策略层（拿到约束错误 ${code}）⇒ RLS 未生效`,
      });
      problems.push({ label: probe.table, code, message });
    } else if (status >= 200 && status < 300) {
      // 理论上不可能走到这里（外键必然不存在）；真出现说明探针前提被破坏，按失败处理
      results.push({ label: probe.table, verdict: 'fail', detail: `anon 写入竟然"成功"（HTTP ${status}）—— 探针前提已破，请人工核查` });
      problems.push({ label: probe.table, code: `HTTP ${status}`, message: '写入未被任何约束或策略阻止' });
    } else {
      // 看不懂的响应 → fail-closed（宁可误报让人来看一眼，也不要静默放过）
      results.push({ label: probe.table, verdict: 'fail', detail: `无法判定（HTTP ${status} ${code} ${message.slice(0, 60)}）` });
      problems.push({ label: probe.table, code: code || `HTTP ${status}`, message });
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
        label: probe.table,
        verdict: 'fail',
        detail: `anon 读到了 ${rows} 行（策略过宽：SELECT 缺少 TO authenticated）`,
      });
      problems.push({ label: probe.table, code: 'POLICY_TOO_BROAD', message: 'anon 可读' });
    } else {
      results.push({ label: probe.table, verdict: 'pass', detail: 'anon 读不到任何行' });
    }
  }

  // ---------- ② RPC 执行权限：anon 必须被拒 ----------
  for (const probe of RPC_PROBES) {
    const { status, body } = await req(url, anonKey, `rpc/${probe.name}`, {
      method: 'POST',
      body: JSON.stringify(probe.args()),
    });

    const code = body?.code || '';
    const message = body?.message || '';

    if (code === RLS_VIOLATION || /permission denied/i.test(message)) {
      results.push({ label: `${probe.name}()`, verdict: 'pass', detail: `anon 调用被拒（${RLS_VIOLATION}）` });
    } else if (status === 404 || code === 'PGRST202') {
      results.push({ label: `${probe.name}()`, verdict: 'skip', detail: '函数不存在（存在性由 check-test-schema.mjs 负责）' });
    } else if (status >= 200 && status < 300) {
      results.push({
        label: `${probe.name}()`,
        verdict: 'fail',
        detail: `anon 能执行它（HTTP ${status}）—— ${probe.why}`,
      });
      problems.push({ label: `${probe.name}()`, code: `HTTP ${status}`, message: probe.why });
    } else {
      results.push({ label: `${probe.name}()`, verdict: 'fail', detail: `无法判定（HTTP ${status} ${code} ${message.slice(0, 50)}）` });
      problems.push({ label: `${probe.name}()`, code: code || `HTTP ${status}`, message });
    }
  }

  // ---------- ③ 暴露面白名单：多出任何函数都要显式登记 ----------
  if (serviceKey) {
    const spec = await req(url, serviceKey, '');
    const rpcs = spec.body?.paths
      ? Object.keys(spec.body.paths).filter((p) => p.startsWith('/rpc/')).map((p) => p.slice('/rpc/'.length))
      : null;
    if (!rpcs) {
      results.push({ label: 'RPC 暴露面', verdict: 'fail', detail: `读不到 PostgREST 函数清单（HTTP ${spec.status}）` });
      problems.push({ label: 'RPC 暴露面', code: `HTTP ${spec.status}`, message: '无法确认暴露面' });
    } else {
      const unexpected = rpcs.filter((n) => !RPC_ALLOWLIST.has(n));
      if (unexpected.length) {
        results.push({
          label: 'RPC 暴露面',
          verdict: 'fail',
          detail: `出现白名单外的函数：${unexpected.join(', ')}（可能是手工粘进 SQL Editor 的调试函数）`,
        });
        problems.push({ label: 'RPC 暴露面', code: 'UNEXPECTED_RPC', message: unexpected.join(', ') });
      } else {
        results.push({ label: 'RPC 暴露面', verdict: 'pass', detail: `仅 ${rpcs.length} 个已登记函数：${rpcs.join(', ')}` });
      }
    }
  } else {
    results.push({ label: 'RPC 暴露面', verdict: 'skip', detail: '没有 service_role key，跳过暴露面核对（读 OpenAPI 需要它）' });
  }

  return { results, problems };
}

/** 打印报告 + 修复指引；返回是否全部通过 */
export function reportRls(results, problems, out = console) {
  out.log('\n=== 安全自检（anon 视角）：表 RLS + 函数执行权限 ===');
  out.log('  表　：anon + 必然违反外键的 INSERT —— 42501 = 策略拦下了；约束错误 = RLS 没开');
  out.log('  函数：anon 调 RPC —— 42501 = 权限拦下了；2xx = 未登录也能执行\n');
  for (const r of results) {
    const mark = r.verdict === 'pass' ? '✓' : r.verdict === 'skip' ? '·' : '✗';
    out.log(`  ${mark} ${String(r.label).padEnd(22)} ${r.detail}`);
  }

  if (!problems.length) {
    out.log('\n✅ 业务表的 RLS 与 RPC 执行权限均已生效：anon 既读不到、也调不动\n');
    return true;
  }

  out.error('\n🛑 未登录（anon）能碰到不该碰的东西\n');
  for (const p of problems) out.error(`  ${p.label}：${p.code} ${String(p.message).slice(0, 80)}`);
  out.error('\n修复：到该项目 Supabase Dashboard → SQL Editor，执行仓库内');
  out.error('     supabase/migration-rls-hardening.sql        （表：RLS 开关 + 策略）');
  out.error('     supabase/migration-rpc-execute-hardening.sql（函数：收回 PUBLIC/anon 的 EXECUTE）');
  out.error('     执行完重跑本脚本，应输出「RLS 与 RPC 执行权限均已生效」。');
  out.error('     本次命中的若全是函数/暴露面类（没有表类），优先跑第二个文件。\n');
  return false;
}

// ---------- 直接运行（作为 CLI）----------
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const testEnv = loadDotenv(join(APP_E2E, '.env.test'));
  const prodEnv = loadDotenv(join(ROOT, '.env'));

  const testUrl = process.env.E2E_SUPABASE_URL || testEnv.E2E_SUPABASE_URL;
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY || testEnv.E2E_SUPABASE_ANON_KEY;
  const serviceKey = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY || testEnv.E2E_SUPABASE_SERVICE_ROLE_KEY;
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

  const { results, problems } = await probeRls({ url: testUrl, anonKey, serviceKey });
  const ok = reportRls(results, problems);
  process.exit(ok ? 0 : 1);
}
