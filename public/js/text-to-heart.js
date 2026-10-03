/**
 * 文字化心飞向桃心 —— 珍藏仪式 v3（2026-10 光效重做）
 *
 * v2 的实测缺陷（2026-10-03 逐帧审查 + 量化）：
 *   粒子是「尘屑」不是「光」（心形区仅 0.41% 像素亮于背景 +25 灰阶）、
 *   暗场发灰脏（奶白底 + 半透明深蓝 = 饱和度 8.6% 的灰紫泥）、
 *   第一收点被弹窗淡出吞掉（吸收完 60ms 弹窗就开始关）、
 *   弹窗一关亮白主界面露出，光种在亮底上近乎隐形（调性断裂）。
 *
 * v3 对策：
 *   1. 发光质感：粒子走 'lighter' 加色合成 + 光晕/热核双层 sprite + 尺寸亮度梯度
 *      （16% 亮核 5-7px + 大量细尘）+ 飞行拖尾 —— 治「尘屑」而不是单纯调亮
 *      （v1 过曝的教训：亮度靠层次不靠堆 alpha）
 *   2. 暗场：深梅紫高透明配方（任何时段底都落到同一档深梅），心形后加聚焦光晕
 *   3. 逐字抽丝：粒子出生先沿字面法线上升外扩（lift），再汇聚入心（travel），
 *      文字左→右熄灭与粒子出生仍同步
 *   4. 编排：吸收完成后留 560ms 给印章「咚-咚」（弹窗仍可见）→ 弹窗淡出时
 *      舞台层（.cherish-stage，fixed 深梅紫）同步淡入接住暗场 → 光种在暗场里
 *      二段飞行 → 顶栏接收（第二收点，全程可见）→ 舞台再淡出回主界面
 *
 * 阶段（1×，ms，自仪式开始计）：
 *   0      仪式开始（长按充能完成后由 messages 触发）：暗场渐入 / 元素让位 / 文字透亮
 *   500    逐字溶解（左→右扫过 480ms）：字符熄灭 = 粒子出生（抽丝上升）
 *   ~2380  心成形：聚焦光晕渐入 + 心跳两下（双圈波带）
 *   3140   心被 stageEl 吸收（430ms，第一收点在 3570 触发）
 *   3570   印章桃心「咚-咚」接收 + 光爆（弹窗仍可见 —— v2 只留 60ms 就被淡出吞掉）
 *   4130   舞台层（.cherish-stage）先落位淡入 + 顶栏提升到舞台之上
 *   4350   弹窗淡出（onModalFade；舞台已落位 ⇒ 无交叉闪白）
 *   4430   光种二段飞行（520ms，大光晕 + 连续拖尾）飞向 heartEl（第二收点）
 *   4950   onArrive（顶栏接收跳动）+ 波带 + 迷你心飘散
 *   5350   舞台层淡出回主界面；5370 done（焚毁收尾由 messages 执行）
 *
 * @module text-to-heart
 */

/* ===== 小工具 ===== */

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** 预渲染柔光 sprite：多段色标径向渐变（中心热核 → 边缘透明） */
function makeSprite(stops, S = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [pos, color] of stops) grad.addColorStop(pos, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}

/* ===== 文字像素采样（粒子出生点与 DOM 文字重合） ===== */

function sampleText(text, font, lineHeight, maxW) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    if (g.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; }
    else line += ch;
  }
  if (line) lines.push(line);
  const w = Math.ceil(maxW) + 4;
  const h = Math.ceil(lines.length * lineHeight) + 8;
  c.width = w;
  c.height = h;
  g.font = font;
  g.fillStyle = '#000';
  g.textBaseline = 'top';
  lines.forEach((ln, i) => g.fillText(ln, 0, i * lineHeight));
  const img = g.getImageData(0, 0, w, h).data;
  const pts = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (img[(y * w + x) * 4 + 3] > 110) pts.push([x, y]);
    }
  }
  return pts;
}

/* ===== 心形目标点：单层轮廓 + 边缘偏置填充 ===== */

function heartXY(t) {
  return [
    16 * Math.pow(Math.sin(t), 3),
    -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
  ];
}

/** 均匀弧长采样单层轮廓（剪影清晰的关键） */
function uniformHeartRing(count) {
  const N = 2000;
  const cum = [];
  let prev = heartXY(0);
  let total = 0;
  for (let i = 1; i <= N; i++) {
    const p = heartXY((i / N) * Math.PI * 2);
    total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    cum.push(total);
    prev = p;
  }
  const pts = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / count;
    while (cum[j] < target) j++;
    pts.push(heartXY((j / N) * Math.PI * 2));
  }
  return pts;
}

function generateHeartTargets(count, scale) {
  const ringN = Math.floor(count * 0.55);
  const ring = uniformHeartRing(ringN);
  const pts = ring.map(([x, y]) => [x * scale, y * scale]);
  const innerN = count - ringN;
  for (let k = 0; k < innerN; k++) {
    const [rx, ry] = ring[Math.floor(Math.random() * ringN)];
    const u = Math.pow(Math.random(), 0.65) * 0.72; // 边缘偏置：靠外概率更高
    pts.push([rx * scale * (1 - u), ry * scale * (1 - u)]);
  }
  return pts.slice(0, count);
}

/* ===== 主入口 ===== */

/**
 * 文字化心飞向桃心（珍藏仪式 v3）。
 * @param {Object} opts
 * @param {HTMLElement} opts.textEl 留言文字容器（含 .note-read__char 字符 span）
 * @param {HTMLElement} opts.stageEl 阅读卡印章桃心（第一收点）
 * @param {HTMLElement} opts.heartEl 顶栏桃心（第二收点）
 * @param {Function} [opts.onStageArrive] 心被印章桃心吸收时回调
 * @param {Function} [opts.onModalFade] 该关弹窗了（舞台层已就位接住暗场）
 * @param {Function} [opts.onArrive] 光种到达顶栏时回调（触发桃心接收跳动）
 * @param {Function} opts.done 全部结束回调
 */
export function textToHeart({ textEl, stageEl, heartEl, onStageArrive, onModalFade, onArrive, done }) {
  const finish = () => { if (done) done(); };

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !textEl) {
    if (onStageArrive) onStageArrive();
    if (onArrive) onArrive();
    finish();
    return;
  }

  const text = (textEl.textContent || '').trim();
  if (!text) {
    if (onStageArrive) onStageArrive();
    if (onArrive) onArrive();
    finish();
    return;
  }

  /* --- 几何：文字块 / 舞台桃心 / 顶栏桃心（均转视口坐标，canvas 是 fixed 全屏） --- */
  const rect = textEl.getBoundingClientRect();
  const cs = getComputedStyle(textEl);
  const fontSize = parseFloat(cs.fontSize) || 18;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.8;

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  let stageX = cx;
  let stageY = Math.max(60, rect.top - 90);
  if (stageEl) {
    const sr = stageEl.getBoundingClientRect();
    stageX = sr.left + sr.width / 2;
    stageY = sr.top + sr.height / 2;
  }
  let endX = cx;
  let endY = 30;
  if (heartEl) {
    const hr = heartEl.getBoundingClientRect();
    endX = hr.left + hr.width / 2;
    endY = hr.top + hr.height / 2;
  }

  /* --- 字符 span（messages 已拆好；兜底自拆） --- */
  let chars = Array.from(textEl.querySelectorAll('.note-read__char'));
  if (!chars.length) {
    textEl.textContent = '';
    for (const ch of text) {
      const s = document.createElement('span');
      s.className = 'note-read__char';
      s.textContent = ch;
      textEl.appendChild(s);
    }
    chars = Array.from(textEl.querySelectorAll('.note-read__char'));
  }
  // 每字的 x 中心（用于左→右扫描熄灭）
  const charDelay = chars.map((c) => {
    const r = c.getBoundingClientRect();
    return (((r.left + r.width / 2) - rect.left) / Math.max(1, rect.width)) * 480;
  });

  /* --- 采样文字 → 粒子起点（2px 步长细尘） --- */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxW = Math.max(60, rect.width - 40);
  const sampled = sampleText(text, `${fontSize}px ${cs.fontFamily}`, lineHeight, maxW);
  if (!sampled.length) {
    if (onStageArrive) onStageArrive();
    if (onArrive) onArrive();
    finish();
    return;
  }

  const offX = rect.left + 20;
  const offY = rect.top + (lineHeight - fontSize) / 2 + 2;

  /* --- 心形目标 --- */
  const heartW = Math.max(96, Math.min(150, rect.width * 0.52));
  const hs = heartW / 32;
  const heartCx = cx;
  const heartCy = cy - 40;
  // 波带/光晕的视觉中心：心形质量偏上（心尖朝下），比包围盒中心高一档
  const focusX = heartCx;
  const focusY = heartCy - heartW * 0.08;
  const count = Math.min(1350, Math.max(850, sampled.length));
  const targets = generateHeartTargets(count, hs);

  /* --- 粒子：细尘 84% / 亮核 16%（亮核里 30% 白高光）；'lighter' 加色出层次 --- */
  const P = [];
  const stride = sampled.length / count;
  for (let i = 0; i < count; i++) {
    const sp = sampled[Math.floor(i * stride)];
    const tp = targets[i];
    const spark = Math.random() < 0.16;
    const srcX = sp[0] / maxW; // 字面横向位置：出生延迟 + 抽丝扇形方向
    P.push({
      x0: offX + sp[0],
      y0: offY + sp[1],
      tx: heartCx + tp[0],
      ty: heartCy + tp[1],
      // 出生延迟 = 按 x 位置左→右扫过（与 DOM 字符熄灭同步）
      delay: clamp01(srcX) * 480 + Math.random() * 90,
      dur: 950 + Math.random() * 350,
      rise: 24 + Math.random() * 20,
      drift: (srcX - 0.5) * 22 + (Math.random() - 0.5) * 10,
      size: spark ? 1.2 + Math.random() * 0.6 : 0.6 + Math.random() * 0.45,
      alpha: spark ? 0.42 + Math.random() * 0.18 : 0.15 + Math.random() * 0.11,
      spark,
      white: spark && Math.random() < 0.3,
      phase: Math.random() * Math.PI * 2,
      flow: 5 + Math.random() * 6,
      px: 0,
      py: 0,
      px2: 0,
      py2: 0,
      hasPrev: false,
    });
  }

  /* --- 时间轴（ms，从仪式开始计） --- */
  const T_ERODE = 500;
  const T_ARRIVE = T_ERODE + 480 + 1400;
  const T_BEAT = T_ARRIVE + 80;
  const BEAT = 620;
  const T_ABSORB = T_BEAT + BEAT + 60;
  const ABSORB = 430;
  // 吸收完成后留 560ms 让印章「咚-咚」播完大半再动弹窗（v2 只留 60ms，收点被吞）
  const T_MODALFADE = T_ABSORB + ABSORB + 560;
  // 舞台先落位（0.25s）再放弹窗淡出：顺序反了亮白主界面会透出来「闪白」
  const T_MODALHIDE = T_MODALFADE + 220;
  const T_SEEDFLY = T_MODALFADE + 300;
  const SEEDFLY = 520;
  const T_STAGEOUT = T_SEEDFLY + SEEDFLY + 400;
  const TOTAL = T_STAGEOUT + 20;

  /* --- 全屏 canvas（fixed，挂 body：跨弹窗生命周期） --- */
  const W = window.innerWidth;
  const H = window.innerHeight;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;inset:0;width:${W}px;height:${H}px;pointer-events:none;z-index:300;`;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  /* --- 舞台层：暗场跨弹窗延续（弹窗淡出时淡入接住，光种在深梅紫里飞行） --- */
  const stageLayer = document.createElement('div');
  stageLayer.className = 'cherish-stage';
  document.body.appendChild(stageLayer);
  let stageRemoveTimer = null;
  let stageEnded = false;
  function endStage() {
    if (stageEnded) return;
    stageEnded = true;
    stageLayer.style.opacity = '0';
    document.body.classList.remove('cherish-stage-on');
    stageRemoveTimer = setTimeout(() => stageLayer.remove(), 750);
  }

  /* --- 光效 sprite（'lighter' 加色：光晕层 + 热核层 + 聚焦光晕） --- */
  const spriteCore = makeSprite([
    [0, 'rgba(255,255,255,0.98)'],
    [0.16, 'rgba(255,226,240,0.8)'],
    [0.42, 'rgba(246,140,182,0.32)'],
    [1, 'rgba(244,114,160,0)'],
  ]);
  const spriteHalo = makeSprite([
    [0, 'rgba(255,214,232,0.5)'],
    [0.32, 'rgba(244,114,160,0.24)'],
    [1, 'rgba(244,114,160,0)'],
  ]);
  const spriteGlow = makeSprite([
    [0, 'rgba(255,196,222,0.55)'],
    [0.35, 'rgba(242,100,152,0.22)'],
    [1, 'rgba(242,100,152,0)'],
  ]);

  const sparkles = [];
  const seedPath = [];
  const ripples = [];
  let rippleFired = [false, false];
  let stageFired = false;
  let burst = null;
  let fadeFired = false;
  let modalHideFired = false;
  let seedFired = false;
  let arriveFired = false;
  let aborted = false;

  const bez = (p0, p1, p2, t) => {
    const u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
  };
  // 吸收弧线控制点（向上拱）
  const absCx = (heartCx + stageX) / 2;
  const absCy = Math.min(heartCy, stageY) - 46;
  // 光种二段飞行控制点
  const cpX = (stageX + endX) / 2 + 26;
  const cpY = Math.min(stageY, endY) - 60;

  /* --- DOM 状态机 --- */
  textEl.classList.add('note-read__content--erode'); // 透亮（CSS 两段式：先亮后散）
  if (textEl.parentElement) textEl.parentElement.classList.add('note-read--ceremony');

  const start = performance.now();

  function frame(now) {
    if (aborted) return;
    try {
      frameInner(now);
    } catch (err) {
      // 渲染异常也必须走完收尾：done 不达会让 ceremonyRunning 卡死（弹窗永久不可关）+ 留言不焚毁
      console.error('[text-to-heart] 仪式渲染异常，强制收尾:', err);
      cleanup();
      endStage();
      if (!arriveFired) { arriveFired = true; if (onArrive) onArrive(); }
      finish();
    }
  }

  function frameInner(now) {
    const t = now - start;

    if (t >= TOTAL) {
      cleanup();
      endStage();
      if (!arriveFired) { arriveFired = true; if (onArrive) onArrive(); }
      finish();
      return;
    }

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter'; // 加色合成：粒子重叠自然出光（治「尘屑」的关键）

    /* 逐字熄灭（左→右，与粒子出生同步） */
    if (t >= T_ERODE) {
      const e = t - T_ERODE;
      for (let i = 0; i < chars.length; i++) {
        if (e >= charDelay[i] && chars[i].style.opacity !== '0') chars[i].style.opacity = '0';
      }
    }

    /* 心跳（成形后两下） */
    let beatS = 1;
    if (t >= T_BEAT && t < T_ABSORB) {
      const bt = clamp01((t - T_BEAT) / BEAT);
      beatS = bt < 0.16 ? 1 + easeOutCubic(bt / 0.16) * 0.11
        : bt < 0.34 ? 1.11 - easeInOutCubic((bt - 0.16) / 0.18) * 0.11
        : bt < 0.5 ? 1 + easeOutCubic((bt - 0.34) / 0.16) * 0.055
        : bt < 0.68 ? 1.055 - easeInOutCubic((bt - 0.5) / 0.18) * 0.055 : 1;
      if (!rippleFired[0] && bt >= 0.14) {
        rippleFired[0] = true;
        ripples.push({ t0: t, x: focusX, y: focusY, r0: 14, r1: 58 });
      }
      if (!rippleFired[1] && bt >= 0.48) {
        rippleFired[1] = true;
        ripples.push({ t0: t, x: focusX, y: focusY, r0: 12, r1: 50 });
      }
    }

    /* 吸收阶段：心整体飞向舞台桃心 */
    const absorbT = clamp01((t - T_ABSORB) / ABSORB);
    const absE = easeInOutCubic(absorbT);
    const gx = absorbT > 0 ? bez(heartCx, absCx, stageX, absE) : heartCx;
    const gy = absorbT > 0 ? bez(heartCy, absCy, stageY, absE) : heartCy;
    const gScale = absorbT > 0 ? 1 - 0.8 * easeOutCubic(absorbT) : 1;

    if (absorbT >= 1 && !stageFired) {
      stageFired = true;
      burst = { t0: t, x: stageX, y: stageY, r0: heartW * 0.5, r1: heartW * 1.65, life: 620, a0: 0.5 };
      if (onStageArrive) onStageArrive();
    }

    /* 聚焦光晕：粒子汇聚期渐入、随心跳呼吸（暗场里的舞台追光）。
       吸收时跟着心走、吸收完即归零 —— 残留的静态光会读成「死区/没收干净」 */
    const glowIn = clamp01((t - (T_ERODE + 800)) / 1500);
    const glowFade = 1 - absorbT;
    const glowA = glowIn * glowFade * (0.15 + Math.max(0, beatS - 1) * 1.7);
    if (glowA > 0.004) {
      const gs = heartW * 2.6 * (absorbT > 0 ? 1 - 0.55 * easeOutCubic(absorbT) : 1);
      ctx.globalAlpha = glowA;
      ctx.drawImage(spriteGlow, gx - gs / 2, gy - gs / 2, gs, gs);
    }

    /* 接收光爆：印章「咚-咚」与顶栏接收各一圈扩散光（收点要「被接住」的实感） */
    if (burst) {
      const bp = clamp01((t - burst.t0) / burst.life);
      if (bp >= 1) burst = null;
      else {
        const br = burst.r0 + (burst.r1 - burst.r0) * easeOutCubic(bp);
        ctx.globalAlpha = burst.a0 * Math.pow(1 - bp, 1.6);
        ctx.drawImage(spriteGlow, burst.x - br, burst.y - br, br * 2, br * 2);
      }
    }

    /* 粒子（光晕层 + 亮核层 + 飞行拖尾） */
    for (const p of P) {
      const born = T_ERODE + p.delay;
      if (t < born) continue;
      const e = clamp01((t - born) / p.dur);
      let px;
      let py;
      if (absorbT === 0) {
        // 两段运动：先「抽丝」上升外扩（lift，占满前 38%），再汇聚入心（travel）
        const lift = easeOutCubic(clamp01(e / 0.38));
        const travel = easeInOutCubic(clamp01((e - 0.28) / 0.72));
        const sx = p.x0 + p.drift * lift;
        const sy = p.y0 - p.rise * lift;
        px = sx + (p.tx - sx) * travel;
        py = sy + (p.ty - sy) * travel;
        // 湍流只作用于旅途后段（抽丝段要竖向干净，湍流会把它抹成横向闪粉带）
        const env = Math.sin(Math.PI * clamp01((e - 0.32) / 0.62));
        const ang = Math.sin(px * 0.02 + t * 0.002 + p.phase) + Math.cos(py * 0.017 - t * 0.0016);
        px += Math.cos(ang) * p.flow * env;
        py += Math.sin(ang) * p.flow * env - 4 * env;
        if (e >= 1) {
          px += Math.sin(t * 0.003 + p.phase) * 0.7;
          py += Math.cos(t * 0.0026 + p.phase) * 0.7;
        }
        px = heartCx + (px - heartCx) * beatS;
        py = heartCy + (py - heartCy) * beatS;
      } else {
        px = gx + (p.tx - heartCx) * gScale;
        py = gy + (p.ty - heartCy) * gScale;
      }
      let a = p.alpha * clamp01((t - born) / 160);
      // 吸收阶段快速衰减到 0：残粒停在印章位会读成「没收干净的桃心」（2026-10-03 实测）
      if (absorbT > 0) a *= Math.pow(1 - absorbT, 1.5);
      const d = p.size * 4.4 * (absorbT > 0 ? 1 - absorbT * 0.6 : 1);

      if (a > 0.004) {
        // 三帧拖尾沿运动方向拉伸：竖向运动拉成竖丝（「抽丝」），横向才拉成横带
        if (p.hasPrev && e < 1) {
          const dx = px - p.px2;
          const dy = py - p.py2;
          const vertical = Math.abs(dy) >= Math.abs(dx);
          const tw1 = vertical ? d * 1.15 : d * 2.1;
          const th1 = vertical ? d * 2.5 : d * 1.15;
          const tw2 = vertical ? d * 0.9 : d * 1.6;
          const th2 = vertical ? d * 2.0 : d * 0.9;
          ctx.globalAlpha = a * 0.42;
          ctx.drawImage(spriteHalo, p.px - tw1 / 2, p.py - th1 / 2, tw1, th1);
          ctx.globalAlpha = a * 0.2;
          ctx.drawImage(spriteHalo, p.px2 - tw2 / 2, p.py2 - th2 / 2, tw2, th2);
        }
        // 光晕层
        ctx.globalAlpha = a;
        ctx.drawImage(spriteHalo, px - d * 1.35, py - d * 1.35, d * 2.7, d * 2.7);
        // 亮核层（细尘没有热核，亮核才有 —— 尺寸/亮度梯度 = 「光」的来源）
        if (p.spark) {
          ctx.globalAlpha = Math.min(1, a * 1.25);
          ctx.drawImage(p.white ? spriteCore : spriteHalo, px - d * 0.5, py - d * 0.5, d, d);
          if (p.white) {
            ctx.globalAlpha = Math.min(1, a * 1.4);
            ctx.drawImage(spriteCore, px - d * 0.28, py - d * 0.28, d * 0.56, d * 0.56);
          }
        }
      }
      p.px2 = p.px;
      p.py2 = p.py;
      p.px = px;
      p.py = py;
      p.hasPrev = true;
    }

    /* 波带（心跳两下 / 顶栏接收）：双描边软波，半径克制，读作「波」不是「辅助圆环」 */
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      const p = clamp01((t - rp.t0) / 700);
      if (p >= 1) { ripples.splice(i, 1); continue; }
      const r = rp.r0 + (rp.r1 - rp.r0) * easeOutCubic(p);
      const fade = Math.pow(1 - p, 1.6);
      ctx.strokeStyle = `rgba(255,160,198,${(0.26 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.1 + 1.6 * p;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(244,114,160,${(0.14 * fade).toFixed(3)})`;
      ctx.lineWidth = 2 + 2 * p;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, r * 0.86, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* 暗场交接：舞台层先落位（0.25s），再放弹窗淡出 —— 反序会「闪白」 */
    if (t >= T_MODALFADE && !fadeFired) {
      fadeFired = true;
      stageLayer.style.opacity = '1';
      document.body.classList.add('cherish-stage-on');
    }
    if (t >= T_MODALHIDE && !modalHideFired) {
      modalHideFired = true;
      if (onModalFade) onModalFade();
    }

    /* 光种二段飞行：大光晕 + 热核 + 连续拖尾。起步就动（混入线性项），
       纯 easeInOut 会「悬停」在印章位小半秒，读成没熄灭的残火星 */
    if (t >= T_SEEDFLY) {
      if (!seedFired) seedFired = true;
      const st = clamp01((t - T_SEEDFLY) / SEEDFLY);
      const se = 0.22 * st + 0.78 * easeInOutCubic(st);
      const sx = bez(stageX, cpX, endX, se);
      const sy = bez(stageY, cpY, endY, se);
      seedPath.push({ x: sx, y: sy });
      if (seedPath.length > 5) seedPath.shift();
      const sd = 21 * (1 - st * 0.3);
      // 拖尾（由近到远衰减）
      for (let i = 0; i < seedPath.length - 1; i++) {
        const k = (i + 1) / seedPath.length;
        ctx.globalAlpha = 0.16 + 0.3 * k;
        const td = sd * (0.45 + 0.5 * k);
        ctx.drawImage(spriteGlow, seedPath[i].x - td * 1.6, seedPath[i].y - td * 1.6, td * 3.2, td * 3.2);
      }
      ctx.globalAlpha = 0.72;
      ctx.drawImage(spriteGlow, sx - sd * 2.1, sy - sd * 2.1, sd * 4.2, sd * 4.2);
      ctx.globalAlpha = 0.95;
      ctx.drawImage(spriteCore, sx - sd / 2, sy - sd / 2, sd, sd);
      if (sparkles.length < 36 && Math.random() < 0.75) {
        sparkles.push({ x: sx, y: sy, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 10 + 6, life: 1 });
      }
      if (st >= 1 && !arriveFired) {
        arriveFired = true;
        if (onArrive) onArrive();
        burst = { t0: t, x: endX, y: endY, r0: 10, r1: heartW * 0.85, life: 520, a0: 0.55 };
        ripples.push({ t0: t, x: endX, y: endY, r0: 8, r1: 44 });
        spawnMiniHearts(endX, endY);
      }
    }
    for (let i = sparkles.length - 1; i >= 0; i--) {
      const s = sparkles[i];
      s.life -= 0.032;
      if (s.life <= 0) { sparkles.splice(i, 1); continue; }
      s.x += s.vx * 0.016;
      s.y += s.vy * 0.016;
      const d = 4.5 * s.life + 1.5;
      ctx.globalAlpha = s.life * 0.6;
      ctx.drawImage(spriteCore, s.x - d / 2, s.y - d / 2, d, d);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (t >= T_STAGEOUT) endStage();
    requestAnimationFrame(frame);
  }

  /* 迷你心飘散（结尾收束，DOM 浮层挂 body 不随弹窗消失） */
  function spawnMiniHearts(x, y) {
    for (let i = 0; i < 3; i++) {
      const m = document.createElement('div');
      m.className = 'mini-heart';
      m.style.left = `${x - 9 + (i - 1) * 13}px`;
      m.style.top = `${y - 10}px`;
      m.style.setProperty('--mx', `${(i - 1) * 30}px`);
      m.style.animationDelay = `${i * 0.12}s`;
      m.innerHTML = '<svg viewBox="0 0 32 32" width="18" height="18"><path d="M16 28s-11-6.6-11-14.2C5 9.2 7.9 6.5 11.3 6.5c2 0 3.8 1 4.7 2.6.9-1.6 2.7-2.6 4.7-2.6C24.1 6.5 27 9.2 27 13.8 27 21.4 16 28 16 28z" fill="#f472a0"/></svg>';
      document.body.appendChild(m);
      setTimeout(() => m.remove(), 1300);
    }
  }

  function cleanup() {
    canvas.remove();
    textEl.classList.remove('note-read__content--erode');
    if (textEl.parentElement) textEl.parentElement.classList.remove('note-read--ceremony');
    chars.forEach((c) => { c.style.opacity = ''; });
  }

  requestAnimationFrame(frame);
}
