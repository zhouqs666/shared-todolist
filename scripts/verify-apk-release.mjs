/**
 * APK 发布后回读校验（post-deploy smoke check，只读）
 *
 * 站在「客户端视角」验证这次 APK 发布真的可安装：
 *   1. app_native_versions 有该版本行且 enabled = true —— App 查得到
 *   2. storage_path 指向的 APK 能下载、字节数与记录一致    —— App 拉得到
 *   3. **下载内容的 SHA-256 == 表里的 apk_sha256**          —— App 装得上
 *   4. 包内 index.html 的 shell-version meta == 版本号      —— 装的是这一版，不是旧包
 *
 * ## 为什么第 3 条是这里最关键的（与 web 通道的回读校验最大差别）
 * `apk-update.js` 在唤起系统安装器**之前**会算下载内容的 sha256 并和表里的值比对，
 * 不一致就**拒绝安装**。所以「表里的 sha256」和「Storage 里那份字节」只要对不上，
 * 用户侧的完整表现是：**更新面板弹出 → 下载完成 → 什么都没发生**。
 * 服务端两边都返回成功，日志全绿，用户在手机上一脸茫然 —— 这正是回读校验存在的理由。
 *
 * ## 另一条（第 4 条）防的是「发了个旧包」
 * 2026-09-04 真发生过（2.1.26 把桌面上的旧 APK 传上去了）。`release-apk.mjs` 也在上传前
 * 校验一次包内 meta；这里是**从 Storage 下载回来再校验**，校验对象是"用户真正会拿到的那份"。
 * 上传前查 + 上传后回读查，不是重复：前者防"传错文件"，后者防"传坏了 / 传丢了 / 传串了"。
 *
 * 用法：
 *   node scripts/verify-apk-release.mjs              # 校验线上最新 enabled 壳版本
 *   node scripts/verify-apk-release.mjs 2.1.29       # 校验指定版本
 *   node scripts/verify-apk-release.mjs 2.1.29 --expect-sha256 <hex>   # 额外断言本次发布的哈希
 *
 * 只读：仅 SELECT 版本表 + 下载 Storage 对象，不写任何数据（铁律一）。
 * 退出码：0 = 全部通过；1 = 任一断言失败（可直接当 CI 门禁用）。
 */

import { createClient } from '@supabase/supabase-js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';
import { compareVersions } from './_lib-version-check.mjs';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`APK 发布后回读校验（只读）

用法：
  node scripts/verify-apk-release.mjs [版本号] [--expect-sha256 <hex>]

不传版本号 = 校验线上最新 enabled 壳版本。
退出码 0 = 通过，1 = 失败（可作 CI 门禁）。`);
  process.exit(0);
}

const VERSION = args[0] && !args[0].startsWith('--') ? args[0] : null;
if (VERSION && !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z`);
  process.exit(1);
}
const shaIdx = args.indexOf('--expect-sha256');
const EXPECT_SHA = shaIdx >= 0 ? (args[shaIdx + 1] || null) : null;
// 传了 flag 却没给值 = 用法写错，直接退出而不是静默跳过这条校验
if (shaIdx >= 0 && !EXPECT_SHA) {
  console.error('✗ --expect-sha256 缺少哈希值');
  process.exit(1);
}
if (EXPECT_SHA && !/^[0-9a-f]{64}$/.test(EXPECT_SHA)) {
  console.error(`✗ --expect-sha256 必须是 64 位小写十六进制（收到：${EXPECT_SHA}）`);
  process.exit(1);
}

loadEnv();
const { url, key } = requireSupabaseEnv();
const sb = createClient(url, key, { auth: { persistSession: false } });

/** 失败计数：跑完全部检查再退出，一次拿到完整清单（而不是第一个失败就走） */
const failures = [];
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? `：${detail}` : ''}`);
  } else {
    console.log(`  ✗ ${label}${detail ? `：${detail}` : ''}`);
    failures.push(label);
  }
}

console.log(`\n🔍 APK 回读校验${VERSION ? ` 版本 ${VERSION}` : ' 线上最新 enabled 壳版本'}\n`);

// ---------- 1. 版本行 ----------
let query = sb.from('app_native_versions').select('*');
query = VERSION
  ? query.eq('version_name', VERSION).maybeSingle()
  : query.eq('enabled', true).order('released_at', { ascending: false }).limit(1).maybeSingle();

const { data: row, error: qErr } = await query;
if (qErr) {
  console.error(`✗ 查询 app_native_versions 失败：${qErr.message}`);
  process.exit(1);
}
if (!row) {
  console.error(VERSION
    ? `✗ app_native_versions 没有版本 ${VERSION}（发布脚本写表失败了？）`
    : '✗ 线上没有任何 enabled 壳版本');
  process.exit(1);
}

console.log(`  版本行：${row.version_name}（code ${row.version_code}，${row.released_at}）`);
check(row.enabled === true, 'enabled = true（App 能查到）', `enabled=${row.enabled}`);

// ---------- 1b. 「App 真的会挑中它吗」——按客户端代码复现挑选逻辑 ----------
// apk-update.js 的挑选方式是：**enabled=true → order by released_at desc → limit 1**，
// 然后拿这行的 version_name 和本地版本做 semver 比较（versionCode 只影响 Android 安装器，
// 不参与 App 的更新判断）。
// 由此推出一个**真实存在、且不报错**的隐患：如果表里存在 version_name 更高、但 released_at
// 更早的启用行，App 会取到"日期最新"的那行 → 判定"无更新" → 那个更高的版本**永远推不出去**。
// 这种问题在任何单一端的日志里都看不出来，只有对着客户端代码查表才能发现。
const { data: enabledRows, error: enErr } = await sb
  .from('app_native_versions')
  .select('version_name, released_at')
  .eq('enabled', true)
  .order('released_at', { ascending: false });
if (enErr) {
  console.error(`✗ 查询已启用行失败：${enErr.message}`);
  process.exit(1);
}
const picked = enabledRows?.[0];
check(!!picked && picked.version_name === row.version_name,
  '它就是 App 会挑中的那行（enabled 里 released_at 最新）',
  picked ? `App 取到 ${picked.version_name}` : '无启用行');
const highestEnabled = (enabledRows || [])
  .reduce((mx, r) => (compareVersions(r.version_name, mx) > 0 ? r.version_name : mx), '0.0.0');
check(highestEnabled === row.version_name,
  '它是已启用行里 version_name 最高的（否则更高那版永远推不出去）',
  `启用行最高 ${highestEnabled}，本行 ${row.version_name}`);

// versionCode 只作**信息展示**，不作断言 —— 这是刻意的，理由要说清楚：
// 「code 必须严格递增」是**发布时**的守卫（release-apk.mjs 里对"历史最大值"强制校验），
// 不是**回读时**的不变式。因为下线一个坏版本之后，正在服役的好版本它的 code 反而更低 ——
// 现实例子：2.1.28（code 32）在服役，而 2.8.0（code 33）误发布后已被 enabled=false。
// 对现役版本断言"code 必须最大"会把合法状态判成失败（本脚本第一版就是这么写错的）。
console.log(`  · versionCode = ${row.version_code}（仅 Android 安装器使用；递增由发版时守卫）`);

console.log(`  说明：${row.notes || '（无）'}`);

// ---------- 2. Storage 对象 ----------
const storagePath = row.storage_path;
if (!storagePath) {
  console.error('✗ 版本行缺少 storage_path，无法回读');
  process.exit(1);
}
console.log(`\n  下载 app_updates/${storagePath} ...`);
const { data: blob, error: dlErr } = await sb.storage.from('app_updates').download(storagePath);
if (dlErr) {
  console.error(`✗ 下载失败：${dlErr.message}`);
  process.exit(1);
}
const apkBuf = Buffer.from(await blob.arrayBuffer());
check(apkBuf.length > 0, 'APK 对象可下载且非空', `${(apkBuf.length / 1024 / 1024).toFixed(1)} MB`);

// 体积一致：客户端下载时也会比对（apk_size_bytes 是面板显示的进度依据）
if (row.apk_size_bytes != null) {
  check(apkBuf.length === row.apk_size_bytes, '字节数与 apk_size_bytes 一致',
    apkBuf.length === row.apk_size_bytes
      ? `${apkBuf.length}`
      : `实际 ${apkBuf.length}，表里 ${row.apk_size_bytes}`);
}

// ---------- 3. SHA-256（客户端安装前的硬校验，对不上 = 用户装不上） ----------
const actualSha = createHash('sha256').update(apkBuf).digest('hex');
if (row.apk_sha256) {
  check(actualSha === row.apk_sha256, 'SHA-256 与 apk_sha256 一致（App 安装前会校验）',
    actualSha === row.apk_sha256
      ? `${actualSha.slice(0, 16)}…`
      : `实际 ${actualSha}\n      表中 ${row.apk_sha256}\n      ⇒ 用户会"下载完成后毫无反应"（安装器被哈希校验拦下）`);
} else {
  check(false, 'SHA-256 与 apk_sha256 一致（App 安装前会校验）', '版本行缺 apk_sha256，App 无法校验完整性');
}
if (EXPECT_SHA) {
  check(actualSha === EXPECT_SHA, '--expect-sha256 与下载内容一致', `${actualSha.slice(0, 16)}…`);
}

// ---------- 4. 包内 meta（防「发了个旧包」） ----------
// 解出临时 APK 再拆开看 assets/public/index.html —— 校验对象是「用户实际会拿到的那份」。
const tmpDir = mkdtempSync(join(tmpdir(), 'verify-apk-'));
let innerHtml = '';
try {
  const tmpApk = join(tmpDir, `${row.version_name}.apk`);
  writeFileSync(tmpApk, apkBuf);
  try {
    innerHtml = execFileSync('unzip', ['-p', tmpApk, 'assets/public/index.html'], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    check(false, '包内 assets/public/index.html 可解出', `unzip 失败：${e.message}`);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

if (innerHtml) {
  const shellMeta = innerHtml.match(/<meta name="shell-version" content="([^"]*)" \/>/);
  check(!!shellMeta, '包内 index.html 含 shell-version meta');
  if (shellMeta) {
    check(shellMeta[1] === row.version_name, '包内 shell-version 与版本行一致（不是旧包）',
      shellMeta[1] === row.version_name
        ? shellMeta[1]
        : `包内=${shellMeta[1]}，版本行=${row.version_name}（发了个旧包：用户装上仍是旧壳）`);
  }
}

// ---------- 结论 ----------
if (failures.length === 0) {
  console.log(`\n✅ 回读校验通过：APK ${row.version_name} 对客户端可安装\n`);
  process.exit(0);
}
console.error(`\n✗ APK 回读校验失败 ${failures.length} 项：${failures.join('、')}\n`);
console.error('  处置建议：');
console.error('   · SHA-256 / 体积不一致 → 多为上传中断或对象损坏，**重跑发布**（脚本 upsert 覆盖同一路径）');
console.error('   · 包内 meta 是旧版本     → 上传了旧文件，重跑发布前先确认 APK 来源');
console.error('   · 紧急止血：临时把该行 enabled 置 false（App 会退回上一个启用版本）——');
console.error('     注意 APK 的"回滚"只是**停止推送**，已经装了坏包的用户不会自动降级，');
console.error('     所以坏包的正确处置是**尽快发一个修好的更高版本**，而不是依赖下线。\n');
process.exit(1);
