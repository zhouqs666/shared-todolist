#!/usr/bin/env node
/**
 * DORA 四指标报告（**只读**）：部署频率 / 前置时间 / 变更失败率 / 恢复时间
 *
 * 用法：
 *   node scripts/dora-metrics.mjs                 # 近 30 天
 *   node scripts/dora-metrics.mjs --days 90
 *   node scripts/dora-metrics.mjs --json          # 给机器读（CI 里存档、画图都行）
 *   node scripts/dora-metrics.mjs --fail-on-degraded   # 指标超阈值时退出码非 0（当门禁用）
 *
 * 数据来源：`app_versions`（热更新）+ `app_native_versions`（APK 壳），全是发布脚本自己写的行。
 * 口径与已知限制写在 `scripts/_lib-dora.mjs` 头部 —— 那里是唯一的事实来源，别再抄一份。
 *
 * ⚠️ 本脚本**只读**：只 select，不写任何表。`--fail-on-degraded` 也只是退出码。
 * ⚠️ 与 `query-latest-version.mjs` / `verify-release.mjs` 同属发布链路的观测工具，
 *    凭据走 `_lib-env.mjs`（本地 `.env` / CI 环境变量）。
 */

import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';
import { createClient } from '@supabase/supabase-js';
import { computeDora, formatDoraReport } from './_lib-dora.mjs';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let days = 30;
let asJson = false;
let failOnDegraded = false;

// 阈值（当门禁时用；默认刻意宽松 —— 先观察真实分布再收紧，别一上来就定死数）
let maxFailureRate = 0.3;
let maxLeadMedianMin = 7 * 24 * 60;
let maxRecoveryMedianMin = 3 * 24 * 60;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--days') days = Number(args[++i]);
  else if (a === '--json') asJson = true;
  else if (a === '--fail-on-degraded') failOnDegraded = true;
  else if (a === '--max-failure-rate') maxFailureRate = Number(args[++i]);
  else if (a === '--max-lead-minutes') maxLeadMedianMin = Number(args[++i]);
  else if (a === '--max-recovery-minutes') maxRecoveryMedianMin = Number(args[++i]);
  else if (a === '-h' || a === '--help') {
    console.log(`DORA 四指标报告（只读）

  node scripts/dora-metrics.mjs [--days 30] [--json] [--fail-on-degraded]
  [--max-failure-rate 0.3] [--max-lead-minutes 10080] [--max-recovery-minutes 4320]

口径见 scripts/_lib-dora.mjs 头部注释。`);
    process.exit(0);
  } else {
    // 手滑的参数必须报错退出：静默忽略会让 `--day 90` 这种写法"看起来生效了"
    console.error(`✗ 未识别的参数：${a}（用 --help 看用法）`);
    process.exit(1);
  }
}

if (!Number.isFinite(days) || days <= 0) {
  console.error(`✗ --days 需要正数，收到：${args[args.indexOf('--days') + 1]}`);
  process.exit(1);
}

loadEnv();
const { url: SUPABASE_URL, key: SERVICE_KEY } = requireSupabaseEnv();

const SELECT = 'version, released_at, enabled, commit_sha, commit_at, commit_dirty, '
  + 'disabled_at, disabled_reason, disabled_is_incident';
const SELECT_NATIVE = 'version_name, released_at, enabled, commit_sha, commit_at, commit_dirty, '
  + 'disabled_at, disabled_reason, disabled_is_incident';

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** 迁移没执行时这些列不存在 —— 那时**不能**整个脚本报错，而要给出可执行的提示 */
async function fetchRows(table, select, fallbackSelect) {
  const { data, error } = await sb.from(table).select(select).order('released_at', { ascending: true });
  if (!error) return { rows: data || [], degraded: null };
  const missing = /commit_sha|disabled_at|column/i.test(`${error.message} ${error.details || ''}`);
  if (!missing) throw new Error(`读 ${table} 失败：${error.message}`);
  const { data: d2, error: e2 } = await sb.from(table).select(fallbackSelect).order('released_at', { ascending: true });
  if (e2) throw new Error(`读 ${table} 失败：${e2.message}`);
  return { rows: d2 || [], degraded: error.message };
}

const { rows: web, degraded: dw } = await fetchRows(
  'app_versions', SELECT, 'version, released_at, enabled');
const { rows: native, degraded: dn } = await fetchRows(
  'app_native_versions', SELECT_NATIVE, 'version_name, released_at, enabled');

if (dw || dn) {
  console.error('\n⚠️ 数据库还没有 DORA 元数据列（commit_sha / disabled_* ）。');
  console.error('   请先在 Supabase Dashboard → SQL Editor 执行 supabase/migration-dora-metrics.sql');
  console.error('   在此之前：部署频率可算，前置时间与失败率/恢复时间无法计算。\n');
}

const metrics = computeDora({ web, native, now: new Date(), days });

if (asJson) {
  console.log(JSON.stringify(metrics, null, 2));
} else {
  const report = formatDoraReport(metrics);
  console.log('\n' + report + '\n');

  // CI 里顺手写 Run Summary（本地跑时这个环境变量不存在，自动跳过）
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n', { flag: 'a' });
    } catch (e) {
      console.error(`  （写 Run Summary 失败，不影响报告：${e.message}）`);
    }
  }
}

if (failOnDegraded) {
  const breaches = [];
  const { changeFailure: c, leadTime: l, recovery: r } = metrics;
  if (c.rate !== null && c.rate > maxFailureRate) {
    breaches.push(`变更失败率 ${(c.rate * 100).toFixed(1)}% > ${(maxFailureRate * 100).toFixed(0)}%`);
  }
  if (l.medianMin !== null && l.medianMin > maxLeadMedianMin) {
    breaches.push(`前置时间中位数 ${l.medianMin.toFixed(0)} 分钟 > ${maxLeadMedianMin} 分钟`);
  }
  if (r.medianMin !== null && r.medianMin > maxRecoveryMedianMin) {
    breaches.push(`恢复时间中位数 ${r.medianMin.toFixed(0)} 分钟 > ${maxRecoveryMedianMin} 分钟`);
  }
  if (breaches.length > 0) {
    console.error(`✗ DORA 门禁未通过：`);
    for (const b of breaches) console.error(`    · ${b}`);
    process.exit(1);
  }
  console.log('✓ DORA 门禁通过（阈值内）');
}
