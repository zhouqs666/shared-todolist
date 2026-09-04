/**
 * 图片工具：选图 / 压缩 / 上传 / 删除
 *
 * 设计取舍：
 *   - 一条待办最多一张图，定位是"可选备注"，不是主角。
 *   - 上传前用 <canvas> 压缩（长边 1280、JPEG 0.8），节省 Supabase 免费层
 *     存储（1GB）和流量（2GB/月）。PNG（截图/表情包/透明图）保留 PNG 不二次损失。
 *   - 选图用原生 <input type=file accept=image/*>：PWA 和 APK 通用，
 *     安卓 13+ 走系统 Photo Picker 免权限。
 */

import { supabase } from './supabase.js';

const BUCKET = 'todo-attachments';
const SHORT_EDGE_MAX = 1280; // 短边阈值：超过才压缩
const JPEG_QUALITY = 0.92;  // 提到 0.92，减少文字边缘伪影

// 文件 MIME → 扩展名（直接原文件上传分支用）
function extFromType(type) {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  return 'jpg';
}

/**
 * 压缩图片：**短边阈值**策略。
 *
 *   - 短边 ≤ SHORT_EDGE_MAX：直接上传原文件，不经过 canvas。
 *     长图（如手机长截图，长边可达数千像素）短边通常 ≤ 1280，
 *     保留原分辨率可保住文字清晰度；跳过 canvas 同时避免 JPEG 二次损失。
 *   - 短边 > SHORT_EDGE_MAX：等比缩到短边 = SHORT_EDGE_MAX（普通大照片压缩），
 *     PNG 保留 PNG 无损，其余转 JPEG 0.92。
 *   - webp/gif：一律直接原文件上传（避免动图被 canvas 取首帧变静态）。
 *
 * @param {File} file 原始图片文件
 * @returns {Promise<{blob:Blob, ext:string}>}
 */
export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const ext = extFromType(file.type);
    // webp/gif 直接原文件上传（动图保护）
    if (ext === 'webp' || ext === 'gif') {
      resolve({ blob: file, ext });
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const shortEdge = Math.min(img.width, img.height);
      // 短边 ≤ 阈值：保留原文件，避免长图文字失真 + JPEG 二次损失
      if (shortEdge <= SHORT_EDGE_MAX) {
        resolve({ blob: file, ext });
        return;
      }
      // 短边 > 阈值：等比缩到短边 = SHORT_EDGE_MAX
      const ratio = SHORT_EDGE_MAX / shortEdge;
      const width = Math.round(img.width * ratio);
      const height = Math.round(img.height * ratio);
      const isPng = ext === 'png';
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      // 白底（JPEG 无 alpha，避免透明 PNG 压成 JPEG 黑底）
      if (!isPng) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(img, 0, 0, width, height);
      const mime = isPng ? 'image/png' : 'image/jpeg';
      canvas.toBlob(
        (blob) => {
          if (blob) resolve({ blob, ext });
          else reject(new Error('压缩失败'));
        },
        mime,
        isPng ? undefined : JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

/**
 * 弹出系统选图器，返回选中的文件（用户取消返回 null）。
 * @returns {Promise<File|null>}
 */
export function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files && input.files[0];
      resolve(f || null);
    };
    // 部分浏览器取消选择时不触发 change，无法可靠监听取消；这里不做超时兜底，
    // 调用方按 await 结果处理即可（null = 未选）。
    input.click();
  });
}

/**
 * 弹出系统选图器（多选），返回选中的文件数组（用户取消返回 null）。
 * @returns {Promise<File[]|null>}
 */
export function pickImages() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => {
      if (!input.files || input.files.length === 0) { resolve(null); return; }
      resolve(Array.from(input.files));
    };
    input.click();
  });
}

/**
 * 压缩并上传图片到 Storage，返回 public URL。
 * @param {string} todoId 关联的待办 id（用作路径前缀，便于清理）
 * @param {File} file 原始图片文件
 * @returns {Promise<string>} publicUrl
 */
export async function uploadTodoImage(todoId, file) {
  const { blob, ext } = await compressImage(file);
  const path = `${todoId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type,
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * 删除 Storage 里的图片文件（按 public URL 解析 path）。
 * 失败静默（最多留孤儿文件，不影响业务）。
 * @param {string} url 图片 public URL
 */
export async function removeTodoImage(url) {
  try {
    const marker = `/object/public/${BUCKET}/`;
    const idx = url.indexOf(marker);
    if (idx < 0) return;
    const path = url.slice(idx + marker.length);
    await supabase.storage.from(BUCKET).remove([path]);
  } catch (e) {
    console.warn('[image] 删除图片失败:', e.message);
  }
}
