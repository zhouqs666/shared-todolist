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
    pinned: !!row.pinned, // 是否置顶（true=置顶，显示在列表最上方）
    rarity: row.rarity || 'common', // 稀有度：common(普通)/rare/epic/legendary（隐藏款盲盒）
    raritySeen: row.rarity_seen !== false, // 隐藏款是否已被对方看过（false=对方端需播惊喜提示）
    deletedAt: row.deleted_at || null, // 软删除时间（null=正常，非null=已在回收站）
    // 到点提醒三件套（migration-reminders.sql；三者 DB CHECK 保证同空/同非空）
    // ⚠️ 必须在 toExternal 映射：Realtime 回推走这里，漏了会丢字段 → 徽标/对账静默失效
    reminderAt: row.remind_at || null, // 提醒时间（UTC ISO；null=未设）
    reminderScope: row.remind_scope || null, // both|self|partner（相对 reminderBy 设置者）
    reminderBy: row.remind_by || null, // 提醒设置者 userId
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
    starLevel: row.star_level || 0, // 星级（批次 4）：0=普通/1=闪卡/2=烫金；列缺失/未返回时兜底 0
    unlockedBy: row.unlocked_by,
    todoId: row.todo_id || null,
    unlockedAt: row.unlocked_at,
  };
}

/**
 * todo_comments 行 → 前端 comment（待办留言板）
 * ⚠️ deletedAt 必须映射（与 toNote 不同）：软删行仍要留在缓存里，
 *    因为回复的前缀「回复 @昵称」需要解析已被删除的父留言是谁写的。
 */
export function toTodoComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    todoId: row.todo_id,
    authorId: row.author_id,
    parentId: row.parent_id || null, // 回复目标（null=主留言）
    content: row.content,
    editedAt: row.edited_at || null, // 改过 → UI 显示「已编辑」
    deletedAt: row.deleted_at || null, // 软删除（铁律九：只打时间戳）
    createdAt: row.created_at,
  };
}

/** comment_likes 行 → 前端 like */
export function toCommentLike(row) {
  if (!row) return null;
  return {
    id: row.id,
    commentId: row.comment_id,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}
