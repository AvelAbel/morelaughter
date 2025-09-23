// Lightweight canvas background with soft radial blobs and optional drift animation
// Public API: initBackground({ seed, density, animate, speed, noise, palette })

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pick(arr, rnd) { return arr[Math.floor(rnd() * arr.length)]; }

export function initBackground(options = {}) {
  // Prevent duplicates across step changes
  const existing = document.getElementById('bg-canvas');
  if (existing) {
    return { destroy() { try { existing.remove(); } catch {} } };
  }
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const opts = {
    seed: options.seed ?? 1337,
    density: Math.min(16, Math.max(10, options.density ?? 12)),
    animate: prefersReduced ? false : !!options.animate,
    speed: Math.min(1.0, Math.max(0.05, options.speed ?? 0.25)),
    noise: Math.min(0.15, Math.max(0, options.noise ?? 0.06)),
    palette: options.palette || [
      getComputedStyle(document.documentElement).getPropertyValue('--c1')?.trim() || '#b06e49',
      getComputedStyle(document.documentElement).getPropertyValue('--c2')?.trim() || '#cd9a61',
      getComputedStyle(document.documentElement).getPropertyValue('--c3')?.trim() || '#1c1a2e',
      getComputedStyle(document.documentElement).getPropertyValue('--c4')?.trim() || '#572a29',
      getComputedStyle(document.documentElement).getPropertyValue('--c5')?.trim() || '#d4b3a3',
      getComputedStyle(document.documentElement).getPropertyValue('--c6')?.trim() || '#391b23',
      getComputedStyle(document.documentElement).getPropertyValue('--c7')?.trim() || '#733729',
      getComputedStyle(document.documentElement).getPropertyValue('--c8')?.trim() || '#38334b',
      getComputedStyle(document.documentElement).getPropertyValue('--c9')?.trim() || '#cb804a'
    ]
  };

  try { localStorage.setItem('bg.animate', String(opts.animate)); } catch {}

  const prng = mulberry32(opts.seed >>> 0);
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // Canvas setup
  const cnv = document.createElement('canvas');
  cnv.id = 'bg-canvas';
  Object.assign(cnv.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '0', pointerEvents: 'none',
  });
  // Ensure canvas is behind content but above body background (veil handled via CSS ::before)
  document.body.prepend(cnv);
  try { document.body.classList.add('bg-active'); } catch {}

  const ctx = (() => {
    try { return cnv.getContext('2d', { alpha: true }); } catch { return cnv.getContext('2d'); }
  })();
  if (!ctx) return;

  let w = 0, h = 0, blobs = [];

  function genBlobs() {
    blobs = [];
    const n = opts.density;
    for (let i = 0; i < n; i++) {
      let x = prng();
      let y = prng();
      // Избегаем центральной области, чтобы в центре не было радиального эффекта
      // Повторно генерируем, пока точка не выйдет за радиус от центра
      let tries = 0;
      while (tries < 8) {
        const dx = x - 0.5, dy = y - 0.5;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.22) break;
        x = prng(); y = prng(); tries += 1;
      }
      const r = 0.15 + prng() * 0.35; // radius in min(width,height)
      const color = pick(opts.palette, prng);
      const alpha = 0.10 + prng() * 0.20;
      const vx = (prng() - 0.5) * opts.speed * 0.002; // fraction per ms
      const vy = (prng() - 0.5) * opts.speed * 0.002;
      blobs.push({ x, y, r, color, alpha, vx, vy });
    }
  }

  function resize() {
    const bw = document.documentElement.clientWidth || window.innerWidth;
    const bh = document.documentElement.clientHeight || window.innerHeight;
    w = Math.max(1, Math.floor(bw));
    h = Math.max(1, Math.floor(bh));
    cnv.width = Math.floor(w * dpr);
    cnv.height = Math.floor(h * dpr);
    cnv.style.width = w + 'px';
    cnv.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(noiseAmount = opts.noise) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    for (const b of blobs) {
      const rx = b.x * w, ry = b.y * h;
      const rr = b.r * Math.min(w, h);
      const g = ctx.createRadialGradient(rx, ry, rr * 0.15, rx, ry, rr);
      g.addColorStop(0, hexToRgba(b.color, b.alpha));
      g.addColorStop(1, hexToRgba(b.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2); ctx.fill();
    }
    if (noiseAmount > 0) {
      // Dither: subtle noise overlay to prevent banding
      const step = 3;
      // Стабильный шум: независимый от глобального prng, фиксируем seed на каждый draw
      const nprng = mulberry32((opts.seed ^ 0x9E3779B9) >>> 0);
      ctx.save();
      ctx.globalAlpha = Math.min(0.08, noiseAmount);
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const a = nprng() * 255 & 0xff;
          ctx.fillStyle = `rgba(0,0,0,${a/255 * 0.08})`;
          ctx.fillRect(x, y, step, step);
        }
      }
      ctx.restore();
    }
  }

  function hexToRgba(hex, a) {
    const c = hex.replace('#','');
    const v = c.length === 3 ? c.split('').map(s=>s+s).join('') : c;
    const r = parseInt(v.slice(0,2),16), g = parseInt(v.slice(2,4),16), b = parseInt(v.slice(4,6),16);
    return `rgba(${r},${g},${b},${a})`;
  }

  let rafId = 0, animTime = 0, lastTs = 0;
  function tick(ts) {
    if (!opts.animate) return;
    if (document.hidden) { lastTs = ts; rafId = requestAnimationFrame(tick); return; }
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    // 30 fps cap
    if (dt < 1000/30) { rafId = requestAnimationFrame(tick); return; }
    lastTs = ts;
    const k = Math.min(40, dt);
    for (const b of blobs) {
      b.x += b.vx * k; b.y += b.vy * k;
      // Не позволяем пятнам заходить в центр: отражаем скорость при заходе в центральный круг
      const dx = b.x - 0.5, dy = b.y - 0.5;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.22) { b.vx = -b.vx; b.vy = -b.vy; b.x += b.vx * k; b.y += b.vy * k; }
      if (b.x < -0.2) b.x = 1.2; if (b.x > 1.2) b.x = -0.2;
      if (b.y < -0.2) b.y = 1.2; if (b.y > 1.2) b.y = -0.2;
    }
    draw();
    rafId = requestAnimationFrame(tick);
  }

  // Initial
  resize();
  genBlobs();
  // First paint
  const t0 = performance.now();
  draw();
  const t1 = performance.now();
  // console.log('BG first paint ms=', (t1 - t0).toFixed(1));

  // Resize with debounce
  let rto = 0;
  window.addEventListener('resize', () => {
    if (rto) clearTimeout(rto);
    rto = setTimeout(() => { resize(); draw(); }, Math.max(150, Math.min(200, 180)));
  }, { passive: true });

  if (opts.animate) rafId = requestAnimationFrame(tick);

  return {
    destroy() {
      try { if (rafId) cancelAnimationFrame(rafId); } catch {}
      try { cnv.remove(); } catch {}
      try { document.body.classList.remove('bg-active'); } catch {}
    }
  };
}


