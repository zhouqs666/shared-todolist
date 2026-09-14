/**
 * 通用 .env 加载 + Supabase 凭据校验（发布/校验脚本共用）
 *
 * 为什么抽出来：release.mjs / query-latest-version.mjs / verify-release.mjs
 * 三个脚本都要「读 .env → 拿 SUPABASE_URL + SUPABASE_KEY → 建 client」，
 * 各自复制一份解析逻辑，一旦 .env 格式或校验规则调整就要改三处。
 *
 * 行为约定（与原 release.mjs 内联实现完全一致，不引入新语义）：
 *   - 不覆盖已存在的 process.env（CI 里直接注入环境变量，不需要 .env 文件）
 *   - 去掉值两端的成对引号
 *   - 缺少 .env 或缺凭据 → 打印可执行的提示后 process.exit(1)，调用方不必 try/catch
 *
 * 复用约束：被发布脚本 import，**必须入库提交**（`_lib-*` 在 .gitignore 里有白名单例外）。
 *
 * 尚未迁移的脚本（刻意留下，不是遗漏 —— 见 CODE-REVIEW「🟡 有结论」）：
 *   - `release-apk.mjs`：APK 发布路径。它的 `--dry-run` **仍会改写 android assets 里的
 *     index.html**（预演并非完全只读），迁移后无法干净地做回归，而收益只有省掉 20 行解析。
 *     对一个有过「发了个旧包」事故史（2026-09-04，2.1.26）的脚本，这个风险比 DRY 值钱。
 *   - `rollback.mjs`：它的 loadEnv 是另一套契约（返回对象 + throw），且脚本本身会写生产
 *     （把版本置 enabled=false），没有安全的自测路径。迁移应当配一次真实回滚演练一起做。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（从 scripts/ 往上跳一级） */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 把 .env 的键值注入 process.env（已存在的键不覆盖） */
export function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    // CI 场景不落 .env 文件，改为直接注入环境变量，所以缺失不算错误
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) return;
    console.error('✗ 找不到 .env 文件，请在项目根目录创建（参考 .env.example）');
    process.exit(1);
  }
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

/**
 * 读取并校验 Supabase 凭据。
 * @returns {{ url: string, key: string }} key 为 service_role
 */
export function requireSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.error('✗ 缺少 SUPABASE_URL 或 SUPABASE_KEY（service_role）');
    process.exit(1);
  }
  // service_role key 是 JWT（>100 字符）；anon key 更短。防呆：拿 anon 跑发布会在写表时 401。
  if (key.length < 100) {
    console.error('✗ SUPABASE_KEY 看起来是 anon key，需要 service_role key（更长）才能上传/写表');
    process.exit(1);
  }
  return { url, key };
}
