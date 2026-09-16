#!/usr/bin/env node
/**
 * DORA 元数据迁移的回归测试（**不需要任何 Supabase 凭据，可进 CI**）
 *
 * 为什么要有它：这份迁移是要**让业主手工在 Dashboard 的 SQL Editor 里跑一次**的。
 * 一段没人跑过的 SQL 只是"看起来对的文本" —— 真实风险有两条：
 *   ① 语法/顺序错误：SQL Editor 里还是整体回滚，但人以为自己已经"执行过了"；
 *   ② 列名与脚本不一致：`dora-metrics.mjs` / `release*.mjs` 读写的列名写错，
 *      运行时**不会报错**，只会安静地读不到数据（指标长期显示"—"而无人察觉）。
 * 所以在交给业主之前，先在本地用真 Postgres（PGlite）跑一遍，并且把
 * **脚本要读的列清单**与**迁移建出来的列**对账 —— 这是本项目一贯的"契约检查"做法。
 *
 * 做法（全程本地、不连任何 Supabase 项目 —— 铁律一）：
 *   ① 造一个「和线上同形」的两张版本表（列取自 migration-app-hot-update.sql /
 *      migration-app-native-versions-force.sql），
 *   ② 断言迁移**之前** `dora-metrics.mjs` 的完整 select 会失败（⇒ 证明回落路径不是无用保险），
 *   ③ 跑迁移 → 断言 12 个新列齐备、类型正确，
 *   ④ 再跑一次 → 断言幂等（不报错、不改变语义），
 *   ⑤ 断言不变式可被 SQL 表达：`disabled_at IS NULL ⟺ enabled = true`（本项目自己维护的约定），
 *   ⑥ 断言回溯：老行（enabled=false 且 disabled_at IS NULL）与未归类行（disabled_is_incident IS NULL）
 *      会被 SQL 分得清 —— DORA 报告正是靠这两条区分「老数据」「未归类」与「事故」。
 *
 * 用法：node scripts/test_dora_migration.mjs
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { DORA_COLUMNS, BASE_COLUMNS } from './_lib-dora.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(join(ROOT, 'supabase', 'migration-dora-metrics.sql'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}
const errText = (e) => (e && e.message ? e.message : String(e)).split('\n')[0];

const db = new PGlite();

// ① 和线上同形的基础表（列取自两个既有迁移文件，**不含**本次要加的 6 列）
await db.exec(`
  create table public.app_versions (
    id              uuid primary key default gen_random_uuid(),
    version         text not null unique,
    storage_path    text not null,
    released_at     timestamptz not null default now(),
    min_app_version text,
    enabled         boolean not null default true,
    notes           text
  );
  create table public.app_native_versions (
    id                    uuid primary key default gen_random_uuid(),
    version_name          text not null unique,
    version_code          integer not null,
    storage_path          text not null,
    apk_size_bytes        bigint,
    apk_sha256            text,
    released_at           timestamptz not null default now(),
    enabled               boolean not null default true,
    notes                 text,
    is_force_update       boolean not null default false,
    min_supported_version text
  );
`);

console.log('\n=== ① 迁移之前：dora-metrics 的完整 select 必须失败 ===');
for (const [table, cols] of [['app_versions', DORA_COLUMNS.web], ['app_native_versions', DORA_COLUMNS.native]]) {
  let failed = false;
  let msg = '';
  try {
    await db.query(`select ${cols.join(', ')} from public.${table} limit 0`);
  } catch (e) { failed = true; msg = errText(e); }
  check(`迁移前 ${table} 完整 select 报错（证明回落路径有用，且这些列确实是新增的）`, failed, msg);
}

console.log('\n=== ② 跑迁移 ===');
try {
  await db.exec(MIGRATION);
  check('迁移执行成功（没有语法错误、没有顺序问题）', true);
} catch (e) {
  check('迁移执行成功', false, errText(e));
}

console.log('\n=== ③ 迁移之后：12 个新列齐备 + 类型正确 ===');
const expected = ['commit_sha', 'commit_at', 'commit_dirty', 'disabled_at', 'disabled_reason', 'disabled_is_incident'];
for (const table of ['app_versions', 'app_native_versions']) {
  const { rows } = await db.query(`
    select column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = 'public' and table_name = $1
  `, [table]);
  const got = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
  for (const c of expected) {
    check(`${table}.${c} 存在`, c in got, `实际列：${Object.keys(got).join(',')}`);
  }
  check(`${table}.commit_at 是 timestamptz`, got.commit_at === 'timestamp with time zone', `实际 ${got.commit_at}`);
  check(`${table}.disabled_at 是 timestamptz`, got.disabled_at === 'timestamp with time zone', `实际 ${got.disabled_at}`);
  check(`${table}.commit_dirty 是 boolean`, got.commit_dirty === 'boolean', `实际 ${got.commit_dirty}`);
  check(`${table}.commit_sha 是 text`, got.commit_sha === 'text', `实际 ${got.commit_sha}`);

  // 新列必须可空：迁移前的老行没有值，NOT NULL 会让迁移在真实数据上直接失败
  const nullable = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
  const allNullable = expected.every((c) => nullable[c] === 'YES');
  check(`${table} 的 6 个新列全部可空（老行没有值，否则迁移会失败）`, allNullable,
    expected.map((c) => `${c}=${nullable[c]}`).join(' '));

  // 列清单对账：脚本要读的列，必须真的存在（这条才是"契约"）
  let ok = true;
  let msg = '';
  try {
    await db.query(`select ${DORA_COLUMNS[table === 'app_versions' ? 'web' : 'native'].join(', ')} from public.${table} limit 0`);
    await db.query(`select ${BASE_COLUMNS[table === 'app_versions' ? 'web' : 'native'].join(', ')} from public.${table} limit 0`);
  } catch (e) { ok = false; msg = errText(e); }
  check(`${table}：脚本的完整列清单 + 回落列清单都能对上真实 schema`, ok, msg);
}

console.log('\n=== ④ 幂等：再跑一次 ===');
try {
  await db.exec(MIGRATION);
  check('重复执行不报错（全部 add column if not exists）', true);
} catch (e) {
  check('重复执行不报错', false, errText(e));
}
{
  const { rows } = await db.query(`
    select count(*)::int as n from information_schema.columns
     where table_schema='public' and table_name='app_versions' and column_name = any($1)
  `, [expected]);
  check('重复执行后列没有变多（仍是 6 个）', rows[0].n === 6, `实际 ${rows[0].n}`);
}

console.log('\n=== ⑤ 不变式与回溯分类（DORA 报告靠这几条区分老数据/未归类/事故）===');
// 事故下线（计入失败率）
await db.exec(`insert into public.app_versions (version, storage_path, enabled, released_at,
  disabled_at, disabled_reason, disabled_is_incident, commit_sha, commit_at, commit_dirty)
  values ('4.0.0', 'releases/4.0.0.zip', false, now() - interval '3 days',
          now() - interval '2 days', '列表空白', true, 'abc123', now() - interval '4 days', false)`);
// 演练下线（不计入）
await db.exec(`insert into public.app_versions (version, storage_path, enabled, released_at,
  disabled_at, disabled_reason, disabled_is_incident)
  values ('4.0.1', 'releases/4.0.1.zip', false, now() - interval '2 days',
          now() - interval '2 days', '回滚演练', false)`);
// 未归类下线（单独列出、不计入）
await db.exec(`insert into public.app_versions (version, storage_path, enabled, released_at, disabled_at)
  values ('4.0.2', 'releases/4.0.2.zip', false, now() - interval '1 day', now() - interval '1 day')`);
// 迁移前的老行（enabled=false 且没有下线记录）
await db.exec(`insert into public.app_versions (version, storage_path, enabled, released_at)
  values ('3.9.9', 'releases/3.9.9.zip', false, now() - interval '20 days')`);
// 在线正常版本
await db.exec(`insert into public.app_versions (version, storage_path, enabled, released_at)
  values ('4.0.3', 'releases/4.0.3.zip', true, now())`);

const incident = await db.query(`select version from public.app_versions where disabled_is_incident is true`);
check('事故下线恰好 1 条（演练与未归类都不算）', incident.rows.length === 1 && incident.rows[0].version === '4.0.0',
  JSON.stringify(incident.rows));

const legacy = await db.query(`select version from public.app_versions where enabled = false and disabled_at is null`);
check('迁移前老行单独分得出来（1 条 3.9.9）', legacy.rows.length === 1 && legacy.rows[0].version === '3.9.9',
  JSON.stringify(legacy.rows));

const unclassified = await db.query(`select version from public.app_versions where disabled_at is not null and disabled_is_incident is null`);
check('未归类下线分得出来（1 条 4.0.2）', unclassified.rows.length === 1 && unclassified.rows[0].version === '4.0.2',
  JSON.stringify(unclassified.rows));

const violation = await db.query(`select version from public.app_versions where enabled = true and disabled_at is not null`);
check('**没有**「已恢复上线但下线记录还在」的行（这条才是要守的方向 —— 它会让已恢复的版本仍被算作故障）',
  violation.rows.length === 0, JSON.stringify(violation.rows));
const legacyShape = await db.query(`select version from public.app_versions where enabled = false and disabled_at is null`);
check('反向是允许的：迁移前老行就是「enabled=false 但没有下线记录」（报告据此单独列出、不计入指标）',
  legacyShape.rows.length === 1 && legacyShape.rows[0].version === '3.9.9', JSON.stringify(legacyShape.rows));

// 前置时间的两种"不该算"的样本都能被识别
const leadUsable = await db.query(`select version from public.app_versions where commit_at is not null and commit_dirty is not true`);
check('可算前置时间的样本（4.0.0）筛得出来', leadUsable.rows.length === 1 && leadUsable.rows[0].version === '4.0.0',
  JSON.stringify(leadUsable.rows));
const dirtySkipped = await db.query(`select version from public.app_versions where commit_dirty is true`);
check('脏工作区样本能被排除（当前 0 条）', dirtySkipped.rows.length === 0, JSON.stringify(dirtySkipped.rows));

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==`);
await db.close();
process.exit(fail > 0 ? 1 : 0);
