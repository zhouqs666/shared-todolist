/**
 * 数据访问层入口
 * 按 DB_TYPE 切换实现：json（本地）| supabase（生产）
 *
 * 业务层只依赖这里导出的接口，不直接接触具体存储实现。
 */

import { config } from '../config/env.js';
import { jsonStore } from './jsonStore.js';

/**
 * @typedef {Object} Todo
 * @property {string} id
 * @property {string} text
 * @property {boolean} completed
 * @property {string} createdBy
 * @property {string} createdAt
 * @property {string|null} completedBy
 * @property {string|null} completedAt
 */

let store;

if (config.dbType === 'supabase') {
  const { supabaseStore } = await import('./supabaseStore.js');
  store = supabaseStore;
} else {
  // 默认 json（本地开发）
  store = jsonStore;
}

export const todoStore = store;
