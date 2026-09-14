/**
 * 发布后回读校验（post-deploy smoke check）
 *
 * 站在「客户端视角」验证这一次发布真的可交付：
 *   1. app_versions 有该版本行且 enabled = true  —— App 查得到
 *   2. storage_path 指向的 zip 能下载且非空       —— App 拉得到
 *   3. 包内 index.html 的 app-version meta == 版本号 —— App 装的是这一版，不是旧包/缓存
 *
 * 为什么必须回读：`release.mjs` 只保证「上传返回成功 + 写表返回成功」，
 * 这两步都是「服务端接受了请求」，不等于「客户端能拿到正确内容」。
 * 上传的 zip 打错 meta、写表写错版本号、对象上传后损坏 —— 只有下载回来拆开看才发现，
 * 而 App 侧的表现是「更新下载完、重启后还是旧界面」，极难定位。
 * CD 的最后一环是「验证交付物」，不是「脚本没报错」。
 *
 * 用法：
 *   node scripts/verify-release.mjs                    # 校验线上最新 enabled 版本
 *   node scripts/verify-release.mjs 2.7.65             # 校验指定版本
 *   node scripts/verify-release.mjs 2.7.65 --min-app 2.1.0   # 附带校验最低兼容壳版本
 *
 * 只读：仅 SELECT 版本表 + 下载 Storage 对象，不写任何数据（铁律一）。
 * 退出码：0 = 全部通过；1 = 任一断言失败（可直接当 CI 门禁用）。
 */

import { createClient } from '@supabase/supabase-js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`发布后回读校验（只读）

用法：
  node scripts/verify-release.mjs [版本号] [--min-app x.y.z]

不传版本号 = 校验线上最新 enabled 版本。
退出码 0 = 通过，1 = 失败（可作 CI 门禁）。`);
  process.exit(0);
}

const VERSION = args[0] && !args[0].startsWith('--') ? args[0] : null;
if (VERSION && !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z`);
  process.exit(1);
}
const minAppIdx = args.indexOf('--min-app');
const EXPECT_MIN_APP = minAppIdx >= 0 ? args[minAppIdx + 1] || null : null;
// --min-app 后面没跟值（如 `--min-app` 结尾）说明用法写错，直接退出而不是静默跳过校验
if (minAppIdx >= 0 && !EXPECT_MIN_APP) {
  console.error('✗ --min-app 缺少版本号参数');
  process.exit(1);
}

loadEnv();
const { url, key } = requireSupabaseEnv();
const sb = createClient(url, key, { auth: { persistSession: false } });

/** 失败计数（最后决定退出码，跑完全部检查而不是第一个失败就退出，一次拿到完整清单） */
const failures = [];
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? `：${detail}` : ''}`);
  } else {
    console.log(`  ✗ ${label}${detail ? `：${detail}` : ''}`);
    failures.push(label);
  }
}

console.log(`\n🔍 回读校验${VERSION ? ` 版本 ${VERSION}` : ' 线上最新 enabled 版本'}\n`);

// ---------- 1. 版本行 ----------
let query = sb.from('app_versions').select('*');
query = VERSION
  ? query.eq('version', VERSION).maybeSingle()
  : query.eq('enabled', true).order('released_at', { ascending: false }).limit(1).maybeSingle();

const { data: row, error: qErr } = await query;
if (qErr) {
  console.error(`✗ 查询 app_versions 失败：${qErr.message}`);
  process.exit(1);
}
if (!row) {
  console.error(VERSION
    ? `✗ app_versions 没有版本 ${VERSION}（发布脚本写表失败了？）`
    : '✗ 线上没有任何 enabled 版本');
  process.exit(1);
}

console.log(`  版本行：${row.version}（${row.released_at}）`);
check(row.enabled === true, 'enabled = true（App 能查到）', `enabled=${row.enabled}`);
if (EXPECT_MIN_APP) {
  check(row.min_app_version === EXPECT_MIN_APP, `min_app_version = ${EXPECT_MIN_APP}`,
    `实际 ${row.min_app_version ?? 'null'}`);
}
console.log(`  说明：${row.notes || '（无）'}`);

// ---------- 2. Storage 对象 ----------
const storagePath = row.storage_path || `releases/${row.version}.zip`;
console.log(`\n  下载 app_updates/${storagePath} ...`);
const { data: blob, error: dlErr } = await sb.storage.from('app_updates').download(storagePath);
if (dlErr) {
  console.error(`✗ 下载失败：${dlErr.message}`);
  process.exit(1);
}
const zipBuf = Buffer.from(await blob.arrayBuffer());
check(zipBuf.length > 0, '对象可下载且非空', `${(zipBuf.length / 1024).toFixed(1)} KB`);

// ---------- 3. 包内 meta ----------
// 解出临时 zip 后拆开看 index.html —— 校验的是「App 实际会拿到的内容」，
// 而不是「我们以为打包进去的内容」。
const tmpDir = mkdtempSync(join(tmpdir(), 'verify-release-'));
let innerHtml = '';
try {
  const tmpZip = join(tmpDir, `${row.version}.zip`);
  writeFileSync(tmpZip, zipBuf);
  try {
    innerHtml = execFileSync('unzip', ['-p', tmpZip, 'index.html'], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    check(false, '包内 index.html 可解出',
      `unzip 失败：${e.message}（确认包结构与 updater 要求一致：zip 根目录即 web 内容）`);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

if (innerHtml) {
  const metaMatch = innerHtml.match(/<meta name="app-version" content="([^"]*)" \/>/);
  check(!!metaMatch, '包内 index.html 含 app-version meta');
  if (metaMatch) {
    check(metaMatch[1] === row.version, '包内 meta 与版本号一致',
      metaMatch[1] === row.version ? metaMatch[1] : `meta=${metaMatch[1]}，版本行=${row.version}（App 会判定版本不一致，反复下载）`);
  }
}

// ---------- 结论 ----------
if (failures.length === 0) {
  console.log(`\n✅ 回读校验通过：版本 ${row.version} 对客户端可交付\n`);
  process.exit(0);
}
console.error(`\n✗ 回读校验失败 ${failures.length} 项：${failures.join('、')}\n`);
console.error('  处置建议：先确认是否写入端出错（重跑发布），');
console.error('  必要时用 `node scripts/rollback.mjs` 下线该版本，避免客户端拿到坏包。\n');
process.exit(1);
