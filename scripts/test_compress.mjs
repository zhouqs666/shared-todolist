/**
 * 图片压缩逻辑测试（不碰生产数据）
 *
 * 动态 import image-utils.js 的 compressImage，验证短边阈值策略：
 *   - 长图（短边 ≤ 1280）：直接原文件，不压缩（保文字清晰）
 *   - 大照片（短边 > 1280）：等比缩到短边 1280
 *   - webp/gif：直接原文件（动图保护）
 *
 * 用法： node scripts/test_compress.mjs
 */
import { chromium } from 'playwright';
import { guardReadOnly } from './_lib-readonly-guard.mjs';

const browser = await chromium.launch();
const page = await browser.newPage();
// 本脚本跑在生产服务（:3000）上：只读守卫保证它永远不会写生产库
const guard = guardReadOnly(page);
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.err]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerr]', e.message));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });

// 生成指定尺寸图片 File，调 compressImage，返回诊断
const testCompress = async (width, height, type) => {
  return await page.evaluate(
    async ({ width, height, type }) => {
      const { compressImage } = await import('/js/image-utils.js');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fda4af';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#000';
      ctx.font = '20px sans-serif';
      ctx.fillText('测试文字', 10, 30);
      const blob = await new Promise((r) => canvas.toBlob(r, type, 0.9));
      const ext0 = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      const file = new File([blob], 'test.' + ext0, { type });
      const origSize = file.size;
      const result = await compressImage(file);
      const isOriginal = result.blob === file;
      let resultDims = null;
      if (!isOriginal) {
        const url = URL.createObjectURL(result.blob);
        const img = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = url;
        });
        resultDims = { w: img.width, h: img.height };
        URL.revokeObjectURL(url);
      }
      return {
        isOriginal,
        ext: result.ext,
        origSize,
        resultSize: result.blob.size,
        resultDims,
      };
    },
    { width, height, type }
  );
};

const assert = (cond, msg) => {
  if (!cond) throw new Error('❌ ' + msg);
  console.log('  ✓');
};

console.log('1. 长图 1080×5000 JPEG（短边 1080 < 1280，应原文件不压缩）:');
let r = await testCompress(1080, 5000, 'image/jpeg');
console.log('  ', JSON.stringify(r));
assert(r.isOriginal === true, '长图应原文件');
assert(r.ext === 'jpg', 'ext 应 jpg');

console.log('2. 大照片 4032×3024 JPEG（短边 3024 > 1280，应压缩到短边 1280）:');
r = await testCompress(4032, 3024, 'image/jpeg');
console.log('  ', JSON.stringify(r));
assert(r.isOriginal === false, '大照片应压缩');
assert(r.ext === 'jpg', 'ext 应 jpg');
// 短边策略：短边方向缩到 1280；4032×3024 → 1707×1280（短边=1280）
assert(r.resultDims && Math.min(r.resultDims.w, r.resultDims.h) === 1280, `压缩后短边应 1280，实际 ${JSON.stringify(r.resultDims)}`);
assert(r.resultDims.w === 1707 && r.resultDims.h === 1280, `压缩后应 1707×1280，实际 ${JSON.stringify(r.resultDims)}`);

console.log('3. 正方形大图 2000×2000 PNG（短边 2000 > 1280，应压缩到 1280×1280 PNG）:');
r = await testCompress(2000, 2000, 'image/png');
console.log('  ', JSON.stringify(r));
assert(r.isOriginal === false, '大 PNG 应压缩');
assert(r.ext === 'png', 'ext 应 png');
assert(r.resultDims && r.resultDims.w === 1280 && r.resultDims.h === 1280, `压缩后应 1280×1280，实际 ${JSON.stringify(r.resultDims)}`);

console.log('4. 小图 800×600 JPEG（短边 600 < 1280，应原文件）:');
r = await testCompress(800, 600, 'image/jpeg');
console.log('  ', JSON.stringify(r));
assert(r.isOriginal === true, '小图应原文件');

console.log('5. webp（应直接原文件，动图保护）:');
r = await testCompress(2000, 2000, 'image/webp');
console.log('  ', JSON.stringify(r));
assert(r.isOriginal === true, 'webp 应原文件');
assert(r.ext === 'webp', 'ext 应 webp');

await browser.close();
const clean = guard.assertClean();
console.log(clean ? '\n✅ 全部测试通过' : '\n⚠️ 断言通过，但只读守卫发现写请求（见上）');
