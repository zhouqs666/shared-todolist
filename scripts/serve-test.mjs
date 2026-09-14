/**
 * 测试专用静态服务器（铁律一的 Web 通道隔离）
 *
 * 背景：`scripts/serve.mjs` 托管的是生产 `public/`，其中 `js/supabase.js`
 * 硬编码生产库 URL。用它跑 Playwright 测试 = 拿生产库做测试。
 * （2026-09-14 事故：调试创建 19 条生产待办，误解锁 legendary_1 传说贴纸。）
 *
 * 本脚本做的事：
 *   1. 读 app-e2e/.env.test 的 E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY
 *   2. 与 .env 的生产 URL 比对，相同或缺失 → 拒绝启动
 *   3. 托管 public/，但**在内存里改写** `/js/supabase.js` 指向测试库
 *      —— 生产文件零改动，测试配置不可能被打进发布包
 *   4. 暴露 `/__dbinfo`，供测试脚本做 fail-closed 校验（见 scripts/e2e_common.py）
 *   5. 启动时打印醒目横幅，明确当前连的是哪个库
 *
 * 用法：node scripts/serve-test.mjs [port]    # 默认端口 3100（与生产的 3000 错开）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
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

const prodEnv = loadDotenv(path.join(ROOT, '.env'));
const PROD_URL = prodEnv.SUPABASE_URL;

const testEnv = loadDotenv(path.join(ROOT, 'app-e2e', '.env.test'));
// 允许环境变量覆盖，便于 CI
const TEST_URL = process.env.E2E_SUPABASE_URL || testEnv.E2E_SUPABASE_URL;
const TEST_ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY || testEnv.E2E_SUPABASE_ANON_KEY;

// ===== 安全闸：不满足隔离条件就拒绝启动 =====
if (!TEST_URL || !TEST_ANON_KEY) {
  console.error('✗ app-e2e/.env.test 缺少 E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY');
  console.error('  测试服务器必须连独立测试库（铁律一），拒绝以生产库启动。');
  process.exit(1);
}
if (!PROD_URL) {
  console.error('✗ 读不到 .env 的 SUPABASE_URL，无法校验隔离性，拒绝启动（fail-closed）');
  process.exit(1);
}
if (TEST_URL === PROD_URL) {
  console.error('✗ 测试库 URL 与生产库相同！');
  console.error(`  测试库：${TEST_URL}`);
  console.error(`  生产库：${PROD_URL}`);
  console.error('  铁律一：测试必须物理隔离，拒绝启动。');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3100;

// ===== 生产 supabase.js 的替身（内存改写，不落盘）=====
const SUPABASE_JS_PATH = path.join(PUBLIC_DIR, 'js', 'supabase.js');
const PROD_SUPABASE_SRC = fs.readFileSync(SUPABASE_JS_PATH, 'utf8');

function buildTestSupabaseJs() {
  let code = PROD_SUPABASE_SRC;
  const before = code;
  code = code.replace(
    /const SUPABASE_URL = '[^']*';/,
    `const SUPABASE_URL = '${TEST_URL}';`
  );
  code = code.replace(
    /const SUPABASE_ANON_KEY = '[^']*';/,
    `const SUPABASE_ANON_KEY = '${TEST_ANON_KEY}';`
  );
  if (code === before || !code.includes(TEST_URL)) {
    console.error('✗ 改写 supabase.js 失败：URL/KEY 字面量未命中，请检查文件结构');
    process.exit(1);
  }
  return code;
}

const TEST_SUPABASE_JS = buildTestSupabaseJs();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendText(res, body, mime = 'text/plain; charset=utf-8', status = 200) {
  res.writeHead(status, {
    'Content-Type': mime,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, absPath) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 'Not Found', 'text/plain; charset=utf-8', 404);
      return;
    }
    const ext = path.extname(absPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(absPath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);

  // ===== 隔离自证端点：测试脚本靠它做 fail-closed 校验 =====
  if (urlPath === '/__dbinfo') {
    sendText(res, JSON.stringify({
      project: 'test',
      supabaseUrl: TEST_URL,
      prodUrl: PROD_URL,
      isolated: TEST_URL !== PROD_URL,
      port: PORT,
    }), 'application/json; charset=utf-8');
    return;
  }

  // ===== 核心：supabase.js 内存改写为测试库 =====
  if (urlPath === '/js/supabase.js') {
    sendText(res, TEST_SUPABASE_JS, 'text/javascript; charset=utf-8');
    return;
  }

  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let absPath = path.join(PUBLIC_DIR, safePath);

  try {
    if (fs.statSync(absPath).isDirectory()) {
      absPath = path.join(absPath, 'index.html');
    }
  } catch (_) {
    const withHtml = absPath + '.html';
    if (fs.existsSync(withHtml)) {
      sendFile(res, withHtml);
      return;
    }
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  sendFile(res, absPath);
});

server.listen(PORT, () => {
  const line = '═'.repeat(58);
  console.log(`\n${line}`);
  console.log('🧪 测试专用服务器已启动（铁律一：物理隔离生产库）');
  console.log(line);
  console.log(`  本机:     http://localhost:${PORT}`);
  console.log(`  测试库:   ${TEST_URL}`);
  console.log(`  生产库:   ${PROD_URL}  ← 本服务绝不连它`);
  console.log(`  改写生效: /js/supabase.js（内存替换，生产文件零改动）`);
  console.log(`  自证端点: http://localhost:${PORT}/__dbinfo`);
  console.log(`${line}`);
  console.log('  ⚠️ 测试脚本必须指向本端口，禁止用 3000（那是生产库）');
  console.log(`${line}\n`);
});
