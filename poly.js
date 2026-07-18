// ===========================================================================
// poly.js — N-player (3 / 4) polygon-arena mode.
//
// A regular N-gon arena (triangle for 3P, square for 4P). Each player defends
// one edge with a paddle that slides along the edge AND up/down the wall plane
// (2-DOF, matching the classic game's paddle feel, generalised to N tilted
// planes). The ball bounces in full 3D — off the floor, the ceiling, the edge
// walls and the paddles. Miss your edge and you lose a life; hit 0 lives and
// your edge is walled off and you're out. Last player standing wins.
//
// Controls: P1 = mouse cursor, P2 = arrow keys, P3/P4 = gamepads.
//
// Rendered as an N-way split screen (2×2 grid; for 3P the 4th cell is a
// top-down overview). Runs in its own THREE.Scene, sharing the caller's
// renderer/canvas. main.js hands control here when the player count is > 2.
// ===========================================================================
import * as THREE from 'three';
import * as Audio from './audio.js';
import * as Confetti from './confetti.js';
import { binds } from './binds.js';

const PLAYER_COLORS = [0x35e04a, 0x4d8dff, 0xff7a3c, 0xb96bff];
const PLAYER_NAMES = ['PLAYER 1', 'PLAYER 2', 'PLAYER 3', 'PLAYER 4'];

// Arena geometry (double-size arena)
const R = 22;          // circumradius of the polygon
const PLAY_H = 12;     // ceiling height (ball bounces between floor and this)
const WALL_H = PLAY_H; // rendered wall height

// Ball
const BALL_R = 0.9;
const BALL_SPEED = 20;
const MAX_BALLS = 5;
const TRAIL_LEN = 7;   // ghost sprites trailing each ball

// Paddle
const PADDLE_W_FRAC = 0.34;  // paddle length as a fraction of its edge length
const PADDLE_H = 3.6;        // paddle height on the wall plane
const PADDLE_THICK = 0.6;
const PADDLE_SPEED = 24;     // slide speed (units/sec) for key/stick control
const PADDLE_ENGLISH = 0.5;  // how much paddle motion becomes ball tang/vert vel
const OFFSET_ENGLISH = 2.2;  // how much off-centre contact angles the ball
const GROW_FACTOR = 1.7;

// Lives
const START_LIVES = 3;

// Cameras (fov is auto-fit per viewport each frame so the arena fills the cell)
const CAM_DIST = R * 1.6;
const CAM_HEIGHT = PLAY_H * 0.85;
const LOOK_Y = PLAY_H * 0.45;
const FIT_W = R * 0.92;         // half-extent to frame horizontally
const FIT_H = PLAY_H * 0.6;     // half-extent to frame vertically

// Power-ups (mirrors the classic set)
const PU_SPAWN_MIN = 5, PU_SPAWN_MAX = 9;
const PU_MAX_ACTIVE = 2;
const PU_RADIUS = 0.7;
const MAGNET_TIME = 20, MAGNET_ACCEL = 7;
const GROW_TIME = 9;
const SPEED_TIME = 6, SPEED_MUL = 1.5;
const SPIN_TIME = 6, ARENA_SPIN_RATE = 0.9;
const VINE_TIME = 7, VINE_SLOW = 0.1;   // vines slow the target to 10% speed
const SHOTGUN_AMMO = 5, PELLETS = 6, BULLET_SPEED = 30, BULLET_SPREAD = 5;
const BULLET_LIFE = 0.7, BULLET_R = 0.18, FIRE_COOLDOWN = 0.25;

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

const UP = new THREE.Vector3(0, 1, 0);

// ---- Shared glow sprite (soft additive radial gradient) -------------------
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
export function createPolyGame(renderer, opts = {}) {
  const onExit = opts.onExit || (() => {});

  // ---- Scene + lighting --------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.Fog(0x05060a, R * 1.6, R * 4.2);
  if (opts.environment) scene.environment = opts.environment;

  scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x0b0f1a, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(6, 30, 10);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6f8cff, 0.35);
  fill.position.set(-8, 12, -12);
  scene.add(fill);

  // Everything that should roll with the SPIN power-up lives under this group.
  const arenaGroup = new THREE.Group();
  scene.add(arenaGroup);

  // ---- Materials (reuse the glb's brick/wood look, tiled) ----------------
  function tiled(srcMat, rx, ry, fallbackColor) {
    if (srcMat && srcMat.map) {
      const m = srcMat.clone();
      m.map = srcMat.map.clone();
      m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
      m.map.repeat.set(rx, ry);
      m.map.needsUpdate = true;
      m.side = THREE.DoubleSide;
      return m;
    }
    return new THREE.MeshStandardMaterial({ color: fallbackColor, roughness: 0.85, side: THREE.DoubleSide });
  }
  const wallMat = tiled(opts.wallMaterial, 2, 1, 0x5a4632);
  const floorMat = tiled(opts.floorMaterial, 3, 3, 0x2a2f3a);

  // ---- State -------------------------------------------------------------
  let N = 3;
  let running = false, matchOver = false;
  let now = 0;
  let countdown = 0, goUntil = 0;
  let nextSpawn = 0;
  let speedMul = 1, speedUntil = 0;
  let arenaSpinUntil = 0, arenaSpinAngle = 0;
  let puBag = [];

  const players = [];   // { index, color, name, lives, alive, edge, paddle, c, h, prevC, prevH, ... }
  const edges = [];     // { A:Vector2, B, mid:Vector2, d:Vector2, n:Vector2, L, owner, wall, wallMesh }
  const balls = [];
  const powerups = [];
  const bullets = [];
  const bursts = [];
  let floorMesh = null, ceilMesh = null;

  // ---- Input -------------------------------------------------------------
  const keys = new Set();
  let mouseX = 0.5, mouseY = 0.5; // normalised within P1's viewport
  const firePrev = [false, false, false, false];
  const padEdge = {};

  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    if (k === binds.rematch && matchOver) restart();
    if (k === binds.mute) Audio.toggleMuted();
  }
  function onKeyUp(e) { keys.delete(e.key.toLowerCase()); }
  function p1CssRect() {
    // P1's viewport in CSS px (top-left origin): left column (3P) or top-left
    // quadrant (4P).
    const w = window.innerWidth, h = window.innerHeight;
    if (N === 3) return { l: 0, t: 0, w: w / 3, h };
    return { l: 0, t: 0, w: w / 2, h: h / 2 };
  }
  function onMouseMove(e) {
    const r = p1CssRect();
    mouseX = THREE.MathUtils.clamp((e.clientX - r.l) / r.w, 0, 1);
    mouseY = THREE.MathUtils.clamp((e.clientY - r.t) / r.h, 0, 1);
  }

  // ---- Gamepads: assign connected pads to P3, P4 in connection order -----
  function connectedPads() {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    const out = [];
    for (let i = 0; i < list.length; i++) if (list[i]) out.push(list[i]);
    return out;
  }
  function padForPlayer(i) { // i is 0-based; P3 -> pads[0], P4 -> pads[1]
    const pads = connectedPads();
    return pads[i - 2] || null;
  }
  function axis(pad, i) { const v = pad ? (pad.axes[i] || 0) : 0; return Math.abs(v) < 0.18 ? 0 : v; }
  function padBtn(pad, i) { return !!(pad && pad.buttons[i] && pad.buttons[i].pressed); }

  // =========================================================================
  // Build the arena for N players
  // =========================================================================
  function buildArena(playerCount) {
    N = playerCount;
    // Wipe any previous build.
    while (arenaGroup.children.length) arenaGroup.remove(arenaGroup.children[0]);
    players.length = 0; edges.length = 0; balls.length = 0;
    powerups.length = 0; bullets.length = 0; bursts.length = 0;

    // Vertices: orient so edge 0's outward normal points toward -Z (world
    // "south"), giving P1 a natural front-on view.
    const base = -Math.PI / 2 - Math.PI / N;
    const verts = [];
    for (let i = 0; i < N; i++) {
      const a = base + i * (2 * Math.PI / N);
      verts.push(new THREE.Vector2(R * Math.cos(a), R * Math.sin(a)));
    }

    // Floor (polygon) + ceiling.
    const shape = new THREE.Shape();
    shape.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < N; i++) shape.lineTo(verts[i].x, verts[i].y);
    shape.closePath();
    const floorGeo = new THREE.ShapeGeometry(shape);
    floorGeo.rotateX(Math.PI / 2); // XY shape -> XZ floor (faces up after flip)
    floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.receiveShadow = true;
    arenaGroup.add(floorMesh);

    const ceilGeo = new THREE.ShapeGeometry(shape);
    ceilGeo.rotateX(-Math.PI / 2);
    ceilMesh = new THREE.Mesh(ceilGeo, new THREE.MeshStandardMaterial({
      color: 0x0a1424, roughness: 1, transparent: true, opacity: 0.15, side: THREE.DoubleSide,
    }));
    ceilMesh.position.y = PLAY_H;
    arenaGroup.add(ceilMesh);

    // Glowing centre disc on the floor — a focal point.
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.7, 48),
      new THREE.MeshBasicMaterial({ color: 0x2a4a7a, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.02;
    arenaGroup.add(disc);

    // Soft overhead light for specular pops on the ball.
    const spot = new THREE.PointLight(0xbfd4ff, 0.8, R * 4, 1.6);
    spot.position.set(0, PLAY_H + 2, 0);
    arenaGroup.add(spot);

    // Corner posts (steel pillars) — structure + a clear sense of containment.
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x8895ac, metalness: 0.8, roughness: 0.35, emissive: 0x141c2c, emissiveIntensity: 0.6 });
    const postGeo = new THREE.CylinderGeometry(0.34, 0.42, PLAY_H, 16);
    for (const v of verts) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(v.x, PLAY_H / 2, v.y);
      post.castShadow = true;
      arenaGroup.add(post);
    }

    // Edges + walls + goal strips + paddles + cameras.
    for (let i = 0; i < N; i++) {
      const A = verts[i], B = verts[(i + 1) % N];
      const d = new THREE.Vector2().subVectors(B, A).normalize();
      const L = A.distanceTo(B);
      const mid = new THREE.Vector2().addVectors(A, B).multiplyScalar(0.5);
      const n = mid.clone().normalize(); // outward normal (regular polygon)
      const edge = { A, B, d, n, L, mid, owner: i, wall: false, wallMesh: null, stripMat: null };
      edges.push(edge);

      // Wall backdrop (rendered slightly outside the edge). Hidden from the
      // owner's own camera via layers so it never blocks their view.
      const wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(L, WALL_H), wallMat);
      const wOff = 0.25;
      wallMesh.position.set(mid.x + n.x * wOff, WALL_H / 2, mid.y + n.y * wOff);
      wallMesh.lookAt(0, WALL_H / 2, 0); // face inward
      wallMesh.receiveShadow = true;
      wallMesh.layers.set(i + 1); // only cameras that ENABLE layer i+1 see it
      edge.wallMesh = wallMesh;
      arenaGroup.add(wallMesh);

      // Goal strip: an emissive line on the floor marking this player's edge.
      const stripMat = new THREE.MeshStandardMaterial({
        color: PLAYER_COLORS[i], emissive: PLAYER_COLORS[i], emissiveIntensity: 1.4, roughness: 0.5 });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(L, 0.12, 0.5), stripMat);
      strip.position.set(mid.x, 0.07, mid.y);
      strip.rotation.y = -Math.atan2(d.y, d.x);
      arenaGroup.add(strip);
      edge.stripMat = stripMat;

      // Paddle
      const pw = L * PADDLE_W_FRAC;
      const padMat = new THREE.MeshStandardMaterial({
        color: PLAYER_COLORS[i], emissive: PLAYER_COLORS[i], emissiveIntensity: 0.6,
        metalness: 0.35, roughness: 0.3,
      });
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(pw, PADDLE_H, PADDLE_THICK), padMat);
      paddle.castShadow = true;
      paddle.add(makeGlow(PLAYER_COLORS[i], PADDLE_H * 1.25));
      arenaGroup.add(paddle);

      // Camera behind this edge, looking in over the wall.
      const cam = new THREE.PerspectiveCamera(58, 1, 0.1, 400);
      cam.position.set(mid.x + n.x * CAM_DIST, CAM_HEIGHT, mid.y + n.y * CAM_DIST);
      const target = new THREE.Vector3(0, LOOK_Y, 0);
      cam.lookAt(target);
      cam.userData.fitD = cam.position.distanceTo(target); // for per-frame fov fit
      cam.layers.enableAll();
      cam.layers.disable(i + 1); // don't render our own front wall

      // Screen-right sign: does moving the paddle along +d go right on screen?
      const f = new THREE.Vector3(-n.x, 0, -n.y);            // inward view dir
      const right = new THREE.Vector3().crossVectors(f, UP); // camera screen-right
      const d3 = new THREE.Vector3(d.x, 0, d.y);
      const screenRightSign = Math.sign(d3.dot(right)) || 1;

      const pw2 = pw / 2;
      players.push({
        index: i, color: PLAYER_COLORS[i], name: PLAYER_NAMES[i],
        lives: START_LIVES, alive: true,
        edge, paddle, cam, screenRightSign,
        pw, ph: PADDLE_H, baseHalfW: pw2, baseHalfH: PADDLE_H / 2,
        halfW: pw2, halfH: PADDLE_H / 2,
        c: L / 2, h: PLAY_H / 2, prevC: L / 2, prevH: PLAY_H / 2,
        slideVel: 0, vertVel: 0,
        growUntil: 0, magnetUntil: 0, slowUntil: 0, ammo: 0, fireReady: 0,
        vine: makeVines(), gun: null,
      });
      arenaGroup.add(players[players.length - 1].vine);
    }

    // Pools ----------------------------------------------------------------
    const ballGeo = new THREE.SphereGeometry(BALL_R, 32, 24);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffdf91, emissiveIntensity: 0.85, roughness: 0.12, metalness: 0.0,
    });
    for (let i = 0; i < MAX_BALLS; i++) {
      const mesh = new THREE.Mesh(ballGeo, ballMat);
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.add(makeGlow(0xffe9b0, BALL_R * 4.2));   // inner bright glow
      mesh.add(makeGlow(0xffb64a, BALL_R * 8.0));   // outer soft glow
      arenaGroup.add(mesh);
      const trail = [];
      for (let t = 0; t < TRAIL_LEN; t++) {
        const s = makeGlow(0xffd27a, BALL_R * 3.0);
        s.visible = false;
        arenaGroup.add(s);
        trail.push(s);
      }
      balls.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(),
        radius: BALL_R, lastHitter: null, active: false, trail, hist: [] });
    }
    const bulletGeo = new THREE.SphereGeometry(BULLET_R, 8, 8);
    const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffb14a });
    for (let i = 0; i < 60; i++) {
      const mesh = new THREE.Mesh(bulletGeo, bulletMat);
      mesh.visible = false;
      mesh.add(makeGlow(0xffb14a, BULLET_R * 6));
      arenaGroup.add(mesh);
      bullets.push({ mesh, vel: new THREE.Vector3(), life: 0, owner: null });
    }
    for (let i = 0; i < 10; i++) bursts.push(makeBurst());

    // Guns (one per player, loaded lazily below if the model is available).
    if (opts.gunModel) {
      for (const p of players) {
        const model = opts.gunModel.clone();
        const rig = new THREE.Group();
        rig.add(model);
        rig.userData.recoil = 0;
        rig.visible = false;
        arenaGroup.add(rig);
        p.gun = rig;
      }
    }

    updatePaddleTransforms();
  }

  // ---- Vines overlay -----------------------------------------------------
  function makeVines() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3f8f36, emissive: 0x0f2e0c, emissiveIntensity: 0.5, roughness: 0.75,
    });
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.12, 8, 18), mat);
      ring.position.y = -0.9 + i * 0.6;
      ring.rotation.x = Math.PI / 2;
      ring.rotation.z = i * 0.6;
      g.add(ring);
    }
    g.visible = false;
    return g;
  }

  // ---- Particle bursts ---------------------------------------------------
  const BURST_N = 20, BURST_TIME = 0.5;
  function makeBurst() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BURST_N * 3), 3));
    const mat = new THREE.PointsMaterial({
      map: GLOW_TEX, size: 0.5, sizeAttenuation: true,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
    });
    const pts = new THREE.Points(geo, mat);
    pts.visible = false;
    arenaGroup.add(pts);
    return { pts, vels: Array.from({ length: BURST_N }, () => new THREE.Vector3()), life: 0 };
  }
  function spawnBurst(pos, color) {
    const b = bursts.find((x) => x.life <= 0) || bursts[0];
    b.life = BURST_TIME; b.pts.visible = true;
    b.pts.material.color.setHex(color); b.pts.material.opacity = 1;
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
        arr[i * 3] += b.vels[i].x * dt; arr[i * 3 + 1] += b.vels[i].y * dt; arr[i * 3 + 2] += b.vels[i].z * dt;
      }
      b.pts.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = b.life / BURST_TIME;
    }
  }

  // =========================================================================
  // Paddle transforms + input
  // =========================================================================
  const _m = new THREE.Matrix4();
  const _x = new THREE.Vector3(), _z = new THREE.Vector3();
  function updatePaddleTransforms() {
    for (const p of players) {
      const e = p.edge;
      // Position: A + c*d along the edge, at height h, on the edge line.
      const px = e.A.x + e.d.x * p.c;
      const pz = e.A.y + e.d.y * p.c;
      p.paddle.position.set(px, p.h, pz);
      // Orient: local X -> edge dir, Y -> up, Z -> cross(X,Y).
      _x.set(e.d.x, 0, e.d.y);
      _z.crossVectors(_x, UP);
      _m.makeBasis(_x, UP, _z);
      p.paddle.quaternion.setFromRotationMatrix(_m);
      p.paddle.visible = p.alive;
    }
  }

  function movePaddles(dt) {
    for (const p of players) {
      if (!p.alive) continue;
      const e = p.edge;
      const cMin = p.halfW, cMax = e.L - p.halfW;
      const hMin = p.halfH, hMax = PLAY_H - p.halfH;
      const slow = p.slowUntil > now ? VINE_SLOW : 1;
      const spd = PADDLE_SPEED * dt * slow;

      if (p.index === 0) {
        // Mouse: absolute position within P1's viewport.
        let tx = mouseX, ty = mouseY;
        if (p.screenRightSign < 0) tx = 1 - tx;
        p.c = THREE.MathUtils.lerp(cMin, cMax, tx);
        p.h = THREE.MathUtils.lerp(hMax, hMin, ty); // screen-top -> high
      } else if (p.index === 1) {
        // Arrow keys.
        let dx = 0, dy = 0;
        if (keys.has(binds.p2Right)) dx += 1;
        if (keys.has(binds.p2Left)) dx -= 1;
        if (keys.has(binds.p2Up)) dy += 1;
        if (keys.has(binds.p2Down)) dy -= 1;
        p.c += dx * p.screenRightSign * spd;
        p.h += dy * spd;
      } else {
        // Gamepad.
        const pad = padForPlayer(p.index);
        const sx = axis(pad, 0), sy = axis(pad, 1);
        p.c += sx * p.screenRightSign * spd;
        p.h += -sy * spd;
      }
      p.c = THREE.MathUtils.clamp(p.c, cMin, cMax);
      p.h = THREE.MathUtils.clamp(p.h, hMin, hMax);
      p.slideVel = (p.c - p.prevC) / Math.max(dt, 1e-4);
      p.vertVel = (p.h - p.prevH) / Math.max(dt, 1e-4);
      p.prevC = p.c; p.prevH = p.h;
    }
    updatePaddleTransforms();
  }

  // =========================================================================
  // Balls
  // =========================================================================
  function activeBalls() { return balls.filter((b) => b.active); }
  function serveBall(slot, pos, vel, hitter) {
    slot.active = true; slot.mesh.visible = true;
    slot.mesh.position.copy(pos); slot.vel.copy(vel);
    slot.spin.set(0, 0, 0); slot.lastHitter = hitter ?? null;
  }
  function deactivateBall(slot) {
    slot.active = false; slot.mesh.visible = false;
    slot.hist.length = 0;
    if (slot.trail) for (const s of slot.trail) s.visible = false;
  }
  function updateTrail(b) {
    b.hist.unshift(b.mesh.position.clone());
    if (b.hist.length > TRAIL_LEN + 1) b.hist.pop();
    for (let i = 0; i < b.trail.length; i++) {
      const p = b.hist[i + 1];
      const s = b.trail[i];
      if (!p) { s.visible = false; continue; }
      s.visible = true;
      s.position.copy(p);
      const k = 1 - i / b.trail.length;
      s.material.opacity = 0.5 * k;
      s.scale.setScalar(BALL_R * 3.0 * k);
    }
  }
  function serveCenter() {
    balls.forEach(deactivateBall);
    const a = Math.random() * Math.PI * 2;
    const v = new THREE.Vector3(Math.cos(a), (Math.random() - 0.5) * 0.4, Math.sin(a))
      .normalize().multiplyScalar(BALL_SPEED * speedMul);
    serveBall(balls[0], new THREE.Vector3(0, PLAY_H / 2, 0), v, null);
  }
  function spawnExtraBall(src) {
    const slot = balls.find((b) => !b.active);
    if (!slot) return;
    const v = src.vel.clone().applyAxisAngle(UP, (Math.random() < 0.5 ? 1 : -1) * 0.6);
    serveBall(slot, src.mesh.position.clone(), v, src.lastHitter);
  }

  const _pv = new THREE.Vector2();
  function nearestEdgeOwner(pos) {
    let best = null, bestDist = -Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const e = p.edge;
      const dist = (pos.x - e.A.x) * e.n.x + (pos.z - e.A.y) * e.n.y;
      if (dist > bestDist) { bestDist = dist; best = p; }
    }
    return best;
  }

  function updateBalls(dt) {
    for (const b of balls) {
      if (!b.active) continue;
      const pos = b.mesh.position;

      // Magnet: an active owner pulls balls whose nearest edge is theirs.
      for (const p of players) {
        if (p.magnetUntil > now && p.alive) {
          const near = nearestEdgeOwner(pos);
          if (near === p) {
            const e = p.edge;
            const px = e.A.x + e.d.x * p.c, pz = e.A.y + e.d.y * p.c;
            b.vel.x += (px - pos.x) * MAGNET_ACCEL * dt;
            b.vel.z += (pz - pos.z) * MAGNET_ACCEL * dt;
            b.vel.y += (p.h - pos.y) * MAGNET_ACCEL * dt;
          }
        }
      }

      pos.addScaledVector(b.vel, dt);
      const r = b.radius;

      // Floor + ceiling.
      if (pos.y - r < 0) { pos.y = r; b.vel.y = Math.abs(b.vel.y); Audio.play('bounce'); }
      if (pos.y + r > PLAY_H) { pos.y = PLAY_H - r; b.vel.y = -Math.abs(b.vel.y); Audio.play('bounce'); }

      // Edges: find the most-penetrated edge the ball is exiting through.
      let hitEdge = null, hitDist = -Infinity, hitS = 0;
      for (const e of edges) {
        const dist = (pos.x - e.A.x) * e.n.x + (pos.z - e.A.y) * e.n.y; // outward
        if (dist <= -r) continue;
        const vn = b.vel.x * e.n.x + b.vel.z * e.n.y;
        if (vn <= 0) continue; // not heading out
        const s = (pos.x - e.A.x) * e.d.x + (pos.z - e.A.y) * e.d.y;
        if (s < 0 || s > e.L) continue;
        if (dist > hitDist) { hitDist = dist; hitEdge = e; hitS = s; }
      }
      if (hitEdge) resolveEdge(b, hitEdge, hitDist, hitS);
      if (!b.active) continue;

      // Power-up pickups.
      for (let i = powerups.length - 1; i >= 0; i--) {
        const pu = powerups[i];
        if (pos.distanceTo(pu.group.position) < r + PU_RADIUS) {
          collectPowerup(pu, b);
          removePowerup(i);
        }
      }

      updateTrail(b);
    }
  }

  function reflectAndPush(b, e, dist) {
    const pos = b.mesh.position, r = b.radius;
    const vn = b.vel.x * e.n.x + b.vel.z * e.n.y;
    b.vel.x -= 2 * vn * e.n.x; b.vel.z -= 2 * vn * e.n.y;
    const over = dist + r + 0.001;
    pos.x -= over * e.n.x; pos.z -= over * e.n.y;
  }

  function resolveEdge(b, e, dist, s) {
    const owner = players[e.owner];
    // Walled-off (eliminated) edge → plain bounce.
    if (e.wall || !owner.alive) { reflectAndPush(b, e, dist); Audio.play('wall'); return; }

    const pos = b.mesh.position;
    const covered = Math.abs(s - owner.c) <= owner.halfW &&
                    Math.abs(pos.y - owner.h) <= owner.halfH;
    if (covered) {
      reflectAndPush(b, e, dist);
      // English: paddle motion + off-centre contact, tangential + vertical.
      const offT = s - owner.c, offV = pos.y - owner.h;
      b.vel.x += e.d.x * (owner.slideVel * PADDLE_ENGLISH + offT * OFFSET_ENGLISH) * 0.25;
      b.vel.z += e.d.y * (owner.slideVel * PADDLE_ENGLISH + offT * OFFSET_ENGLISH) * 0.25;
      b.vel.y += (owner.vertVel * PADDLE_ENGLISH + offV * OFFSET_ENGLISH) * 0.25;
      // Keep it moving inward, then normalise speed (slightly faster each hit).
      const vn2 = b.vel.x * e.n.x + b.vel.z * e.n.y;
      if (vn2 > -1) { const add = -1 - vn2; b.vel.x += add * e.n.x; b.vel.z += add * e.n.y; }
      b.vel.setLength(BALL_SPEED * speedMul * 1.03);
      b.lastHitter = owner;
      spawnBurst(pos, owner.color);
      Audio.play('hit');
    } else {
      // Missed → the edge's owner concedes a life.
      spawnBurst(pos, 0xffffff);
      Audio.play('score');
      loseLife(owner, b);
    }
  }

  function loseLife(p, ball) {
    if (!p.alive) return;
    p.lives = Math.max(0, p.lives - 1);
    deactivateBall(ball);
    if (p.lives <= 0) eliminate(p);
    syncHud();
    const aliveNow = players.filter((x) => x.alive);
    if (aliveNow.length <= 1) return endMatch(aliveNow[0] || null);
    if (activeBalls().length === 0) serveCenter();
  }

  function eliminate(p) {
    p.alive = false;
    p.edge.wall = true;
    p.paddle.visible = false;
    if (p.vine) p.vine.visible = false;
    if (p.gun) p.gun.visible = false;
    // The owner's wall was hidden from their own camera; show it everywhere now.
    if (p.edge.wallMesh) p.edge.wallMesh.layers.set(0);
    // Dim the goal strip to a dead grey.
    if (p.edge.stripMat) { p.edge.stripMat.color.setHex(0x394050); p.edge.stripMat.emissive.setHex(0x0a0d12); }
    spawnBurst(new THREE.Vector3(p.edge.mid.x, PLAY_H / 2, p.edge.mid.y), p.color);
    Audio.play('eliminate');
  }

  // =========================================================================
  // Shotgun
  // =========================================================================
  function updateFire(dt) {
    for (const p of players) {
      if (!p.alive) continue;
      let fire = false;
      if (p.index === 0) fire = keys.has(binds.p1Shoot);
      else if (p.index === 1) fire = keys.has(binds.p2Shoot);
      else { const pad = padForPlayer(p.index); fire = padBtn(pad, 7) || padBtn(pad, 0); }
      if (fire && !firePrev[p.index]) fireShotgun(p);
      firePrev[p.index] = fire;
    }
  }
  function fireShotgun(p) {
    if (p.ammo <= 0 || now < p.fireReady) return;
    p.ammo--; p.fireReady = now + FIRE_COOLDOWN;
    const e = p.edge;
    const inX = -e.n.x, inZ = -e.n.y; // inward
    const ox = e.A.x + e.d.x * p.c + inX * 0.6;
    const oz = e.A.y + e.d.y * p.c + inZ * 0.6;
    for (let i = 0; i < PELLETS; i++) {
      const slot = bullets.find((s) => s.life <= 0);
      if (!slot) break;
      slot.life = BULLET_LIFE; slot.owner = p; slot.mesh.visible = true;
      slot.mesh.position.set(ox, p.h, oz);
      const sp = (Math.random() - 0.5) * BULLET_SPREAD;
      slot.vel.set(inX * BULLET_SPEED + e.d.x * sp, (Math.random() - 0.5) * BULLET_SPREAD, inZ * BULLET_SPEED + e.d.y * sp);
    }
    spawnBurst(new THREE.Vector3(ox, p.h, oz), 0xffb14a);
    if (p.gun) p.gun.userData.recoil = 1;
    Audio.play('shoot');
    syncHud();
  }
  function updateBullets(dt) {
    for (const b of bullets) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.mesh.visible = false; continue; }
      b.mesh.position.addScaledVector(b.vel, dt);
      for (const ball of balls) {
        if (!ball.active) continue;
        if (b.mesh.position.distanceTo(ball.mesh.position) < ball.radius + BULLET_R) {
          ball.vel.copy(b.vel).setLength(BALL_SPEED * speedMul * 1.15);
          ball.lastHitter = b.owner;
          spawnBurst(ball.mesh.position, 0xffb14a);
          b.life = 0; b.mesh.visible = false;
          break;
        }
      }
    }
  }
  function updateGuns(dt) {
    for (const p of players) {
      const g = p.gun; if (!g) continue;
      const r = g.userData.recoil = Math.max(0, g.userData.recoil - dt * 6);
      g.visible = running && p.alive && p.ammo > 0 && !arenaSpinning();
      if (!g.visible) continue;
      const e = p.edge;
      const inX = -e.n.x, inZ = -e.n.y;
      g.position.set(e.A.x + e.d.x * p.c + inX * (0.7 - r * 0.3), p.h - 0.1, e.A.y + e.d.y * p.c + inZ * (0.7 - r * 0.3));
      g.lookAt(0, p.h, 0);
    }
  }

  // A random point inside the polygon (used for power-up spawns).
  function randInterior() {
    const inr = R * Math.cos(Math.PI / N) * 0.72;
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * inr;
    return { x: Math.cos(a) * rr, z: Math.sin(a) * rr };
  }

  // =========================================================================
  // Power-ups
  // =========================================================================
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
      default:          geo = new THREE.TetrahedronGeometry(0.6); break;
    }
    const mat = new THREE.MeshStandardMaterial({
      color: cfg.color, emissive: cfg.color, emissiveIntensity: 0.7, metalness: 0.3, roughness: 0.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const group = new THREE.Group();
    group.add(mesh); group.add(makeGlow(cfg.color, 2.6));
    group.userData.shape = mesh;
    return group;
  }
  function spawnPowerupAt(type, x, y, z) {
    const group = makePowerupMesh(type);
    group.position.set(x, y, z);
    arenaGroup.add(group);
    powerups.push({ type, group, baseY: y, phase: Math.random() * Math.PI * 2 });
  }
  function spawnPowerup() {
    const p = randInterior();
    const y = THREE.MathUtils.lerp(1.5, PLAY_H - 1.5, Math.random());
    spawnPowerupAt(nextPowerupType(), p.x, y, p.z);
  }
  function removePowerup(i) {
    const pu = powerups[i];
    arenaGroup.remove(pu.group);
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

  function otherAlive(owner) {
    return players.filter((p) => p.alive && p !== owner);
  }
  function collectPowerup(pu, ball) {
    const owner = ball.lastHitter && ball.lastHitter.alive ? ball.lastHitter : nearestEdgeOwner(ball.mesh.position);
    const cfg = PU_TYPES[pu.type];
    spawnBurst(pu.group.position, cfg.color);
    let who = '';
    switch (pu.type) {
      case 'MULTIBALL':
        spawnExtraBall(ball);
        if (activeBalls().length < MAX_BALLS) spawnExtraBall(ball);
        break;
      case 'MAGNET': if (owner) { owner.magnetUntil = now + MAGNET_TIME; who = owner.name + ' '; } break;
      case 'GROW':   if (owner) { applyGrow(owner); who = owner.name + ' '; } break;
      case 'SPEED':  applySpeed(); break;
      case 'SHOTGUN': if (owner) { owner.ammo += SHOTGUN_AMMO; who = owner.name + ' '; } break;
      case 'SPIN':   arenaSpinUntil = now + SPIN_TIME; break;
      case 'VINE': {
        const foes = otherAlive(owner);
        if (foes.length) {
          foes.sort((a, b) => b.lives - a.lives); // slow the current leader
          foes[0].slowUntil = now + VINE_TIME;
          who = (owner ? owner.name : '') + ' → ' + foes[0].name + ' ';
        }
        break;
      }
    }
    showToast(`${who}${cfg.label}`, cfg.color);
    Audio.play(pu.type === 'MULTIBALL' ? 'multiball' : 'powerup');
    syncHud();
  }
  function applyGrow(p) {
    p.growUntil = now + GROW_TIME;
    p.paddle.scale.set(GROW_FACTOR, GROW_FACTOR, 1);
    p.halfW = p.baseHalfW * GROW_FACTOR; p.halfH = p.baseHalfH * GROW_FACTOR;
  }
  function applySpeed() {
    const ratio = SPEED_MUL / speedMul;
    for (const b of activeBalls()) b.vel.multiplyScalar(ratio);
    speedMul = SPEED_MUL; speedUntil = now + SPEED_TIME;
  }
  function updateEffects() {
    for (const p of players) {
      if (p.growUntil && now > p.growUntil) {
        p.growUntil = 0; p.paddle.scale.set(1, 1, 1);
        p.halfW = p.baseHalfW; p.halfH = p.baseHalfH;
      }
      if (p.vine) {
        p.vine.visible = running && p.slowUntil > now && p.alive && !arenaSpinning();
        if (p.vine.visible) { p.vine.position.copy(p.paddle.position); p.vine.rotation.y += 0.03; }
      }
    }
    if (speedUntil && now > speedUntil) {
      const back = 1 / speedMul;
      for (const b of activeBalls()) b.vel.multiplyScalar(back);
      speedMul = 1; speedUntil = 0;
    }
  }

  // ---- Arena spin --------------------------------------------------------
  function updateArenaSpin(dt) {
    if (arenaSpinUntil > now) arenaSpinAngle += ARENA_SPIN_RATE * dt;
    else if (arenaSpinAngle !== 0) {
      const target = Math.round(arenaSpinAngle / (Math.PI * 2)) * (Math.PI * 2);
      arenaSpinAngle = THREE.MathUtils.damp(arenaSpinAngle, target, 4, dt);
      if (Math.abs(arenaSpinAngle - target) < 0.004) arenaSpinAngle = 0;
    }
    arenaGroup.rotation.y = arenaSpinAngle;
  }
  function arenaSpinning() { return arenaSpinAngle !== 0; }

  // =========================================================================
  // HUD (DOM, injected)
  // =========================================================================
  let hudRoot = null, cardEls = [], toastEl = null, countEl = null, bannerEl = null,
      winnerEl = null;
  // Card anchor per player: 3P = three columns; 4P = four quadrant corners.
  function cardCss(i) {
    if (N === 3) {
      const lefts = ['14px', 'calc(33.333% + 14px)', 'calc(66.666% + 14px)'];
      return `top:14px;left:${lefts[i]};`;
    }
    return ['top:14px;left:14px;', 'top:14px;right:14px;',
            'bottom:14px;left:14px;', 'bottom:14px;right:14px;'][i];
  }
  function buildHud() {
    if (hudRoot) hudRoot.remove();
    hudRoot = document.createElement('div');
    hudRoot.id = 'polyhud';
    const dividers = N === 3
      ? '<div class="pdivv" style="left:33.333%"></div><div class="pdivv" style="left:66.666%"></div>'
      : '<div class="pdivv"></div><div class="pdivh"></div>';
    hudRoot.innerHTML = dividers + `
      <div class="pcount"></div>
      <div class="ptoast"></div>
      <div class="pbanner">
        <div class="ptrophy">🏆</div>
        <div class="pwinner">PLAYER 1 WINS</div>
        <div class="pbtns">
          <button class="pbtn prematch">REMATCH</button>
          <button class="pbtn pmenu">MENU</button>
        </div>
        <div class="psub">R to rematch · M mutes</div>
      </div>`;
    document.body.appendChild(hudRoot);
    toastEl = hudRoot.querySelector('.ptoast');
    countEl = hudRoot.querySelector('.pcount');
    bannerEl = hudRoot.querySelector('.pbanner');
    winnerEl = hudRoot.querySelector('.pwinner');
    hudRoot.querySelector('.prematch').addEventListener('click', restart);
    hudRoot.querySelector('.pmenu').addEventListener('click', () => quit());

    cardEls = [];
    for (const p of players) {
      const card = document.createElement('div');
      card.className = 'pcard';
      card.style.cssText = 'position:absolute;' + cardCss(p.index);
      hudRoot.appendChild(card);
      cardEls.push(card);
    }
    syncHud();
  }

  function syncHud() {
    if (!cardEls.length) return;
    for (const p of players) {
      const hex = '#' + p.color.toString(16).padStart(6, '0');
      const hearts = '♥'.repeat(p.lives) + '<span style="opacity:.25">' + '♥'.repeat(START_LIVES - p.lives) + '</span>';
      const fx = [];
      if (p.growUntil > now) fx.push('BIG');
      if (p.magnetUntil > now) fx.push('MAGNET');
      if (p.slowUntil > now) fx.push('VINED');
      if (p.ammo > 0) fx.push('×' + p.ammo);
      cardEls[p.index].innerHTML =
        `<div class="pn" style="color:${hex}">${p.name}${p.alive ? '' : ' · OUT'}</div>` +
        `<div class="ph" style="color:${hex}">${p.alive ? hearts : '—'}</div>` +
        (fx.length ? `<div class="pfx">${fx.join(' · ')}</div>` : '');
      cardEls[p.index].style.opacity = p.alive ? '1' : '0.5';
    }
  }
  let toastUntil = 0;
  function showToast(text, color) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.style.color = '#' + color.toString(16).padStart(6, '0');
    toastEl.classList.add('show');
    toastUntil = now + 1.5;
  }
  function showCount(text) {
    if (!countEl) return;
    countEl.textContent = text; countEl.style.display = 'block';
    countEl.classList.remove('pop'); void countEl.offsetWidth; countEl.classList.add('pop');
  }

  // =========================================================================
  // Match flow
  // =========================================================================
  function beginCountdown() {
    countdown = 3; showCount('3');
    balls.forEach(deactivateBall);
  }
  function endMatch(winner) {
    matchOver = true;
    balls.forEach(deactivateBall);
    Audio.play('win');
    Audio.startMusic('victory');
    Confetti.burst();
    if (winnerEl) {
      const hex = winner ? '#' + winner.color.toString(16).padStart(6, '0') : '#eaf2ff';
      winnerEl.textContent = winner ? `${winner.name} WINS` : 'DRAW';
      winnerEl.style.color = hex;
    }
    if (countEl) countEl.style.display = 'none';
    if (bannerEl) bannerEl.classList.add('show');
  }
  function restart() {
    if (bannerEl) bannerEl.classList.remove('show');
    Confetti.stop();
    Audio.startMusic('game');
    matchOver = false;
    speedMul = 1; speedUntil = 0; arenaSpinUntil = 0; arenaSpinAngle = 0;
    arenaGroup.rotation.y = 0;
    for (let i = powerups.length - 1; i >= 0; i--) removePowerup(i);
    for (const b of bullets) { b.life = 0; b.mesh.visible = false; }
    for (const b of balls) deactivateBall(b);
    puBag = [];
    for (const e of edges) {
      e.wall = false;
      if (e.wallMesh) e.wallMesh.layers.set(e.owner + 1);
      if (e.stripMat) { e.stripMat.color.setHex(PLAYER_COLORS[e.owner]); e.stripMat.emissive.setHex(PLAYER_COLORS[e.owner]); }
    }
    for (const p of players) {
      p.lives = START_LIVES; p.alive = true;
      p.growUntil = 0; p.magnetUntil = 0; p.slowUntil = 0; p.ammo = 0;
      p.paddle.scale.set(1, 1, 1); p.halfW = p.baseHalfW; p.halfH = p.baseHalfH;
      p.c = p.edge.L / 2; p.h = PLAY_H / 2; p.prevC = p.c; p.prevH = p.h;
      p.cam.layers.enableAll(); p.cam.layers.disable(p.index + 1);
    }
    updatePaddleTransforms();
    syncHud();
    beginCountdown();
  }

  // =========================================================================
  // Update + render
  // =========================================================================
  function update(dt) {
    if (!running || matchOver) return;
    now += dt;
    if (countdown > 0) {
      const before = Math.ceil(countdown);
      countdown -= dt;
      if (countdown > 0) { const a = Math.ceil(countdown); if (a !== before) { showCount(String(a)); Audio.play('count'); } }
      else { showCount('GO!'); Audio.play('go'); goUntil = now + 0.7; nextSpawn = now + PU_SPAWN_MIN; serveCenter(); }
      movePaddles(dt);
      return;
    }
    if (goUntil && now > goUntil) { if (countEl) countEl.style.display = 'none'; goUntil = 0; }

    movePaddles(dt);
    updateFire(dt);
    updateEffects();
    updateArenaSpin(dt);
    updateBalls(dt);
    updateBullets(dt);
    updatePowerups(dt);
    updateBursts(dt);
    updateGuns(dt);

    if (toastUntil && now > toastUntil) { toastEl.classList.remove('show'); toastUntil = 0; }
  }

  // Per-player viewport rects in GL coords (origin bottom-left). 3P uses three
  // tall columns (bigger per player); 4P uses a 2×2 grid.
  function playerRects() {
    const w = window.innerWidth, h = window.innerHeight;
    if (N === 3) {
      const c = Math.floor(w / 3);
      return [
        { x: 0,     y: 0, w: c,         h },
        { x: c,     y: 0, w: c,         h },
        { x: 2 * c, y: 0, w: w - 2 * c, h },
      ];
    }
    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    return [
      { x: 0,  y: hh, w: hw,     h: h - hh }, // P1 top-left
      { x: hw, y: hh, w: w - hw, h: h - hh }, // P2 top-right
      { x: 0,  y: 0,  w: hw,     h: hh },     // P3 bottom-left
      { x: hw, y: 0,  w: w - hw, h: hh },     // P4 bottom-right
    ];
  }
  // Auto-fit fov so the arena fills each cell regardless of its aspect.
  function frameCam(cam, aspect) {
    const D = cam.userData.fitD || CAM_DIST;
    const vH = 2 * Math.atan(FIT_H / D);
    const vW = 2 * Math.atan((FIT_W / D) / aspect);
    cam.fov = THREE.MathUtils.radToDeg(Math.max(vH, vW)) * 1.06;
    cam.aspect = aspect; cam.updateProjectionMatrix();
  }
  function render() {
    if (!running) return;
    const rects = playerRects();
    renderer.setScissorTest(true);
    for (let i = 0; i < players.length; i++) {
      const p = players[i], r = rects[i];
      frameCam(p.cam, r.w / r.h);
      renderer.setViewport(r.x, r.y, r.w, r.h);
      renderer.setScissor(r.x, r.y, r.w, r.h);
      renderer.render(scene, p.cam);
    }
    renderer.setScissorTest(false);
  }

  // =========================================================================
  // Public API
  // =========================================================================
  function start(playerCount) {
    buildArena(playerCount);
    buildHud();
    document.body.classList.add('polyactive');
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    running = true; matchOver = false; now = 0;
    speedMul = 1; speedUntil = 0; arenaSpinUntil = 0; arenaSpinAngle = 0;
    Audio.unlock();
    Audio.startMusic('game');
    beginCountdown();
  }
  function stop() {
    running = false;
    Confetti.stop();
    Audio.stopMusic();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMouseMove);
    document.body.classList.remove('polyactive');
    if (hudRoot) { hudRoot.remove(); hudRoot = null; cardEls = []; }
  }
  function quit() { stop(); onExit(); }

  return {
    start, stop,
    update, render,
    isRunning: () => running,
    isMatchOver: () => matchOver,
    goHome: () => quit(),
    resize: () => { /* rects recomputed each frame; nothing to cache */ },
  };
}
