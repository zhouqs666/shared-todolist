/**
 * DORA 四指标的**纯计算**（不碰网络、不碰文件）—— 放在 `_lib-` 里是为了可测：
 * `scripts/test_dora_metrics.mjs` 用合成夹具逐项验证口径，不需要凭据、不需要数据库、能进 CI。
 *
 * 四个指标与**本项目里的口径**（口径必须写死，否则"指标"就成了一段随时可重新解释的话）：
 *
 *   1. 部署频率   = 窗口内**上线的版本数** ÷ 窗口天数（分通道各算一份，同时给合计）
 *   2. 前置时间   = released_at − commit_at（**中位数**为主，DORA 惯例用中位数抗离群值）。
 *                   只统计"有 commit 且工作区干净"的部署；被跳过的样本量会明确打出来。
 *   3. 变更失败率 = 「事故下线」的部署数 ÷ 窗口内部署数。
 *                   ⚠️ 分类由**人**在 `rollback.mjs --incident` 时给出 —— 机器判不出
 *                   "这次下线是因为出事了，还是例行退役/演练"。未归类的会单独列出，不猜。
 *   4. 恢复时间   = 坏版本发布 → 同通道下一个版本上线（中位数）。没有后续版本 = 未恢复，不编数字。
 *
 * ── 已知的口径限制（写在代码里，免得半年后当 bug 修）──────────────────
 * · `app_versions` 是「一版本一行」（`upsert onConflict: version`），所以**同一版本号重发**
 *   （如下线后再恢复上线）只更新 released_at，不会多出一行 ⇒ 部署频率会少算这种重发。
 *   本项目至今只发生过一次（2.7.65 回滚演练），量级可忽略；真要精确就得引入独立的部署事件表。
 * · 迁移（`supabase/migration-dora-metrics.sql`）之前的老行没有 commit/下线信息，无法参与
 *   前置时间与失败率 —— 报告里会打印"可算样本 / 总部署数"，不假装覆盖全部历史。
 * · **通道 B 的历史行包含 2026-09-04 那天壳更新联调期批量写入的 20+ 条验证版**（`2.1.1`~`2.1.27`），
 *   所以"近 30 天壳部署 27 次"是**真实数据、但不是 27 次对外发布** ——
 *   读这个数字时要知道那天的性质。脚本不做这层过滤（它判不出哪次是"真发布"，
 *   硬编码日期规则又会在半年后变成假话）。
 */

const MIN = 60 * 1000;

/** 把一行数据库记录规整成计算用的形状（两条通道的列名不同，在这里归一） */
export function normalizeRow(row, channel) {
  return {
    channel,
    version: channel === 'web' ? row.version : row.version_name,
    releasedAt: row.released_at ? new Date(row.released_at) : null,
    enabled: row.enabled,
    commitSha: row.commit_sha || null,
    commitAt: row.commit_at ? new Date(row.commit_at) : null,
    commitDirty: row.commit_dirty === null || row.commit_dirty === undefined ? null : row.commit_dirty,
    disabledAt: row.disabled_at ? new Date(row.disabled_at) : null,
    disabledReason: row.disabled_reason || null,
    disabledIsIncident: row.disabled_is_incident === null || row.disabled_is_incident === undefined
      ? null : row.disabled_is_incident,
  };
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(nums, p) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[idx];
}

function mean(nums) {
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * @param {object} input
 * @param {object[]} input.web      app_versions 的行
 * @param {object[]} input.native   app_native_versions 的行
 * @param {Date}     input.now      计算基准时刻（可注入，便于测试）
 * @param {number}   input.days     窗口天数
 */
export function computeDora({ web = [], native = [], now = new Date(), days = 30 }) {
  const to = now;
  const from = new Date(to.getTime() - days * 24 * 60 * MIN);

  const all = [
    ...web.map((r) => normalizeRow(r, 'web')),
    ...native.map((r) => normalizeRow(r, 'native')),
  ].filter((r) => r.releasedAt && !Number.isNaN(r.releasedAt.getTime()));

  const inWindow = all.filter((r) => r.releasedAt >= from && r.releasedAt <= to);

  // ── 1. 部署频率 ─────────────────────────────────────────────
  const byChannel = {
    web: inWindow.filter((r) => r.channel === 'web').length,
    native: inWindow.filter((r) => r.channel === 'native').length,
  };
  const perDay = inWindow.length / days;
  const deployFrequency = {
    total: inWindow.length,
    byChannel,
    perDay,
    perWeek: perDay * 7,
    list: inWindow.slice().sort((a, b) => a.releasedAt - b.releasedAt)
      .map((r) => ({ channel: r.channel, version: r.version, releasedAt: r.releasedAt })),
  };

  // ── 2. 前置时间（提交 → 上线）───────────────────────────────
  const leadSamples = [];
  let skippedDirty = 0;
  let skippedNoCommit = 0;
  for (const r of inWindow) {
    if (!r.commitAt) { skippedNoCommit++; continue; }
    if (r.commitDirty === true) { skippedDirty++; continue; }
    const minutes = (r.releasedAt - r.commitAt) / MIN;
    // 负数说明 commit 时间在发布之后（时钟错乱 / 误用了未来的 ref）—— 不参与统计，但要留痕
    if (minutes < 0) { skippedNoCommit++; continue; }
    leadSamples.push(minutes);
  }
  const leadTime = {
    samples: leadSamples.length,
    medianMin: median(leadSamples),
    meanMin: mean(leadSamples),
    p90Min: percentile(leadSamples, 90),
    maxMin: leadSamples.length ? Math.max(...leadSamples) : null,
    skippedNoCommit,
    skippedDirty,
  };

  // ── 3. 变更失败率 ───────────────────────────────────────────
  const incident = inWindow.filter((r) => r.disabledIsIncident === true);
  const unclassified = all.filter((r) => r.disabledAt && r.disabledIsIncident === null);
  const legacyDisabled = all.filter((r) => r.enabled === false && !r.disabledAt);
  const changeFailure = {
    failed: incident.length,
    deploys: inWindow.length,
    rate: inWindow.length ? incident.length / inWindow.length : null,
    list: incident.map((r) => ({
      channel: r.channel, version: r.version, releasedAt: r.releasedAt,
      disabledAt: r.disabledAt, reason: r.disabledReason,
      detectMin: r.disabledAt ? (r.disabledAt - r.releasedAt) / MIN : null,
    })).sort((a, b) => a.releasedAt - b.releasedAt),
    unclassified: unclassified.map((r) => ({ channel: r.channel, version: r.version, reason: r.disabledReason })),
    legacyDisabled: legacyDisabled.map((r) => ({ channel: r.channel, version: r.version, releasedAt: r.releasedAt })),
  };

  // ── 4. 恢复时间（坏版本发布 → 同通道下一版上线）──────────────
  const recoveries = [];
  const unrecovered = [];
  for (const bad of incident) {
    const next = all
      .filter((r) => r.channel === bad.channel && r.releasedAt > bad.releasedAt)
      .sort((a, b) => a.releasedAt - b.releasedAt)[0];
    if (!next) { unrecovered.push({ channel: bad.channel, version: bad.version }); continue; }
    recoveries.push({
      channel: bad.channel,
      version: bad.version,
      recoveredBy: next.version,
      recoveryMin: (next.releasedAt - bad.releasedAt) / MIN,
      detectMin: bad.disabledAt ? (bad.disabledAt - bad.releasedAt) / MIN : null,
    });
  }
  const recovery = {
    samples: recoveries.length,
    medianMin: median(recoveries.map((r) => r.recoveryMin)),
    maxMin: recoveries.length ? Math.max(...recoveries.map((r) => r.recoveryMin)) : null,
    detectMedianMin: median(recoveries.filter((r) => r.detectMin !== null).map((r) => r.detectMin)),
    list: recoveries.sort((a, b) => a.recoveryMin - b.recoveryMin),
    unrecovered,
  };

  return {
    window: { days, from, to },
    deployFrequency,
    leadTime,
    changeFailure,
    recovery,
  };
}

/** 分钟 → 人话（报告里别出现 "133.4 分钟" 这种要心算的写法） */
export function humanizeMinutes(min) {
  if (min === null || min === undefined) return '—';
  if (min < 1) return `${Math.round(min * 60)} 秒`;
  if (min < 60) return `${min.toFixed(1)} 分钟`;
  if (min < 60 * 24) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return `${h} 小时 ${m} 分`;
  }
  return `${(min / (60 * 24)).toFixed(1)} 天`;
}

/** 渲染报告（markdown；CLI 与 GITHUB_STEP_SUMMARY 用同一份文本，避免两处口径漂移） */
export function formatDoraReport(m) {
  const { deployFrequency: f, leadTime: l, changeFailure: c, recovery: r } = m;
  const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
  const L = [];

  L.push(`# DORA 四指标（近 ${m.window.days} 天）`);
  L.push('');
  L.push(`窗口：${m.window.from.toISOString()} → ${m.window.to.toISOString()}`);
  L.push('');
  L.push('| 指标 | 值 | 样本 |');
  L.push('|---|---|---|');
  L.push(`| 部署频率 | ${f.perWeek.toFixed(1)} 次/周（${f.perDay.toFixed(2)} 次/天） | 窗口内 ${f.total} 次部署 |`);
  L.push(`| 前置时间（提交→上线，中位数） | ${humanizeMinutes(l.medianMin)} | ${l.samples} 个可算样本 |`);
  L.push(`| 变更失败率 | ${pct(c.rate)} | ${c.failed} 次事故下线 / ${c.deploys} 次部署 |`);
  L.push(`| 恢复时间（发布→修复版上线，中位数） | ${humanizeMinutes(r.medianMin)} | ${r.samples} 个已恢复样本 |`);
  L.push('');
  L.push(`分通道部署：热更新（通道 A）${f.byChannel.web} 次 ／ APK 壳（通道 B）${f.byChannel.native} 次`);
  L.push('');

  // 前置时间：把"跳过了多少样本"明说，否则中位数会显得比实际漂亮
  if (l.skippedNoCommit || l.skippedDirty) {
    L.push(`> 前置时间跳过 ${l.skippedNoCommit} 个「无 commit 记录」（迁移前的老版本）+ `
      + `${l.skippedDirty} 个「工作区不干净」（发布内容不对应某个 commit）。`);
    L.push('');
  }
  if (l.p90Min !== null) {
    L.push(`> 前置时间 p90 = ${humanizeMinutes(l.p90Min)}，最大值 = ${humanizeMinutes(l.maxMin)}（看得出长尾）。`);
    L.push('');
  }

  if (c.failed > 0) {
    L.push('事故下线明细：');
    L.push('');
    L.push('| 通道 | 版本 | 发布 | 下线 | 发布→下线 | 原因 |');
    L.push('|---|---|---|---|---|---|');
    for (const x of c.list) {
      L.push(`| ${x.channel} | ${x.version} | ${x.releasedAt.toISOString().slice(0, 16)} | `
        + `${x.disabledAt ? x.disabledAt.toISOString().slice(0, 16) : '—'} | `
        + `${humanizeMinutes(x.detectMin)} | ${x.reason || '—'} |`);
    }
    L.push('');
  }
  if (c.unclassified.length > 0) {
    L.push(`> ⚠️ ${c.unclassified.length} 次下线**未归类**（不算进失败率）：`
      + `${c.unclassified.map((x) => `${x.channel}/${x.version}`).join('、')}。`
      + '下次用 `rollback.mjs --incident` 标注是不是事故，指标才准。');
    L.push('');
  }
  if (c.legacyDisabled.length > 0) {
    L.push(`> ${c.legacyDisabled.length} 个老版本处于 enabled=false 但没有下线记录`
      + `（迁移前的行，无法归因，未计入任何指标）。`);
    L.push('');
  }
  if (r.detectMedianMin !== null) {
    L.push(`> 次要口径「发布→发现问题/止损」（中位数）= ${humanizeMinutes(r.detectMedianMin)}：`
      + '与恢复时间的差额就是"止损之后到修好上线"的时间。');
    L.push('');
  }
  if (r.unrecovered.length > 0) {
    L.push(`> ⚠️ ${r.unrecovered.length} 次事故**尚无后续版本**（未恢复，不计入恢复时间中位数）：`
      + `${r.unrecovered.map((x) => `${x.channel}/${x.version}`).join('、')}。`);
    L.push('');
  }
  if (f.total === 0) {
    L.push('> 窗口内没有部署 —— 指标全是"—"。用 `--days` 放宽窗口再看。');
    L.push('');
  }
  return L.join('\n');
}
