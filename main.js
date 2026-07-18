import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPolyGame } from './poly.js';
import * as Audio from './audio.js';
import * as Confetti from './confetti.js';
import { createCursor } from './cursor.js';
import { binds, setBind, resetBinds, BIND_META, keyLabel } from './binds.js';

const gameCursor = createCursor();

// ===========================================================================
// Renderer + scene
// ===========================================================================
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.Fog(0x05060a, 20, 58); // depth on the long arena

// Image-based lighting for nicer reflections on the lit paddle materials.
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
} catch (e) {
  console.warn('Environment map unavailable:', e);
}

// The .glb ships no lights, so add our own — soft, balanced, not blown out.
scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x0b0f1a, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(6, 24, 10);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 80;
key.shadow.camera.left = -20; key.shadow.camera.right = 20;
key.shadow.camera.top = 20; key.shadow.camera.bottom = -20;
key.shadow.bias = -0.0005;
scene.add(key);
const fill = new THREE.DirectionalLight(0x6f8cff, 0.35);
fill.position.set(-8, 10, -12);
scene.add(fill);

// ===========================================================================
// Shared glow sprite texture (soft radial gradient, used for ball/pickup glow
// and particles). Additive-blended so it reads over the unlit textured arena.
// ===========================================================================
const GLOW_TEX = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
function makeGlow(color, worldScale) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: GLOW_TEX, color, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true,
  }));
  s.scale.setScalar(worldScale);
  return s;
}

// ===========================================================================
// Cameras (split-screen)
// ===========================================================================
const halfAspect = () => (window.innerWidth / 2) / window.innerHeight;
const cam1 = new THREE.PerspectiveCamera(55, halfAspect(), 0.1, 1000);
const cam2 = new THREE.PerspectiveCamera(55, halfAspect(), 0.1, 1000);
const CAM_BACK = 12; // distance behind each paddle plane (third-person)
const FP_FOV = 74;   // wide, immersive field of view for first-person
let viewMode = 'third'; // 'third' | 'first'

// Set FOV + aspect for the current view mode. Call on load, resize, and when
// the view is toggled. Positioning is done separately (every frame) so the
// first-person camera can follow the paddle.
function fovForAspect(aspect) {
  if (viewMode !== 'third') return FP_FOV;
  const hx = (bounds.maxX - bounds.minX) / 2 + 0.8;
  const hy = (bounds.maxY - bounds.minY) / 2 + 0.9;
  const D = CAM_BACK - 0.4;
  const vfovH = 2 * Math.atan(hy / D);
  const vfovW = 2 * Math.atan((hx / D) / aspect);
  return THREE.MathUtils.radToDeg(Math.max(vfovH, vfovW)) * 1.08;
}
function frameCameras() {
  if (!bounds) return;
  // Solo (vs bot) renders cam1 full-screen; split screen uses half-width halves.
  const a1 = botEnabled ? (window.innerWidth / window.innerHeight) : halfAspect();
  const a2 = halfAspect();
  cam1.fov = fovForAspect(a1); cam1.aspect = a1; cam1.updateProjectionMatrix();
  cam2.fov = fovForAspect(a2); cam2.aspect = a2; cam2.updateProjectionMatrix();
  positionCameras();
}

// Place both cameras for the current view mode + current paddle positions.
function positionCameras() {
  if (!bounds || !P1) return;
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;
  if (viewMode === 'third') {
    // Behind each paddle, framing the whole arena.
    cam1.position.set(midX, midY, paddle1Z + CAM_BACK); cam1.lookAt(midX, midY, 0);
    cam2.position.set(midX, midY, paddle2Z - CAM_BACK); cam2.lookAt(midX, midY, 0);
  } else {
    // At the paddle, just in front of it, looking down-arena at the opponent.
    cam1.position.set(P1.obj.position.x, P1.obj.position.y + 0.2, paddle1Z - 0.6);
    cam1.lookAt(midX, midY, paddle2Z);
    cam2.position.set(P2.obj.position.x, P2.obj.position.y + 0.2, paddle2Z + 0.6);
    cam2.lookAt(midX, midY, paddle1Z);
  }
}

// ===========================================================================
// Tunables
// ===========================================================================
const WIN_SCORE = 10;
const PADDLE_SPEED = 9;
const BALL_SPEED = 11;
const MAX_BALLS = 4;

// Spin / Magnus
const SPIN_FROM_PADDLE = 0.55;  // how much paddle motion becomes spin
const SPIN_FROM_OFFSET = 1.2;   // how much off-center contact becomes spin
const MAGNUS_K = 0.045;         // curve strength (accel = k * spin × vel)
const SPIN_DECAY = 0.4;         // per-second spin damping

// Power-ups
const PU_SPAWN_MIN = 5, PU_SPAWN_MAX = 9; // seconds between spawns
const PU_MAX_ACTIVE = 2;
const PU_RADIUS = 0.7;
const MAGNET_TIME = 20, MAGNET_ACCEL = 7;
const GROW_TIME = 9, GROW_FACTOR = 1.7;
const SPEED_TIME = 6, SPEED_MUL = 1.5;
const SPIN_TIME = 6, ARENA_SPIN_RATE = 0.9;   // arena spins; the ball swirls with it
const VINE_TIME = 7, VINE_SLOW = 0.1;         // vines slow the opponent to 10% speed
const ZAXIS = new THREE.Vector3(0, 0, 1);

// Hail: falls from the ceiling, deflects the ball, and can knock loose a power-up.
const HAIL_MAX = 40;
const HAIL_R = 0.16;
const HAIL_SPEED = 8;
const HAIL_SPAWN = 0.3;      // seconds between hailstones
const HAIL_KNOCK = 4;        // how hard it deflects the ball
const HAIL_PU_CHANCE = 0.22; // chance a ball-struck hailstone drops a power-up
const HAIL_PU_CAP = 3;

// Shotgun power-up: 5 shots, each a spread of pellets that knock the ball back
const SHOTGUN_AMMO = 5;
const PELLETS = 6;
const BULLET_SPEED = 32;
const BULLET_SPREAD = 6;   // lateral spread velocity
const BULLET_LIFE = 0.7;
const BULLET_R = 0.18;
const FIRE_COOLDOWN = 0.25;

const PU_TYPES = {
  MULTIBALL: { color: 0x51e0ff, label: 'MULTI-BALL' },
  MAGNET:    { color: 0xff4dd2, label: 'MAGNET' },
  GROW:      { color: 0x5dff8f, label: 'BIG PADDLE' },
  SPEED:     { color: 0xffd23f, label: 'SPEED UP' },
  SHOTGUN:   { color: 0xff7a3c, label: 'SHOTGUN x5' },
  SPIN:      { color: 0xb96bff, label: 'SPIN ARENA' },
  VINE:      { color: 0x4a9e3a, label: 'VINES' },
};
const PU_KEYS = Object.keys(PU_TYPES);

// Bot difficulty. speed = fraction of a human's paddle speed; lead = how far it
// predicts the ball's intercept (0 = just chases, 1 = full prediction); error =
// random aim offset in world units (bigger = worse); react = seconds between
// target re-thinks (bigger = more sluggish); shoot = uses the shotgun.
const BOT_LEVELS = {
  EASY:   { speed: 0.10, lead: 0.35, error: 1.7, react: 0.30, shoot: false },
  MEDIUM: { speed: 0.50, lead: 0.80, error: 0.7, react: 0.13, shoot: true },
  HARD:   { speed: 1.05, lead: 1.00, error: 0.12, react: 0.0, shoot: true },
};

// ===========================================================================
// State
// ===========================================================================
let arena;                       // gltf root (identity transform == world)
let bounds;                      // { minX, maxX, minY, maxY }
let paddle1Z, paddle2Z;
let P1, P2;                      // paddle controllers
const balls = [];               // ball slots (pooled)
const powerups = [];            // active power-up objects
const bursts = [];              // particle bursts (pooled)
const bullets = [];             // shotgun pellets (pooled)
const hail = [];                // hailstones (pooled)
let hailTimer = 0;
let hailUntil = 0;              // hail only falls during an active HAIL storm
let puBag = [];                 // shuffle-bag so every power-up type appears
let gun1 = null, gun2 = null;   // shotgun models (held by paddles)
let vine1 = null, vine2 = null; // vine overlays (on slowed paddles)
let arenaSpinUntil = 0, arenaSpinAngle = 0;
let score1 = 0, score2 = 0;
let matchOver = false, ready = false, started = false;
let botEnabled = false;
let botLevel = 'MEDIUM'; // key into BOT_LEVELS
let playerCount = 2;     // 2 = classic; 3/4 = polygon mode
let polyGame = null;     // lazily-created N-player engine (poly.js)
let polyActive = false;  // when true the poly engine drives update/render
// Assets handed to the polygon engine once the models finish loading.
let glbWallMat = null, glbFloorMat = null, gunModelSrc = null;
let now = 0;                    // monotonic game time (seconds)
let nextSpawn = PU_SPAWN_MIN;
let speedMul = 1, speedUntil = 0;
let countdown = 0, goUntil = 0; // pre-serve 3-2-1 countdown

// HUD
const elP1 = document.querySelector('[data-p1]');
const elP2 = document.querySelector('[data-p2]');
const elP1fx = document.querySelector('[data-p1fx]');
const elP2fx = document.querySelector('[data-p2fx]');
const elP1ammo = document.querySelector('[data-p1ammo]');
const elP2ammo = document.querySelector('[data-p2ammo]');
const elP1shells = document.querySelector('[data-p1shells]');
const elP2shells = document.querySelector('[data-p2shells]');
const elP1gun = document.querySelector('[data-p1gun]');
const elP2gun = document.querySelector('[data-p2gun]');
const elToast = document.querySelector('[data-toast]');
const elBanner = document.getElementById('banner');
const elWinner = document.querySelector('[data-winner]');
const elFinalScore = document.querySelector('[data-finalscore]');
const elCount = document.getElementById('countdown');
const elStart = document.getElementById('start');
const elView = document.getElementById('viewhint');
document.querySelector('[data-goal]').textContent = `FIRST TO ${WIN_SCORE}`;

function toggleView() {
  if (!ready) return;
  viewMode = viewMode === 'third' ? 'first' : 'third';
  frameCameras();
  elView.textContent = `VIEW: ${viewMode === 'third' ? '3RD' : '1ST'} PERSON · C or △ to switch`;
}

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------
function startGame(bot) {
  if (started || !ready) return;
  Audio.unlock();
  if (playerCount > 2) { startPolyMode(); return; }
  started = true;
  botEnabled = !!bot;
  Confetti.stop();
  Audio.startMusic('game');
  const p2name = document.querySelector('[data-p2name]');
  if (p2name) p2name.textContent = botEnabled ? `BOT · ${botLevel}` : 'PLAYER 2';
  const p2key = document.querySelector('[data-p2key]');
  if (p2key) p2key.textContent = botEnabled ? 'AUTO' : '/ or R2';
  // Solo (vs bot) → one full-screen view; 2-player → split screen.
  document.body.classList.toggle('solo', botEnabled);
  document.body.classList.remove('pregame');
  elStart.classList.add('hidden');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  frameCameras();          // aspect differs between solo and split
  balls.forEach(deactivateBall);
  countdown = 3;           // ball serves when the countdown ends
  showCount('3');
}

// ---- Polygon (3/4-player) mode entry/exit ----
function startPolyMode() {
  if (!polyGame) {
    polyGame = createPolyGame(renderer, {
      wallMaterial: glbWallMat, floorMaterial: glbFloorMat,
      environment: scene.environment, gunModel: gunModelSrc,
      onExit: exitPolyMode,
    });
  }
  started = true; polyActive = true;
  elStart.classList.add('hidden');
  document.body.classList.remove('pregame');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  polyGame.start(playerCount);
}
function exitPolyMode() {
  // Called by poly.js after it tears down its own HUD/listeners.
  polyActive = false; started = false;
  Confetti.stop();
  Audio.startMusic('menu');
  document.body.classList.add('pregame');
  elStart.classList.remove('hidden');
  frameCameras();
}

function showCount(text) {
  elCount.textContent = text;
  elCount.style.display = 'block';
  elCount.classList.remove('pop');
  void elCount.offsetWidth;  // restart the pop animation
  elCount.classList.add('pop');
  Audio.play(text === 'GO!' ? 'go' : 'count');
}
// Mode switch: OFF = 2 players, ON = 1 player vs bot.
let selectedBot = false;
const elSwitch = document.querySelector('[data-modeswitch]');
const elOpt2p = document.querySelector('[data-opt2p]');
const elOpt1p = document.querySelector('[data-opt1p]');
const elDiff = document.querySelector('[data-difficulty]');
const diffBtns = Array.from(document.querySelectorAll('[data-diff]'));
const elModeswitch = document.querySelector('#start .modeswitch');
const pcBtns = Array.from(document.querySelectorAll('[data-pc]'));
function setPlayerCount(n) {
  playerCount = n;
  pcBtns.forEach((b) => b.classList.toggle('active', +b.dataset.pc === n));
  // Bot / difficulty only apply to the classic 2-player game.
  if (elModeswitch) elModeswitch.style.display = n === 2 ? 'flex' : 'none';
  setMode(selectedBot); // refreshes the difficulty visibility for the new count
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function setMode(bot) {
  selectedBot = bot;
  elSwitch.classList.toggle('on', selectedBot);
  elSwitch.setAttribute('aria-checked', String(selectedBot));
  elOpt2p.classList.toggle('active', !selectedBot);
  elOpt1p.classList.toggle('active', selectedBot);
  elDiff.style.display = (playerCount === 2 && selectedBot) ? 'flex' : 'none'; // skill only matters vs bot
  // Drop focus so a later Space/Enter (to start) doesn't re-toggle this button.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function setDifficulty(lvl) {
  botLevel = lvl;
  diffBtns.forEach((b) => b.classList.toggle('active', b.dataset.diff === lvl));
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
elSwitch.addEventListener('click', () => setMode(!selectedBot));
elOpt2p.addEventListener('click', () => setMode(false));
elOpt1p.addEventListener('click', () => setMode(true));
diffBtns.forEach((b) => b.addEventListener('click', () => setDifficulty(b.dataset.diff)));
pcBtns.forEach((b) => b.addEventListener('click', () => setPlayerCount(+b.dataset.pc)));
setDifficulty('MEDIUM');
setPlayerCount(2);
setMode(false);

document.querySelector('[data-play]').addEventListener('click', () => startGame(selectedBot));
document.getElementById('fsCorner').addEventListener('click', toggleFullscreen);
document.querySelector('[data-fsmenu]').addEventListener('click', toggleFullscreen);
document.querySelector('[data-rematch]').addEventListener('click', () => restartMatch());
document.querySelector('[data-menu]').addEventListener('click', () => returnToMenu());

// ---------------------------------------------------------------------------
// Settings (volumes, cursor sensitivity, keybinds) — persisted to localStorage
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'splitpong.settings';
const settings = Object.assign(
  { master: 0.8, music: 0.6, ball: 0.85, gun: 0.7, sensitivity: 0.5 },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; } })(),
);
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }
function applySetting(key) {
  if (key === 'sensitivity') gameCursor.setSensitivity(settings.sensitivity);
  else Audio.setVolume(key, settings[key]);
}
for (const k of Object.keys(settings)) applySetting(k); // apply saved values on load

const elSettings = document.getElementById('settings');
const elSetBinds = document.getElementById('setbinds');

function syncSliders() {
  document.querySelectorAll('#settings .setslider').forEach((sl) => {
    const key = sl.dataset.vol;
    sl.value = settings[key];
    const pct = document.querySelector(`[data-pct="${key}"]`);
    if (pct) pct.textContent = Math.round(settings[key] * 100) + '%';
  });
}
document.querySelectorAll('#settings .setslider').forEach((sl) => {
  const key = sl.dataset.vol;
  sl.addEventListener('input', () => {
    settings[key] = parseFloat(sl.value);
    const pct = document.querySelector(`[data-pct="${key}"]`);
    if (pct) pct.textContent = Math.round(settings[key] * 100) + '%';
    applySetting(key);
    saveSettings();
  });
});

function renderBinds() {
  elSetBinds.innerHTML = '';
  for (const sec of BIND_META) {
    const h = document.createElement('div'); h.className = 'setsec'; h.textContent = sec.group;
    h.style.marginTop = '6px';
    elSetBinds.appendChild(h);
    for (const [action, label] of sec.items) {
      const row = document.createElement('div'); row.className = 'bindrow';
      const lab = document.createElement('span'); lab.className = 'setlabel'; lab.textContent = label;
      const btn = document.createElement('button'); btn.className = 'bindkey'; btn.textContent = keyLabel(binds[action]);
      btn.addEventListener('click', () => captureBind(action, btn));
      row.appendChild(lab); row.appendChild(btn);
      elSetBinds.appendChild(row);
    }
  }
}
function captureBind(action, btn) {
  capturingBind = true;
  btn.classList.add('capturing');
  btn.textContent = 'PRESS…';
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    const k = e.key.toLowerCase();
    if (k !== 'escape') setBind(action, k);
    window.removeEventListener('keydown', onKey, true);
    capturingBind = false;
    btn.classList.remove('capturing');
    renderBinds(); // refresh labels (a key may now be shared)
  };
  window.addEventListener('keydown', onKey, true);
}
document.getElementById('resetBinds').addEventListener('click', () => { resetBinds(); renderBinds(); });

function openSettings() { settingsOpen = true; syncSliders(); renderBinds(); elSettings.classList.remove('hidden'); }
function closeSettings() { settingsOpen = false; elSettings.classList.add('hidden'); }
document.getElementById('settingsMenuBtn').addEventListener('click', openSettings);
document.getElementById('closeSettings').addEventListener('click', closeSettings);

// In-battle home button → back to the menu (works for both modes).
document.getElementById('homeBtn').addEventListener('click', () => {
  if (polyActive) { if (polyGame) polyGame.goHome(); }
  else returnToMenu();
});

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}

// Controller buttons (edge-detected). Cross/Options starts a match AND
// rematches (same button); Triangle switches the camera view; L1/R1 toggles
// the mode on the menu. Runs every frame from the render loop.
const padEdge = {};
function padPressed(pad, i) {
  const down = !!(pad.buttons[i] && pad.buttons[i].pressed);
  const edge = down && !padEdge[i];
  padEdge[i] = down;
  return edge;
}
function pollPad() {
  const pad = getPad();
  if (!pad) { for (const k in padEdge) padEdge[k] = false; return; }
  const cross = padPressed(pad, 0);
  const options = padPressed(pad, 9);
  const triangle = padPressed(pad, 3);
  const l1 = padPressed(pad, 4);
  const r1 = padPressed(pad, 5);
  const startBtn = cross || options;

  if (triangle) toggleView();               // △ = camera view
  if (!started) {
    if (l1 || r1) setMode(!selectedBot);     // L1/R1 = 2P / bot
    if (startBtn) startGame(selectedBot);    // ✕ = start match
  } else if (matchOver) {
    if (startBtn) restartMatch();            // ✕ = rematch (same button)
    if (l1 || r1) returnToMenu();
  }
}

// ===========================================================================
// Input
// ===========================================================================
const keys = new Set();
let capturingBind = false; // true while the settings panel is capturing a new key
let settingsOpen = false;
window.addEventListener('keydown', (e) => {
  if (capturingBind) return; // the capture handler owns the keyboard right now
  const k = e.key.toLowerCase();
  keys.add(k);
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', '/'].includes(k)) e.preventDefault();
  if (settingsOpen) return;  // don't fire game actions while settings is open
  if (!started && (k === ' ' || k === 'enter')) startGame(selectedBot);
  if (!started && k === '1') { setMode(true); startGame(true); }
  if (!started && k === '2') { setMode(false); startGame(false); }
  if (k === binds.fullscreen) toggleFullscreen();
  if (k === binds.view) toggleView();
  if (k === binds.mute) Audio.toggleMuted();
  if (k === binds.rematch && matchOver) restartMatch();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// ---- Touch controls (tablet): drag your paddle within your half ----
let p1Touch = null, p2Touch = null;
function mapTouchToBounds(nx, ny, side) {
  nx = Math.max(0, Math.min(1, nx)); ny = Math.max(0, Math.min(1, ny));
  const bx = side > 0 ? THREE.MathUtils.lerp(bounds.minX, bounds.maxX, nx)
                      : THREE.MathUtils.lerp(bounds.maxX, bounds.minX, nx); // P2 view is mirrored
  const by = THREE.MathUtils.lerp(bounds.maxY, bounds.minY, ny);           // screen-top = high
  return { x: bx, y: by };
}
function handleClassicTouch(e) {
  if (polyActive || !bounds || !started || matchOver) return;
  e.preventDefault();
  p1Touch = null; p2Touch = null;
  const w = window.innerWidth, h = window.innerHeight;
  for (const t of e.touches) {
    const x = t.clientX, y = t.clientY;
    if (botEnabled) p1Touch = mapTouchToBounds(x / w, y / h, +1);          // solo = full screen
    else if (x < w / 2) p1Touch = mapTouchToBounds(x / (w / 2), y / h, +1); // left half = P1
    else p2Touch = mapTouchToBounds((x - w / 2) / (w / 2), y / h, -1);      // right half = P2
  }
}
canvas.addEventListener('touchstart', handleClassicTouch, { passive: false });
canvas.addEventListener('touchmove', handleClassicTouch, { passive: false });
canvas.addEventListener('touchend', handleClassicTouch, { passive: false });
canvas.addEventListener('touchcancel', handleClassicTouch, { passive: false });

// Browsers block audio until a user gesture, so we can't autoplay on load.
// Show a small hint, then on the first interaction unlock the audio engine and
// start the home-screen music (unless a match is already under way).
const soundHint = document.createElement('div');
soundHint.textContent = '🔊 click or press any key for sound';
soundHint.style.cssText = 'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);' +
  'z-index:40;font-family:"Segoe UI",Roboto,system-ui,sans-serif;font-size:12px;letter-spacing:2px;' +
  'color:#eaf2ff;opacity:.75;background:rgba(10,16,30,.5);border:1px solid rgba(120,180,255,.25);' +
  'padding:8px 16px;border-radius:999px;pointer-events:none;animation:pulse 1.8s ease-in-out infinite;';
document.body.appendChild(soundHint);

function primeAudio() {
  Audio.unlock();
  if (!started && !polyActive) Audio.startMusic('menu');
  soundHint.remove();
  window.removeEventListener('pointerdown', primeAudio);
  window.removeEventListener('keydown', primeAudio);
}
window.addEventListener('pointerdown', primeAudio);
window.addEventListener('keydown', primeAudio);

// ===========================================================================
// Load model
// ===========================================================================
const MODEL_URL = './Untitled.glb?v=textured-2';
new GLTFLoader().load(MODEL_URL, (gltf) => {
  arena = gltf.scene;
  scene.add(arena);
  arena.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const find = (n) => arena.getObjectByName(n) || arena.getObjectByName(n.replace(/\./g, ''));
  const paddle1 = find('Cube');
  const paddle2 = find('Cube.001');
  const ballMesh = find('Sphere');
  const wallA = find('Plane.001'), wallB = find('Plane.002');
  const floor = find('Plane'), ceil = find('Plane.005');
  const backA = find('Plane.003'), backB = find('Plane.004');
  if (backA) backA.visible = false;
  if (backB) backB.visible = false;

  for (const [k, v] of Object.entries({ paddle1, paddle2, ballMesh, wallA, wallB, floor, ceil }))
    if (!v) console.error('Model object not found:', k);

  const box = (o) => new THREE.Box3().setFromObject(o);
  const bWallA = box(wallA), bWallB = box(wallB);
  const bBall = box(ballMesh), bP1 = box(paddle1), bP2 = box(paddle2);
  const bFloor = box(floor), bCeil = box(ceil);

  const ballR = (bBall.max.x - bBall.min.x) / 2;
  const left = bWallA.getCenter(new THREE.Vector3()).x < bWallB.getCenter(new THREE.Vector3()).x ? bWallA : bWallB;
  const right = left === bWallA ? bWallB : bWallA;
  let minX = left.max.x, maxX = right.min.x;
  if (!(maxX > minX)) { minX = -3.5; maxX = 3.5; }
  const minY = bFloor.max.y;
  const maxY = Math.max(bCeil.min.y, minY + 6);
  bounds = { minX, maxX, minY, maxY };

  paddle1Z = paddle1.position.z;
  paddle2Z = paddle2.position.z;

  // Grab the brick/wood materials so the polygon arena can reuse the look.
  const matOf = (o) => o && (Array.isArray(o.material) ? o.material[0] : o.material);
  glbWallMat = matOf(wallA) || matOf(wallB);
  glbFloorMat = matOf(floor);

  // Paddle controllers -----------------------------------------------------
  const mkPaddle = (obj, z, side, box3, color) => ({
    obj, z, side, color,
    half: { x: (box3.max.x - box3.min.x) / 2, y: (box3.max.y - box3.min.y) / 2 },
    baseHalf: { x: (box3.max.x - box3.min.x) / 2, y: (box3.max.y - box3.min.y) / 2 },
    baseScale: obj.scale.clone(),
    vel: new THREE.Vector3(), prev: obj.position.clone(),
    growUntil: 0, magnetUntil: 0, slowUntil: 0, ammo: 0, fireReady: 0,
    botNextThink: 0, botTargetX: 0, botTargetY: 0,
  });
  P1 = mkPaddle(paddle1, paddle1Z, +1, bP1, 0x35e04a);
  P2 = mkPaddle(paddle2, paddle2Z, -1, bP2, 0x4d8dff);

  // Ball pool --------------------------------------------------------------
  // Clone a pristine (glow-free) reference so extra balls don't inherit glows.
  const glowScale = (ballR * 2 * 2.6) / ballMesh.scale.x; // compensate node scale
  const pristine = ballMesh.clone();
  for (let i = 0; i < MAX_BALLS; i++) {
    const mesh = i === 0 ? ballMesh : pristine.clone();
    if (i > 0) arena.add(mesh);
    mesh.visible = false;
    const glow = makeGlow(0xfff2c4, glowScale); // child sprite auto-follows the ball
    mesh.add(glow);
    balls.push({ mesh, glow, vel: new THREE.Vector3(), spin: new THREE.Vector3(),
      radius: ballR, lastHitter: null, active: false });
  }

  // Particle bursts pool ---------------------------------------------------
  for (let i = 0; i < 8; i++) bursts.push(makeBurst());

  // Shotgun bullet pool ----------------------------------------------------
  const bulletGeo = new THREE.SphereGeometry(BULLET_R, 8, 8);
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffb14a });
  for (let i = 0; i < 60; i++) {
    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    mesh.visible = false;
    mesh.add(makeGlow(0xffb14a, BULLET_R * 6));
    arena.add(mesh);
    bullets.push({ mesh, vel: new THREE.Vector3(), life: 0, owner: null });
  }

  // Vine overlays (shown on a slowed paddle) --------------------------------
  vine1 = makeVines(); vine2 = makeVines();
  scene.add(vine1, vine2);
  vine1.visible = vine2.visible = false;

  // Hail pool (falls from the ceiling) --------------------------------------
  const hailGeo = new THREE.IcosahedronGeometry(HAIL_R, 0);
  const hailMat = new THREE.MeshStandardMaterial({
    color: 0xcfeaff, emissive: 0x2a4a66, emissiveIntensity: 0.4, roughness: 0.2, metalness: 0.1,
  });
  for (let i = 0; i < HAIL_MAX; i++) {
    const mesh = new THREE.Mesh(hailGeo, hailMat);
    mesh.visible = false;
    arena.add(mesh); // arena frame → rolls with the spin power-up
    hail.push({ mesh, vel: new THREE.Vector3(), active: false });
  }

  frameCameras();
  ready = true; // wait for the start screen before serving

}, undefined, (err) => console.error('Failed to load model', err));

// ===========================================================================
// Shotgun model — held by each paddle in world space, so it sits on the
// character (visible in third person) and both players see the opponent's gun.
// ===========================================================================
const GUN_URL = './shotgun.glb?v=1';
const GUN_LEN = 0.95;                       // world size of the gun
const GUN_ROT = new THREE.Euler(0, 0, 0);   // model orientation (barrel toward -Z)
const GUN_FWD = 0.7;                        // how far in front of the paddle it sits
const GUN_SIDE = 0.18;                      // lateral offset
const GUN_DOWN = 0.05;                      // vertical offset

function makeGunRig(model) {
  const inner = new THREE.Group();
  inner.rotation.copy(GUN_ROT);
  inner.add(model);
  const rig = new THREE.Group();
  rig.add(inner);
  rig.userData.recoil = 0;
  return rig;
}

new GLTFLoader().load(GUN_URL, (g) => {
  const src = g.scene;
  // Normalize: scale so the longest side == GUN_LEN, then recenter at origin.
  const size = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  src.scale.multiplyScalar(GUN_LEN / maxDim);
  const c = new THREE.Box3().setFromObject(src).getCenter(new THREE.Vector3());
  src.position.sub(c);

  gunModelSrc = src.clone(); // pristine copy for the polygon arena to clone
  gun1 = makeGunRig(src);
  gun2 = makeGunRig(src.clone());
  scene.add(gun1, gun2);                    // world-space (rendered by both cameras)
  gun1.visible = gun2.visible = false;
}, undefined, (err) => console.warn('Shotgun model failed to load:', err));

function updateGuns(dt) {
  updateGun(gun1, P1, +1, dt);
  updateGun(gun2, P2, -1, dt);
}
function updateGun(g, p, side, dt) {
  if (!g) return;
  const r = g.userData.recoil = Math.max(0, g.userData.recoil - dt * 6);
  g.visible = started && p.ammo > 0 && !arenaSpinning(); // world-space; hide while arena rolls
  if (!g.visible) return;
  const fwd = -side; // toward the opponent
  g.position.set(
    p.obj.position.x + GUN_SIDE * side,
    p.obj.position.y - GUN_DOWN,
    p.z + fwd * (GUN_FWD - r * 0.3), // recoil pulls it back toward the owner
  );
  g.rotation.set(r * 0.3, side > 0 ? 0 : Math.PI, 0); // face down-arena, muzzle rises on recoil
}

// ---- Vines (leafy rings that wrap a slowed paddle) ----
function makeVines() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3f8f36, emissive: 0x0f2e0c, emissiveIntensity: 0.5, roughness: 0.75,
  });
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.11, 8, 18), mat);
    ring.position.y = -1.1 + i * 0.75;
    ring.rotation.x = Math.PI / 2;   // lie flat → wraps around the vertical paddle
    ring.rotation.z = i * 0.6;
    g.add(ring);
  }
  return g;
}
function updateVines() {
  updateVine(vine1, P1);
  updateVine(vine2, P2);
}
function updateVine(v, p) {
  if (!v) return;
  v.visible = started && p.slowUntil > now && !arenaSpinning(); // world-space; hide while spinning
  if (!v.visible) return;
  v.position.copy(p.obj.position);
  v.rotation.y += 0.03;
}

// ---- Arena spin power-up: the whole arena rolls about its center. The ball,
// paddles, bullets and power-ups are all children of `arena`, so they roll with
// it automatically; physics stays in the arena's local frame, camera is fixed. ----
function updateArenaSpin(dt) {
  if (!arena || !bounds) return;
  if (arenaSpinUntil > now) {
    arenaSpinAngle += ARENA_SPIN_RATE * dt;
  } else if (arenaSpinAngle !== 0) {
    const target = Math.round(arenaSpinAngle / (Math.PI * 2)) * (Math.PI * 2); // nearest level
    arenaSpinAngle = THREE.MathUtils.damp(arenaSpinAngle, target, 4, dt);
    if (Math.abs(arenaSpinAngle - target) < 0.004) arenaSpinAngle = 0;
  }
  // Rotate about the arena centre (cx, cy) on the Z axis: position = C - R·C.
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  const a = arenaSpinAngle, cos = Math.cos(a), sin = Math.sin(a);
  arena.rotation.z = a;
  arena.position.x = cx - (cx * cos - cy * sin);
  arena.position.y = cy - (cx * sin + cy * cos);
}
function arenaSpinning() { return arenaSpinAngle !== 0; }

// ===========================================================================
// Balls
// ===========================================================================
function activeBalls() { return balls.filter((b) => b.active); }

function activateBall(slot, pos, vel, hitter) {
  slot.active = true;
  slot.mesh.visible = true;
  slot.mesh.position.copy(pos);
  slot.vel.copy(vel);
  slot.spin.set(0, 0, 0);
  slot.lastHitter = hitter ?? null;
}
function deactivateBall(slot) { slot.active = false; slot.mesh.visible = false; }

function serveInitial(dir) {
  balls.forEach(deactivateBall);
  const midY = (bounds.minY + bounds.maxY) / 2;
  const ang = (Math.random() - 0.5) * 0.8;
  const yv = (Math.random() - 0.5) * 0.5;
  const v = new THREE.Vector3(Math.sin(ang), yv, dir * Math.cos(ang)).normalize().multiplyScalar(BALL_SPEED * speedMul);
  activateBall(balls[0], new THREE.Vector3(0, midY, 0), v, null);
}

function spawnExtraBall(src) {
  const slot = balls.find((b) => !b.active);
  if (!slot) return;
  const v = src.vel.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() < 0.5 ? 1 : -1) * 0.5);
  activateBall(slot, src.mesh.position.clone(), v, src.lastHitter);
}

// ===========================================================================
// Update
// ===========================================================================
function update(dt) {
  if (!ready || !started || matchOver) return;
  now += dt;

  // Pre-serve countdown: paddles can move, but the ball waits.
  if (countdown > 0) {
    const before = Math.ceil(countdown);
    countdown -= dt;
    if (countdown > 0) {
      const after = Math.ceil(countdown);
      if (after !== before) showCount(String(after));
    } else {
      showCount('GO!');
      goUntil = now + 0.7;
      nextSpawn = now + PU_SPAWN_MIN;
      serveInitial(Math.random() < 0.5 ? 1 : -1);
    }
    updatePaddles(dt);
    return;
  }
  if (goUntil && now > goUntil) { elCount.style.display = 'none'; goUntil = 0; }

  updatePaddles(dt);
  updateFire(dt);
  updateEffects();
  updateArenaSpin(dt);
  updateBalls(dt);
  updateBullets(dt);
  updateHail(dt);
  updatePowerups(dt);
  updateBursts(dt);
  updateVines();
  updateHudFx();
}

// ---- Gamepad helpers (PS4 via the Standard mapping) ----
const DEADZONE = 0.18;
function getPad() {
  const list = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = 0; i < list.length; i++) if (list[i]) return list[i];
  return null;
}
function axis(pad, i) { const v = pad ? pad.axes[i] || 0 : 0; return Math.abs(v) < DEADZONE ? 0 : v; }
function padBtn(pad, i) { return !!(pad && pad.buttons[i] && pad.buttons[i].pressed); }

function updatePaddles(dt) {
  const pad = getPad();
  const s1 = PADDLE_SPEED * dt * (P1.slowUntil > now ? VINE_SLOW : 1);
  const s2 = PADDLE_SPEED * dt * (P2.slowUntil > now ? VINE_SLOW : 1);

  // P1: bound keys + left stick
  let p1x = 0, p1y = 0;
  if (keys.has(binds.p1Left)) p1x -= 1;
  if (keys.has(binds.p1Right)) p1x += 1;
  if (keys.has(binds.p1Up)) p1y += 1;
  if (keys.has(binds.p1Down)) p1y -= 1;
  p1x += axis(pad, 0);     // left stick X
  p1y += -axis(pad, 1);    // left stick Y (up is negative)
  P1.obj.position.x += p1x * s1;
  P1.obj.position.y += p1y * s1;

  // P2: bot AI, or bound keys + right stick (X inverted — cam2 faces the other way)
  if (botEnabled) {
    botMove(dt);
  } else {
    let p2x = 0, p2y = 0;
    if (keys.has(binds.p2Left)) p2x += 1;
    if (keys.has(binds.p2Right)) p2x -= 1;
    if (keys.has(binds.p2Up)) p2y += 1;
    if (keys.has(binds.p2Down)) p2y -= 1;
    p2x += -axis(pad, 2);  // right stick X (inverted to match the view)
    p2y += -axis(pad, 3);  // right stick Y
    P2.obj.position.x += p2x * s2;
    P2.obj.position.y += p2y * s2;
  }

  // Touch drag overrides keyboard/stick for that paddle this frame.
  if (p1Touch) { P1.obj.position.x = p1Touch.x; P1.obj.position.y = p1Touch.y; }
  if (p2Touch && !botEnabled) { P2.obj.position.x = p2Touch.x; P2.obj.position.y = p2Touch.y; }

  for (const p of [P1, P2]) {
    p.obj.position.x = THREE.MathUtils.clamp(p.obj.position.x, bounds.minX + p.half.x, bounds.maxX - p.half.x);
    p.obj.position.y = THREE.MathUtils.clamp(p.obj.position.y, bounds.minY + p.half.y, bounds.maxY - p.half.y);
    p.obj.position.z = p.z; // Z locked
    p.vel.copy(p.obj.position).sub(p.prev).divideScalar(Math.max(dt, 1e-4));
    p.prev.copy(p.obj.position);
  }
}

// Bot controls P2. Behaviour scales with the chosen difficulty: speed,
// prediction (lead), aim error, and reaction lag.
function botThink(cfg) {
  const p = P2;
  const live = balls.filter((b) => b.active);
  if (live.length === 0) {
    p.botTargetX = (bounds.minX + bounds.maxX) / 2;
    p.botTargetY = (bounds.minY + bounds.maxY) / 2;
    return;
  }
  let target = null, soonest = Infinity;
  for (const b of live) {
    if (b.vel.z < 0) { // heading toward P2 (-Z)
      const time = (b.mesh.position.z - p.z) / -b.vel.z;
      if (time > 0 && time < soonest) { soonest = time; target = b; }
    }
  }
  let tx, ty;
  if (target) {
    // Predict the intercept — smarter levels lead the ball further.
    const t = Math.min(soonest, 2.5) * cfg.lead;
    tx = target.mesh.position.x + target.vel.x * t;
    ty = target.mesh.position.y + target.vel.y * t;
  } else {
    let nearest = live[0], nd = Infinity;
    for (const b of live) {
      const d = Math.abs(b.mesh.position.z - p.z);
      if (d < nd) { nd = d; nearest = b; }
    }
    tx = nearest.mesh.position.x;
    ty = nearest.mesh.position.y;
  }
  // Aim error (dumber levels miss by more).
  tx += (Math.random() - 0.5) * cfg.error;
  ty += (Math.random() - 0.5) * cfg.error;
  p.botTargetX = THREE.MathUtils.clamp(tx, bounds.minX, bounds.maxX);
  p.botTargetY = THREE.MathUtils.clamp(ty, bounds.minY, bounds.maxY);
}

function botMove(dt) {
  const p = P2;
  const cfg = BOT_LEVELS[botLevel] || BOT_LEVELS.MEDIUM;
  const s = PADDLE_SPEED * cfg.speed * dt * (p.slowUntil > now ? VINE_SLOW : 1);

  // Re-think the target only every `react` seconds → reaction lag.
  if (now >= p.botNextThink) {
    p.botNextThink = now + cfg.react;
    botThink(cfg);
  }
  const dx = p.botTargetX - p.obj.position.x, dy = p.botTargetY - p.obj.position.y;
  if (Math.abs(dx) > 0.03) p.obj.position.x += Math.sign(dx) * Math.min(s, Math.abs(dx));
  if (Math.abs(dy) > 0.03) p.obj.position.y += Math.sign(dy) * Math.min(s, Math.abs(dy));
}

// ===========================================================================
// Shotgun firing + bullets
// ===========================================================================
const firePrev = { 1: false, 2: false };
function updateFire() {
  const pad = getPad();
  const p1fire = padBtn(pad, 6) || keys.has(binds.p1Shoot);   // L2 or bound key
  const p2fire = padBtn(pad, 7) || keys.has(binds.p2Shoot);   // R2 or bound key
  if (p1fire && !firePrev[1]) fireShotgun(P1);
  if (p2fire && !firePrev[2] && !botEnabled) fireShotgun(P2);
  firePrev[1] = p1fire;
  firePrev[2] = p2fire;

  // Bot fires its shotgun at an incoming ball (smarter levels only).
  if (botEnabled && (BOT_LEVELS[botLevel] || {}).shoot && P2.ammo > 0 && now >= P2.fireReady) {
    for (const ball of balls) {
      if (ball.active && ball.vel.z < 0 && Math.abs(ball.mesh.position.z - P2.z) < 6) {
        fireShotgun(P2); break;
      }
    }
  }
}

function fireShotgun(p) {
  if (p.ammo <= 0 || now < p.fireReady) return;
  p.ammo--;
  p.fireReady = now + FIRE_COOLDOWN;
  const fwd = -p.side; // toward the opponent
  const originZ = p.z + fwd * 0.6;
  for (let i = 0; i < PELLETS; i++) {
    const slot = bullets.find((b) => b.life <= 0);
    if (!slot) break;
    slot.life = BULLET_LIFE;
    slot.owner = p.side;
    slot.mesh.visible = true;
    slot.mesh.position.set(p.obj.position.x, p.obj.position.y, originZ);
    slot.vel.set(
      (Math.random() - 0.5) * BULLET_SPREAD,
      (Math.random() - 0.5) * BULLET_SPREAD,
      fwd * BULLET_SPEED,
    );
  }
  spawnBurst(new THREE.Vector3(p.obj.position.x, p.obj.position.y, originZ), 0xffb14a);
  Audio.play('shoot');
  const rig = p === P1 ? gun1 : gun2;
  if (rig) rig.userData.recoil = 1; // kick the viewmodel
}

function updateBullets(dt) {
  for (const b of bullets) {
    if (b.life <= 0) continue;
    b.life -= dt;
    if (b.life <= 0) { b.mesh.visible = false; continue; }
    b.mesh.position.addScaledVector(b.vel, dt);

    // kill once it flies past the opponent's plane
    const pz = b.mesh.position.z;
    if ((b.owner > 0 && pz < paddle2Z) || (b.owner < 0 && pz > paddle1Z)) {
      b.life = 0; b.mesh.visible = false; continue;
    }

    // hit a ball → knock it back toward the opponent
    for (const ball of balls) {
      if (!ball.active) continue;
      if (b.mesh.position.distanceTo(ball.mesh.position) < ball.radius + BULLET_R) {
        const dir = b.owner > 0 ? -1 : 1;
        ball.vel.z = dir * (Math.abs(ball.vel.z) || BALL_SPEED);
        ball.vel.x += b.vel.x * 0.12;
        ball.vel.y += b.vel.y * 0.12;
        ball.vel.setLength(BALL_SPEED * speedMul * 1.2);
        ball.lastHitter = b.owner > 0 ? P1 : P2;
        spawnBurst(ball.mesh.position, 0xffb14a);
        b.life = 0; b.mesh.visible = false;
        break;
      }
    }
  }
}

function updateBalls(dt) {
  for (const b of balls) {
    if (!b.active) continue;
    const pos = b.mesh.position;

    // Magnus curve: perpendicular acceleration from spin.
    if (b.spin.lengthSq() > 1e-6) {
      const magnus = new THREE.Vector3().crossVectors(b.spin, b.vel).multiplyScalar(MAGNUS_K);
      b.vel.addScaledVector(magnus, dt);
      // visually roll the ball
      const ang = b.spin.length() * dt;
      if (ang > 1e-5) b.mesh.rotateOnWorldAxis(b.spin.clone().normalize(), ang);
      b.spin.multiplyScalar(Math.max(0, 1 - SPIN_DECAY * dt));
    }

    // Magnet effect: an owning paddle pulls balls on its own half.
    for (const p of [P1, P2]) {
      if (p.magnetUntil > now && Math.sign(pos.z) === Math.sign(p.z)) {
        b.vel.x += (p.obj.position.x - pos.x) * MAGNET_ACCEL * dt;
        b.vel.y += (p.obj.position.y - pos.y) * MAGNET_ACCEL * dt;
      }
    }

    pos.addScaledVector(b.vel, dt);

    // Walls (X) and floor/ceiling (Y)
    const r = b.radius;
    if (pos.x - r < bounds.minX) { pos.x = bounds.minX + r; b.vel.x = Math.abs(b.vel.x); Audio.play('bounce'); }
    if (pos.x + r > bounds.maxX) { pos.x = bounds.maxX - r; b.vel.x = -Math.abs(b.vel.x); Audio.play('bounce'); }
    if (pos.y - r < bounds.minY) { pos.y = bounds.minY + r; b.vel.y = Math.abs(b.vel.y); Audio.play('bounce'); }
    if (pos.y + r > bounds.maxY) { pos.y = bounds.maxY - r; b.vel.y = -Math.abs(b.vel.y); Audio.play('bounce'); }

    // Power-up pickups
    for (let i = powerups.length - 1; i >= 0; i--) {
      const pu = powerups[i];
      if (pos.distanceTo(pu.group.position) < r + PU_RADIUS) {
        collectPowerup(pu, b);
        removePowerup(i);
      }
    }

    // Paddle collisions / scoring
    handlePaddle(b, P1);
    handlePaddle(b, P2);
  }
}

function handlePaddle(b, p) {
  const pos = b.mesh.position, r = b.radius, side = p.side;
  if (side > 0) { if (pos.z + r < p.z || b.vel.z <= 0) return; }
  else { if (pos.z - r > p.z || b.vel.z >= 0) return; }

  const dx = pos.x - p.obj.position.x, dy = pos.y - p.obj.position.y;
  if (Math.abs(dx) <= p.half.x + r && Math.abs(dy) <= p.half.y + r) {
    // Deflect
    pos.z = p.z - side * (r + 0.01);
    b.vel.z = -b.vel.z;
    b.vel.x += dx * 2.2;
    b.vel.y += dy * 2.2;
    b.vel.setLength(BALL_SPEED * speedMul * 1.03);

    // Spin: from paddle motion (english) + off-center contact.
    b.spin.y += -p.vel.x * SPIN_FROM_PADDLE - dx * SPIN_FROM_OFFSET;
    b.spin.x += p.vel.y * SPIN_FROM_PADDLE + dy * SPIN_FROM_OFFSET;
    b.spin.clampLength(0, 9);

    b.lastHitter = p;
    spawnBurst(pos, p.color);
    Audio.play('hit');
  } else if ((side > 0 && pos.z - r > p.z) || (side < 0 && pos.z + r < p.z)) {
    // Passed the paddle → opponent scores.
    if (side > 0) score2++; else score1++;
    spawnBurst(pos, 0xffffff);
    Audio.play('score');
    updateScore();
    deactivateBall(b);
    if (score1 >= WIN_SCORE || score2 >= WIN_SCORE) return endMatch();
    if (activeBalls().length === 0) serveInitial(side > 0 ? -1 : 1);
  }
}

// ===========================================================================
// Effects
// ===========================================================================
function updateEffects() {
  for (const p of [P1, P2]) {
    if (p.growUntil && now > p.growUntil) {
      p.growUntil = 0;
      p.obj.scale.copy(p.baseScale);
      p.half = { x: p.baseHalf.x, y: p.baseHalf.y };
    }
  }
  if (speedUntil && now > speedUntil) {
    const back = 1 / speedMul;
    for (const b of activeBalls()) b.vel.multiplyScalar(back);
    speedMul = 1; speedUntil = 0;
  }
}

function applyGrow(p) {
  p.growUntil = now + GROW_TIME;
  p.obj.scale.set(p.baseScale.x * GROW_FACTOR, p.baseScale.y * GROW_FACTOR, p.baseScale.z);
  p.half = { x: p.baseHalf.x * GROW_FACTOR, y: p.baseHalf.y * GROW_FACTOR };
}
function applyMagnet(p) { p.magnetUntil = now + MAGNET_TIME; }
function applySpeed() {
  const ratio = (SPEED_MUL) / speedMul;
  for (const b of activeBalls()) b.vel.multiplyScalar(ratio);
  speedMul = SPEED_MUL; speedUntil = now + SPEED_TIME;
}
function applySpin() { arenaSpinUntil = now + SPIN_TIME; }
function applyVine(opp) { opp.slowUntil = now + VINE_TIME; }

function collectPowerup(pu, ball) {
  const owner = ball.lastHitter || (ball.vel.z > 0 ? P2 : P1);
  const foe = owner === P1 ? P2 : P1;
  const cfg = PU_TYPES[pu.type];
  spawnBurst(pu.group.position, cfg.color);
  let who = '';
  switch (pu.type) {
    case 'MULTIBALL': spawnExtraBall(ball); if (activeBalls().length < MAX_BALLS) spawnExtraBall(ball); break;
    case 'MAGNET':    applyMagnet(owner); who = owner === P1 ? 'P1 ' : 'P2 '; break;
    case 'GROW':      applyGrow(owner);   who = owner === P1 ? 'P1 ' : 'P2 '; break;
    case 'SPEED':     applySpeed(); break;
    case 'SHOTGUN':   owner.ammo += SHOTGUN_AMMO; who = owner === P1 ? 'P1 ' : 'P2 '; break;
    case 'SPIN':      applySpin(); break;
    case 'VINE':      applyVine(foe); who = (owner === P1 ? 'P1' : 'P2') + ' → '; break;
  }
  showToast(`${who}${cfg.label}`, cfg.color);
  Audio.play(pu.type === 'MULTIBALL' ? 'multiball' : 'powerup');
}

// ===========================================================================
// Power-ups (spawning + visuals)
// ===========================================================================
function makePowerupMesh(type) {
  const cfg = PU_TYPES[type];
  let geo;
  switch (type) {
    case 'MULTIBALL': geo = new THREE.IcosahedronGeometry(0.5, 0); break;
    case 'MAGNET':    geo = new THREE.TorusGeometry(0.42, 0.16, 12, 24); break;
    case 'GROW':      geo = new THREE.BoxGeometry(0.7, 0.7, 0.7); break;
    case 'SHOTGUN':   geo = new THREE.ConeGeometry(0.4, 0.85, 14); break;
    case 'SPIN':      geo = new THREE.TorusKnotGeometry(0.32, 0.11, 64, 8); break;
    case 'VINE':      geo = new THREE.OctahedronGeometry(0.5, 0); break;
    default:          geo = new THREE.TetrahedronGeometry(0.6); break; // SPEED
  }
  const mat = new THREE.MeshStandardMaterial({
    color: cfg.color, emissive: cfg.color, emissiveIntensity: 0.7,
    metalness: 0.3, roughness: 0.2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.add(makeGlow(cfg.color, 2.6));
  group.userData.shape = mesh;
  return group;
}

// Shuffle-bag: every type appears once per cycle (random order, no repeats),
// with an extra VINE so vines come up more often.
function nextPowerupType() {
  if (puBag.length === 0) {
    puBag = [...PU_KEYS];
    for (let i = puBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [puBag[i], puBag[j]] = [puBag[j], puBag[i]];
    }
  }
  return puBag.pop();
}
function spawnPowerupAt(type, x, y, z) {
  const group = makePowerupMesh(type);
  group.position.set(x, y, z);
  (arena || scene).add(group); // same frame as the ball, so spin keeps collisions correct
  powerups.push({ type, group, baseY: y, phase: Math.random() * Math.PI * 2 });
}
function spawnPowerup() {
  const x = THREE.MathUtils.lerp(bounds.minX + 1, bounds.maxX - 1, Math.random());
  const y = THREE.MathUtils.lerp(bounds.minY + 2, bounds.maxY - 2, Math.random());
  const z = (Math.random() - 0.5) * 12;
  spawnPowerupAt(nextPowerupType(), x, y, z);
}
function removePowerup(i) {
  const pu = powerups[i];
  (arena || scene).remove(pu.group);
  pu.group.userData.shape.geometry.dispose();
  pu.group.userData.shape.material.dispose();
  powerups.splice(i, 1);
}

function updatePowerups(dt) {
  if (now >= nextSpawn && powerups.length < PU_MAX_ACTIVE) {
    spawnPowerup();
    nextSpawn = now + THREE.MathUtils.lerp(PU_SPAWN_MIN, PU_SPAWN_MAX, Math.random());
  }
  for (const pu of powerups) {
    pu.group.userData.shape.rotation.x += dt * 1.2;
    pu.group.userData.shape.rotation.y += dt * 1.6;
    pu.group.position.y = pu.baseY + Math.sin(now * 2 + pu.phase) * 0.35;
  }
}

// ===========================================================================
// Hail — falls from the ceiling, deflects the ball, can drop a power-up
// ===========================================================================
function spawnHail() {
  const h = hail.find((x) => !x.active);
  if (!h) return;
  h.active = true;
  h.mesh.visible = true;
  h.mesh.position.set(
    THREE.MathUtils.lerp(bounds.minX + 0.3, bounds.maxX - 0.3, Math.random()),
    bounds.maxY - 0.3,
    (Math.random() - 0.5) * 24,
  );
  h.vel.set((Math.random() - 0.5) * 1.5, -HAIL_SPEED, (Math.random() - 0.5) * 1.5);
}
function updateHail(dt) {
  if (now < hailUntil) {
    hailTimer -= dt;
    if (hailTimer <= 0) { spawnHail(); hailTimer = HAIL_SPAWN; }
  }

  for (const h of hail) {
    if (!h.active) continue;
    h.vel.y -= 6 * dt; // gravity
    h.mesh.position.addScaledVector(h.vel, dt);
    h.mesh.rotation.x += dt * 3; h.mesh.rotation.y += dt * 2;

    // Melt on the floor
    if (h.mesh.position.y - HAIL_R < bounds.minY) {
      h.active = false; h.mesh.visible = false;
      spawnBurst(h.mesh.position, 0xbfe4ff);
      continue;
    }
    // Hit a ball → deflect it, shatter, maybe drop a power-up
    for (const b of balls) {
      if (!b.active) continue;
      if (h.mesh.position.distanceTo(b.mesh.position) < b.radius + HAIL_R) {
        const n = b.mesh.position.clone().sub(h.mesh.position).normalize();
        b.vel.addScaledVector(n, HAIL_KNOCK);
        b.vel.setLength(BALL_SPEED * speedMul); // deflect direction, keep speed
        spawnBurst(h.mesh.position, 0xbfe4ff);
        if (Math.random() < HAIL_PU_CHANCE && powerups.length < HAIL_PU_CAP) {
          spawnPowerupAt(nextPowerupType(), h.mesh.position.x,
            THREE.MathUtils.clamp(h.mesh.position.y, bounds.minY + 2, bounds.maxY - 2),
            h.mesh.position.z);
        }
        h.active = false; h.mesh.visible = false;
        break;
      }
    }
  }
}

// ===========================================================================
// Particle bursts (pooled, additive Points)
// ===========================================================================
const BURST_N = 22, BURST_TIME = 0.55;
function makeBurst() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BURST_N * 3), 3));
  const mat = new THREE.PointsMaterial({
    map: GLOW_TEX, size: 0.5, sizeAttenuation: true,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
  });
  const pts = new THREE.Points(geo, mat);
  pts.visible = false;
  scene.add(pts);
  return { pts, vels: Array.from({ length: BURST_N }, () => new THREE.Vector3()), life: 0 };
}
function spawnBurst(pos, color) {
  const b = bursts.find((x) => x.life <= 0) || bursts[0];
  b.life = BURST_TIME;
  b.pts.visible = true;
  b.pts.material.color.setHex(color);
  b.pts.material.opacity = 1;
  const arr = b.pts.geometry.attributes.position.array;
  for (let i = 0; i < BURST_N; i++) {
    arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
    b.vels[i].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .normalize().multiplyScalar(2 + Math.random() * 4);
  }
  b.pts.geometry.attributes.position.needsUpdate = true;
}
function updateBursts(dt) {
  for (const b of bursts) {
    if (b.life <= 0) continue;
    b.life -= dt;
    if (b.life <= 0) { b.pts.visible = false; continue; }
    const arr = b.pts.geometry.attributes.position.array;
    for (let i = 0; i < BURST_N; i++) {
      b.vels[i].multiplyScalar(1 - 2.5 * dt);
      arr[i * 3] += b.vels[i].x * dt;
      arr[i * 3 + 1] += b.vels[i].y * dt;
      arr[i * 3 + 2] += b.vels[i].z * dt;
    }
    b.pts.geometry.attributes.position.needsUpdate = true;
    b.pts.material.opacity = b.life / BURST_TIME;
  }
}

// ===========================================================================
// HUD
// ===========================================================================
function updateScore() { elP1.textContent = score1; elP2.textContent = score2; }

function badgesHtml(p) {
  const out = [];
  if (p.growUntil > now) out.push(['big', 'BIG']);
  if (p.magnetUntil > now) out.push(['magnet', 'MAGNET']);
  if (p.slowUntil > now) out.push(['vine', 'VINED']);
  if (speedUntil > now) out.push(['fast', 'FAST']);
  return out.map(([c, t]) => `<span class="badge ${c}">${t}</span>`).join('');
}
function renderAmmo(panel, shellsEl, gunEl, p) {
  if (p.ammo === p._hudAmmo) return;     // only rebuild when it changes
  p._hudAmmo = p.ammo;
  if (p.ammo > 0) {
    panel.hidden = false;
    shellsEl.innerHTML = '<span class="shell"></span>'.repeat(Math.min(p.ammo, 8));
    gunEl.textContent = `SHOTGUN ×${p.ammo}`;
  } else {
    panel.hidden = true;
  }
}
function updateHudFx() {
  elP1fx.innerHTML = badgesHtml(P1);
  elP2fx.innerHTML = badgesHtml(P2);
  renderAmmo(elP1ammo, elP1shells, elP1gun, P1);
  renderAmmo(elP2ammo, elP2shells, elP2gun, P2);
}

let toastTimer = 0;
function showToast(text, color) {
  elToast.textContent = text;
  elToast.style.color = '#' + color.toString(16).padStart(6, '0');
  elToast.classList.add('show');
  toastTimer = now + 1.5;
}

function endMatch() {
  matchOver = true;
  Audio.play('win');
  Audio.startMusic('victory');
  Confetti.burst();
  const p1win = score1 >= WIN_SCORE;
  elWinner.textContent = p1win ? 'PLAYER 1 WINS' : (botEnabled ? 'BOT WINS' : 'PLAYER 2 WINS');
  elWinner.style.color = p1win ? '#35e04a' : '#4d8dff';
  elFinalScore.textContent = `${score1} – ${score2}`;
  elCount.style.display = 'none';
  elBanner.classList.add('show');
}

function resetPlayState() {
  for (let i = powerups.length - 1; i >= 0; i--) removePowerup(i);
  for (const b of bullets) { b.life = 0; b.mesh.visible = false; }
  for (const h of hail) { h.active = false; h.mesh.visible = false; }
  hailTimer = 0; hailUntil = 0; puBag = [];
  balls.forEach(deactivateBall);
  speedMul = 1; speedUntil = 0;
  arenaSpinUntil = 0; arenaSpinAngle = 0;
  if (arena) { arena.rotation.z = 0; arena.position.set(0, 0, 0); }
  if (vine1) vine1.visible = false;
  if (vine2) vine2.visible = false;
  for (const p of [P1, P2]) {
    p.growUntil = 0; p.magnetUntil = 0; p.slowUntil = 0; p.ammo = 0;
    p.obj.scale.copy(p.baseScale);
    p.half = { x: p.baseHalf.x, y: p.baseHalf.y };
  }
}

function restartMatch() {
  score1 = 0; score2 = 0; matchOver = false;
  Confetti.stop();
  Audio.startMusic('game');
  elBanner.classList.remove('show');
  updateScore();
  resetPlayState();
  countdown = 3; showCount('3'); // rematch also counts in
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function returnToMenu() {
  Confetti.stop();
  Audio.startMusic('menu');
  matchOver = false; started = false; botEnabled = false;
  countdown = 0; goUntil = 0; elCount.style.display = 'none';
  elBanner.classList.remove('show');
  document.body.classList.add('pregame');
  document.body.classList.remove('solo');
  elStart.classList.remove('hidden');
  score1 = 0; score2 = 0; updateScore();
  resetPlayState();
  frameCameras(); // back to the split-screen backdrop
}

// ===========================================================================
// Split-screen render loop
// ===========================================================================
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  // Gamepad reticle cursor — active on UI screens (menu / win banner) so a
  // controller can navigate; hidden during live play.
  const uiActive = polyActive
    ? !!(polyGame && polyGame.isMatchOver())
    : (!started || matchOver);
  gameCursor.update(dt, uiActive);
  // Home button visible only during live play.
  const inBattle = polyActive
    ? !!(polyGame && !polyGame.isMatchOver())
    : (started && !matchOver);
  document.body.classList.toggle('inbattle', inBattle);
  if (polyActive && polyGame) { polyGame.update(dt); polyGame.render(); return; }
  if (ready) pollPad();
  update(dt);
  updateGuns(dt);
  if (ready) positionCameras(); // first-person follows the paddle each frame
  if (toastTimer && now > toastTimer) { elToast.classList.remove('show'); toastTimer = 0; }

  const w = window.innerWidth, h = window.innerHeight;
  if (botEnabled) {
    // Solo: single full-screen view of the human player.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, cam1);
  } else {
    // Split screen: Player 1 left, Player 2 right.
    const halfW = Math.floor(w / 2);
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, halfW, h); renderer.setScissor(0, 0, halfW, h);
    renderer.render(scene, cam1);
    renderer.setViewport(halfW, 0, w - halfW, h); renderer.setScissor(halfW, 0, w - halfW, h);
    renderer.render(scene, cam2);
  }
}
animate();

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  frameCameras();
});
