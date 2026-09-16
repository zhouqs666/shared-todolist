/**
 * 发布元数据：**溯源**（这次发布的代码来自哪个 commit）+ **带可选列的写入**（迁移未执行时不阻断发布）
 *
 * 为什么单独抽一个库：`release.mjs`（通道 A）与 `release-apk.mjs`（通道 B）都要写这两样东西，
 * 各抄一份必然漂移 —— 而漂移的后果是"两条通道的 DORA 数据口径不一致"，那种错误没人会发现。
 *
 * ── 设计原则：溯源是**观测**，不是发布的必要条件 ─────────────────────
 * 两个函数都**不抛错**：
 *   · 拿不到 git 信息 → 返回 sha=null + 原因，发布照常（宁可少一条指标，不能因为观测不了就发不了版）
 *   · 数据库还没执行 `migration-dora-metrics.sql` → 自动去掉新列重写一次，并把原因返回给调用方打警告
 * 反面做法（直接抛错）的代价是把"可观测性"变成"交付通道的单点故障" —— 铁律三要求交付必须到得了用户手里。
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * 解析发布内容的 git 溯源。
 *
 * @param {object}  opts
 * @param {string?} opts.ref    指定 ref（`--from-git` 回退模式必传）。缺省用 HEAD。
 * @param {string[]} opts.paths 判定"工作区是否干净"的范围（通道 A: ['public']；通道 B: ['public','android']）
 * @returns {{sha: string|null, committedAt: string|null, dirty: boolean|null, reason: string|null}}
 *          `reason` 非空 = 拿不到溯源（此时 sha/committedAt 为 null），调用方应打印它。
 */
export function resolveGitProvenance({ ref = null, paths = ['public'] } = {}) {
  try {
    // 指定 ref 时用它（回退包的内容来自旧 ref，不是 HEAD）；
    // 否则用 HEAD —— 本地与 CI 都成立（CI 里 checkout 后 HEAD 就是本次触发的 commit）。
    const sha = git(['rev-parse', '--verify', `${ref || 'HEAD'}^{commit}`]);
    const committedAt = git(['show', '-s', '--format=%cI', sha]);

    // ⚠️ CI 上顺手交叉校验一次：若 GITHUB_SHA 与 HEAD 不一致，说明 checkout 的不是触发分支的
    // 那个提交 —— 那样记录下来的 sha 就不代表"这次发布的代码"。不阻断，但要留话。
    let warn = null;
    if (!ref && process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) {
      warn = `GITHUB_SHA(${process.env.GITHUB_SHA.slice(0, 8)}) ≠ HEAD(${sha.slice(0, 8)})，已按 HEAD 记录`;
    }

    // 脏工作区：内容不来自某个 commit ⇒ 该行不能参与前置时间统计（否则算出来的"前置时间"是假的）
    const dirtyOut = git(['status', '--porcelain', '--', ...paths]);
    const dirty = dirtyOut.length > 0;

    return { sha, committedAt, dirty, reason: warn };
  } catch (e) {
    return {
      sha: null, committedAt: null, dirty: null,
      reason: `拿不到 git 溯源（${(e.message || '').split('\n')[0]}）⇒ 本行不会计入 DORA 前置时间`,
    };
  }
}

/** PostgREST 在"这一列不存在"时的报错特征（schema cache 未刷新 / 42703 两种形态都覆盖） */
function isMissingColumnError(error, column) {
  const msg = `${error?.message || ''} ${error?.details || ''}`;
  // ⚠️ 必须**先确认报错里提到了这一列**：`PGRST204`（列不在 schema cache）是按"请求里的列"
  // 逐个报的，单看错误码无法区分是哪个列 —— 第一版就是这么写的，于是任何一个 204 都会把
  // **全部**可选列剥掉（测试 8 组里的"部分缺失"用例当场抓住了它）。
  const mentionsColumn = new RegExp(`['"\`]?${column}\\b`).test(msg);
  if (!mentionsColumn) return false;
  return /PGRST204/.test(error?.code || '')
    || /does not exist|schema cache|unknown column/i.test(msg);
}

/**
 * upsert 一行，但**新列可以缺失**：数据库还没执行迁移时，自动去掉可选列重写一次。
 *
 * @param {object} sb           supabase client（service_role）
 * @param {string} table        表名
 * @param {object} row          完整行（含可选列）
 * @param {string[]} optionalKeys 可选列名（缺失时允许退化）
 * @param {string} onConflict   冲突列（通常是 version / version_name）
 * @returns {{degraded: string|null, error: string|null}} degraded 非空 = 退化了，原因给它
 */
export async function upsertWithOptionalColumns(sb, table, row, optionalKeys, onConflict) {
  const attempt = (payload) => sb.from(table).upsert(payload, { onConflict });
  const { error } = await attempt(row);
  if (!error) return { degraded: null, error: null };

  // 只对我们自己新增的列退化；其它报错照旧上抛（不能把"真失败"吞成"发布成功"）
  const missing = optionalKeys.filter((k) => k in row && isMissingColumnError(error, k));
  if (missing.length === 0) {
    return { degraded: null, error: `写版本表失败：${error.message}` };
  }
  // 只去掉**确实被报缺失**的列（不要求"全部缺失"）：迁移只跑了一半时也要能发得出去。
  // 安全性来自下面这一步 —— 重试**必须成功**，否则把重试的报错当作最终结果上抛，
  // 所以"退化"永远不可能把一个真失败伪装成发布成功。
  const trimmed = { ...row };
  for (const k of missing) delete trimmed[k];
  const { error: e2 } = await attempt(trimmed);
  if (e2) return { degraded: null, error: `写版本表失败：${e2.message}` };
  return { degraded: error.message, error: null };
}
