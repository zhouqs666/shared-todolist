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
  };
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
  /** 拉取所有 todos（按 completed ASC、created_at DESC 排序） */
  async listTodos() {
    const { data, error } = await supabase
      .from('todos')
      .select('*')
      .order('completed', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) throw wrapError(error);
    return (data || []).map(toExternal);
  },

  /** 创建 todo（created_by 必须是当前用户 id） */
  async createTodo(text, userId) {
    const { data, error } = await supabase
      .from('todos')
      .insert({ text, created_by: userId, completed: false })
      .select()
      .single();
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

  /** 删除 todo */
  async deleteTodo(id) {
    const { error } = await supabase.from('todos').delete().eq('id', id);
    if (error) throw wrapError(error);
  },

  /** 拉取所有 profiles（用于构建 userId → displayName / avatar 映射） */
  async listProfiles() {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name');
    if (error) throw wrapError(error);
    return (data || []).map((p) => ({
      id: p.id,
      username: p.username,
      displayName: p.display_name,
      avatar: avatarForUsername(p.username),
    }));
  },
};
