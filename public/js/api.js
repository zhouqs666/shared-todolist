/**
 * REST API 封装
 * 统一处理错误码、抛出可读异常
 */

export class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function request(path, options = {}) {
  let resp;
  try {
    resp = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    throw new ApiError('NETWORK', 0);
  }

  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    // 非 JSON 响应
  }

  if (!resp.ok || !data?.ok) {
    throw new ApiError(data?.error || 'UNKNOWN', resp.status);
  }
  return data;
}

export const api = {
  listTodos: () => request('/api/todos'),
  createTodo: (text) =>
    request('/api/todos', { method: 'POST', body: JSON.stringify({ text }) }),
  updateTodo: (id, completed) =>
    request(`/api/todos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed }),
    }),
  deleteTodo: (id) => request(`/api/todos/${id}`, { method: 'DELETE' }),
};
