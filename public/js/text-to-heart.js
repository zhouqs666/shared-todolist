/**
 * 文字化心飞向桃心 —— 珍藏仪式的顶级视觉重构
 *
 * 与廉价粒子动画的区别：
 *   1. 加法混合（lighter）：光点重叠自然增亮，像真实的光而非贴纸
 *   2. 运动余晖：不完全清屏，粒子拖着彗尾般的轨迹，流动感的核心
 *   3. curl noise 流场：粒子沿有机湍流路径汇聚，绝不走直线
 *   4. 预渲染柔光 sprite：径向渐变光斑，数百粒子 60fps
 *   5. 心跳节拍：成型后按 App 的心跳曲线（咚-咚…呼吸）跳两下
 *   6. 整体飞行：心作为整体沿弧线飞向桃心，带星尘尾迹
 *
 * 阶段：文字松动升腾(0.35s) → 湍流汇聚成心(1.2s) → 心跳两下(0.65s) → 整体飞向桃心(0.75s)
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
function parseRGB(str) {
  const m = String(str).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return m ? [+m[1], +m[2], +m[3]] : [76, 5, 49];
}

/** 有机湍流场：位置+时间 → 流向角度（伪 curl noise，平滑且无重复感） */
function flowAngle(x, y, t) {
  return (
    Math.sin(x * 0.012 + t * 1.1) +
    Math.cos(y * 0.014 - t * 0.8) +
    Math.sin((x + y) * 0.006 + t * 0.6) +
    Math.cos((x - y) * 0.009 - t * 0.4)
  ) * 1.2;
}

/** 心跳曲线（与 App 心跳 CSS 同构：咚-咚…呼吸），t∈[0,1] → scale */
function beatCurve(t) {
  // 第一跳更大，第二跳轻，之后呼吸
  if (t < 0.14) return 1 + easeOutCubic(t / 0.14) * 0.10;
  if (t < 0.30) return 1.10 - easeInOutCubic((t - 0.14) / 0.16) * 0.10;
  if (t < 0.46) return 1 + easeOutCubic((t - 0.30) / 0.16) * 0.055;
  if (t < 0.62) return 1.055 - easeInOutCubic((t - 0.46) / 0.16) * 0.055;
  return 1;
}

/** 预渲染柔光 sprite：中心热核 + 边缘透明 */
function makeSprite(inner, mid) {
  const S = 48;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.3, mid);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}

/* ===== 文字采样 ===== */

/**
 * 把留言文字渲染到隐藏 canvas 并采样像素点。
 * 用真实的字号/行高/可用宽度排版，保证粒子初始位置和 DOM 文字基本重合。
 */
function sampleTextPoints(text, fontSize, lineHeight, maxW, dpr) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${fontSize}px -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`;
  ctx.font = font;
  // 手动按宽度换行（与 DOM white-space:pre-wrap 近似）
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = ch; }
    else line = test;
  }
  if (line) lines.push(line);

  c.width = Math.ceil(maxW * dpr);
  c.height = Math.ceil(lines.length * lineHeight * dpr + fontSize * dpr);
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  lines.forEach((ln, i) => ctx.fillText(ln, 0, i * lineHeight));

  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  const step = 3; // 采样步长（CSS px）
  const pts = [];
  for (let y = 0; y < c.height; y += step * dpr) {
    for (let x = 0; x < c.width; x += step * dpr) {
      const alpha = img[(Math.round(y) * c.width + Math.round(x)) * 4 + 3];
      if (alpha > 120) pts.push([x / dpr, y / dpr]);
    }
  }
  return { pts, w: c.width / dpr, h: c.height / dpr };
}

/* ===== 心形点生成 ===== */

/** 心形参数方程（t∈[0,2π)） */
function heartPoint(t) {
  return [
    16 * Math.pow(Math.sin(t), 3),
    -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
  ];
}
/** 点是否在心形内（隐式方程） */
function insideHeart(x, y) {
  const xs = x / 16, ys = -y / 14;
  return Math.pow(xs * xs + ys * ys - 1, 3) - xs * xs * ys * ys * ys <= 0;
}

/** 生成心形目标点：三层轮廓（强化边缘清晰度）+ 内部填充 */
function generateHeartPoints(count, scale) {
  const pts = [];
  const ringScales = [1, 0.86, 0.7];
  const ringCount = Math.min(count, Math.floor(count * 0.42));
  for (let i = 0; i < ringCount; i++) {
    const t = (i / ringCount) * Math.PI * 2;
    const [x, y] = heartPoint(t);
    pts.push([x * scale * ringScales[i % 3], y * scale * ringScales[i % 3]]);
  }
  let added = 0, tries = 0;
  while (pts.length < count && tries < count * 30) {
    tries++;
    const x = (Math.random() * 2 - 1) * 16;
    const y = (Math.random() * 2 - 1) * 15;
    if (insideHeart(x, y)) { pts.push([x * scale, y * scale]); added++; }
  }
  while (pts.length < count) {
    const t = Math.random() * Math.PI * 2;
    const [x, y] = heartPoint(t);
    pts.push([x * scale * 0.5, y * scale * 0.5]);
  }
  return pts;
}

/* ===== 主入口 ===== */

/**
 * 文字化心飞向桃心。
 * @param {Object} opts
 * @param {HTMLElement} opts.textEl 留言文字元素
 * @param {HTMLElement} opts.heartEl 顶栏桃心（终点）
 * @param {Function} [opts.onArrive] 心到达桃心时回调（触发桃心接收跳动）
 * @param {Function} opts.done 全部结束回调
 */
export function textToHeart({ textEl, heartEl, onArrive, done }) {
  const finish = () => { done && done(); };
  if (!textEl) { finish(); return; }

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) { onArrive && onArrive(); finish(); return; }

  const text = (textEl.textContent || '').trim();
  if (!text) { onArrive && onArrive(); finish(); return; }

  /* --- 几何：起点（文字）/ 心形中心 / 终点（顶栏桃心） --- */
  const rect = textEl.getBoundingClientRect();
  const cs = getComputedStyle(textEl);
  const fontSize = parseFloat(cs.fontSize) || 18;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.8;
  const [tr, tg, tb] = parseRGB(cs.color);

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  let endX = cx, endY = 30;
  if (heartEl) {
    const hr = heartEl.getBoundingClientRect();
    endX = hr.left + hr.width / 2;
    endY = hr.top + hr.height / 2;
  }

  /* --- 采样文字 → 粒子起点 --- */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxW = Math.max(60, rect.width - 40); // 减去内边距
  const { pts: sampled, w: tw, h: th } = sampleTextPoints(text, fontSize, lineHeight, maxW, dpr);
  if (sampled.length === 0) { onArrive && onArrive(); finish(); return; }

  // 控制粒子总量（性能与密度平衡）
  const MAX_PTS = 620;
  let textPts = sampled;
  if (sampled.length > MAX_PTS) {
    const stride = sampled.length / MAX_PTS;
    textPts = Array.from({ length: MAX_PTS }, (_, i) => sampled[Math.floor(i * stride)]);
  } else if (sampled.length > 0 && sampled.length < 300) {
    // 短消息补足粒子（"晚安"三两个字采样点太少，心形会稀疏）：
    // 在原文字点附近抖动复制，密度够心形才饱满
    const extra = [];
    for (let i = 0; i < 300 - sampled.length; i++) {
      const src = sampled[i % sampled.length];
      extra.push([src[0] + (Math.random() - 0.5) * 6, src[1] + (Math.random() - 0.5) * 6]);
    }
    textPts = sampled.concat(extra);
  }

  /* --- 心形目标 --- */
  const heartW = Math.max(96, Math.min(150, rect.width * 0.52)); // 屏幕像素宽
  const scale = heartW / 32;
  const heartPts = generateHeartPoints(textPts.length, scale);

  const textOffX = cx - tw / 2;
  const textOffY = cy - th / 2;

  /* --- 光斑 sprites（真实文字色 → 玫瑰 → 亮白） --- */
  const spriteText = makeSprite(
    `rgba(${tr},${tg},${tb},0.95)`,
    `rgba(${tr},${tg},${tb},0.45)`,
  );
  const spriteRose = makeSprite(
    'rgba(255,183,200,0.95)',
    'rgba(244,63,94,0.50)',
  );
  const spriteGlow = makeSprite(
    'rgba(255,255,255,0.95)',
    'rgba(255,170,195,0.45)',
  );

  /* --- 粒子 --- */
  const particles = textPts.map((tp, i) => {
    const hp = heartPts[i];
    return {
      x: textOffX + tp[0],        // 起点（文字像素）
      y: textOffY + tp[1],
      tx: cx + hp[0],             // 心形目标
      ty: cy + hp[1],
      delay: Math.random() * 300,               // 错峰出发（ms）
      dur: 900 + Math.random() * 300,           // 汇聚时长（ms）
      size: 0.75 + Math.random() * 0.85,        // 尺寸差异（景深）
      flow: 0.6 + Math.random() * 0.8,          // 湍流敏感度差异
      phase: Math.random() * Math.PI * 2,       // 随机相位
      tw: 1.6 + Math.random() * 1.4,            // 微光闪烁频率
    };
  });

  /* --- 时间轴 --- */
  const T_LOOSEN = 380;    // 文字松动（起点停留，字面渐隐）
  const T_FLOW_END = 1900; // 全部粒子汇聚完成
  const T_BEAT = 1950;     // 心跳开始
  const BEAT = 650;
  const T_FLY = T_BEAT + BEAT;  // 2600 飞行开始
  const FLY = 750;
  const TOTAL = T_FLY + FLY + 120; // 含淡出尾巴

  // 飞行弧线控制点（向上拱起的贝塞尔）
  const cpX = (cx + endX) / 2 + (Math.random() * 40 - 20);
  const cpY = Math.min(cy, endY) - 90;

  /* --- 全屏画布 --- */
  const W = window.innerWidth, H = window.innerHeight;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;inset:0;width:${W}px;height:${H}px;pointer-events:none;z-index:400;`;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  // 文字本体平滑让位（粒子接管）
  textEl.style.transition = 'opacity 0.55s ease-out';
  textEl.style.opacity = '0';

  // 星尘尾迹
  const sparkles = [];
  let arrivedFired = false;
  let stopped = false;

  function bez(p0, p1, p2, t) {
    const u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
  }

  const start = performance.now();

  function frame(now) {
    if (stopped) return;
    const elapsed = now - start;

    if (elapsed >= TOTAL) {
      stopped = true;
      canvas.remove();
      textEl.style.opacity = '';
      textEl.style.transition = '';
      if (!arrivedFired) { arrivedFired = true; onArrive && onArrive(); }
      finish();
      return;
    }

    // 心恰好在视觉上抵达顶栏桃心的瞬间触发接收跳动（不等尾巴淡完）
    if (!arrivedFired && elapsed >= T_FLY + FLY) {
      arrivedFired = true;
      onArrive && onArrive();
    }

    /* 余晖：不完全清屏，旧帧渐隐 → 粒子自带彗尾 */
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.fillRect(0, 0, W, H);

    /* 加法混合：光叠加光 */
    ctx.globalCompositeOperation = 'lighter';

    /* 心跳 */
    let beatS = 1, beatGlow = 0;
    if (elapsed >= T_BEAT) {
      const bt = clamp01((elapsed - T_BEAT) / BEAT);
      beatS = beatCurve(bt);
      beatGlow = Math.max(0, beatS - 1) * 3.2;
    }

    /* 飞行 */
    let flyT = 0;
    if (elapsed >= T_FLY) flyT = clamp01((elapsed - T_FLY) / FLY);
    const flyE = easeInOutCubic(flyT);
    const gx = flyT > 0 ? bez(cx, cpX, endX, flyE) : cx;
    const gy = flyT > 0 ? bez(cy, cpY, endY, flyE) : cy;
    const gScale = flyT > 0 ? 1 - 0.82 * easeOutCubic(flyT) : 1; // 1 → 0.18

    /* 心跳时的柔光晕（先画，垫底） */
    if (beatGlow > 0 && flyT === 0) {
      const hs = heartW * 1.5;
      ctx.globalAlpha = Math.min(0.4, 0.16 * beatGlow);
      ctx.drawImage(spriteRose, cx - hs / 2, cy - hs / 2, hs, hs);
    }

    /* 粒子 */
    const tSec = elapsed / 1000;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const t = elapsed - T_LOOSEN - p.delay;
      const e = t <= 0 ? 0 : clamp01(t / p.dur);
      const ease = easeInOutCubic(e);

      let bx, by;
      if (flyT === 0) {
        bx = p.x + (p.tx - p.x) * ease;
        by = p.y + (p.ty - p.y) * ease;
      } else {
        bx = gx + (p.tx - cx) * gScale;
        by = gy + (p.ty - cy) * gScale;
      }

      // 湍流偏移：起点为 0（字面完整），途中最大，抵达归零
      const env = Math.sin(Math.PI * e);
      const ang = flowAngle(bx, by, tSec + p.phase * 0.3);
      const amp = p.flow * 26 * env * (flyT > 0 ? 0 : 1);
      const ox = Math.cos(ang) * amp;
      const oy = Math.sin(ang) * amp - 5 * env;

      // 抵达后的微光闪烁（心是活的）
      let shim = 0;
      if (e >= 1 && flyT === 0) shim = Math.sin(tSec * p.tw * Math.PI + p.phase) * 0.8;

      const px = bx + ox + shim * Math.cos(p.phase);
      const py = by + oy + shim * Math.sin(p.phase);

      // 透明度：入场渐显 → 飞行渐隐
      let a = clamp01(elapsed / 220);
      if (flyT > 0) a *= 1 - flyT * 0.92;

      // 颜色进程：文字色 → 玫瑰（途中）→ 亮白（心跳/飞行）
      const mix = clamp01(e * 1.1 + beatGlow * 0.25);

      // 尺寸：途中胀大（气流感），飞行收缩
      const s = p.size * (2.3 + 1.5 * env) * (1 - 0.45 * flyT);
      const d = s * 6; // sprite 直径

      if (mix < 0.5) {
        ctx.globalAlpha = a * (1 - mix * 2);
        ctx.drawImage(spriteText, px - d / 2, py - d / 2, d, d);
        ctx.globalAlpha = a * (mix * 2);
        ctx.drawImage(spriteRose, px - d / 2, py - d / 2, d, d);
      } else {
        ctx.globalAlpha = a * (1 - (mix - 0.5) * 2) * 0.92;
        ctx.drawImage(spriteRose, px - d / 2, py - d / 2, d, d);
        ctx.globalAlpha = a * ((mix - 0.5) * 2);
        ctx.drawImage(spriteGlow, px - d / 2, py - d / 2, d, d);
      }
    }

    /* 飞行星尘尾迹 */
    if (flyT > 0 && flyT < 1) {
      if (sparkles.length < 36 && Math.random() < 0.7) {
        sparkles.push({
          x: gx + (Math.random() - 0.5) * heartW * gScale,
          y: gy + (Math.random() - 0.5) * heartW * gScale * 0.9,
          vx: (Math.random() - 0.5) * 10,
          vy: (Math.random() - 0.5) * 10 - 6,
          life: 1,
        });
      }
      for (let i = sparkles.length - 1; i >= 0; i--) {
        const sp = sparkles[i];
        sp.life -= 0.032;
        if (sp.life <= 0) { sparkles.splice(i, 1); continue; }
        sp.x += sp.vx * 0.016;
        sp.y += sp.vy * 0.016;
        const sd = 5 * sp.life + 2;
        ctx.globalAlpha = sp.life * 0.55;
        ctx.drawImage(spriteGlow, sp.x - sd / 2, sp.y - sd / 2, sd, sd);
      }
    }

    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
