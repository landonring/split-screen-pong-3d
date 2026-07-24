// ===========================================================================
// headtrack.js — steer your paddle with your head, using the webcam.
//
// Two detectors, best first:
//   1. The browser's built-in FaceDetector (Chrome/Edge shape-detection API) —
//      an actual face box, when it's available.
//   2. A skin-tone centroid fallback that works everywhere: the frame is
//      shrunk to 80×60, pixels in the YCbCr skin range are averaged, and the
//      centre of that blob is treated as your head.
//
// Everything runs locally on a <canvas>; no frames leave the device and
// nothing is recorded. `head.nx / head.ny` are 0..1 screen-space targets that
// main.js and poly.js read exactly like a mouse position.
// ===========================================================================

// Live tracking output, read every frame by the game.
export const head = {
  active: false,   // tracking is on AND we have a lock
  nx: 0.5,         // 0 = left edge of your view, 1 = right
  ny: 0.5,         // 0 = top, 1 = bottom
  seen: false,     // is a head visible right now?
};

const CAM_W = 160, CAM_H = 120;   // capture size we analyse (tiny = cheap)
const GRID_W = 80, GRID_H = 60;   // downscaled analysis grid

let video = null, work = null, wctx = null, preview = null, pctx = null;
let stream = null, raf = 0, running = false;
let detector = null, detectorBusy = false, detectorAt = 0;
let sensitivity = 0.5, mirror = true;
let centerX = 0.5, centerY = 0.5;   // calibration (where "straight ahead" is)
let needsCenter = true;
let rawX = 0.5, rawY = 0.5;         // smoothed raw head position in the frame
let lastSeen = 0;
let statusCb = null;

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
export function onStatus(cb) { statusCb = cb; }
function status(text, warn = false) { if (statusCb) statusCb(text, warn); }

export function setSensitivity(v) { sensitivity = Math.max(0, Math.min(1, v)); }
export function setMirror(v) { mirror = !!v; }
export function recenter() { needsCenter = true; }
export function isRunning() { return running; }

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------
export async function enable() {
  if (running) return true;
  if (!isSupported()) { status('This browser has no webcam access.', true); return false; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CAM_W }, height: { ideal: CAM_H }, facingMode: 'user' },
      audio: false,
    });
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    status(denied ? 'Camera blocked — allow camera access for this page, then try again.'
                  : 'No camera found.', true);
    return false;
  }

  if (!video) {
    video = document.createElement('video');
    video.playsInline = true; video.muted = true;
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;';
    document.body.appendChild(video);
  }
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* autoplay of a muted stream is allowed */ }

  if (!work) {
    work = document.createElement('canvas');
    work.width = GRID_W; work.height = GRID_H;
    wctx = work.getContext('2d', { willReadFrequently: true });
  }
  preview = document.getElementById('headcam');
  pctx = preview ? preview.getContext('2d') : null;

  // Native face detection when the browser has it; skin-tone blob otherwise.
  if (!detector && typeof window.FaceDetector !== 'undefined') {
    try { detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); } catch (e) { detector = null; }
  }

  running = true;
  head.active = false; head.seen = false;
  needsCenter = true;
  document.body.classList.add('headcam');
  status(detector ? 'Tracking with the browser\'s face detector — centre yourself in the preview.'
                  : 'Tracking on. Sit facing the camera in even light, then hit RECENTER.');
  loop();
  return true;
}

export function disable() {
  running = false;
  head.active = false; head.seen = false;
  if (raf) cancelAnimationFrame(raf), raf = 0;
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  if (video) video.srcObject = null;
  document.body.classList.remove('headcam');
  if (pctx && preview) pctx.clearRect(0, 0, preview.width, preview.height);
}

export async function toggle() {
  if (running) { disable(); return false; }
  return enable();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
// Skin-tone blob: average the position of pixels that look like skin. Robust
// enough for "where is the person", which is all we need.
function detectSkin(img) {
  const d = img.data;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = (y * GRID_W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r < 60 || r <= g || r <= b) continue;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (cb < 77 || cb > 127 || cr < 133 || cr > 175) continue;
      // Heads sit above hands/arms in frame, so weight the top of the frame up.
      const w = 1 + (1 - y / GRID_H);
      sx += x * w; sy += y * w; n += w;
    }
  }
  if (n < 25) return null;                       // too little skin — no lock
  return { x: sx / n / GRID_W, y: sy / n / GRID_H, area: n };
}

async function detectFace() {
  // FaceDetector is async; run it at ~15 Hz and reuse the last box in between.
  if (!detector || detectorBusy) return;
  const t = performance.now();
  if (t - detectorAt < 66) return;
  detectorBusy = true; detectorAt = t;
  try {
    const faces = await detector.detect(video);
    if (faces && faces.length) {
      const b = faces[0].boundingBox;
      const vw = video.videoWidth || CAM_W, vh = video.videoHeight || CAM_H;
      detector.last = { x: (b.x + b.width / 2) / vw, y: (b.y + b.height / 2) / vh, area: 999 };
    } else if (detector) {
      detector.last = null;
    }
  } catch (e) {
    detector = null;   // API present but unusable — fall back to skin tone
  }
  detectorBusy = false;
}

function loop() {
  if (!running) return;
  raf = requestAnimationFrame(loop);
  if (!video || video.readyState < 2) return;

  wctx.drawImage(video, 0, 0, GRID_W, GRID_H);

  let hit = null;
  if (detector) {
    detectFace();                      // fire-and-forget; updates detector.last
    hit = detector && detector.last;
  }
  if (!hit) hit = detectSkin(wctx.getImageData(0, 0, GRID_W, GRID_H));

  const t = performance.now();
  if (hit) {
    lastSeen = t;
    // Smooth the raw reading — webcam noise would otherwise jitter the paddle.
    rawX += (hit.x - rawX) * 0.35;
    rawY += (hit.y - rawY) * 0.35;
    if (needsCenter) { centerX = rawX; centerY = rawY; needsCenter = false; }
  }
  head.seen = t - lastSeen < 700;
  head.active = running && head.seen;

  // Offset from the calibrated centre, amplified so a small lean covers the
  // whole play area, then flipped for mirror mode (webcam view is mirrored).
  const gain = 1.6 + sensitivity * 4.0;
  let nx = 0.5 + (rawX - centerX) * gain;
  let ny = 0.5 + (rawY - centerY) * gain;
  if (mirror) nx = 1 - nx;
  head.nx = Math.max(0, Math.min(1, nx));
  head.ny = Math.max(0, Math.min(1, ny));

  drawPreview(hit);
}

function drawPreview(hit) {
  if (!pctx || !preview) return;
  const w = preview.width, h = preview.height;
  pctx.drawImage(video, 0, 0, w, h);
  // Calibrated centre.
  pctx.strokeStyle = 'rgba(120,180,255,.45)';
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(centerX * w, 0); pctx.lineTo(centerX * w, h);
  pctx.moveTo(0, centerY * h); pctx.lineTo(w, centerY * h);
  pctx.stroke();
  // Lock-on box.
  if (hit) {
    const bx = hit.x * w, by = hit.y * h;
    pctx.strokeStyle = '#35e04a'; pctx.lineWidth = 2;
    pctx.strokeRect(bx - 16, by - 16, 32, 32);
  } else {
    pctx.fillStyle = 'rgba(255,80,80,.75)';
    pctx.font = 'bold 11px system-ui, sans-serif';
    pctx.save(); pctx.scale(-1, 1);        // the preview is CSS-mirrored
    pctx.fillText('NO HEAD', -w + 8, h - 8);
    pctx.restore();
  }
}
