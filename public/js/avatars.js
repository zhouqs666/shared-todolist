/**
 * 用户名 → 头像映射（前端静态资源）
 *
 * 两个固定账号：XiaoBaoBao 是女生，DaBaoBei 是男生。
 * 抽到独立模块，避免 db.js 与 auth.js 互相 import 造成循环依赖。
 */

const USERNAME_TO_AVATAR = {
  小宝宝: '/icons/avatars/xiaobaobao.jpg',
  大宝贝: '/icons/avatars/dabaobei.jpg',
  // 英文登录名兼容入口
  XiaoBaoBao: '/icons/avatars/xiaobaobao.jpg',
  DaBaoBei: '/icons/avatars/dabaobei.jpg',
};

/**
 * 未命中任何预设时的兜底头像（内联 SVG，不新增静态文件）。
 *
 * 为什么**必须有兜底**（2026-09-15 实测发现的产品缺口，不是洁癖）：
 *   `renderMe()` 只在 avatar 非空时才创建 `.topbar__avatar`，而
 *   **「长按头像 → 账号菜单（回收站 / 退出登录）」的入口就挂在那个 img 上** ——
 *   所以头像为空时，用户彻底点不到回收站和退出登录。
 *   触发条件不止"测试账号"：任何非预设昵称（改过昵称、测试环境账号）都命中；
 *   另外预设头像走文件路径，加载失败时 `img.onerror` 会移除它，同样失去入口。
 *   用 data-URI 兜底（永不加载失败），保证入口永远在。
 */
export const FALLBACK_AVATAR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#f3b9cd"/><stop offset="1" stop-color="#e884a8"/>' +
      '</linearGradient></defs>' +
      '<circle cx="32" cy="32" r="32" fill="url(#g)"/>' +
      '<path d="M32 47s-13-7.8-13-16.6c0-4.3 3.4-7.5 7.4-7.5 2.7 0 4.9 1.4 5.6 3.3.7-1.9 2.9-3.3 5.6-3.3 4 0 7.4 3.2 7.4 7.5C45 39.2 32 47 32 47z" fill="#fff"/>' +
      '</svg>'
  );

/** 根据用户名返回头像 URL；未匹配到预设时返回兜底头像（**不返回 null**，原因见上） */
export function avatarForUsername(username) {
  if (!username) return FALLBACK_AVATAR;
  // 精确匹配（中文/英文均可）
  if (USERNAME_TO_AVATAR[username]) return USERNAME_TO_AVATAR[username];
  // 兜底：用小写子串匹配（伪邮箱 / 任意大小写都能命中）
  const lower = String(username).toLowerCase();
  if (lower.includes('xiaobaobao') || username.includes('小宝宝')) {
    return USERNAME_TO_AVATAR.XiaoBaoBao;
  }
  if (lower.includes('dabaobei') || username.includes('大宝贝')) {
    return USERNAME_TO_AVATAR.DaBaoBei;
  }
  return FALLBACK_AVATAR;
}
