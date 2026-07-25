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

/** 根据用户名返回头像 URL，未匹配返回 null */
export function avatarForUsername(username) {
  if (!username) return null;
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
  return null;
}
