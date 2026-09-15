/**
 * APK（原生壳）发布脚本
 *
 * 用法：
 *   node scripts/release-apk.mjs <版本号> [选项]
 *
 * 示例：
 *   node scripts/release-apk.mjs 2.1.29 --notes "App 内更新能力 + 震动权限"
 *   node scripts/release-apk.mjs 2.1.29 --code 34                    # 显式指定 versionCode（须与 build.gradle 一致）
 *   node scripts/release-apk.mjs 2.1.29 --apk ~/Desktop/有爱.apk     # 指定 APK 路径
 *   node scripts/release-apk.mjs 2.1.29 --dry-run                   # 只校验不上传，预演
 *   node scripts/release-apk.mjs 2.1.29 --dry-run --build           # 预演但真的构建（CI 预演用）
 *
 * 流程：
 *   1. 校验版本号格式（x.y.z）
 *   2. 【铁律】先查线上 app_native_versions 最新启用版本，新版本必须语义化大于线上，
 *      否则中止（防止版本号倒挂导致 App 判定"无更新"——2026-08-07 的血泪教训）
 *   3. 【铁律】发布前置守卫：build.gradle 必须与本次发布**一致**（一次性报出全部不一致）
 *      · versionName 必须**逐字等于**本次版本号（否则客户端会"无限重装同一版本"）
 *      · versionCode 必须严格递增 —— 跟**含已下线版本**的历史最大值比，
 *        不是只跟"最新 enabled"比（2.8.0 误发布后下线，它的 code 33 也已经用掉了）
 *      · `--code` 不允许与 build.gradle 不一致（APK 里真实的 code 永远取自 build.gradle）
 *   4. cap sync（public/ → android assets）→ 校验 assets 指向生产库
 *   5. 构建期注入版本 meta → gradle assembleRelease
 *   6. 定位 APK → 校验包内 meta（防"发了个旧包"）→ SHA-256 + 体积
 *   7. 上传到 Supabase Storage 的 app_updates bucket（apks/youai-<版本>.apk）
 *   8. 在 app_native_versions 表 upsert 版本记录
 *
 * 凭据：用 service_role key（SUPABASE_URL + SUPABASE_KEY）。
 *       `.env` 文件 **或** 同名环境变量二选一（后者是 CI 通道，见 _lib-env.mjs）。
 *
 * 生效时机：App 冷启动 1.8s 后检查，弹更新面板 → 下载 → 校验 sha256 → 唤起系统安装器
 *          （用户手动点安装）。所以 sha256 写错 = 用户装不上，不是"体验差一点"。
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertNewerThanLatest } from './_lib-version-check.mjs';
import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`APK（原生壳）发布脚本

用法：
  node scripts/release-apk.mjs <版本号> [选项]

选项：
  --notes "<说明>"   更新说明（面板里展示）
  --code <n>         versionCode（缺省从 android/app/build.gradle 读取；**若传入则必须与之一致**）
  --apk <path>       APK 文件路径（默认 gradle 产物，fallback ~/Desktop/有爱.apk）
  --dry-run          只校验不上传，预演（默认跳过 gradle 构建，保持预演快速）
  --build            即使 --dry-run 也真的跑 gradle 构建（CI 预演用：
                     不构建就无法校验「包内 meta」这条最关键的防旧包断言）
  -h, --help         显示帮助

示例：
  node scripts/release-apk.mjs 2.1.29 --notes "App 内更新 + 震动权限"
  node scripts/release-apk.mjs 2.1.29 --dry-run --build
`);
  process.exit(0);
}

const VERSION = args[0];
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z（如 2.1.0）`);
  process.exit(1);
}

let notes = '';
let code = null;
let apkPath = null;
let dryRun = false;
let forceBuild = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--notes') notes = args[++i] || '';
  else if (args[i] === '--code') code = parseInt(args[++i], 10);
  else if (args[i] === '--apk') apkPath = args[++i] || null;
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--build') forceBuild = true;
}

// ---------- 凭据（.env 或环境变量，CI 走后者） ----------
// 2026-09-15 迁移到 _lib-env.mjs：原来是本地内联的 loadEnv（**强制要求 .env 文件存在**），
// CI 里没有 .env、凭据只从 GitHub Secrets 注入环境变量 → 那个版本在 CI 上必然跑不起来。
// 抽公用后「无 .env 时回落环境变量」这条路径由 _lib-env.mjs 统一保证。
loadEnv();
const { url: SUPABASE_URL, key: SERVICE_KEY } = requireSupabaseEnv();

// ---------- 主流程 ----------
async function main() {
  console.log(`\n📦 发布 APK 版本 ${VERSION}\n`);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1.【铁律】先查线上最新启用版本，版本号必须语义化大于线上
  console.log('  → 查询线上最新壳版本（铁律：不允许版本号倒挂）...');
  await assertNewerThanLatest(sb, 'app_native_versions', 'version_name', VERSION,
    '  血泪教训 2026-08-07：壳版本号低，App 判定无更新，用户永远收不到。');

  // 1.2【铁律】发布前置守卫 —— build.gradle 与「本次发布」必须一致。
  //
  // 这一块守的是**同一件事的两面**：`app_native_versions` 表里那行，必须**如实描述**
  // 用户马上要装的那个 APK。表说一套、包里是另一套，客户端就会做出错误判断
  // （最严重的是「无限重装同一版本」，见下面 versionName 那段）。
  //
  // 放在 cap sync / gradle 之前是为了 **fail fast**：坏输入不该等 2~3 分钟构建完才报错，
  // CI 预演尤其需要这一点。
  //
  // ⚠️ 设计上**一次性报出全部不一致**再退出，而不是第一个就退 ——
  //    这些前置条件通常要一起改（versionCode + versionName 一起升），
  //    报一个改一个等于让用户来回跑两轮。与两个 verify-*.mjs 的「跑完全部检查」一致。
  const gradlePath = join(ROOT, 'android', 'app', 'build.gradle');
  const gradle = await readFile(gradlePath, 'utf8');
  const gradleCodeRaw = gradle.match(/versionCode\s+(\d+)/)?.[1];
  const gradleNameRaw = gradle.match(/versionName\s+["']([^"']*)["']/)?.[1];
  if (!gradleCodeRaw || gradleNameRaw === undefined) {
    console.error(`✗ 无法从 android/app/build.gradle 解析 versionCode / versionName（解析到 code=${gradleCodeRaw ?? '无'} name=${gradleNameRaw ?? '无'}）`);
    process.exit(1);
  }
  const gradleCode = parseInt(gradleCodeRaw, 10);
  const preconditions = [];
  /** 历史最大 versionCode 那行（含已下线版本）；在 (d) 里查到，仅用于日志与报错文案 */
  let maxEver = null;

  // (a) versionName 必须逐字等于本次发布的版本号。
  //     为什么是「逐字相等」而不是「大于等于」：客户端拿 **APK manifest 里的 versionName**
  //     当本地版本（apk-update.js 用 App.getInfo().version，注释里写明了 2026-09-04 的血泪教训：
  //     读 meta 会拿到过期快照），再和表里的 version_name 比。两者不等就会：
  //       表说 2.1.29、装的包自报 2.1.28 → 2.1.29 > 2.1.28 → **又提示更新** → 重装 → 仍报 2.1.28
  //       → 用户陷入**无限重装同一版本**（这正是 09-04 那次事故的症状）。
  //     ⚠️ 之前**没有任何检查**守这一条：versionCode 有守卫、包内 shell-version meta 也校验，
  //     但 meta 是脚本自己注入的（恒等于本次版本号，必然通过）—— 于是「表与包不一致」可以一路绿灯。
  if (gradleNameRaw !== VERSION) {
    preconditions.push(`versionName 不一致：build.gradle 是 "${gradleNameRaw}"，本次要发 "${VERSION}"。
    ⇒ 用户装上的包会自报 ${gradleNameRaw}，而表里写 ${VERSION}，App 会**反复提示同一次更新**（无限重装）。
    修复：把 android/app/build.gradle 的 versionName 改成 "${VERSION}"（走 PR 合并）。`);
  }

  // (b) versionCode 必须**严格递增**，基准是「历史上用过的最大值」（含已下线行）。
  //     为什么不能只跟「最新 enabled」比：2.8.0 误发布后已 enabled=false，但它的 versionCode
  //     33 是**真实存在过**的包号 —— Android 不允许同码覆盖安装，同码 = 用户点安装直接失败。
  if (code == null) {
    code = gradleCode;
  } else if (!Number.isInteger(code) || code <= 0) {
    preconditions.push(`--code 不合法：${code}`);
  } else if (code !== gradleCode) {
    // (c) `--code` 不能与 build.gradle 不一致 —— 因为**打进 APK 的是 build.gradle 里的值**，
    //     而表里写的是这里的值。两者不一致 = 表描述的 APK 并不存在：
    //     表说 code 34、包里是 32 ⇒ 下一次「34 > 33 可发」的判断建立在假前提上，
    //     而用户端 Android 真正比较的也是包里的 32。**这个参数只会制造脱钩，没有正当用途。**
    preconditions.push(`--code ${code} 与 build.gradle 的 versionCode ${gradleCode} 不一致。
    ⇒ APK 里真实的 versionCode 永远取自 build.gradle，用 --code 覆盖只会让**表里记的号和包里装的不一致**。
    修复：改 android/app/build.gradle 的 versionCode（走 PR 合并），然后不要传 --code。`);
  }

  // (d) 历史最大值检查也**并进同一批**报出。
  //     ⚠️ 这条曾经写成独立的一步、排在 preconditions 之后 —— 结果「一次性报出全部不一致」只兑现了一半：
  //     versionName 不一致时会先 exit，versionCode 的问题根本轮不到报，
  //     而这两项**通常要一起改**（升一次版本 = code 与 name 同步升），
  //     于是操作者要「改 name → 重跑 → 才发现 code 也没升 → 再改 → 再跑」两轮。
  //     （这是自查时发现的：CI 预演只报了一条，而按设计本该报两条 —— 声明与行为不一致要当缺陷修。）
  if (Number.isInteger(code) && code > 0) {
    const { data: maxCodeRows, error: maxCodeErr } = await sb
      .from('app_native_versions')
      .select('version_code, version_name')
      .order('version_code', { ascending: false })
      .limit(1);
    if (maxCodeErr) {
      console.error(`✗ 查询历史最大 versionCode 失败：${maxCodeErr.message}`);
      process.exit(1);
    }
    maxEver = maxCodeRows?.[0] ?? null;
    if (maxEver && code <= maxEver.version_code) {
      preconditions.push(`versionCode 必须严格递增：历史上用过 ${maxEver.version_code}（${maxEver.version_name}），本次 ${code}。
    Android 不允许同码覆盖安装 —— 同码会让用户点安装时直接失败，且**没有任何提示**。
    注意基准含**已下线**版本（2.8.0 的 code 33 虽已 enabled=false，33 也已经用掉了）。
    修复：把 android/app/build.gradle 的 versionCode 改成大于 ${maxEver.version_code}（走 PR 合并）。`);
    }
  }

  if (preconditions.length > 0) {
    console.error('\n✗ 发布前置检查未通过（build.gradle 与本次发布不一致）：\n');
    for (const p of preconditions) console.error(`  · ${p}\n`);
    console.error('  说明：这些都是**代码改动**，必须先走 PR 合并到 main，再重新触发发布 ——');
    console.error('        发布流水线刻意不代改仓库文件（否则线上版本与仓库内容就会脱钩）。\n');
    process.exit(1);
  }

  console.log(`  ✓ build.gradle 与本次发布一致：versionName=${gradleNameRaw} · versionCode=${code}（历史最大 ${maxEver ? `${maxEver.version_code} · ${maxEver.version_name}` : '无（首发）'}）`);

  // 1.5【必需前置】cap sync：把 public/ 同步进 android assets。
  // 为什么这里必须先同步（2026-09-14 加）：下面按「构建期注入」给 assets 盖版本号，
  // 而 app-version 要盖成「线上最新 web 版本」—— 这个 stamp 只有在 **assets 内容确实来自当前
  // public/** 时才成立。若 assets 是旧快照却盖上新版本号，App 会认为「我已是最新」而
  // **永远不下载**那份更新的 bundle（这正是最危险的方向，与 2.8.0 那类事故同源）；
  // 反之若漏同步导致 stamp 偏低，App 只会多重启一次即可自愈。所以宁可不盖章，也要先同步。
  console.log('  → cap sync（public/ → android assets）...');
  {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('npx', ['cap', 'sync', 'android'], { cwd: ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      console.error('✗ cap sync 失败，中止发布（避免把过期 web 资源打进 APK）');
      process.exit(1);
    }
  }

  // 1.6【铁律一门禁】assets 里的 supabase.js 必须指向生产库。
  // build-test-apk.mjs 会把 assets 临时换成测试库，若还原步骤没跑，正式包就会带上测试库
  // （用户视角 = 账号登不上、待办"全丢"），发布前在这里硬性拦截。
  const assetsSupabasePath = resolve(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'js', 'supabase.js');
  if (existsSync(assetsSupabasePath)) {
    const assetsSupabase = readFileSync(assetsSupabasePath, 'utf8');
    const embeddedUrl = assetsSupabase.match(/const SUPABASE_URL = '([^']*)'/)?.[1];
    if (embeddedUrl !== SUPABASE_URL) {
      console.error('✗ android assets 的 supabase.js 未指向生产库（疑似测试构建残留），中止发布。');
      console.error(`   assets 内是：${embeddedUrl ?? '(未检出)'}`);
      console.error(`   生产库是：  ${SUPABASE_URL}`);
      console.error('   修复：npx cap sync android 后重试。');
      process.exit(1);
    }
    console.log('  ✓ android assets supabase.js 指向生产库');
  }

  // 2. 读 assets 旧 shell-version（判断是否需要 gradle rebuild）
  const androidIndexPath = resolve(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html');
  let oldAndroidMeta = null;
  if (existsSync(androidIndexPath)) {
    const h = readFileSync(androidIndexPath, 'utf8');
    const m = h.match(/<meta name="shell-version" content="([^"]*)"/);
    oldAndroidMeta = m ? m[1] : null;
  }
  const needRebuild = (oldAndroidMeta !== VERSION);

  // 3. 构建期注入版本 meta —— **只写 android assets**（真正会被打进 APK 的那份副本），
  //    不再写 public/index.html：那是「仓库持有版本真相」的旧设计，会让每次打 APK 都欠一笔
  //    meta 提交（分支保护下要走 PR）。仓库里那两份 meta 恒为占位值 0.0.0。
  //    · app-version   = 线上最新启用的 web 版本（cap sync 刚把 assets 对齐到 public/，
  //                      而发布只从 main 出包 → 这个 stamp 是如实的）；查不到就退回 0.0.0（偏低安全）
  //    · shell-version = 本次壳版本（apk-update.js 首选 App.getInfo()，meta 只是兜底）
  const { data: latestWeb, error: webErr } = await sb
    .from('app_versions').select('version')
    .eq('enabled', true).order('released_at', { ascending: false })
    .limit(1).maybeSingle();
  if (webErr) {
    console.error(`✗ 查询线上最新 web 版本失败：${webErr.message}`);
    process.exit(1);
  }
  const webVersion = latestWeb?.version ?? '0.0.0';
  if (!existsSync(androidIndexPath)) {
    console.error('✗ 找不到 android assets 的 index.html（cap sync 没产出？）');
    process.exit(1);
  }
  let androidHtml = readFileSync(androidIndexPath, 'utf8');
  if (!/<meta name="app-version" content="[^"]*" \/>/.test(androidHtml) ||
      !/<meta name="shell-version" content="[^"]*" \/>/.test(androidHtml)) {
    console.error('✗ assets index.html 缺少 app-version / shell-version meta，无法注入');
    process.exit(1);
  }
  androidHtml = androidHtml
    .replace(/<meta name="app-version" content="[^"]*" \/>/, `<meta name="app-version" content="${webVersion}" />`)
    .replace(/<meta name="shell-version" content="[^"]*" \/>/, `<meta name="shell-version" content="${VERSION}" />`);
  writeFileSync(androidIndexPath, androidHtml);
  console.log(`  ✓ 已注入 assets：app-version=${webVersion}（线上最新 web）· shell-version=${VERSION}（本次壳）`);

  // 4. gradle 构建
  //    常规：只在「assets 旧 meta != 新版本」且非预演时构建（保持本地 --dry-run 快速）
  //    预演 + --build：**照样构建** —— CI 预演必须走通这一步，否则拿不到 APK、
  //    下面第 5b 步「包内 meta == 本次版本」这条最关键的防旧包断言就等于没做。
  const shouldBuild = forceBuild || (needRebuild && !dryRun);
  if (shouldBuild) {
    const { spawnSync } = await import('node:child_process');
    console.log(`  → android assets meta ${oldAndroidMeta ?? '(无)'} → ${VERSION}，gradle assembleRelease ...${dryRun ? '（预演 --build）' : ''}`);
    const gradleResult = spawnSync('./gradlew', ['assembleRelease'], {
      cwd: join(ROOT, 'android'),
      stdio: 'inherit',
      shell: true,
    });
    if (gradleResult.status !== 0) {
      console.error('✗ gradle build 失败');
      process.exit(1);
    }
    console.log('  ✓ gradle build 完成');
  } else if (dryRun) {
    console.log('  ⏭  预演未加 --build：跳过 gradle 构建（用已有 APK 校验；包内 meta 断言可能因此失去意义）');
  }

  // 5. 定位 APK
  // 顺序：显式 --apk > gradle 产物（自动 build 后永远是最新）> 桌面副本（兜底）
  // 血泪教训：桌面副本排前面时，会把旧 APK 直接上传（2026-09-04，2.1.26 发了个旧包）
  const candidates = [
    apkPath,
    join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    join(homedir(), 'Desktop', '有爱.apk'),
  ].filter(Boolean);
  const apkFile = candidates.find((p) => existsSync(p));
  if (!apkFile) {
    console.error(`✗ 找不到 APK 文件，依次找过：
${candidates.map((p) => '   - ' + p).join('\n')}
  请先打包（gradlew assembleRelease）并覆盖到 ~/Desktop/有爱.apk，或用 --apk 指定路径`);
    process.exit(1);
  }
  console.log(`  ✓ APK：${apkFile}`);

  // 5b.【铁律】校验 APK 内的 shell-version meta == 本次版本号
  // 防止把旧 APK（meta 过期）发出去——所有"发了个旧包"的事故都死在这里
  {
    const { execFileSync } = await import('node:child_process');
    const apkIndexHtml = execFileSync('unzip', ['-p', apkFile, 'assets/public/index.html'], { encoding: 'utf8' });
    const apkMeta = apkIndexHtml.match(/<meta name="shell-version" content="([^"]*)"/)?.[1];
    if (apkMeta !== VERSION) {
      console.error(`✗ APK 内 shell-version meta 是 ${apkMeta ?? '(无)'}，不等于本次版本 ${VERSION}！
  这个 APK 是旧的（gradle 没打包进最新 assets）。
  排查：npx cap sync android 后重跑 gradlew assembleRelease，或删掉 android/app/build 再 build。`);
      process.exit(1);
    }
    // 连 app-version 一起校验：它是热更新「本地版本」的来源，盖错方向会导致
    // 「声称比实际内容新 → App 永远不下载」（比多重启一次严重得多）。
    const apkWebMeta = apkIndexHtml.match(/<meta name="app-version" content="([^"]*)"/)?.[1];
    if (apkWebMeta !== webVersion) {
      console.error(`✗ APK 内 app-version meta 是 ${apkWebMeta ?? '(无)'}，不等于注入值 ${webVersion}！
  说明 gradle 打的不是刚注入过 meta 的那份 assets。`);
      process.exit(1);
    }
    console.log(`  ✓ APK 内 meta：shell-version=${VERSION} · app-version=${apkWebMeta}（防旧包校验通过）`);
  }

  // 6. SHA-256 + 体积（versionCode 已在 1.2 校验过，见那里的注释说明为什么提前）
  const buf = await readFile(apkFile);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const size = buf.length;
  console.log(`  ✓ 体积 ${(size / 1024 / 1024).toFixed(1)} MB · SHA-256 ${sha256.slice(0, 16)}…`);

  if (dryRun) {
    console.log('\n🟡 --dry-run：校验通过，跳过上传。');
    return;
  }

  // 8. 上传 Storage
  const storagePath = `apks/youai-${VERSION}.apk`;
  console.log(`  → 上传到 app_updates/${storagePath} ...`);
  const { error: upErr } = await sb.storage
    .from('app_updates')
    .upload(storagePath, buf, { contentType: 'application/octet-stream', upsert: true });
  if (upErr) throw new Error(`上传失败：${upErr.message}`);
  console.log('  ✓ 上传成功');

  // 9. 写版本表
  console.log('  → 写入 app_native_versions 表...');
  const { error: dbErr } = await sb.from('app_native_versions').upsert({
    version_name: VERSION,
    version_code: code,
    storage_path: storagePath,
    apk_size_bytes: size,
    apk_sha256: sha256,
    enabled: true,
    notes: notes || null,
    // 可选参数（等 SQL 迁移 add column 后生效；缺省时显式写 false/null）
    is_force_update: false,
    min_supported_version: null,
    released_at: new Date().toISOString(),
  }, { onConflict: 'version_name' });
  if (dbErr) throw new Error(`写版本表失败：${dbErr.message}`);

  console.log('\n✅ 发布成功！');
  console.log(`   版本：${VERSION}（code ${code}）`);
  if (notes) console.log(`   说明：${notes}`);
  console.log(`\n   App 下次冷启动时自动弹出更新面板：下载 → 校验 → 唤起系统安装器。`);
  console.log(`   注意：对方首次安装需在系统弹窗里允许「来自此来源的应用」（仅一次）。\n`);
}

main().catch((err) => {
  console.error('\n✗ 发布失败：', err && err.message ? err.message : err);
  process.exit(1);
});
