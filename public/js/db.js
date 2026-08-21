/**
 * 数据访问层
 *
 * 封装所有对 Supabase todos / profiles 表的读写。
 * 把 DB 的 snake_case 字段转成前端用的 camelCase，
 * 让上层代码（app.js / state.js）完全不需要关心底层结构变化。
 *
 * 字段映射：
 *   DB: id, text, completed, created_by, created_at, completed_by, completed_at
 *   前端: id, text, completed, createdBy,  createdAt,  completedBy,  completedAt
 */

import { supabase } from './supabase.js';
import { avatarForUsername } from './avatars.js';

/** DB 行 → 前端 todo 对象 */
function toExternal(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedBy: row.completed_by || null,
    completedAt: row.completed_at || null,
    nudgeBy: row.nudge_by || null, // 轻轻提醒的标记人 id（克制提醒功能）
    imagePath: row.image_path || null, // 图片附件的 public URL（null=无图）
    completedNote: row.completed_note || null, // 完成备注（完成后的交代，null=无备注）
    rarity: row.rarity || 'common', // 稀有度：common(普通)/rare/epic/legendary（隐藏款盲盒）
    raritySeen: row.rarity_seen !== false, // 隐藏款是否已被对方看过（false=对方端需播惊喜提示）
  };
}

/**
 * 从 Supabase Storage 的 public URL 里解析出 object path（用于 remove）。
 * URL 形如：https://xxx.supabase.co/storage/v1/object/public/todo-attachments/<todoId>/<file>.jpg
 * 返回 <todoId>/<file>.jpg；解析失败返回 null。
 */
function storagePathFromUrl(url) {
  if (!url) return null;
  try {
    const marker = '/object/public/todo-attachments/';
    const idx = url.indexOf(marker);
    if (idx < 0) return null;
    return url.slice(idx + marker.length);
  } catch (e) {
    return null;
  }
}

/**
 * 包装 Supabase 错误为统一的错误对象
 * 上层用 err.code 判断类型（沿用旧 api.js 的错误码语义）
 */
function wrapError(err, fallbackCode = 'UNKNOWN') {
  const e = new Error(err.message || 'Unknown');
  e.code = err.code || fallbackCode;
  e.status = err.status || 0;
  return e;
}

export const db = {
  /** 拉取所有 todos（仅未删除的，按 completed ASC、created_at DESC 排序） */
  async listTodos() {
    const { data, error } = await supabase
      .from('todos')
      .select('*')
      .is('deleted_at', null)
      .order('completed', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) throw wrapError(error);
    return (data || []).map(toExternal);
  },

  /** 创建 todo（created_by 必须是当前用户 id）
   *  imagePath 可选：若创建时已上传好图片，直接写入（避免再发一次 update）
   *  rarity 可选：隐藏款稀有度（rare/epic/legendary），不传则写 common；由前端开奖后传入
   *  容错：若 SQL 迁移未执行（rarity 列不存在，42703），降级为不带 rarity 插入，
   *       保证核心添加功能不受影响（与 listProfiles 对 last_seen_at 的降级同模式）。 */
  async createTodo(text, userId, imagePath, rarity) {
    const row = { text, created_by: userId, completed: false, rarity: rarity || 'common', rarity_seen: true };
    if (imagePath) row.image_path = imagePath;
    let { data, error } = await supabase
      .from('todos')
      .insert(row)
      .select()
      .single();
    // PGRST204 = PostgREST schema cache 找不到 rarity/rarity_seen 列（迁移未执行），降级重试
    // （PostgREST 在请求层拦截，不到 DB 层，所以不是 PG 的 42703）
    if (error && error.code === 'PGRST204') {
      const fallbackRow = { text, created_by: userId, completed: false };
      if (imagePath) fallbackRow.image_path = imagePath;
      const retry = await supabase.from('todos').insert(fallbackRow).select().single();
      error = retry.error;
      data = retry.data;
    }
    if (error) throw wrapError(error, 'INVALID_INPUT');
    return toExternal(data);
  },

  /** 设置完成状态（同时维护 completed_by / completed_at 一致性） */
  async setCompleted(id, completed, userId) {
    const patch = completed
      ? {
          completed: true,
          completed_by: userId,
          completed_at: new Date().toISOString(),
        }
      : {
          completed: false,
          completed_by: null,
          completed_at: null,
        };
    const { data, error } = await supabase
      .from('todos')
      .update(patch)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw wrapError(error);
    if (!data) throw wrapError({ message: 'NOT_FOUND', code: 'NOT_FOUND' });
    return toExternal(data);
  },

  /**
   * 设置完成备注（覆盖语义：新值替换旧值，传 null/空串=清除备注）。
   * 独立于 setCompleted：备注是"已完成后"的追加/修改，completed 状态不变。
   */
  async setCompletedNote(id, note) {
    const { data, error } = await supabase
      .from('todos')
      .update({ completed_note: note || null })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw wrapError(error);
    return toExternal(data);
  },

  /** 删除 todo（软删除：标记 deleted_at，不物理删除，可恢复） */
  async deleteTodo(id) {
    const { error } = await supabase
      .from('todos')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw wrapError(error);
  },

  /**
   * 设置/取消"轻轻提醒"标记（克制提醒功能）。
   * @param {string} id todo id
   * @param {string|null} userId 标记者 id（取消传 null）
   */
  async setNudge(id, userId) {
    const { data, error } = await supabase
      .from('todos')
      .update({ nudge_by: userId })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw wrapError(error);
    if (!data) throw wrapError({ message: 'NOT_FOUND', code: 'NOT_FOUND' });
    return toExternal(data);
  },

  /**
   * 设置/更换/删除 todo 的图片。
   * @param {string} id todo id
   * @param {string|null} imagePath 图片 public URL（null=删除图片）
   * @param {string|null} prevPath 旧 URL（更换/删除时用于清理旧文件，可选）
   */
  async setImage(id, imagePath) {
    const { data, error } = await supabase
      .from('todos')
      .update({ image_path: imagePath })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw wrapError(error);
    if (!data) throw wrapError({ message: 'NOT_FOUND', code: 'NOT_FOUND' });
    // 删除/换图都不再物理删 Storage 文件（软删除精神：误删可由后台恢复，
    // 孤儿文件无害，免费层空间足够）。如需清理走后台脚本。
    return toExternal(data);
  },

  /**
   * 拉取所有 profiles（用于构建 userId → displayName / avatar / lastSeenAt 映射）。
   * 容错：若 last_seen_at 列不存在（SQL 迁移未执行），降级为不带该字段重查，
   *      避免加字段导致整个 profiles 加载失败 → 待办不显示创建者。
   */
  async listProfiles() {
    let { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, last_seen_at');
    if (error) {
      // 列不存在的错误（Postgrest 错误码 42703），降级为不带 last_seen_at
      // 保守起见：任何错误都尝试一次降级查询，失败才真正抛出
      const fallback = await supabase
        .from('profiles')
        .select('id, username, display_name');
      if (fallback.error) throw wrapError(fallback.error);
      data = fallback.data;
    }
    return (data || []).map((p) => ({
      id: p.id,
      username: p.username,
      displayName: p.display_name,
      avatar: avatarForUsername(p.username),
      lastSeenAt: p.last_seen_at || null,
    }));
  },

  /**
   * 更新自己的最后在线时间（打开 APP + 定时心跳时调用）。
   * 失败静默（last_seen 是锦上添花，不能影响主流程；列不存在时调用方已 catch）。
   */
  async updateLastSeen(userId) {
    const { error } = await supabase
      .from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw wrapError(error);
  },

  /**
   * 打开计数：给自己的 login_count_for_partner +1。
   * 含义："我又打开了一次 App，对方还没看到"。对方打开 App 时会据此播 N 下光晕，然后清零。
   * 每次"冷启动"App 都 +1（不管是不是登录态）。
   * 失败静默（光晕是锦上添花）。
   */
  async incrementLoginCount(userId) {
    // 用 RPC 原子自增（避免读-改-写竞态）
    const { error } = await supabase.rpc('increment_login_count', { target_uid: userId });
    if (error) {
      // RPC 不存在（迁移未执行）时静默降级，不抛错
      console.warn('[db] incrementLoginCount 失败（已忽略）:', error.message);
    }
  },

  /**
   * 消费对方的打开计数：读取并清零（原子操作，通过 SECURITY DEFINER 函数绕过 RLS）。
   * @param {string} partnerId 对方的 userId
   * @returns {Promise<number>} 对方累积的、尚未被看到的打开次数（看完即清零）
   */
  async consumePartnerLoginCount(partnerId) {
    const { data, error } = await supabase.rpc('consume_login_count', { target_uid: partnerId });
    if (error) {
      console.warn('[db] consumePartnerLoginCount 失败（已忽略）:', error.message);
      return 0;
    }
    return data || 0;
  },

  // ===== 悄悄留言（daily_notes，阅后即焚）=====
  // 语义：每条留言独立保留，互不覆盖。接收方读某条 → 标记已读 → 删除该条（逐条即焚）。

  /** 拉取所有留言（仅未删除的，含 read_by 状态，按时间正序） */
  async listNotes() {
    const { data, error } = await supabase
      .from('daily_notes')
      .select('id, day_key, author_id, content, read_by, deleted_at, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (error) throw wrapError(error);
    return (data || []).map(toNote);
  },

  /** 发一条悄悄留言（逐条独立，不清旧留言） */
  async sendNote(content, userId) {
    const { data, error } = await supabase
      .from('daily_notes')
      .insert({ author_id: userId, content })
      .select('id, day_key, author_id, content, read_by, created_at')
      .single();
    if (error) throw wrapError(error, 'INVALID_INPUT');
    return toNote(data);
  },

  /** 标记某条留言为「我已读」（阅后即焚第一步，区分谁读过） */
  async markNoteRead(id, userId) {
    const { data, error } = await supabase
      .from('daily_notes')
      .update({ read_by: userId })
      .eq('id', id)
      .select('id, day_key, author_id, content, read_by, created_at')
      .maybeSingle();
    if (error) throw wrapError(error);
    if (!data) throw wrapError({ message: 'NOT_FOUND', code: 'NOT_FOUND' });
    return toNote(data);
  },

  /** 阅后即焚：软删除指定一条留言（标记 deleted_at，不碰别人的） */
  async deleteNote(id) {
    const { error } = await supabase
      .from('daily_notes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw wrapError(error);
  },

  // ===== 任务表情反应（reactions）=====

  /** 拉取全部表情反应（todoId → emoji 数组） */
  async listReactions() {
    const { data, error } = await supabase
      .from('reactions')
      .select('id, todo_id, user_id, emoji, created_at');
    if (error) throw wrapError(error);
    return (data || []).map((r) => ({
      id: r.id,
      todoId: r.todo_id,
      userId: r.user_id,
      emoji: r.emoji,
      createdAt: r.created_at,
    }));
  },

  /** 贴一条表情（UNIQUE 约束保证幂等，重复会被 DB 忽略） */
  async addReaction(todoId, emoji, userId) {
    const { data, error } = await supabase
      .from('reactions')
      .insert({ todo_id: todoId, user_id: userId, emoji })
      .select('id, todo_id, user_id, emoji, created_at')
      .single();
    // 23505 = unique_violation：已存在，视为已贴成功（幂等）
    if (error) {
      if (error.code === '23505') return null;
      throw wrapError(error);
    }
    return {
      id: data.id,
      todoId: data.todo_id,
      userId: data.user_id,
      emoji: data.emoji,
      createdAt: data.created_at,
    };
  },

  /** 取消一条表情（emoji 可传单个值或数组，数组用于兼容旧 emoji 数据） */
  async removeReaction(todoId, emoji, userId) {
    const emojis = Array.isArray(emoji) ? emoji : [emoji];
    const { error } = await supabase
      .from('reactions')
      .delete()
      .eq('todo_id', todoId)
      .eq('user_id', userId)
      .in('emoji', emojis);
    if (error) throw wrapError(error);
  },

  // ===== 收集图鉴（stickers，两人共享一本）=====

  /** 拉取全部已解锁贴纸（共享图鉴，所有 authenticated 可见） */
  async listStickers() {
    const { data, error } = await supabase
      .from('stickers')
      .select('id, sticker_key, rarity, unlocked_by, todo_id, unlocked_at');
    if (error) throw wrapError(error);
    return (data || []).map(toSticker);
  },

  /**
   * 解锁一张贴纸（完成隐藏款待办时调用）。
   * 用 upsert + onConflict('sticker_key') 保证幂等：同一张贴纸重复解锁被忽略。
   * @returns {Promise<Object|null>} 新解锁的贴纸对象；若已存在（重复解锁）返回 null
   */
  async unlockSticker(stickerKey, rarity, userId, todoId) {
    const { data, error } = await supabase
      .from('stickers')
      .upsert(
        { sticker_key: stickerKey, rarity, unlocked_by: userId, todo_id: todoId || null },
        { onConflict: 'sticker_key', ignoreDuplicates: true }
      )
      .select('id, sticker_key, rarity, unlocked_by, todo_id, unlocked_at');
    if (error) throw wrapError(error);
    // ignoreDuplicates:true 时，已存在的行不会返回 → data 为空数组 = 重复解锁
    if (!data || data.length === 0) return null;
    return toSticker(data[0]);
  },

  /**
   * 标记一条隐藏款待办为"已被看过"（对方端首次见到播完惊喜提示后回标）。
   * 失败静默（锦上添花字段，不影响主流程）。
   */
  async markRaritySeen(id) {
    const { error } = await supabase
      .from('todos')
      .update({ rarity_seen: true })
      .eq('id', id);
    if (error) console.warn('[db] markRaritySeen 失败（已忽略）:', error.message);
  },

};

/** stickers DB 行 → 前端 sticker 对象 */
function toSticker(row) {
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

/** daily_notes DB 行 → 前端 note 对象 */
function toNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    dayKey: row.day_key,
    authorId: row.author_id,
    content: row.content,
    readBy: row.read_by || null, // 谁已读过（阅后即焚依据）
    createdAt: row.created_at,
  };
}
