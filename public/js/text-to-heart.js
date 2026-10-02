/**
 * 文字化心飞向桃心 —— 珍藏仪式 v2（2026-10 动画重设计）
 *
 * 与 v1 的区别（v1 的实测缺陷：加法混合过曝成白块、三层心形剪影发毛、
 * 文字融化成黏块、终点在弹窗遮挡处「凭空消散」）：
 *   1. 治过曝：粒子 3-4.5px 细尘、alpha ≤ 0.55、常规粒子锁玫瑰色，白只留 15% 高光
 *   2. 单层心形剪影：55% 均匀弧长轮廓 + 45% 边缘偏置内部填充（边缘实、内部有肉）
 *   3. 逐字溶解：字符按 x 位置左→右扫描熄灭（DOM），粒子同步出生（canvas），无黏块无叠影
 *   4. 两段飞行 + 可见收点：
 *      心 → 阅读卡内印章桃心（stageEl）被吸收 + 「咚-咚」接收（弹窗仍可见）→
 *      弹窗淡出 → 玫瑰光种二段短飞顶栏桃心（heartEl）→ 接收跳动（弹窗已隐，全程可见）
 *   5. 心跳两下可见：柔光晕 + 两圈波纹
 *
 * 阶段（1×，ms）：
 *   0      仪式开始（长按充能完成后由 messages 触发）：暗场渐入 / 元素让位 / 文字透亮
 *   450    逐字溶解（左→右扫过 480ms）：字符熄灭 = 粒子出生
 *   ~500   粒子升腾 + 湍流汇聚（每粒 950-1300ms）
 *   2280   心成形：心跳两下（柔光晕 + 波纹）
 *   3040   心被 stageEl 吸收（第一收点）+ stageEl 接收跳动
 *   4150   通知弹窗淡出（onModalFade）；玫瑰光种留在舞台位置
 *   4330   光种二段飞行飞向 heartEl（第二收点）
 *   4790   onArrive（顶栏接收跳动）+ 波纹 + 迷你心飘散
 *   5300   done（焚毁收尾由 messages 执行）
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

/** 预渲染柔光 sprite：中心热核 + 边缘透明（尺寸小也有色彩层次） */
function makeSprite(inner, mid) {
  const S = 48;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, mid);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
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
 * 文字化心飞向桃心（珍藏仪式 v2）。
 * @param {Object} opts
 * @param {HTMLElement} opts.textEl 留言文字容器（含 .note-read__char 字符 span）
 * @param {HTMLElement} opts.stageEl 阅读卡印章桃心（第一收点）
 * @param {HTMLElement} opts.heartEl 顶栏桃心（第二收点）
 * @param {Function} [opts.onStageArrive] 心被印章桃心吸收时回调
 * @param {Function} [opts.onModalFade] 该关弹窗了（光种即将二段飞行）
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
  const count = Math.min(1350, Math.max(850, sampled.length));
  const targets = generateHeartTargets(count, hs);

  /* --- 粒子：玫瑰 85% / 高光白 15%，尺寸 3-4.5px，alpha ≤ 0.55 --- */
  const P = [];
  const stride = sampled.length / count;
  for (let i = 0; i < count; i++) {
    const sp = sampled[Math.floor(i * stride)];
    const tp = targets[i];
    const white = Math.random() < 0.15;
    P.push({
      x0: offX + sp[0],
      y0: offY + sp[1],
      tx: heartCx + tp[0],
      ty: heartCy + tp[1],
      // 出生延迟 = 按 x 位置左→右扫过（与 DOM 字符熄灭同步）
      delay: clamp01(sp[0] / maxW) * 480 + Math.random() * 90,
      dur: 950 + Math.random() * 350,
      rise: 10 + Math.random() * 14,
      drift: (Math.random() - 0.5) * 10,
      size: 0.75 + Math.random() * 0.5,
      alpha: white ? 0.5 : 0.34 + Math.random() * 0.2,
      white,
      phase: Math.random() * Math.PI * 2,
      flow: 5 + Math.random() * 6,
    });
  }

  /* --- 时间轴（ms，从仪式开始计） --- */
  const T_DARK = 0;
  const T_BRIGHT = 450;
  const T_ERODE = 500;
  const T_ARRIVE = T_ERODE + 480 + 1300;
  const T_BEAT = T_ARRIVE + 80;
  const BEAT = 620;
  const T_ABSORB = T_BEAT + BEAT + 60;
  const ABSORB = 430;
  const T_MODALFADE = T_ABSORB + ABSORB + 60;
  const T_SEEDFLY = T_MODALFADE + 180;
  const SEEDFLY = 460;
  const TOTAL = T_SEEDFLY + SEEDFLY + 510;

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

  const spriteRose = makeSprite('rgba(255,205,222,0.95)', 'rgba(244,63,110,0.55)');
  const spriteRoseDim = makeSprite('rgba(255,183,200,0.8)', 'rgba(224,81,127,0.4)');
  const spriteWhite = makeSprite('rgba(255,255,255,0.95)', 'rgba(255,214,228,0.5)');

  const sparkles = [];
  const ripples = [];
  let rippleFired = [false, false];
  let stageFired = false;
  let fadeFired = false;
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
      if (!arriveFired) { arriveFired = true; if (onArrive) onArrive(); }
      finish();
    }
  }

  function frameInner(now) {
    const t = now - start;

    if (t >= TOTAL) {
      cleanup();
      if (!arriveFired) { arriveFired = true; if (onArrive) onArrive(); }
      finish();
      return;
    }

    ctx.clearRect(0, 0, W, H);

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
      const glow = Math.max(0, beatS - 1);
      if (glow > 0.001) {
        const gs = heartW * (1.5 + glow * 1.6);
        ctx.globalAlpha = Math.min(0.3, glow * 1.9);
        ctx.drawImage(spriteRose, heartCx - gs / 2, heartCy - gs / 2, gs, gs);
      }
      if (!rippleFired[0] && bt >= 0.14) {
        rippleFired[0] = true;
        ripples.push({ t0: t, x: heartCx, y: heartCy, max: 110 });
      }
      if (!rippleFired[1] && bt >= 0.48) {
        rippleFired[1] = true;
        ripples.push({ t0: t, x: heartCx, y: heartCy, max: 96 });
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      const p = clamp01((t - rp.t0) / 650);
      if (p >= 1) { ripples.splice(i, 1); continue; }
      ctx.globalAlpha = 0.3 * (1 - p);
      ctx.strokeStyle = 'rgba(244,114,160,0.9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, 40 + p * rp.max, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* 吸收阶段：心整体飞向舞台桃心 */
    const absorbT = clamp01((t - T_ABSORB) / ABSORB);
    const absE = easeInOutCubic(absorbT);
    const gx = absorbT > 0 ? bez(heartCx, absCx, stageX, absE) : heartCx;
    const gy = absorbT > 0 ? bez(heartCy, absCy, stageY, absE) : heartCy;
    const gScale = absorbT > 0 ? 1 - 0.8 * easeOutCubic(absorbT) : 1;

    if (absorbT >= 1 && !stageFired) {
      stageFired = true;
      if (onStageArrive) onStageArrive();
    }

    /* 粒子 */
    for (const p of P) {
      const born = T_ERODE + p.delay;
      if (t < born) continue;
      const e = clamp01((t - born) / p.dur);
      let px;
      let py;
      if (absorbT === 0) {
        const travel = easeInOutCubic(clamp01((e - 0.18) / 0.82));
        px = p.x0 + p.drift + (p.tx - (p.x0 + p.drift)) * travel;
        py = p.y0 - p.rise + (p.ty - (p.y0 - p.rise)) * travel;
        const env = Math.sin(Math.PI * e);
        const ang = Math.sin(px * 0.02 + t * 0.002 + p.phase) + Math.cos(py * 0.017 - t * 0.0016);
        px += Math.cos(ang) * p.flow * env;
        py += Math.sin(ang) * p.flow * env - 4 * env;
        if (e >= 1) {
          px += Math.sin(t * 0.003 + p.phase) * 0.6;
          py += Math.cos(t * 0.0026 + p.phase) * 0.6;
        }
        px = heartCx + (px - heartCx) * beatS;
        py = heartCy + (py - heartCy) * beatS;
      } else {
        px = gx + (p.tx - heartCx) * gScale;
        py = gy + (p.ty - heartCy) * gScale;
      }
      let a = p.alpha * clamp01((t - born) / 160);
      if (absorbT > 0) a *= 1 - absorbT * 0.9;
      const d = p.size * 4.4 * (absorbT > 0 ? 1 - absorbT * 0.55 : 1);
      ctx.globalAlpha = a;
      ctx.drawImage(
        p.white ? spriteWhite : (e > 0.6 || absorbT > 0 ? spriteRose : spriteRoseDim),
        px - d / 2, py - d / 2, d, d,
      );
    }

    /* 通知弹窗淡出（光种即将起飞） */
    if (t >= T_MODALFADE && !fadeFired) {
      fadeFired = true;
      if (onModalFade) onModalFade();
    }

    /* 光种二段飞行（玫瑰色：深浅底上都可见） */
    if (t >= T_SEEDFLY) {
      if (!seedFired) seedFired = true;
      const st = clamp01((t - T_SEEDFLY) / SEEDFLY);
      const se = easeInOutCubic(st);
      const sx = bez(stageX, cpX, endX, se);
      const sy = bez(stageY, cpY, endY, se);
      const sd = 13 * (1 - st * 0.4);
      ctx.globalAlpha = 0.95;
      ctx.drawImage(spriteRose, sx - sd / 2, sy - sd / 2, sd, sd);
      if (sparkles.length < 24 && Math.random() < 0.55) {
        sparkles.push({ x: sx, y: sy, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 10 + 6, life: 1 });
      }
      if (st >= 1 && !arriveFired) {
        arriveFired = true;
        if (onArrive) onArrive();
        ripples.push({ t0: t, x: endX, y: endY, max: 120 });
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
      ctx.drawImage(spriteWhite, s.x - d / 2, s.y - d / 2, d, d);
    }

    ctx.globalAlpha = 1;
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
