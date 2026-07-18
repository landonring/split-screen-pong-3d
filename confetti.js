// ===========================================================================
// confetti.js — lightweight full-screen confetti burst for win screens.
// A single overlay <canvas> (pointer-events: none, so banner buttons still
// work). burst() spawns falling paper; it auto-stops once everything lands.
// ===========================================================================
let canvas = null, ctx = null, raf = 0, running = false;
const pieces = [];
const COLORS = ['#35e04a', '#4d8dff', '#ff7a3c', '#b96bff', '#ffd23f', '#51e0ff', '#ff4dd2', '#ffffff'];

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}
function resize() { if (canvas) { canvas.width = window.innerWidth; canvas.height = window.innerHeight; } }

export function burst(count = 220) {
  ensureCanvas();
  const W = canvas.width, H = canvas.height;
  for (let i = 0; i < count; i++) {
    pieces.push({
      x: Math.random() * W,
      y: -20 - Math.random() * H * 0.4,
      vx: (Math.random() - 0.5) * 4,
      vy: 2 + Math.random() * 5,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 12,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      color: COLORS[(Math.random() * COLORS.length) | 0],
    });
  }
  if (!running) { running = true; canvas.style.display = 'block'; loop(); }
}

function loop() {
  raf = requestAnimationFrame(loop);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    p.vy += 0.07; p.vx *= 0.995;
    p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    if (p.y > canvas.height + 40) { pieces.splice(i, 1); continue; }
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  if (pieces.length === 0) {
    running = false; cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

export function stop() {
  pieces.length = 0;
  running = false;
  if (raf) cancelAnimationFrame(raf);
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}
