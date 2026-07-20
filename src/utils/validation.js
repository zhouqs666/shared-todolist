/**
 * 输入校验工具
 */

export const TODO_TEXT_MAX = 200;

/**
 * 校验并规整待办文本
 * @param {any} raw
 * @returns {{ok: true, text: string} | {ok: false, error: string}}
 */
export function normalizeTodoText(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'INVALID_INPUT' };
  }
  const text = raw.trim();
  if (!text) {
    return { ok: false, error: 'INVALID_INPUT' };
  }
  if (text.length > TODO_TEXT_MAX) {
    return { ok: false, error: 'TOO_LONG' };
  }
  return { ok: true, text };
}

/**
 * 转义 HTML 特殊字符，防 XSS
 * 用户输入会在 DOM 通过 textContent 渲染（天然安全），
 * 但此处再兜一层，便于任何场景使用
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
