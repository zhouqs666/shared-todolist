/**
 * Storage 工具：URL ↔ object path 互转
 *
 * 抽自 db.js 和 image-utils.js 的双份实现（2026-09-07 基线审查发现）。
 *   - db.js 旧 storagePathFromUrl（hardcode 'todo-attachments'）
 *   - image-utils.js removeTodoImage 内联 URL 解析
 * 两份逻辑几乎一样，改一处忘另一处是事故温床。统一到这里。
 */

/**
 * 从 Supabase Storage public URL 解析出 object path（用于 remove / 校验）。
 * URL 形如：https://xxx.supabase.co/storage/v1/object/public/<bucket>/<path>
 * 返回 <path>；解析失败返回 null。
 *
 * @param {string} url public URL
 * @param {string} bucket bucket 名称
 * @returns {string|null}
 */
export function storagePathFromUrl(url, bucket) {
  if (!url) return null;
  try {
    const marker = `/object/public/${bucket}/`;
    const idx = url.indexOf(marker);
    if (idx < 0) return null;
    return url.slice(idx + marker.length);
  } catch (e) {
    return null;
  }
}
