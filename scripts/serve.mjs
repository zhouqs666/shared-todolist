/**
 * 极简静态文件服务器（零依赖）
 *
 * 用法： node scripts/serve.mjs [port]
 *
 * 特点：
 *   - 仅用 Node 内置模块（http / fs / path / url）
 *   - 正确的 MIME 类型（含 .webmanifest / .mjs / .svg）
 *   - index.html 作目录默认页
 *   - SPA 兜底：未匹配的路径返回 index.html（让前端路由处理）
 *   - 默认端口 3000
 *
 * 不做的事（保留极简）：
 *   - 无 gzip / brotli（小项目，文件本身不大）
 *   - 无范围请求（不需要视频流）
 *   - 无 HTTPS（由 Cloudflare Tunnel 终结 TLS）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3000;

// MIME 类型表（补全常见类型）
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

function sendFile(res, absPath) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      send404(res);
      return;
    }
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(absPath).pipe(res);
  });
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

const server = http.createServer((req, res) => {
  // 安全：去掉 query 和 hash
  const urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);

  // 防目录穿越
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let absPath = path.join(PUBLIC_DIR, safePath);

  // 目录则尝试 index.html
  try {
    if (fs.statSync(absPath).isDirectory()) {
      absPath = path.join(absPath, 'index.html');
    }
  } catch (_) {
    // 不存在，先尝试加 .html，再不行走 SPA fallback
    const withHtml = absPath + '.html';
    if (fs.existsSync(withHtml)) {
      sendFile(res, withHtml);
      return;
    }
    // SPA fallback：返回 index.html（让前端处理"未登录跳 /login"等）
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  sendFile(res, absPath);
});

server.listen(PORT, () => {
  console.log(`✓ 静态服务器已启动`);
  console.log(`  本机:   http://localhost:${PORT}`);
  console.log(`  目录:   ${PUBLIC_DIR}`);
  console.log(`  Ctrl+C 停止`);
});
