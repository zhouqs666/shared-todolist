/**
 * 图片 lightbox pinch 双指缩放手势测试（E2E）
 *
 * 用 Playwright + page.route mock Supabase，完全不碰生产数据。
 * 验证：
 *   1. 双指 pinch 拉开 → scale 增大
 *   2. pinch 捏合 → scale 回到 1
 *   3. pinch 结束后双击放大/还原仍工作（兼容性）
 *   4. 未放大时单击关闭 lightbox（兼容性）
 *
 * 用法： node scripts/test_pinch.mjs
 */

import { chromium } from 'playwright';

const SUPA_REF = 'zyceucmmtstszdnugimn';
const FAKE_UID = 'test-uid-0001';
const IMG_DATA_URL =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="200"><rect width="80" height="200" fill="#fda4af"/></svg>'
  ).toString('base64');

const mockTodo = {
  id: 'test-todo-1',
  text: 'E2E-测试-pinch',
  completed: false,
  created_by: FAKE_UID,
  created_at: '2026-09-01T00:00:00Z',
  completed_by: null,
  completed_at: null,
  nudge_by: null,
  image_path: IMG_DATA_URL,
  completed_note: null,
  deleted_at: null,
  rarity: 'common',
  rarity_seen: true,
};

// 在浏览器内构造有效格式 fake JWT（supabase-js 前端会解码 payload 读 exp/sub，不验签）
const injectSessionSrc = `
const b64url = (s) => btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(JSON.stringify({
  iss: 'https://${SUPA_REF}.supabase.co/auth/v1',
  sub: '${FAKE_UID}', aud: 'authenticated', exp: now + 3600, iat: now,
  role: 'authenticated', email: 'xiaobaobao@todo.local',
  session_id: 'fake-session-id', is_anonymous: false,
}));
const fakeJwt = header + '.' + payload + '.fakesig';
const sess = {
  access_token: fakeJwt, refresh_token: 'fake-refresh-token',
  expires_in: 3600, token_type: 'bearer', expires_at: now + 3600,
  user: { id: '${FAKE_UID}', aud: 'authenticated', role: 'authenticated',
    email: 'xiaobaobao@todo.local', created_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email' }, user_metadata: { username: 'xiaobaobao' } },
};
localStorage.setItem('sb-${SUPA_REF}-auth-token', JSON.stringify(sess));
`;

const json = (body) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 800 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message));

// 1. 在页面加载前注入 fake session（supabase-js persistSession 读 localStorage）
await page.addInitScript(injectSessionSrc);

// 2. 拦截 Supabase 请求，mock 全部数据
await page.route('**/auth/v1/user**', (r) =>
  r.fulfill(
    json({
      id: FAKE_UID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'xiaobaobao@todo.local',
      created_at: '2026-01-01T00:00:00Z',
      app_metadata: { provider: 'email' },
      user_metadata: { username: 'xiaobaobao' },
    })
  )
);
await page.route('**/rest/v1/profiles**', (r) =>
  r.fulfill(
    json([
      {
        id: FAKE_UID,
        username: 'xiaobaobao',
        display_name: '小宝宝',
        created_at: '2026-01-01T00:00:00Z',
      },
    ])
  )
);
await page.route('**/rest/v1/todos**', (r) => r.fulfill(json([mockTodo])));
await page.route('**/rest/v1/stickers**', (r) => r.fulfill(json([])));
await page.route('**/rest/v1/reactions**', (r) => r.fulfill(json([])));
await page.route('**/rest/v1/daily_notes**', (r) => r.fulfill(json([])));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500); // 等 init 异步流程

// 诊断
const diag = await page.evaluate(() => ({
  url: location.href,
  hasBadge: !!document.querySelector('.todo__image-badge'),
  todoCount: document.querySelectorAll('#todoList li').length,
  hasLightbox: !!document.querySelector('.img-lightbox'),
  bodyText: document.body.innerText.slice(0, 200),
}));
console.log('[诊断]', JSON.stringify(diag, null, 0));
console.log('[console errors so far]', errors.length ? errors : '(无)');

// 等带图 todo 的徽标出现并点击打开 lightbox
await page.waitForSelector('.todo__image-badge', { timeout: 10000 });
await page.click('.todo__image-badge');
await page.waitForSelector('.img-lightbox__img', { timeout: 3000 });
await page.waitForTimeout(300); // 等 img onload 移除 loading

const scaleOf = async () => {
  const t = await page.evaluate(() => {
    const img = document.querySelector('.img-lightbox__img');
    return img ? img.style.transform : '(none)';
  });
  const m = t.match(/scale\(([\d.]+)\)/);
  return m ? parseFloat(m[1]) : 1;
};

const dispatch = async (type, pointerId, x, y) => {
  await page.evaluate(
    ({ type, pointerId, x, y }) => {
      const el = document.querySelector('.img-lightbox');
      const ev = new PointerEvent(type, {
        pointerId,
        clientX: x,
        clientY: y,
        bubbles: true,
        isPrimary: pointerId === 1,
      });
      el.dispatchEvent(ev);
    },
    { type, pointerId, x, y }
  );
};

const assert = (cond, msg) => {
  if (!cond) throw new Error('❌ 断言失败: ' + msg);
};

// ===== 测试 1：双指 pinch 放大 =====
let s = await scaleOf();
console.log(`[初始] scale = ${s}`);
assert(Math.abs(s - 1) < 0.01, `初始 scale 应为 1，实际 ${s}`);

// 两指 down：起点距离 40
await dispatch('pointerdown', 1, 180, 400);
await dispatch('pointerdown', 2, 220, 400);
// 两指 move 拉开到距离 120（3 倍）
await dispatch('pointermove', 1, 140, 400);
await dispatch('pointermove', 2, 260, 400);
s = await scaleOf();
console.log(`[pinch 放大] scale = ${s}`);
assert(s > 2.5, `pinch 放大后 scale 应 > 2.5，实际 ${s}`);

// ===== 测试 2：pinch 捏合回到 1 =====
await dispatch('pointermove', 1, 198, 400);
await dispatch('pointermove', 2, 202, 400); // 距离 4
s = await scaleOf();
console.log(`[pinch 捏合] scale = ${s}`);
assert(s <= 1.01, `pinch 捏合后 scale 应 ≈1，实际 ${s}`);

// ===== 测试 3：pinch 结束后双击放大到 MAX_SCALE（兼容性） =====
await dispatch('pointerup', 1, 198, 400);
await dispatch('pointerup', 2, 202, 400);
// 双击（两次 down/up 间隔 50ms，坐标相同）
await dispatch('pointerdown', 1, 200, 400);
await dispatch('pointerup', 1, 200, 400);
await page.waitForTimeout(60);
await dispatch('pointerdown', 1, 200, 400);
await dispatch('pointerup', 1, 200, 400);
await page.waitForTimeout(320); // 等 zoomWithAnim 动画完成
s = await scaleOf();
console.log(`[双击放大] scale = ${s}`);
assert(Math.abs(s - 4) < 0.05, `双击应放大到 MAX_SCALE=4，实际 ${s}`);

// 双击还原
await dispatch('pointerdown', 1, 200, 400);
await dispatch('pointerup', 1, 200, 400);
await page.waitForTimeout(60);
await dispatch('pointerdown', 1, 200, 400);
await dispatch('pointerup', 1, 200, 400);
await page.waitForTimeout(320);
s = await scaleOf();
console.log(`[双击还原] scale = ${s}`);
assert(Math.abs(s - 1) < 0.05, `双击还原后 scale 应=1，实际 ${s}`);

// ===== 测试 4：未放大时单击关闭 lightbox（兼容性） =====
await dispatch('pointerdown', 1, 50, 50);
await dispatch('pointerup', 1, 50, 50);
await page.waitForTimeout(320); // 等 closeTimer 260ms + 关闭动画
const stillOpen = await page.evaluate(
  () => !!document.querySelector('.img-lightbox')
);
console.log(`[未放大单击关闭] lightbox 仍存在 = ${stillOpen}`);
assert(!stillOpen, '未放大时单击应关闭 lightbox');

console.log('\nconsole errors:', errors.length ? errors : '(无)');
await browser.close();
console.log('\n✅ 全部测试通过');
