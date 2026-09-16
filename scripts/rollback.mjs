/**
 * 紧急**下线**脚本：把指定版本置 enabled=false（止损），并说清它与"真回滚"的区别
 *
 * 用法：
 *   node scripts/rollback.mjs <版本号> [--native] [--restore] [--dry-run]
 *
 *   node scripts/rollback.mjs 2.7.65                    # 下发热更新版本（通道 A）
 *   node scripts/rollback.mjs 2.1.28 --native           # 下线 APK 壳版本（通道 B）
 *   node scripts/rollback.mjs 2.7.65 --dry-run          # 先看影响，不写生产
 *   node scripts/rollback.mjs 2.7.65 --restore          # 逆操作：撤销误下线
 *   node scripts/rollback.mjs 2.7.68 --reason "列表空白" --incident   # 事故止损（进 DORA 指标）
 *
 * 选项：
 *   --native    操作 APK 壳版本表（app_native_versions.version_name）；缺省操作热更新表
 *   --restore   反向操作：把该行重新置 enabled=true（撤销误下线），并清空下线记录
 *   --dry-run   只显示将要做的改动，不写生产
 *   --reason <说明>  下线原因（写进 disabled_reason）。**刻意不做必填**：紧急止损时不该多一步拖延，
 *                    它的价值是事后可归因，不是拦住这次操作。
 *   --incident       标记为**事故下线** ⇒ 计入 DORA 变更失败率。不给 = 未归类（NULL），
 *                    报告会单独列出来提醒 —— 机器猜不出"这次下线是出事了，还是例行退役/演练"。
 *   -h, --help  显示帮助
 *
 * 原理与边界（2026-09-16 更正原措辞；2026-09-16 补通道 B）：
 *   客户端拉版本时会忽略 enabled=false 的行，所以下线后**还没更新的设备 + 新装机**会拿到更早的启用版本；
 *   但**已经更新到该版本的设备不会退回去** —— 客户端判定更新用的是「服务端版本 ≤ 本地版本 → 无更新」
 *   （update.js / apk-update.js），这些设备本地版本已经更高，会一直停在上面。
 *   要让它们退回来，只能发一个「版本号更高、内容为旧代码」的包：
 *       node scripts/release.mjs <更高的新版本号> --from-git <旧 ref>        # 通道 A
 *   详见 AGENTS.md 铁律三「下线 ≠ 回滚」。
 *
 *   ⚠️ 通道 B（APK）还有一层 Android 特有的硬约束：**不允许 versionCode 更低的包覆盖安装**。
 *   所以壳的"退回旧代码"也只能是「**旧壳代码 + 更高的 versionCode**」，
 *   不能简单地把 code 降回去。而且壳的安装是用户手动点的，止损效果比热更新更慢、更不确定。
 *
 * 安全：使用 service_role key；全脚本**只改 enabled + disabled_* 三列**（不动 Storage、不删记录、
 *       不动 released_at）。released_at 尤其不能碰：客户端的挑选逻辑是
 *       「enabled 里按 released_at 倒序取第一条」，改了它就会改变"谁是最新"。
 *       disabled_at / disabled_reason / disabled_is_incident 是**纯记录列**（见
 *       supabase/migration-dora-metrics.sql）：客户端不读它们，只喂给 DORA 的失败率/恢复时间。
 *       ⚠️ 2026-09-16 起「只改 enabled 一列」这句话不再准确 —— 记在这里，免得后人按旧注释推断。
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';

// ---------- 通道定义 ----------
// 两个通道的表名/版本列名/后果文案都不同，集中在一处，避免散落成 if/else。
const CHANNELS = {
  web: {
    table: 'app_versions',
    versionCol: 'version',
    select: 'id, version, enabled, released_at, notes, disabled_at, disabled_reason, disabled_is_incident',
    // 迁移未执行时的回落 select：止损脚本**不能因为观测列缺失而用不了**（见查询处的 try/catch）
    selectBase: 'id, version, enabled, released_at, notes',
    label: '热更新（通道 A）',
    flagHint: '',
    /** 下线后果（通道 A：会落到更早的启用版本） */
    offlineConsequence: (latestEnabled) => latestEnabled
      ? `还没更新的设备将装到 ${latestEnabled}`
      : '已无任何启用版本（客户端不会再收到热更新）',
    /** 真回滚怎么走 */
    trueRollbackHint: 'node scripts/release.mjs <更高的新版本号> --from-git <旧 ref>',
    trueRollbackWhy: '发一个「版本号更高、内容为旧代码」的包，已更新的设备才会退回旧代码',
  },
  native: {
    table: 'app_native_versions',
    versionCol: 'version_name',
    select: 'id, version_name, version_code, enabled, released_at, notes, disabled_at, disabled_reason, disabled_is_incident',
    selectBase: 'id, version_name, version_code, enabled, released_at, notes',
    label: 'APK 壳（通道 B）',
    flagHint: ' --native',
    offlineConsequence: (latestEnabled) => latestEnabled
      ? `还没更新的设备将装到 ${latestEnabled}`
      : '⚠️ 已无任何启用版本 ⇒ **所有设备都不再收到壳更新提示**（App 不会再弹更新面板）',
    trueRollbackHint: 'node scripts/release-apk.mjs <更高的新版本号> --from-git <旧 ref>',
    trueRollbackWhy: 'Android 不允许 versionCode 更低的包覆盖安装 ⇒ 只能发「旧壳代码 + 更高的 versionCode」',
  },
};

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const USAGE = `紧急下线脚本（止损）

用法：
  node scripts/rollback.mjs <版本号> [--native] [--restore] [--dry-run]
                            [--reason "<说明>"] [--incident]

选项：
  --native      操作 APK 壳版本表（app_native_versions）；缺省操作热更新表（app_versions）
  --restore     反向操作：把版本重新置为 enabled=true（撤销误下线），并清空下线记录
  --dry-run     只显示将要做的改动，不写生产
  --reason <说明>  为什么下线，写进 disabled_reason（DORA 报告会显示）
  --incident    标为**事故下线** ⇒ 计入 DORA 变更失败率。不标 = 未归类（不计入，报告会单独提醒）
  -h, --help    显示帮助

示例：
  node scripts/rollback.mjs 2.7.65                                        # 下发热更新版本
  node scripts/rollback.mjs 2.7.68 --reason "新版本列表空白" --incident    # 事故止损（进 DORA）
  node scripts/rollback.mjs 2.1.28 --native --dry-run
  node scripts/rollback.mjs 2.1.28 --native --restore

注意：这是「下线 / 止损」，**不是**「回滚」。已更新到该版本的设备不会退回去 ——
      要让它们退回，需要发一个「版本号更高、内容为旧代码」的包（详见脚本头注释）。
`;
// 没给版本号 = 用法错误 ⇒ exit 1（不能算成功）；显式 -h/--help 才是 exit 0。
// 这条区分很重要：CI 或包装脚本按退出码判断成败，「忘了传参数返回 0」会被当成"下线完成"。
if (argv.length === 0) {
  console.error(USAGE);
  console.error('✗ 缺少版本号');
  process.exit(1);
}
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const VERSION = argv[0];
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z`);
  process.exit(1);
}
const useNative = argv.includes('--native');
const restore = argv.includes('--restore');
const dryRun = argv.includes('--dry-run');
// --reason "<说明>"：为什么下线。写进 disabled_reason，DORA 报告里直接显示（不写则留空，
// 报告会提示补）。**刻意不做成必填**：紧急止损时多一个必填参数就是多一步拖延 ——
// 而它的价值是"事后可归因"，不是"拦住这次操作"（与 --dry-run 不作默认同一个取舍）。
const reasonIdx = argv.indexOf('--reason');
const reason = reasonIdx >= 0 ? (argv[reasonIdx + 1] || '') : '';
// --incident：把它标为**事故下线**，才计入 DORA 变更失败率。
// 不给就留 NULL（未归类）—— 机器猜不出"这次下线是出事了，还是例行退役/演练"，
// 猜错会让失败率失真，所以宁可留空并让报告单独列出来提醒。
const isIncident = argv.includes('--incident') ? true : null;
const knownFlags = ['--native', '--restore', '--dry-run', '--incident', '--reason'];
// argv.slice(1) 的第 i 项对应 argv 的第 i+1 项 —— 用下标精确排除 --reason 的值，
// 不要按"值等于 reason 字符串"来排除（那会误伤同名参数，也是同一个类型的手滑）。
const reasonValueIdx = reasonIdx >= 0 ? reasonIdx + 1 : -1;
const unknown = argv.slice(1).filter((a, i) => {
  if (i + 1 === reasonValueIdx) return false;
  return !knownFlags.includes(a);
});
if (unknown.length > 0) {
  // 静默忽略未知参数会让「打错字」变成「按默认通道操作了另一个表」——那是最危险的一类手滑
  console.error(`✗ 无法识别的参数：${unknown.join('、')}`);
  console.error('  可用：--native / --restore / --dry-run / --incident / --reason "<说明>" / -h');
  process.exit(1);
}
if (reasonIdx >= 0 && !reason) {
  console.error('✗ --reason 后面要跟一段说明（例：--reason "新壳启动即崩"）');
  process.exit(1);
}
if (isIncident && restore) {
  // 恢复上线时没有"是不是事故"可言（那三列会被清空），标了就是误用
  console.error('✗ --incident 只用于下线；--restore 会把下线记录一并清空');
  process.exit(1);
}

const ch = useNative ? CHANNELS.native : CHANNELS.web;
const TARGET = restore ? true : false; // 目标状态
const actionWord = restore ? '恢复上线' : '下线（止损）';

// 2026-09-16 迁移到 _lib-env.mjs：原先是本地内联 loadEnv（**强制要求 .env 存在**）。
// _lib-env.mjs 头部把这次迁移列为待办，理由是「脚本会写生产、没有安全自测路径，
// 迁移应当配一次真实回滚演练一起做」—— 本次正是配着通道 B 的下线演练一起做的。
// 顺带换来：无 .env 时回落环境变量（与其余发布类脚本一致）。
loadEnv();
const { url, key } = requireSupabaseEnv();
const supabase = createClient(url, key, { auth: { persistSession: false } });

console.log(`\n→ 通道：${ch.label}｜表：${ch.table}｜动作：${actionWord}${dryRun ? '（dry-run，不写生产）' : ''}`);
console.log(`→ 查询版本 ${VERSION} 的当前状态…`);

const { data: rowsFull, error: qErr } = await supabase
  .from(ch.table)
  .select(ch.select)
  .eq(ch.versionCol, VERSION)
  .order('released_at', { ascending: false });

// 迁移未执行（disabled_* 列不存在）时回落到基础 select。
// 这一条对本脚本是**硬要求**：它是紧急止损工具，绝不能因为一个观测列而用不了。
const missingCols = qErr && /column|schema cache/i.test(`${qErr.message} ${qErr.details || ''}`);
if (missingCols) {
  console.log('  （该表还没有 disabled_* 列 —— 数据库尚未执行 supabase/migration-dora-metrics.sql，'
    + '本次不记录下线时间/原因）');
}
const { data: rows, error: qErr2 } = missingCols
  ? await supabase.from(ch.table).select(ch.selectBase).eq(ch.versionCol, VERSION)
    .order('released_at', { ascending: false })
  : { data: rowsFull, error: qErr };

if (qErr2) {
  console.error(`✗ 查询失败：${qErr2.message}`);
  process.exit(1);
}
if (!rows || rows.length === 0) {
  console.error(`✗ 找不到版本 ${VERSION}（表 ${ch.table}；已下线？或版本号写错？）`);
  process.exit(1);
}

console.table(rows);

// 同版本多行时只改第一行，会导致「下线了但没生效」（另一行仍 enabled）却报告成功。
// 实测两张表都没有这种情况，所以只是告警、不改语义 —— 但必须说出来，否则这是个「绿着灯的失败」。
// ⚠️ 这里**刻意不写具体行数**：原句是「实测两张表当前都没有这种情况（127/127、27/27）」，
// 而 2026-09-16 复核时 app_versions 已经是 129 行 —— 把我引去查了一遍"是不是有人偷偷发版"
// （结论：没人发版，129 行 = 129 个不同版本、零重复）。
// **写死的数字会过期，会让人去查一个不存在的问题；该写的是不变量。**
if (rows.length > 1) {
  console.log(`\n⚠️ 该版本有 ${rows.length} 行，本次只改 released_at 最新的那一行（id=${rows[0].id}）。`);
  console.log('   若其余行仍是 enabled=true，则"下线"**不会生效**（客户端仍能拿到）—— 请人工确认后再处置。');
}

const target = rows[0];
if (target.enabled === TARGET) {
  console.log(`✓ 版本 ${VERSION} 已经是 enabled=${TARGET}，无需操作`);
  process.exit(0);
}

// ---------- 影响预览 ----------
console.log(`\n→ 计划变更：${ch.table}.id=${target.id} 的 enabled  ${target.enabled} → ${TARGET}`);
console.log('  （只改 enabled 与 disabled_* 这三列；不碰 released_at —— 它决定客户端挑哪条为"最新"）');
if (!restore) {
  console.log(`    下线记录：disabled_at=${new Date().toISOString()}`);
  console.log(`              reason=${reason || '（未填，DORA 报告会提示补）'}`
    + `｜is_incident=${isIncident === null ? 'NULL（未归类，不计入变更失败率）' : 'true（计入）'}`);
}

// 动作后的通道后果：先算出来给人看，dry-run 也一样看得到
const { data: rowsAfter, error: afterErr } = await supabase
  .from(ch.table)
  .select(`${ch.versionCol}, enabled`)
  .order('released_at', { ascending: false });
if (afterErr) {
  console.error(`✗ 预演影响时查询失败：${afterErr.message}`);
  process.exit(1);
}
// 模拟本次变更后的启用集合
const enabledAfter = (rowsAfter || [])
  .map((r) => ({ v: r[ch.versionCol], enabled: r[ch.versionCol] === VERSION ? TARGET : r.enabled }))
  .filter((r) => r.enabled === true);
const latestEnabledAfter = enabledAfter.length > 0 ? enabledAfter[0].v : null;

console.log(`\n  变更后果：${ch.offlineConsequence(latestEnabledAfter)}`);

if (dryRun) {
  console.log('\n🟡 --dry-run：以上为预演，未写入生产。\n');
  process.exit(0);
}

// ---------- 写生产 ----------
// 下线：连同"何时/为何/是否事故"一起记录（DORA 的失败率与恢复时间就靠它）；
// 恢复：把这三列清回 NULL，保持「disabled_at IS NULL ⟺ enabled=true」这条不变式 ——
// 否则"已恢复上线但 disabled_at 还在"会让指标把已恢复的版本算成仍在故障状态。
const patch = restore
  ? { enabled: TARGET, disabled_at: null, disabled_reason: null, disabled_is_incident: null }
  : {
    enabled: TARGET,
    disabled_at: new Date().toISOString(),
    disabled_reason: reason || null,
    disabled_is_incident: isIncident,
  };
console.log(`\n→ 正在把 ${ch.table}.id=${target.id} 置为 enabled=${TARGET}…`);
let { error: uErr } = await supabase
  .from(ch.table)
  .update(patch)
  .eq('id', target.id);
let degraded = false;
if (uErr && /column|schema cache/i.test(`${uErr.message} ${uErr.details || ''}`)) {
  // 迁移没执行：enabled 翻转是止损的**本体**，不能被"记录列不存在"挡住。
  // 退化成只改 enabled，并明说丢了什么（DORA 会因此少一次失败样本）。
  console.warn(`    ⚠️ disabled_* 列不存在（数据库还没执行 supabase/migration-dora-metrics.sql）`);
  console.warn('       ⇒ 只改 enabled，这次下线不会进入 DORA 的失败率/恢复时间统计');
  degraded = true;
  ({ error: uErr } = await supabase.from(ch.table).update({ enabled: TARGET }).eq('id', target.id));
}
if (uErr) {
  console.error(`✗ 写入失败：${uErr.message}`);
  process.exit(1);
}

// 回读校验：写成功 ≠ 真的生效（本项目一贯做法）
// 下线时**连记录列一起校验** —— 只说一句"已下线"却没说"失败样本记住了没"，
// 就会重演「DORA 数据静默缺行」这类"绿着灯的缺失"。
const verifyCols = degraded
  ? `${ch.versionCol}, enabled`
  : `${ch.versionCol}, enabled, disabled_at, disabled_reason, disabled_is_incident`;
const { data: verify, error: vErr } = await supabase
  .from(ch.table)
  .select(verifyCols)
  .eq('id', target.id)
  .single();
if (vErr) {
  console.error(`✗ 写入后回读校验失败：${vErr.message}`);
  process.exit(1);
}
if (verify.enabled !== TARGET) {
  console.error(`✗ 回读校验失败：enabled 仍为 ${verify.enabled}（期望 ${TARGET}）`);
  process.exit(1);
}

// ---------- 结果输出 ----------
if (restore) {
  console.log(`\n✅ 已恢复上线：${VERSION}（enabled=true）`);
  if (!degraded) {
    if (verify.disabled_at === null && verify.disabled_is_incident === null) {
      console.log('   下线记录已清空（disabled_at/reason/is_incident = NULL）'
        + ' —— 保持「未下线 ⟺ disabled_at 为空」这条不变式，指标不会把它当成仍在故障。');
    } else {
      // 清空失败 = 后续 DORA 会把已恢复的版本算成仍在故障 —— 必须响亮报出来
      console.error(`   ⚠️ 但下线记录没清干净：disabled_at=${verify.disabled_at}`
        + `｜is_incident=${verify.disabled_is_incident}`);
      console.error('      影响：DORA 会把这个已恢复的版本仍算作事故 ⇒ 请手工把这三列置 NULL');
      process.exitCode = 1;
    }
  }
  console.log(`   客户端下次冷启动时会重新看到它（前提：它比设备本地版本新）。`);
} else {
  console.log(`\n✅ 已下线（止损完成）`);
  console.log(`   ${ch.label} 版本 ${VERSION} 已在 ${new Date().toLocaleString('zh-CN')} 下线`);
  if (!degraded) {
    console.log(`   已记录：disabled_at=${verify.disabled_at}`
      + `｜is_incident=${verify.disabled_is_incident === true ? 'true（计入 DORA 变更失败率）' : 'NULL（未归类）'}`);
    if (!reason) {
      console.log('     （未填 --reason：DORA 报告会把它列在"未归类/无原因"里提醒你补）');
    }
  }
  console.log(`   生效时机：用户下次冷启动 App 时（已打开的需要杀掉重开 1 次）`);
  console.log(`   后果：${ch.offlineConsequence(latestEnabledAfter)}`);
  console.log('');
  console.log('   ⚠️ 这只是「下线」，不是「回滚」：');
  console.log('      已经更新到该版本的设备**不会退回去** —— 客户端判定更新用的是');
  console.log('      「服务端版本 ≤ 本地版本 → 无更新」，它们的本地版本已经更高了。');
  console.log(`      要让它们退回，需要：${ch.trueRollbackWhy}`);
  console.log(`        ${ch.trueRollbackHint}`);
  if (useNative) {
    console.log('');
    console.log('      另外注意通道 B 的特有节奏：壳安装是**用户手动点的**，');
    console.log('      所以"已下线"只对还没点安装的人有效；装了坏包的人只能等新版本。');
  }
  console.log('');
  console.log('   撤销本次操作：');
  console.log(`      node scripts/rollback.mjs ${VERSION}${ch.flagHint} --restore`);
}
