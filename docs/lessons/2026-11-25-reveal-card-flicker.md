# 2026-11-25：复看卡在真机上一直闪 —— 三个「本该不生效」的缺陷叠成合成器超预算

**关联规则**：AGENTS.md 铁律二（交付前必须全面测试，硬限制要列明）/ 铁律六（维度 E 性能、维度 F 测试）
**影响**：Android 真机（OPPO / ColorOS）打开图鉴复看卡后，卡片持续闪屏；epic/legendary 的金箔流光与全部粒子特效在生产环境从未显示过。Web / 桌面不受影响。

## 事故

业主在真机上点「头像左侧的图鉴入口 → 怦然心动 → 任意一张已开启的贴纸」，复看卡弹出后
**卡片本身一直在闪**（不是整屏黑场）。业主提供了 20 秒录屏。

从录屏里逐帧取像素（Chrome `requestVideoFrameCallback` 按呈现帧解码）复现并抓到了现场：

| 时刻 | 卡片区域亮区 | 画面 |
|---|---|---|
| 11.33s | 完整 | 正常 |
| **11.37s** | **下半截塌掉（亮区从 962px 缩到 594px）** | **残缺瓦片：文字重影、左侧彩色扫描条纹** |
| 11.40s | 完整 | 正常（30ms 后自愈） |
| **17.20s** | 同上 | **下半截整块变成紫色平板，文字与纸纹全部丢失** |
| 17.23s | 完整 | 正常 |

坏帧里**缺失的恰好是文字（网络字形）与纸纹，留下的正是纯 CSS/SVG 部分** —— 这是
**Android GPU 合成器输出不完整 Tile** 的典型形状，不是业务逻辑问题。

## 根因（三条独立缺陷叠成一条链）

### ① 画布在遮罩 `display:none` 时测量 ⇒ 退化成 1×1 像素

`reveal-card.js` 的 `runPlay()` 原本是：

```js
fillCard(spec);            // 这里把 overlay 置为 class="hidden" → display:none !important
fdpr = sizeCanvas(ui.fx);  // ← 此刻量尺寸：getBoundingClientRect() 全是 0
sizeHolo();
...
ui.overlay.classList.remove('hidden');   // ← 遮罩在这之后才可见
```

`sizeCanvas()` 里 `c.width = Math.max(1, r.width * dpr)` ⇒ **1×1**。
后果：`#rvHolo`（WebGL 全息层）变成「1 个着色器像素拉满整张卡」，`mix-blend-mode:screen`
把它叠成一层均匀色纱 —— **epic/legendary 的金箔流光从未真正渲染过**。

`#rvFx`（粒子层）更彻底：canvas 是**替换元素**，绝对定位 + `inset:0` 并不会拉伸它
（替换元素 `width:auto` 取内在尺寸，`left/right` 同时为 0 时按 CSS 2.1 §10.3.8 忽略 `right`）
⇒ 它的 CSS 尺寸永远是 1×1，**粒子 / 星芒 / 渗出 / 爆发在生产环境一次都没显示过**。

### ② 陀螺仪噪声 ⇒ 3D 子树每帧强制重栅格化 47 次/秒

`applyTilt()` 每帧无条件写两处 style：

```js
ui.tiltWrap.style.transform = `rotateX(...) rotateY(...)`;
ui.card3d.style.setProperty('--gx', `${50 + curTilt.x * 30}%`);
```

- `--gx` **从不生效**：`.f-body::after` 的 `background-position: var(--gx) 0` 被
  `rv-cardSheen` 动画整个覆盖（CSS 动画优先级高于普通声明）。实测把 `--gx` 改成 5% 后
  计算值仍是 `-60% 0px` —— 每帧让整棵卡片子树样式失效一次，换来零效果。
- `transform` 每帧都变 ⇒ 整棵 3D 卡片子树（`transform-style:preserve-3d` +
  `mix-blend-mode` 层 + 渐变文字 + SVG 滤镜）被强制**重新栅格化**。真机有陀螺仪，
  传感器噪声让 `curTilt` 每帧都动。

**受控实验（桌面注入 60Hz 噪声模拟真机）**：

| 场景 | `#rvTiltWrap` / `#rvCard3d` 的 style 变更 |
|---|---|
| 桌面（无陀螺仪） | **0 次 / 3 秒** |
| 注入 60Hz 传感器噪声 | **142 次 / 3 秒 ≈ 47 次/秒** |

这解释了「为什么我本地怎么测都复现不出来」：**桌面根本没有陀螺仪事件**。

### ③ 每帧重绘全息层 / 粒子层（未降频）

全息层每帧一次纹理上传、粒子层每帧一次全屏 clear，叠加在②之上把合成器预算打爆。

### 为什么「最近才出现」

版本时间线（只读查 `app_versions`）：

| 版本 | 发布 | 内容 |
|---|---|---|
| 3.5.0 | 10-05 | 开出卡片上线 |
| 3.6.0 | 10-06 | **图鉴复看入口上线**（闪屏的载体） |
| 3.7.0 | **10-14** | **霞鹜文楷 web font 落地 —— 全 App 正文换上网络字体** |
| 3.7.3 | 10-29 | 当前线上版本 |

把 3.6.0 之后每一个碰过「卡片渲染路径」的提交逐个 diff 过：**真正改变卡片文字渲染的只有
`81c4080`（即 3.7.0 的 web font）**。它把 `.f-name`（`background-clip:text` +
`color:transparent` 的渐变文字）、`.f-flavor`、`.f-meta` 从系统字体换成 1.6MB 网络字体 ——
Android WebView 上网络字形要按需栅格化进字形图集并上传纹理；系统字体则在系统缓存里，
重绘不涉及上传。**于是「每帧重栅格」从「贵但完整」变成「贵且可能撕裂」**，坏帧里缺失的
正是网络字形。

该提交自己写着：**「未验证：Android WebView 真机渲染（需发布后设备侧冒烟确认）」** ——
它是那批改动里唯一没在真机上验过的。

无法从仓库排除的外部变量：手机 **System WebView / ColorOS 更新**会改变 GPU 合成行为
（Android 上「突然出现」的经典诱因）；以及业主何时升到 3.7.x。

## 为什么既有测试体系没拦住（两个盲区叠加）

1. **E2E 默认走降级通道**：`e2e_common.login()` 统一写 `__e2e_fx_off=1` ⇒
   `toIdle(true)` + `no-anim` ⇒ **没有淡入、没有逐帧重绘、关闭时立即隐藏**，
   闪屏的三个条件一个都不成立。全量跑批永远看不到。
2. **断言只看 DOM 文字，不看画面**：`reveal_card_snapshot()` 读的是 `textContent` 与
   `getComputedStyle` 的 opacity —— 画布尺寸、纹理上传、Tile 完整性**全都在断言之外**。

## 修复与防回归

- **画布尺寸**：`runPlay()` 里把 `sizeCanvas(ui.fx)` / `sizeHolo()` 移到
  `ui.overlay.classList.remove('hidden')` **之后**（`getBoundingClientRect()` 会强制同步
  布局，遮罩可见后量到的就是真实尺寸）；`#rvFx` 补 `width:100%; height:100%`。
  实测：`#rvHolo` 1×1 → **554×775**（= 卡片尺寸 × dpr），`#rvFx` 1×1 → **780×1688**（= 视口 × dpr）。
- **掐断强制重栅格**：删掉从不生效的 `--gx` 写入；`transform` 仅在倾斜变化 > 0.02
  （约 0.22°，高于传感器噪声量级）时才写。
  实测：注入 60Hz 噪声下 style 变更 **142 次/3 秒 → 0 次/3 秒**。
- **降频**：idle 态重绘降到 ~30fps（`DRAW_INTERVAL_MS`），粒子物理按真实时间累积 dt，
  不会变慢。
- **防回归断言**（`scripts/test_blindbox.py` 7.1d / 7.5a）：epic 卡的 `#rvHolo` backing store
  必须覆盖卡片尺寸；`#rvFx` CSS 尺寸必须覆盖全屏；注入 60Hz 陀螺仪噪声 3 秒内
  `#rvTiltWrap`/`#rvCard3d` 的 style 变更 **≤ 5 次**。任一条退回旧实现即红。

## 教训

1. **`display:none` 时量尺寸 = 量到 0**。任何「先量尺寸再显示」或「先显示再量尺寸」的顺序
   都要写进代码注释 —— 这个 bug 潜伏了 7 周（3.5.0 上线 → 3.7.4 修复）。
2. **替换元素不会被 `inset:0` 拉伸**。canvas / video / img 这类元素要显式写
   `width/height:100%`，否则永远是内在尺寸。
3. **每帧写 style 是要付栅格化代价的**，哪怕写的是一个「反正会被动画覆盖」的变量。
   传感器噪声级别的抖动不配触发重栅格化。
4. **降级通道会遮蔽一整类缺陷**。`__e2e_fx_off=1` 让 E2E 跑得又快又稳，代价是
   「特效路径」上的缺陷零覆盖 —— 需要断言这些路径时，**在用例里显式打开特效**。
5. **网络字体 + `background-clip:text` + 3D 变换 + 混合模式** 这四件套叠在一起，
   在 Android 上是渲染事故的高发组合；上线前没有真机验证，等于把雷留给用户。
