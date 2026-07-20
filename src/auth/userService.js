/**
 * 用户服务：管理两个预置账号
 *
 * V1 决策（Q4）：账号从环境变量预置，无注册流程。
 * 本模块在内存中维护用户记录，提供按用户名查找、密码校验的能力。
 * 数据库初始化（首启动写库）在 M3 引入存储层后补充。
 */

import { config } from '../config/env.js';

/**
 * @typedef {Object} User
 * @property {string} id           - 稳定 ID，如 "u_a"
 * @property {string} username     - 登录用户名
 * @property {string} displayName  - 展示名
 * @property {string} passwordHash - bcrypt 哈希
 */

/** @type {User[]} */
const users = [
  { id: 'u_a', ...config.users.a },
  { id: 'u_b', ...config.users.b },
];

/** 按 id 查 */
export function findById(id) {
  return users.find((u) => u.id === id) || null;
}

/** 按用户名查（大小写敏感） */
export function findByUsername(username) {
  return users.find((u) => u.username === username) || null;
}

/** 列出所有用户（不含 hash） */
export function listSafe() {
  return users.map(({ passwordHash, ...rest }) => rest);
}
