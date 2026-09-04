/**
 * 图片全屏预览（lightbox，多图 carousel + pinch 缩放）
 *
 * 从 app.js 拆出（技术清单第8条：app.js 过长）。本模块只负责 lightbox 的
 * 渲染、切图、缩放、拖拽、关闭；图片增删操作通过 handlers 注入回 app.js，
 * 避免与 db.js / state.js 形成紧耦合。
 *
 * 点徽标打开：横向滑动切图 + 双指 pinch 缩放当前图 + 双击放大 + 放大态拖拽。
 * 顶部页指示「1/N」（单张时隐藏）。底部操作条：加图 / 删除当前图（两段式确认）。
 * 删除只解绑待办与图的关系，Storage 文件保留作后路（软删除精神）。
 * 一次只存在一个 lightbox，关闭即从 DOM 移除。
 *
 * @param {Object} todo 待办对象（含 imagePaths / imagePath）
 * @param {Object} [handlers]
 * @param {(todoId:string, prevPaths:string[])=>void} [handlers.onAddImage] 点"加图"触发（app.js 走 attachImageToTodo）
 * @param {(todoId:string, urlToRemove:string, prevPaths:string[])=>void} [handlers.onRemoveImage] 确认删除当前图触发（app.js 走 removeImageFromTodo）
 */
export function openImageLightbox(todo, handlers = {}) {
  if (document.querySelector('.img-lightbox')) return;

  const imgs = Array.isArray(todo.imagePaths)
    ? todo.imagePaths.slice()
    : todo.imagePath ? [todo.imagePath] : [];
  if (imgs.length === 0) return;
  let index = 0; // 当前图索引

  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '图片预览');

  // track：横向排列所有 slide，translateX 切图
  const track = document.createElement('div');
  track.className = 'img-lightbox__track';
  overlay.appendChild(track);

  // 每个 slide 装一张图
  // long 标记：高宽比 > 3 的长图，宽度撑满 + scale=1 允许垂直拖动看全图
  // （否则 contain 到 80vh 会把长图压成窄条，放大也看不清）
  const slides = imgs.map((url, i) => {
    const slide = document.createElement('div');
    slide.className = 'img-lightbox__slide';
    const loading = document.createElement('div');
    loading.className = 'img-lightbox__loading';
    loading.innerHTML = '<i></i><span>加载中…</span>';
    slide.appendChild(loading);
    const img = document.createElement('img');
    img.className = 'img-lightbox__img';
    img.alt = '';
    const item = { slide, img, long: false };
    const checkLong = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      // 长图检测：高宽比 > 3（竖长）或 < 1/3（横长）
      if (img.naturalHeight / img.naturalWidth > 3 || img.naturalWidth / img.naturalHeight > 3) {
        item.long = true;
        img.classList.add('img-lightbox__img--long');
        // 初始定位到图头：flex 居中下长图上下溢出，设 ty=-overflow 让图头露在顶部，
        // 用户下滑从头看到尾（符合阅读直觉，不用先往上滑找头）
        requestAnimationFrame(() => {
          if (!states[i]) return;
          const r = img.getBoundingClientRect();
          const sr = slide.getBoundingClientRect();
          const overflow = Math.max(0, (r.height - sr.height) / 2);
          if (overflow > 0) {
            // ty=+overflow：img 下移，图头从上方溢出处移到 slide 顶部露出
            // （负值会上移露出图尾，做反了——血泪教训）
            states[i].ty = overflow;
            if (i === index) applyCurrent();
          }
        });
      }
    };
    img.addEventListener('load', () => { loading.remove(); checkLong(); });
    img.addEventListener('error', () => {
      loading.classList.add('img-lightbox__loading--err');
      loading.innerHTML = '<span>图片加载失败，请检查网络后重试</span>';
    });
    img.src = url;
    // 缓存兜底：complete 且有尺寸说明已加载，但 load 事件可能已错过
    if (img.complete && img.naturalWidth > 0) { loading.remove(); checkLong(); }
    slide.appendChild(img);
    track.appendChild(slide);
    return item;
  });

  // 页指示「1/N」（单张时隐藏）
  const indicator = document.createElement('div');
  indicator.className = 'img-lightbox__indicator';
  overlay.appendChild(indicator);

  // 左右半透明箭头（多图才显示，到边界隐藏；点按切图，业界 lightbox 标配）
  // 左右各用原生绘制的 SVG，不做旋转，视觉绝对对称自然。
  const ARROW_PREV =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const ARROW_NEXT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'img-lightbox__nav img-lightbox__nav--prev';
  prevBtn.setAttribute('aria-label', '上一张');
  prevBtn.innerHTML = ARROW_PREV;
  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (index > 0) snapTo(index - 1);
  });
  overlay.appendChild(prevBtn);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'img-lightbox__nav img-lightbox__nav--next';
  nextBtn.setAttribute('aria-label', '下一张');
  nextBtn.innerHTML = ARROW_NEXT;
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (index < imgs.length - 1) snapTo(index + 1);
  });
  overlay.appendChild(nextBtn);

  const updateIndicator = () => {
    const multi = imgs.length > 1;
    // 顶部 1/N（多图才显示）
    if (!multi) { indicator.style.display = 'none'; }
    else { indicator.style.display = ''; indicator.textContent = (index + 1) + ' / ' + imgs.length; }
    // 箭头：多图才显示，到边界隐藏（业界习惯：边界处直接消失，不再点空）
    prevBtn.style.display = (multi && index > 0) ? '' : 'none';
    nextBtn.style.display = (multi && index < imgs.length - 1) ? '' : 'none';
  };
  updateIndicator();

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'img-lightbox__close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  overlay.appendChild(closeBtn);

  // 底部操作条：加图 + 删除当前图（两段式确认）
  const actions = document.createElement('div');
  actions.className = 'img-lightbox__actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'img-lightbox__act';
  addBtn.textContent = '加图';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
    if (handlers.onAddImage) handlers.onAddImage(todo.id, todo.imagePaths);
  });
  actions.appendChild(addBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'img-lightbox__act img-lightbox__act--del';
  delBtn.textContent = '删除当前图';
  let confirmTimer = null;
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!delBtn.classList.contains('img-lightbox__act--confirm')) {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      delBtn.classList.add('img-lightbox__act--confirm');
      delBtn.textContent = '再点一次确认删除';
      confirmTimer = setTimeout(() => {
        delBtn.classList.remove('img-lightbox__act--confirm');
        delBtn.textContent = '删除当前图';
      }, 3000);
      return;
    }
    clearTimeout(confirmTimer);
    const urlToRemove = imgs[index];
    close();
    if (handlers.onRemoveImage) handlers.onRemoveImage(todo.id, urlToRemove, todo.imagePaths);
  });
  actions.appendChild(delBtn);
  overlay.appendChild(actions);

  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && index > 0) snapTo(index - 1);
    else if (e.key === 'ArrowRight' && index < imgs.length - 1) snapTo(index + 1);
  };
  document.addEventListener('keydown', onKey);

  const close = () => {
    overlay.remove();
    document.body.style.overflow = prevOverflow;
    document.removeEventListener('keydown', onKey);
  };
  closeBtn.addEventListener('click', close);

  // ===== carousel 切图 + 每张图 pinch/双击/拖拽 =====
  const MAX_SCALE = 4;
  const states = imgs.map(() => ({ scale: 1, tx: 0, ty: 0 })); // 每张图的变换
  let trackOffset = 0; // track 跟手横向偏移（百分比，切图过程中）

  const applyTrack = () => {
    track.style.transform = 'translateX(' + (-index * 100 + trackOffset) + '%)';
  };
  const applyCurrent = () => {
    const s = states[index];
    slides[index].img.style.transform =
      'translate(' + s.tx + 'px, ' + s.ty + 'px) scale(' + s.scale + ')';
  };
  const clampPan = (i) => {
    const s = states[i];
    const imgRect = slides[i].img.getBoundingClientRect();
    const slideRect = slides[i].slide.getBoundingClientRect();
    // 长图未放大：img 高度溢出 slide，允许垂直拖动看上下（横向不动）
    if (s.scale <= 1 && slides[i].long) {
      const overflow = Math.max(0, (imgRect.height - slideRect.height) / 2);
      s.tx = 0;
      s.ty = Math.max(-overflow, Math.min(overflow, s.ty));
      return;
    }
    if (s.scale <= 1) { s.tx = 0; s.ty = 0; return; }
    const baseW = imgRect.width / s.scale, baseH = imgRect.height / s.scale;
    const mx = Math.max(0, (baseW * s.scale - baseW) / 2);
    const my = Math.max(0, (baseH * s.scale - baseH) / 2);
    s.tx = Math.max(-mx, Math.min(mx, s.tx));
    s.ty = Math.max(-my, Math.min(my, s.ty));
  };
  // 切到指定 index（带动画），不重置目标图变换（保留各自的缩放状态）
  const snapTo = (i) => {
    index = Math.max(0, Math.min(imgs.length - 1, i));
    trackOffset = 0;
    track.classList.add('img-lightbox__track--anim');
    applyTrack();
    setTimeout(() => track.classList.remove('img-lightbox__track--anim'), 270);
    updateIndicator();
  };

  const activePointers = new Map();
  let pinchStartDist = 0, pinchStartScale = 1, isPinching = false;
  let dragStart = null, moved = false, lastTapAt = 0, lastTapX = 0, lastTapY = 0, closeTimer = null;

  const twoFingerDist = () => {
    const pts = [...activePointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };
  // 以屏幕点 (gx,gy) 为不动点缩放当前图 k 倍
  const zoomAtPoint = (gx, gy, k) => {
    const s = states[index];
    const rect = slides[index].img.getBoundingClientRect();
    const cx = gx - (rect.left + rect.width / 2);
    const cy = gy - (rect.top + rect.height / 2);
    s.tx = s.tx + cx * (1 - k);
    s.ty = s.ty + cy * (1 - k);
  };
  const zoomWithAnim = (targetScale, gx, gy) => {
    const s = states[index];
    const img = slides[index].img;
    const k = targetScale / s.scale;
    zoomAtPoint(gx, gy, k);
    s.scale = targetScale;
    if (s.scale <= 1) { s.tx = 0; s.ty = 0; }
    clampPan(index);
    img.classList.add('img-lightbox__img--anim');
    applyCurrent();
    setTimeout(() => img.classList.remove('img-lightbox__img--anim'), 270);
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === closeBtn || actions.contains(e.target) ||
        prevBtn.contains(e.target) || nextBtn.contains(e.target)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      isPinching = true;
      dragStart = null;
      moved = false;
      clearTimeout(closeTimer);
      lastTapAt = 0;
      pinchStartDist = twoFingerDist();
      pinchStartScale = states[index].scale;
      slides[index].img.classList.remove('img-lightbox__img--anim');
      return;
    }
    if (activePointers.size === 1) {
      const s = states[index];
      dragStart = { x: e.clientX, y: e.clientY, tx: s.tx, ty: s.ty };
      moved = false;
      clearTimeout(closeTimer);
    }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = states[index];
    if (isPinching && activePointers.size >= 2) {
      const pts = [...activePointers.values()];
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      if (pinchStartDist > 0) {
        let next = pinchStartScale * (twoFingerDist() / pinchStartDist);
        next = Math.max(1, Math.min(MAX_SCALE, next));
        const k = next / s.scale;
        if (k !== 1) {
          zoomAtPoint(mx, my, k);
          s.scale = next;
          if (s.scale <= 1) { s.tx = 0; s.ty = 0; }
          clampPan(index);
          applyCurrent();
        }
      }
      return;
    }
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    if (s.scale > 1 && moved) {
      // 放大态：平移当前图
      slides[index].img.classList.remove('img-lightbox__img--anim');
      s.tx = dragStart.tx + dx;
      s.ty = dragStart.ty + dy;
      clampPan(index);
      applyCurrent();
    } else if (slides[index].long && s.scale <= 1 && moved && Math.abs(dy) >= Math.abs(dx)) {
      // 长图未放大且纵向为主：垂直拖动看全图（宽度撑满，上下溢出可拖）
      slides[index].img.classList.remove('img-lightbox__img--anim');
      s.tx = 0;
      s.ty = dragStart.ty + dy;
      clampPan(index);
      applyCurrent();
    } else if (s.scale <= 1 && moved && Math.abs(dx) > Math.abs(dy)) {
      // 未放大且横向为主：跟手滑 track 切图
      const overlayW = overlay.clientWidth || 1;
      trackOffset = (dx / overlayW) * 100;
      track.classList.remove('img-lightbox__track--anim');
      applyTrack();
    }
  });
  overlay.addEventListener('pointerup', (e) => {
    const wasPinching = isPinching;
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) isPinching = false;
    if (wasPinching) {
      if (activePointers.size === 1) {
        const [p] = [...activePointers.values()];
        const s = states[index];
        dragStart = { x: p.x, y: p.y, tx: s.tx, ty: s.ty };
        moved = false;
      } else {
        dragStart = null;
      }
      return;
    }
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    dragStart = null;
    const s = states[index];
    if (moved) {
      if (s.scale > 1) return; // 放大态拖拽结束，不切图
      // 长图垂直拖动结束：保持当前 ty，不切图不 tap
      if (slides[index].long && Math.abs(dy) >= Math.abs(dx)) return;
      // 未放大横向滑：判断切图（滑过 15% 宽度切图）
      const overlayW = overlay.clientWidth || 1;
      const percent = (dx / overlayW) * 100;
      if (percent < -15 && index < imgs.length - 1) {
        snapTo(index + 1);
      } else if (percent > 15 && index > 0) {
        snapTo(index - 1);
      } else {
        // 回弹
        trackOffset = 0;
        track.classList.add('img-lightbox__track--anim');
        applyTrack();
        setTimeout(() => track.classList.remove('img-lightbox__track--anim'), 270);
      }
      return;
    }
    // 没移动 → 点击（双击放大 / 单击关闭）
    const now = Date.now();
    const isDouble =
      now - lastTapAt < 300 &&
      Math.abs(e.clientX - lastTapX) < 44 &&
      Math.abs(e.clientY - lastTapY) < 44;
    if (isDouble) {
      lastTapAt = 0;
      const target = s.scale > 1 ? 1 : MAX_SCALE;
      zoomWithAnim(target, e.clientX, e.clientY);
    } else {
      lastTapAt = now;
      lastTapX = e.clientX;
      lastTapY = e.clientY;
      // 单击关闭（仅未放大时），延迟确认不是双击
      closeTimer = setTimeout(() => { if (states[index].scale === 1) close(); }, 260);
    }
  });
  overlay.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) isPinching = false;
    dragStart = null;
  });
}
