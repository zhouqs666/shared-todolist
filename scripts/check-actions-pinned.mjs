#!/usr/bin/env node
/**
 * 结构性检查（批次 D · 供应链安全）：所有 `uses:` 引用的 action 必须固定到完整 commit SHA。
 *
 * ## 为什么需要这个脚本（而不只是打开 GitHub 的开关）
 *
 * 仓库设置里有一项 `sha_pinning_required`（本仓库已开），实测它的行为是：
 * **用到未固定 action 的那个 job 在 "Set up job" 阶段直接失败**，一个 step 都不会执行，
 * 报错 `##[error]The action actions/checkout@v4 is not allowed in <repo>
 * because all actions must be pinned to a full-length commit SHA.`
 * （2026-09-15 在临时 canary 分支上 A/B 实测：同一个 run 里，含 `@v4` 的 job 这样挂掉，
 *  另外两个只用固定 SHA 的 job 正常跑绿 —— 见 CODE-REVIEW.md 的审查记录。）
 *
 * ⚠️ 我最初把这条写成了「工作流根本不启动、PR 上的 check 直接不出现」，**实测推翻了它** ——
 * 失败是响亮的、per-job 的、带明确报错的。写文档时的推断必须被实测检验，否则就是在传播错误结论。
 *
 * 那这个脚本还剩下什么价值？（两条，第二条是开关**根本做不到**的）
 *
 * 1. **反馈更快更早**：GitHub 的开关只在 runner 上生效，你要先推代码、等 runner 起 job、
 *    再看那条报错；本脚本是本地/CI 秒级、且直接打印「取 SHA 的命令」。
 * 2. **它能查版本注释，开关查不了**（这条是它存在的真正理由）：
 *    `# vX.Y.Z` 注释是 **Dependabot 判断当前版本的唯一依据** —— 少了它，
 *    Dependabot 就看不到这个依赖，**永远不会给你提更新**（安全补丁静默进不来）。
 *    `sha_pinning_required` 完全不管注释，只看 SHA 长度。
 *
 * ## 规则
 *
 * 1. `uses: owner/repo@<ref>` 的 `<ref>` 必须是 **40 位十六进制 SHA1**
 *    （`@v4` / `@main` / 短 SHA 一律不合格 —— tag 与分支都是可变的，上游可以随时改写指向）
 * 2. 必须带 `# vX.Y.Z` 版本注释：**Dependabot 靠它判断当前版本**，
 *    没有注释 = Dependabot 看不到这个依赖 = 永远不会提更新（静默盲区）
 * 3. 本地 action（`./path`）与 `docker://` 豁免
 *
 * 只认「赋值行」：`# uses: actions/checkout@v4` 这种注释掉的行不算 ——
 * 第一版 check-e2e-env-keys.mjs 就是栽在「注释里提到就算数」上（负向用例漏判）。
 *
 * 用法：node scripts/check-actions-pinned.mjs [--dir .github/workflows]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;
// uses: <ref>  或  - uses: <ref>；可选尾随注释 `# v4.4.0`
const USES_RE = /^\s*(?:-\s*)?uses:\s*(\S+)(?:\s+#\s*(\S.*?))?\s*$/;

const dirArgIdx = process.argv.indexOf('--dir');
const dir = dirArgIdx === -1 ? '.github/workflows' : process.argv[dirArgIdx + 1];

function listYamlFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => join(dir, f));
}

const violations = [];
let checked = 0;
let exempt = 0;

for (const file of listYamlFiles(dir)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(USES_RE);
    if (!m) return; // 注释行 / 非 uses 行都不匹配 —— 「注释里提一下」不会被当成已声明

    const ref = m[1];
    const comment = m[2];
    const at = `${file}:${i + 1}`;

    // 本地 action / docker 镜像不走 GitHub 的 tag 解析，豁免
    if (ref.startsWith('./') || ref.startsWith('docker://')) {
      exempt += 1;
      return;
    }

    const atIdx = ref.lastIndexOf('@');
    if (atIdx === -1) {
      violations.push(`${at}  ${ref}  → 缺少 @<sha>（既没固定版本，也没法固定）`);
      return;
    }

    const action = ref.slice(0, atIdx);
    const version = ref.slice(atIdx + 1);
    checked += 1;

    if (!SHA_RE.test(version)) {
      // 短 SHA（7~39 位十六进制）单独给一条文案：它的毛病是"不够长、可能撞车/被补全"，
      // 而不是"可变"——报错文案指错方向，排查的人就会往错的方向修。
      const kind = /^[0-9a-f]{7,39}$/.test(version)
        ? 'SHA 不完整，必须写满 40 位'
        : 'tag/分支是可变的，上游能改写它指向的 commit';
      violations.push(`${at}  ${action}@${version}  → 必须用 40 位 commit SHA（${kind}）`);
      return;
    }

    // 只认 `# v1.2.3` 形态：Dependabot 用这条注释确定「当前是哪个版本」再决定要不要升
    if (!comment || !/^v\d+\.\d+\.\d+/.test(comment)) {
      violations.push(
        `${at}  ${action}@${version.slice(0, 7)}…  → 缺 \`# vX.Y.Z\` 版本注释（Dependabot 靠它识别当前版本）`,
      );
    }
  });
}

console.log(`扫描目录：${dir}`);
console.log(`SHA 固定的 action 引用：${checked} 处；豁免（本地/docker）：${exempt} 处`);

if (violations.length > 0) {
  console.error(`\n✗ 发现 ${violations.length} 处不合格的 action 引用：\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('\n修法：把 @<tag> 换成该 tag 指向的完整 commit SHA，并在行尾注明版本，例如');
  console.error('  uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0');
  console.error('取 SHA：gh api repos/<owner>/<repo>/git/ref/tags/<tag>   （type=tag 时再解一层 git/tags/<sha>）');
  process.exit(1);
}

console.log('\n✓ 所有 action 均已固定到完整 commit SHA 且带版本注释');
