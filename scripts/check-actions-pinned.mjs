#!/usr/bin/env node
/**
 * 结构性检查（批次 D · 供应链安全）：所有 `uses:` 引用的 action 必须固定到完整 commit SHA。
 *
 * ## 为什么需要这个脚本（而不只是打开 GitHub 的开关）
 *
 * 仓库设置里有一项 `sha_pinning_required`（本仓库已开）：开启后，引用 tag 的工作流**根本不会启动**。
 * 但那种失败方式极其隐蔽 —— PR 上的 check 直接不出现，看起来像「还没跑」而不是「配错了」，
 * 与 2026-09-15 实测到的「`pull_request.paths` 漏配 workflow 自身 → 该 PR 零验证」是同一类
 * 隐形故障（见 CODE-REVIEW.md F2）。
 *
 * 这个脚本把同一件事提前成「秒级、带明确报错、本地可跑」的静态检查，
 * 与 check-test-guards.mjs / check-e2e-env-keys.mjs 同一族。
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
