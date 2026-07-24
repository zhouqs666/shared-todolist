/**
 * Supabase PostgreSQL 存储实现（生产环境用）
 *
 * 接口与 jsonStore.js 完全一致，由 todoStore.js 按 DB_TYPE 切换
 * 使用 @supabase/supabase-js 客户端
 *
 * 表结构见 /supabase/schema.sql
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

const supabase = createClient(config.supabase.url, config.supabase.key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 表名 */
const TABLE = 'todos';

/**
 * 把数据库行转成对外 Todo（字段对齐 jsonStore 输出）
 * DB 用 boolean/字段名下划线，这里统一成 camelCase + ISO 时间
 */
function toExternal(row) {
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

/** 把外部字段名转成数据库列名（用于 insert/update） */
function toRow(todo) {
  return {
    id: todo.id,
    text: todo.text,
    completed: todo.completed,
    created_by: todo.createdBy,
    created_at: todo.createdAt,
    completed_by: todo.completedBy,
    completed_at: todo.completedAt,
  };
}

export const supabaseStore = {
  /** 全部待办（已排序：未完成在上、新的在上、完成的下沉） */
  async listAll() {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      // 完成项排后面，同区间创建时间倒序
      .order('completed', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(toExternal);
  },

  async findById(id) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? toExternal(data) : null;
  },

  async create({ text, userId }) {
    const now = new Date().toISOString();
    const todo = {
      id: null, // 让 DB 生成（见 schema.sql: default uuid）
      text,
      completed: false,
      createdBy: userId,
      createdAt: now,
      completedBy: null,
      completedAt: null,
    };
    const { data, error } = await supabase
      .from(TABLE)
      .insert(toRow({ ...todo, id: undefined }))
      .select()
      .single();
    if (error) throw error;
    return toExternal(data);
  },

  async update(id, patch, userId) {
    const existing = await supabaseStore.findById(id);
    if (!existing) return null;

    const updateData = {};
    if (patch.completed !== undefined) {
      updateData.completed = !!patch.completed;
      if (patch.completed) {
        updateData.completed_by = userId;
        updateData.completed_at = new Date().toISOString();
      } else {
        updateData.completed_by = null;
        updateData.completed_at = null;
      }
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update(updateData)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data ? toExternal(data) : null;
  },

  async remove(id) {
    // 用 count 选项判断实际删除了几行
    // 注意：PostgREST 需要 Prefer header 才会返回 count
    const { count, error } = await supabase
      .from(TABLE)
      .delete({ count: 'exact' })
      .eq('id', id);
    if (error) throw error;
    // count === 1 表示删除成功；0 表示 ID 不存在
    return count !== null && count > 0;
  },
};
