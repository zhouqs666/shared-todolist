/**
 * Web 通道测试环境隔离检查（铁律一）
 *
 * 只做一件事：确认 Web E2E 连的是独立测试库，不是生产库。
 *
 * 姊妹脚本分工（不要重复实现）：
 *   - schema 漂移检测 → app-e2e/scripts/check-test-schema.mjs
 *     （从 supabase/*.sql 自动推导契约，两个通道共用同一个测试库）
 *   - schema 补齐 SQL   → supabase/test-db-schema-sync.sql
 *
 * 背景（2026-09-14 事故）：Web 通道原本没有隔离，test_*.py 直连生产库，
 * 调试期间在生产库建了 27 条测试待办并误解锁 legendary_1 传说贴纸。
 *
 * 用法：node scripts/check-test-env.mjs
 * 退出码：0 = 隔离就绪；1 = 有问题
 */

import fs from 'node:fs';
import path from 'node:path';

function loadDotenv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const prodEnv = loadDotenv(path.join(ROOT, '.env'));
const testEnv = loadDotenv(path.join(ROOT, 'app-e2e', '.env.test'));

const prodUrl = prodEnv.SUPABASE_URL;
const testUrl = testEnv.E2E_SUPABASE_URL;
const testKey = testEnv.E2E_SUPABASE_SERVICE_ROLE_KEY || testEnv.E2E_SUPABASE_ANON_KEY;

let problems = 0;
const fail = (m) => { problems++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

console.log('\n=== Web 通道测试环境隔离检查 ===\n');

if (!prodUrl || !testUrl) {
  fail(`读不到库地址（生产:${prodUrl ? '有' : '缺'} 测试:${testUrl ? '有' : '缺'}）—— 检查 .env 与 app-e2e/.env.test`);
} else if (testUrl === prodUrl) {
  fail(`测试库与生产库相同：${testUrl} —— 铁律一，绝不可跑测试`);
} else if (!testKey) {
  fail('app-e2e/.env.test 缺少 E2E_SUPABASE_SERVICE_ROLE_KEY / E2E_SUPABASE_ANON_KEY');
} else {
  ok('测试库 ≠ 生产库');
  console.log(`      生产: ${prodUrl}   ← 测试绝不触碰`);
  console.log(`      测试: ${testUrl}`);
  ok('测试服务器运行时改写 supabase.js（生产文件零改动）');
  console.log('      启动方式: node scripts/serve-test.mjs  →  http://localhost:3100');
  console.log('      测试脚本: 默认连 3100，指向 3000 会被 e2e_common.py 拦截');
}

console.log('');
if (problems) {
  console.log(`✗ 共 ${problems} 处问题，跑 E2E 前必须修复。\n`);
  process.exit(1);
}
console.log('✅ 隔离就绪。schema 漂移请另行检查：node app-e2e/scripts/check-test-schema.mjs\n');
