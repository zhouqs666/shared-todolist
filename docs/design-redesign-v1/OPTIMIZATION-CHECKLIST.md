# 「有爱」App · 渐进式视觉优化清单

> **核心原则**：设计方向已确立（焦糖玫瑰 #c2410c + 米杏白 #faf6f1 + 三轨字体 + 仪式动效），
> 但**实施要稳** —— 保留所有功能不变，只做视觉层借鉴，逐项渐进上线。

---

## ⚖️ 三条铁律（务必遵守）

- ✅ **只改视觉层**（CSS / SVG 颜色 / 动画时长 / 字体引用），不改 JS 逻辑 / 数据流 / 功能
- ✅ **每次只发一个或一类改动**，便于测试与回滚
- ❌ **不重构**信息架构、不改 FAB 形态、不加花瓣菜单、不引入新品牌符号（保留现有桃心）

---

## 📊 优先级矩阵（按 ROI × 风险 × 工作量）

| 优先级 | 改动类型 | 风险 | 视觉冲击 | 工作量 | 推荐首发版本 |
|--------|---------|------|---------|--------|------------|
| **P0** | 色彩 token 升级 | 🟢 极低 | 🔥🔥🔥 | 30 分钟 | v2.7.48 |
| **P0** | 圆角统一升级 | 🟢 极低 | 🔥🔥 | 30 分钟 | v2.7.48 |
| **P0** | 阴影品牌色染色 | 🟢 极低 | 🔥🔥 | 30 分钟 | v2.7.48 |
| **P1** | 字体三轨引入 | 🟡 中 | 🔥🔥🔥 | 2 小时 | v2.7.49 |
| **P1** | 卡片纸质感 | 🟢 低 | 🔥🔥 | 1 小时 | v2.7.49 |
| **P1** | Button / Input 视觉升级 | 🟢 低 | 🔥🔥 | 1 小时 | v2.7.49 |
| **P2** | Checkbox 心形选中 | 🟡 中 | 🔥 | 2 小时 | v2.7.50 |
| **P2** | Toast 视觉升级 | 🟢 低 | 🔥 | 30 分钟 | v2.7.50 |
| **P2** | 顶栏毛玻璃增强 | 🟢 低 | 🔥 | 1 小时 | v2.7.50 |
| **P3** | 完成庆祝配色升级 | 🟢 低 | 🔥 | 1 小时 | v2.7.51 |
| **P3** | 隐藏款稀有度色升级 | 🟢 低 | 🔥🔥 | 1 小时 | v2.7.51 |
| **P3** | 纪念日时段配色微调 | 🟢 低 | 🔥 | 30 分钟 | v2.7.51 |

---

## ✅ 详细清单（按优先级排序）

### 🎯 P0 · 色彩 token 升级（v2.7.48 · 必须先做，影响全局）

> 这是 ROI 最高的改动 —— 一次升级，全 App 视觉刷新

- [ ] 主色 `--color-primary: #f43f5e → #c2410c`（rose-500 → 焦糖玫瑰）
- [ ] 主色 hover `--color-primary-dark: #e11d48 → #a8340a`（rose-600）
- [ ] 主色 RGB `--color-primary-rgb: 244, 63, 94 → 194, 65, 12`（用于 rgba() 阴影）
- [ ] 底色 `--color-bg: #fdf5f6 → #faf6f1`（米杏白）
- [ ] 文字色 `--color-text: #292524 → #2f2820`（stone-700 暖墨）
- [ ] 副文字色 `--color-text-muted: #78716c → #6b6051`（stone-500）
- [ ] 边框色 `--color-border: #efe3e5 → #e8dcc6`（cream-300 米杏）
- [ ] 主题背景渐变 `linear-gradient(180deg, #fff3f4 0%, #fdf8f8 42%, #fdf3f5 100%) → linear-gradient(180deg, #faf6f1 0%, #fdfbf7 42%, #faf6f1 100%)`
- [ ] 顶部柔光斑 `radial-gradient(..., rgba(253, 164, 175, 0.20), ...) → rgba(241, 196, 168, 0.20)`（warm light）

**文件**：`public/css/style.css`（仅改 `:root` 块，约 20 行）
**风险**：🔴 **检查所有 `rgba(244, 63, 94, *)` 硬编码阴影**（约 14 处），需同步改为 `rgba(194, 65, 12, *)`
**测试**：打开所有页面（主界面 / 登录 / 纪念日 / 心里话 / 图鉴）逐一截图；色彩对比度仍 ≥ AA
**回归**：`scripts/test_blindbox.py` + `scripts/test_trash.py` 双账号 E2E

---

### 🎯 P0 · 圆角统一升级（v2.7.48 · 与色彩同步）

- [ ] `--radius-sm: 10px → 8px`（小按钮 / 输入框更克制）
- [ ] `--radius-md: 14px → 12px`（卡片更纸质卷角感）
- [ ] `--radius-lg: 18px → 16px`（大卡片）
- [ ] `--radius-xl: 24px → 20px`（弹层更温和）
- [ ] `--radius: 18px → 16px`（兼容旧引用）

**文件**：`public/css/style.css`（仅改 `:root` 块 5 行）
**测试**：所有卡片 / 按钮 / 弹层圆角统一，整体更"信纸卷角"
**风险**：🟢 极低 —— 圆角小改视觉影响温和

---

### 🎯 P0 · 阴影品牌色染色（v2.7.48 · 必做，"温暖感"关键）

- [ ] `--shadow-xs: 0 1px 2px rgba(147, 51, 64, 0.04) → 0 1px 2px rgba(194, 65, 12, 0.04)`
- [ ] `--shadow: 0 1px 2px rgba(225, 29, 72, 0.04), 0 2px 8px rgba(225, 29, 72, 0.05) → rgba(194, 65, 12, 0.04/0.05)`
- [ ] `--shadow-md: rgba(225, 29, 72, 0.05/0.08) → rgba(194, 65, 12, 0.05/0.08)`
- [ ] `--shadow-lg: rgba(225, 29, 72, 0.08/0.12) → rgba(194, 65, 12, 0.08/0.12)`

**文件**：`public/css/style.css`（仅改 `:root` 块 4 行）
**测试**：所有浮层 / 卡片 / Toast 阴影带暖色调，不再是"冷灰"
**风险**：🟢 极低 —— 仅颜色变化，结构不变

---

### 🎯 P1 · 字体三轨引入（v2.7.49 · 视觉跃迁关键）

> 中文用霞鹜文楷（手写信气质）、英文用 Inter、数字用 Berkeley Mono（刻度感）

- [ ] 引入霞鹜文楷 web font（CDN：`https://chinese-fonts-cdn.deno.dev/packages/lxgwwenkai/dist/LXGWWenKai-Regular/result.css`）
- [ ] 引入 Berkeley Mono（CDN 或本地 woff2）
- [ ] CSS 新增变量：
  ```css
  --font-cn: "LXGW WenKai", "Source Han Serif SC", "Songti SC", serif;
  --font-mono: "Berkeley Mono", "JetBrains Mono", "SF Mono", monospace;
  ```
- [ ] 应用点（最小侵入）：
  - 纪念日面板「在一起 N 天」主数字 → `--font-mono`
  - 顶栏用户名 → `--font-cn`
  - 心里话写信输入框 → `--font-cn`
  - 时间戳显示（"2 分钟前"）→ `--font-mono`

**文件**：`public/index.html`（加 `<link>`）+ `public/css/style.css`（变量 + 选择器）
**风险**：🟡 **字体加载性能** —— 必须加 `font-display: swap`；霞鹜文楷子集化后 ~300KB
**测试**：弱网（Slow 3G）下首屏 LCP < 2.5s；纪念日数字用 Mono 看起来更"刻度"

---

### 🎯 P1 · 卡片纸质感（v2.7.49 · 配合字体升级）

> 卡片像"贴在桌面上的纸"，而不是悬浮的塑料片

- [ ] 待办卡片背景：`var(--color-surface)` (纯白) → `var(--color-bg-elevated)` (#fdfbf7 暖白)
- [ ] 卡片加 1px `var(--color-border-subtle)` 米杏色描边
- [ ] 默认阴影从无 → `--shadow-sm`
- [ ] hover 时阴影 `--shadow-md`（已有的话不动）

**文件**：`public/css/style.css`（`.todo` / `.anni-panel__card` / `.card` 等）
**测试**：滚动时卡片像"贴着桌面"而非"漂在玻璃上"

---

### 🎯 P1 · Button / Input 视觉升级（v2.7.49 · 配合字体升级）

- [ ] Button 内距：`padding: 12px 16px → padding: 14px 20px`（更宽松）
- [ ] Button 字重：`500 → 500`（保持），字号：`15px → 15px`（保持）
- [ ] Input 边框：`1px → 1.5px`（强调线条）
- [ ] Input focus：`1.5px rose-500 + 3px offset rose-200 光环`
- [ ] Input placeholder：`--color-text-muted → --color-text-subtle`（更柔和）

**文件**：`public/css/style.css`（`.btn` / `.field__input` / `.login__submit` 等）
**测试**：登录 / 添加面板 / 心里话输入体验

---

### 🎯 P2 · Checkbox 心形选中（v2.7.50 · 完成反馈仪式感）

> 勾选时方框变成心形，更"被珍视"

- [ ] 选中态：方框背景 `var(--color-primary)` + 中央 12px 单心 SVG（`fill: var(--cream-50)`）
- [ ] 过渡：`180ms ease-out`，选中时心形 scale 0 → 1 的 spring 弹出
- [ ] 未选中态保持方框 + 描边（功能不变）

**文件**：`public/css/style.css`（`.todo-check--checked`）+ 必要时微调 `app.js` 的渲染
**风险**：🟡 中 —— 涉及选中态视觉，但**不改 JS 状态逻辑**
**测试**：勾选 / 取消勾选动画流畅；350ms 长按守卫保留

---

### 🎯 P2 · Toast 视觉升级（v2.7.50 · 与卡片质感一致）

- [ ] 背景：`--color-text` 暖墨色 → 保持暖墨，加 `backdrop-filter: blur(8px)`
- [ ] 圆角：`12px`（已有），加 1px `rgba(255,255,255,0.08)` 内描边
- [ ] 阴影：`--shadow-lg` 暖色染色
- [ ] 入场：从屏幕底部升起 24px（已有），加 fade-in 280ms ease-out

**文件**：`public/css/style.css`（`.toast`）
**风险**：🟢 低 —— 仅视觉层
**测试**：成功 / 失败 / 警告 Toast 视觉统一

---

### 🎯 P2 · 顶栏毛玻璃增强（v2.7.50 · 漂浮感）

- [ ] `backdrop-filter: blur(20px) saturate(1.7) → blur(24px) saturate(1.85) brightness(1.02)`
- [ ] 边框：`1px solid rgba(244, 63, 94, 0.08) → 1px solid var(--color-border)`
- [ ] 背景透明度：`rgba(255, 255, 255, 0.72) → rgba(253, 251, 247, 0.72)`（cream-50 暖白）

**文件**：`public/css/style.css`（`.topbar`）
**测试**：滚动时顶栏像"漂浮的磨砂玻璃"

---

### 🎯 P3 · 完成庆祝配色升级（v2.7.51 · 锦上添花）

- [ ] 完成彩带配色 rose-500/rose-300 → legendary-500（金）渐变
- [ ] 隐藏款庆祝保留 rose-500/legendary-500 现有逻辑
- [ ] 震动节奏 `[30, 20, 30]` 保留
- [ ] 完成文案 Toast 用 `--font-cn` 字体（已有 serif fallback 即可）

**文件**：`public/js/confetti-effects.js`（配色常量）
**测试**：完成普通 / 隐藏款的视觉差异

---

### 🎯 P3 · 隐藏款稀有度色升级（v2.7.51 · 与设计令牌对齐）

> 把现有 rare/epic/legendary 颜色映射到新的彩蛋色

- [ ] rare 边框：`--rose-300 → --rare-300` (#f9c9d6 粉)
- [ ] epic 边框：`--violet-300 → --epic-300` (#cdb8e0 紫)
- [ ] legendary 边框：`--gold-300 → --legendary-500` (#c1932e 烫金)
- [ ] 背景从 `--rose-50` → 对应稀有度 50 档

**文件**：`public/css/style.css`（新增彩蛋色 token）+ `app.js` 渲染类名
**测试**：3 档稀有度视觉区分更清晰；完成隐藏款动画保留

---

### 🎯 P3 · 纪念日时段配色微调（v2.7.51 · 锦上添花）

> 顶栏爱心按时间变色（已有逻辑），色值升级

- [ ] 清晨暖橘 `#fb8a6b → #e89e76`（rose-300 更柔和）
- [ ] 白天品牌粉 `#fb7185 → #d9774b`（更焦糖）
- [ ] 深夜深玫红 `#9f1239 → #6a1f06`（更克制）
- [ ] 渐变停止色同步调整

**文件**：`public/index.html`（`<head>` 内联脚本）+ `public/js/anniversary.js`
**风险**：🟢 低 —— 仅色值变化
**测试**：24 小时色值循环（手动改系统时间验证）

---

## 🗓️ 渐进发布计划（4 个热更新版本）

| 版本 | 内容 | 累计工作量 | 风险 | 验证重点 |
|------|------|----------|------|----------|
| **v2.7.48** | P0 三项（色彩 + 圆角 + 阴影） | 1.5 小时 | 🟢 极低 | 全页截图对比；E2E 双账号核心流程 |
| **v2.7.49** | P1 三项（字体 + 卡片 + Button/Input） | 4 小时 | 🟡 中 | 弱网字体加载；纪念日数字视觉；登录/添加 E2E |
| **v2.7.50** | P2 三项（Checkbox 心形 + Toast + 顶栏） | 3.5 小时 | 🟡 中 | 勾选反馈；Toast 视觉；滚动体验 |
| **v2.7.51** | P3 三项（庆祝配色 + 稀有度色 + 纪念日时段） | 2.5 小时 | 🟢 低 | 完成动画；隐藏款视觉；时段配色 |

**总工作量**：约 11.5 小时（分 4 次热更新发版）

---

## 🚫 不做的事（用户明确要求"不改变功能"）

| 不做项 | 影响范围 | 替代方案 |
|--------|---------|---------|
| ❌ 不重构 FAB | 不加长按 400ms 展开花瓣菜单 | 保留现有 FAB 静态点击 |
| ❌ 不动信息架构 | 不改主界面布局 | 保留单列纵深 + 双主角镜像（在纪念日面板已实现） |
| ❌ 不引入新品牌符号 | 不引入"双心交错" | 保留现有单桃心形态，仅升级渐变色值 |
| ❌ 不改心里话写信页结构 | 不重构全屏写信体验 | 仅升级 Input 视觉（P1 已覆盖） |
| ❌ 不加里程碑时间线 | 不在纪念日加时间线元素 | 保留现有 3 个倒计时行 |
| ❌ 不引入暗色模式 | 不实现暗色 UI | 仅预留 token 命名（已在 design-tokens.md 记录） |

---

## 🔑 关键执行提醒（结合 AGENTS.md 铁律）

### 铁律一：绝不触碰生产数据
- 所有色彩调试用本地服务 `node scripts/serve.mjs` + 截图，**不上 Supabase 改数据**

### 铁律二：交付前必跑回归
- 每次发版前跑：`scripts/test_blindbox.py` + `scripts/test_trash.py` + `scripts/test_offline.py`
- 截图对比：升级前 / 升级后 / E2E 流程截图
- 字体加载：`npx lighthouse http://localhost:3000 --only-categories=performance` 看 LCP

### 铁律三：发布前 5 步自检
1. 查线上 `app_versions` 最新版本号（铁律三血泪教训）
2. 跑回归测试
3. 涉及 SQL → 对话里贴可复制完整 SQL（本清单不涉及 SQL，跳过）
4. 涉及 APK → `apksigner verify` + 检查构建时间（本清单只改 `public/`，**不需要打 APK**）
5. 交付回复列明"已做 X / 已验证 Y / 未验证 Z"

### 铁律四：代码改动同步文档
- 色彩 token 升级后 → 同步更新 `PRODUCT-SPEC.md` §5.13 主题描述（从"薄荷绿→玫瑰红"改为"玫瑰→焦糖玫瑰降饱和"）
- 字体三轨引入后 → 更新 §7.2 技术选型表格

### 铁律五：改完即提交
- 每次发版后自动 `git commit`（不强求 push）

---

## 📋 第一次发版推荐（v2.7.48 启动）

如果你今天就动手，建议从 **v2.7.48 的 P0 三项**开始（最高 ROI + 最低风险）：

1. **打开** `public/css/style.css` 的 `:root` 块
2. **替换** 上述 P0 色彩 / 圆角 / 阴影的 token 值（不到 20 行改动）
3. **本地验证**：`node scripts/serve.mjs` → 浏览器打开 `http://localhost:3000`
4. **截图对比**：升级前 vs 升级后（用 Playwright 脚本批量截图 7 个核心页面）
5. **E2E 验证**：跑 `scripts/test_blindbox.py`（双账号核心流程）
6. **发版**：`node scripts/release.mjs 2.7.48 --notes "色彩 + 圆角 + 阴影 token 升级，整体视觉焦糖玫瑰降饱和"`
7. **告知大哥**：杀掉 App 重开两次（首次后台下载，二次生效）

需要我把哪个版本的具体代码改动（含 diff 预览）写出来？比如 v2.7.48 的色彩 token 替换可以直接生成一段 Edit patch？