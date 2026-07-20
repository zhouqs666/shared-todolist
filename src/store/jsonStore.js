/**
 * JSON 文件存储实现（本地开发用）
 *
 * 数据结构遵循 PRD §7.2
 * 通过文件持久化，服务重启后数据保留
 */

import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'todos.json');

/** @type {any[]} 内存缓存，启动时从文件加载 */
let cache = null;
let writeChain = Promise.resolve();

async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      cache = [];
    } else {
      throw err;
    }
  }
}

/** 串行写入，避免并发覆盖 */
function persist() {
  writeChain = writeChain.then(() =>
    fs.mkdir(dirname(DATA_FILE), { recursive: true }).then(() =>
      fs.writeFile(DATA_FILE, JSON.stringify(cache, null, 2), 'utf8')
    )
  );
  return writeChain;
}

async function ensureLoaded() {
  if (cache === null) await load();
}

function genId() {
  return 't_' + crypto.randomBytes(12).toString('hex');
}

/** 把内部记录转成对外 Todo（确保字段一致、布尔化） */
function toExternal(row) {
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    completedBy: row.completedBy || null,
    completedAt: row.completedAt || null,
  };
}

export const jsonStore = {
  /** 返回全部待办（按 PRD 排序：未完成在上、新的在上、完成的下沉） */
  async listAll() {
    await ensureLoaded();
    return [...cache].sort(compare).map(toExternal);
  },

  /** 按 id 查找（外部结构） */
  async findById(id) {
    await ensureLoaded();
    const row = cache.find((t) => t.id === id);
    return row ? toExternal(row) : null;
  },

  /** 新建 */
  async create({ text, userId }) {
    await ensureLoaded();
    const now = new Date().toISOString();
    const row = {
      id: genId(),
      text,
      completed: false,
      createdBy: userId,
      createdAt: now,
      completedBy: null,
      completedAt: null,
    };
    cache.push(row);
    await persist();
    return toExternal(row);
  },

  /**
   * 更新（目前只支持完成状态切换）
   * @param {string} id
   * @param {Object} patch
   * @param {boolean} [patch.completed]
   * @param {string} userId - 当前操作者（用于 completedBy）
   */
  async update(id, patch, userId) {
    await ensureLoaded();
    const row = cache.find((t) => t.id === id);
    if (!row) return null;

    if (patch.completed !== undefined) {
      row.completed = !!patch.completed;
      if (row.completed) {
        row.completedBy = userId;
        row.completedAt = new Date().toISOString();
      } else {
        row.completedBy = null;
        row.completedAt = null;
      }
    }
    await persist();
    return toExternal(row);
  },

  /** 删除，返回是否删除成功 */
  async remove(id) {
    await ensureLoaded();
    const idx = cache.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    cache.splice(idx, 1);
    await persist();
    return true;
  },
};

/**
 * PRD §4.2 Q2 排序：未完成在上、新的在上、完成的下沉
 * 同区间内按 createdAt 倒序
 */
function compare(a, b) {
  // 未完成优先
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  // 同区间：创建时间倒序（新的在上）
  return b.createdAt.localeCompare(a.createdAt);
}
