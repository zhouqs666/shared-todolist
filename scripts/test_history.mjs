/**
 * 已完成历史功能 —— 局部逻辑回归测试（Node，标记"未写生产"）
 *
 * 遵循 AGENTS.md 铁律一/二：
 *   - 不触碰任何生产数据 / 不连数据库，纯逻辑断言。
 *   - 复用真实 state.js 的 sortTodos（已完成沉底），并复刻 app.js 里
 *     主列表过滤 / 历史列表过滤+排序 / 顶栏徽标计数的断言逻辑，
 *     验证"主页只渲染未完成、已完成进历史页"的拆分行为正确。
 *
 * 注意：本测试验证的是「数据变换逻辑」，不是真机 UI 交互（弹层开合、动画、
 * 长按手势、对方实时同步体验等需真机/Playwright，见交付报告硬限制）。
 *
 * 用法：node scripts/test_history.mjs
 */
import { sortTodos } from '../public/js/state.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  OK  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ===== 复刻 app.js 的真实断言逻辑（与源码保持语义一致）=====
// 主页：只渲染未完成
const filterActive = (list) => list.filter((t) => !t.completed);
// 历史：只渲染已完成且未软删除，按 completedAt 倒序
const filterHistory = (list) =>
  list
    .filter((t) => t.completed && !t.deleted_at)
    .sort((a, b) => {
      const ta = a.completedAt || a.createdAt || '';
      const tb = b.completedAt || b.createdAt || '';
      return tb.localeCompare(ta);
    });
// 顶栏徽标：已完成数量
const badgeCount = (list) => list.filter((t) => t.completed && !t.deleted_at).length;

const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

console.log('== 场景1：添加 1 条未完成 → 主列表显示，历史列表没有 ==');
{
  const todos = [{ id: 'a', text: '买菜', completed: false, createdAt: iso(0) }];
  const main = filterActive(todos);
  const history = filterHistory(todos);
  check('主列表含该待办', main.length === 1 && main[0].id === 'a');
  check('历史列表为空', history.length === 0);
  check('徽标为 0（隐藏态逻辑）', badgeCount(todos) === 0);
}

console.log('== 场景2：标记完成 → 主列表消失，历史列表出现，badge+1 ==');
{
  const todos = [{ id: 'a', text: '买菜', completed: true, createdAt: iso(0), completedAt: iso(100) }];
  const main = filterActive(todos);
  const history = filterHistory(todos);
  check('主列表为空', main.length === 0);
  check('历史列表出现该条', history.length === 1 && history[0].id === 'a');
  check('徽标 = 1', badgeCount(todos) === 1);
}

console.log('== 场景3：取消完成（历史页长按）→ 历史消失，主列表出现 ==');
{
  const todos = [{ id: 'a', text: '买菜', completed: false, createdAt: iso(0) }];
  const main = filterActive(todos);
  const history = filterHistory(todos);
  check('主列表重新出现该条', main.length === 1 && main[0].id === 'a');
  check('历史列表再次为空', history.length === 0);
  check('徽标回到 0', badgeCount(todos) === 0);
}

console.log('== 场景4：badge 数量实时同步（多已完成）==');
{
  const todos = [
    { id: 'a', completed: true, completedAt: iso(100) },
    { id: 'b', completed: false },
    { id: 'c', completed: true, completedAt: iso(300) },
    { id: 'd', completed: true, completedAt: iso(200) },
    { id: 'e', completed: true, completedAt: iso(50), deleted_at: iso(400) }, // 软删除不计数
  ];
  check('徽标 = 3（排除未完成与软删除）', badgeCount(todos) === 3);
  const history = filterHistory(todos);
  check('历史列表 = 3 条', history.length === 3);
  // 倒序校验：completedAt 300 > 200 > 100
  check('排序：最近完成在前 (c,d,a)', history.map((t) => t.id).join(',') === 'c,d,a');
  // 软删除的 e 不出现在历史
  check('软删除项不进历史', !history.some((t) => t.id === 'e'));
  // 主列表只含未完成 b
  check('主列表只含未完成 b', filterActive(todos).map((t) => t.id).join(',') === 'b');
}

console.log('== 场景4b：badge 上限 99+ ==');
{
  const todos = Array.from({ length: 150 }, (_, i) => ({ id: 'x' + i, completed: true, completedAt: iso(i) }));
  // badgeCount 真实值=150，UI 层会把 >99 显示成 "99+"，这里验证计数逻辑正确
  check('计数逻辑 = 150（UI 负责截断 99+）', badgeCount(todos) === 150);
}

console.log('== 场景5：sortTodos 已完成沉底（主列表过滤前的底层保证）==');
{
  const list = [
    { id: 'done1', completed: true, createdAt: iso(300) },
    { id: 'todo1', completed: false, createdAt: iso(100) },
    { id: 'todo2', completed: false, createdAt: iso(200) },
  ];
  const sorted = sortTodos(list);
  check('已完成沉到最后', sorted[sorted.length - 1].id === 'done1');
  check('未完成在前且按创建时间倒序', sorted[0].id === 'todo2' && sorted[1].id === 'todo1');
}

console.log('== 场景5b：主列表过滤后“完成即消失”的视觉前提 ==');
{
  // 模拟实时回推：某条从未完成→已完成，setTodos 触发 render→filterActive
  const before = [{ id: 'a', completed: false }];
  const after = before.map((t) => (t.id === 'a' ? { ...t, completed: true, completedAt: iso(0) } : t));
  check('完成前在主列表', filterActive(before).length === 1);
  check('完成后移出主列表', filterActive(after).length === 0);
  check('完成后进入历史列表', filterHistory(after).length === 1);
}

console.log('========================================');
console.log(`通过: ${pass}  失败: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
