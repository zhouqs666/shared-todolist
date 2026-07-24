/**
 * 待办路由：GET/POST/PATCH/DELETE /api/todos[/:id]
 *
 * PRD §8.1 接口设计
 * 所有接口都需要登录（requireAuthApi）
 */

import { Router } from 'express';
import { todoStore } from '../store/todoStore.js';
import { requireAuthApi, getCurrentUserId } from '../auth/middleware.js';
import { normalizeTodoText } from '../utils/validation.js';
import { bus, EVENTS } from '../sockets/eventBus.js';

const router = Router();

router.use(requireAuthApi);

/** GET /api/todos - 全部待办（已排序） */
router.get('/', async (_req, res, next) => {
  try {
    const todos = await todoStore.listAll();
    res.json({ ok: true, todos });
  } catch (err) {
    next(err);
  }
});

/** POST /api/todos - 新建 */
router.post('/', async (req, res, next) => {
  try {
    const result = normalizeTodoText(req.body?.text);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    const todo = await todoStore.create({
      text: result.text,
      userId: getCurrentUserId(req),
    });
    bus.emit(EVENTS.TODO_CREATED, todo, getCurrentUserId(req));
    res.status(201).json({ ok: true, todo });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/todos/:id - 更新（目前仅支持完成状态切换） */
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { completed } = req.body || {};
    if (typeof completed !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
    }
    const todo = await todoStore.update(id, { completed }, getCurrentUserId(req));
    if (!todo) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    bus.emit(EVENTS.TODO_UPDATED, todo, getCurrentUserId(req));
    res.json({ ok: true, todo });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/todos/:id - 删除 */
router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await todoStore.remove(req.params.id);
    if (!removed) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    bus.emit(EVENTS.TODO_DELETED, { id: req.params.id }, getCurrentUserId(req));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
