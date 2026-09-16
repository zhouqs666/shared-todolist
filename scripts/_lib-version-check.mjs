/**
 * 通用版本号工具（供 release.mjs / release-apk.mjs 共享）
 *
 * 核心职责：
 *   1. 语义化版本比较
 *   2. 强制查线上最新启用版本，新版本必须 > 线上，否则 process.exit(1)
 *
 * 2026-08-07 血泪教训：版本号低导致 App 判定"无更新"，用户永远收不到。
 *   - 当时只在 release.mjs（热更新）漏了；release-apk.mjs 已加。
 *   - 现在 release.mjs 也修了（用本模块对称），铁律三两边都兜住。
 *
 * 复用约束：被 release 脚本 import，**必须入库提交**。
 *            别跟调试探针混（_debug-*.mjs / _diag-*.mjs 已被 .gitignore 排除）。
 */

import process from 'node:process';

/** 语义化比较：-1 / 0 / 1（与前端 update.js 同一套语义） */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * 强制查线上最高版本号，新版本必须语义化大于它，否则 process.exit(1)。
 *
 * 【2026-09-16 改】基准从「最新 enabled 行」改为「**全部行**里的最大版本号（含已下线）」。
 * 为什么：客户端判定更新用的是「服务端版本 <= 本地版本 → 无更新」（update.js / apk-update.js），
 * 而设备本地版本可能是某个**曾经下发过、后来被下线**的版本 —— 回滚演练就会留下这种行
 * （线上 2.7.65：enabled=false，notes 写着"随后回滚演练"）。只跟 enabled 行比会放行 2.7.65，
 * 于是那台已经装到 2.7.65 的设备永远收不到更新。已下线的版本号同样"用过就不许再用"。
 *
 * @param {Object} sb Supabase client (service_role)
 * @param {string} table 表名（'app_versions' | 'app_native_versions'）
 * @param {string} versionColumn 版本号列名（'version' | 'version_name'）
 * @param {string} newVersion 待发布版本号
 * @param {string} [hint] 失败时附加提示文案（默认含 2026-08-07 血泪教训）
 * @returns {Promise<Object|null>} 线上最高版本行（无记录时返回 null）
 */
export async function assertNewerThanLatest(sb, table, versionColumn, newVersion, hint) {
  const { data, error } = await sb.from(table).select('*');
  if (error) {
    console.error(`✗ 查询 ${table} 失败：${error.message}`);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log('  ✓ 线上无记录（首发），可直接发布');
    return null;
  }

  let highest = data[0];
  for (const row of data) {
    if (compareVersions(row[versionColumn], highest[versionColumn]) > 0) highest = row;
  }
  const online = highest[versionColumn];
  const offlineTag = highest.enabled === false ? '（已下线但号已用过）' : '';
  if (compareVersions(newVersion, online) <= 0) {
    console.error(`✗ 版本号必须大于线上出现过的最高版本（最高 ${online}${offlineTag}，要发 ${newVersion}）。
${hint || '  血泪教训 2026-08-07：版本号低会导致 App 判定"无更新"，用户永远收不到。'}`);
    process.exit(1);
  }
  console.log(`  ✓ 线上最高版本 ${online}${offlineTag}，本次发 ${newVersion}，可发布`);
  return highest;
}
