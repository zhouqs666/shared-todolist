/**
 * 字段转换模块（DB snake_case ↔ 前端 camelCase）
 *
 * 抽自 db.js 和 realtime.js 的双份实现（技术优化清单第6条）。
 * 两处 toExternal 已 diff 确认逻辑完全一致，合并于此。
 * toNote/toReaction/toSticker 原只在 realtime.js（daily_notes/reactions/stickers 的 Realtime 推送转换）。
 *
 * 上层（db.js / realtime.js）统一从此 import，加字段只改一处。
 */

/** DB todo 行 → 前端 todo 对象 */
export function toExternal(row) {
  if (!row) return null;
  // 多图：优先 image_paths（JSONB 数组），兼容旧 image_path 单值
  const imagePaths = Array.isArray(row.image_paths)
    ? row.image_paths
    : row.image_path
    ? [row.image_path]
    : null;
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedBy: row.completed_by || null,
    completedAt: row.completed_at || null,
    nudgeBy: row.nudge_by || null, // 轻轻提醒的标记人 id（克制提醒功能）
    imagePaths: imagePaths, // 图片附件 URL 数组（多图，null=无图）
    imagePath: imagePaths ? imagePaths[0] : null, // 兼容旧代码（取首张）
    completedNote: row.completed_note || null, // 备注（完成前后均可加，null=无备注）
    rarity: row.rarity || 'common', // 稀有度：common(普通)/rare/epic/legendary（隐藏款盲盒）
    raritySeen: row.rarity_seen !== false, // 隐藏款是否已被对方看过（false=对方端需播惊喜提示）
  };
}

/** daily_notes 行 → 前端 note */
export function toNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    dayKey: row.day_key,
    authorId: row.author_id,
    content: row.content,
    readBy: row.read_by || null,
    createdAt: row.created_at,
  };
}

/** reactions 行 → 前端 reaction */
export function toReaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    todoId: row.todo_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: row.created_at,
  };
}

/** stickers 行 → 前端 sticker */
export function toSticker(row) {
  if (!row) return null;
  return {
    id: row.id,
    stickerKey: row.sticker_key,
    rarity: row.rarity,
    unlockedBy: row.unlocked_by,
    todoId: row.todo_id || null,
    unlockedAt: row.unlocked_at,
  };
}
