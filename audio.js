// ===========================================================================
// audio.js — chiptune sound engine (WebAudio, fully synthesized, no assets).
//
// Provides one-shot sound effects and a looping, bouncy 8-bit background track
// in the spirit of a classic platformer. Everything is generated from
// oscillators + noise, so there are no files to load and it works offline.
//
// Browsers block audio until a user gesture, so call `unlock()` from a click /
// keydown. Both the classic game and the polygon mode import this singleton.
// ===========================================================================

let ctx = null;
let master = null;
const buses = {}; // music, ball, gun, sfx — each its own independently mixable gain
let muted = false;
let unlocked = false;

// Independent volume levels (0..1). 'master' is the overall "Sound" level;
// the rest ride underneath it. Callers can adjust any of these live.
const CHANNELS = ['music', 'ball', 'gun', 'sfx'];
const vol = { master: 0.8, music: 0.6, ball: 0.85, gun: 0.7, sfx: 0.7 };

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain(); master.connect(ctx.destination);
  for (const k of CHANNELS) { buses[k] = ctx.createGain(); buses[k].connect(master); }
  applyVolumes();
  return ctx;
}
function applyVolumes() {
  if (!master) return;
  master.gain.value = muted ? 0 : vol.master;
  for (const k of CHANNELS) if (buses[k]) buses[k].gain.value = vol[k];
}

// 'sound' is an alias for the master level.
export function setVolume(ch, v) {
  if (ch === 'sound') ch = 'master';
  if (!(ch in vol)) return;
  vol[ch] = Math.max(0, Math.min(1, v));
  if (ch === 'master') { if (master) master.gain.value = muted ? 0 : vol.master; }
  else if (buses[ch]) buses[ch].gain.value = vol[ch];
}
export function getVolume(ch) { return vol[ch === 'sound' ? 'master' : ch]; }

export function unlock() {
  ensure();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  unlocked = true;
}

export function setMuted(m) {
  muted = m;
  if (ctx && master) master.gain.setTargetAtTime(m ? 0 : vol.master, ctx.currentTime, 0.02);
}
export function toggleMuted() { setMuted(!muted); return muted; }
export function isMuted() { return muted; }

// ---- Low-level voices ------------------------------------------------------
function tone(freq, when, dur, type = 'square', vol = 0.5, slideTo = null, dest = null) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, when + dur);
  // Punchy chiptune envelope: fast attack, short decay.
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vol, when + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g); g.connect(dest || buses.sfx);
  o.start(when); o.stop(when + dur + 0.02);
}
function noise(when, dur, vol = 0.5, freq = 1200, dest = null) {
  if (!ctx) return;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = freq; filt.Q.value = 0.8;
  const g = ctx.createGain(); g.gain.value = vol;
  src.connect(filt); filt.connect(g); g.connect(dest || buses.sfx);
  src.start(when); src.stop(when + dur);
}
function arp(freqs, when, step, dur, type, vol, dest) {
  freqs.forEach((f, i) => tone(f, when + i * step, dur, type, vol, null, dest));
}

// ---- Sound effects (each takes its destination bus) ------------------------
const SFX = {
  hit:       (d) => tone(680, t(), 0.06, 'square', 0.5, 900, d),
  bounce:    (d) => tone(300, t(), 0.05, 'square', 0.4, 380, d),
  wall:      (d) => tone(220, t(), 0.05, 'triangle', 0.45, 180, d),
  score:     (d) => { const s = t(); tone(500, s, 0.09, 'square', 0.5, 380, d); tone(300, s + 0.09, 0.14, 'square', 0.45, 180, d); },
  powerup:   (d) => arp([660, 880, 1046, 1320], t(), 0.055, 0.09, 'square', 0.42, d),
  multiball: (d) => arp([784, 988, 1318, 1568], t(), 0.045, 0.08, 'square', 0.4, d),
  shoot:     (d) => { noise(t(), 0.14, 0.5, 900, d); tone(180, t(), 0.1, 'sawtooth', 0.35, 80, d); },
  eliminate: (d) => arp([440, 349, 262, 175], t(), 0.11, 0.16, 'square', 0.5, d),
  count:     (d) => tone(880, t(), 0.12, 'square', 0.5, null, d),
  go:        (d) => { const s = t(); tone(1046, s, 0.1, 'square', 0.55, null, d); tone(1568, s + 0.1, 0.22, 'square', 0.5, null, d); },
  win:       (d) => arp([523, 659, 784, 1046, 1318], t(), 0.11, 0.2, 'square', 0.5, d),
  start:     (d) => arp([392, 523, 659], t(), 0.06, 0.1, 'square', 0.4, d),
};
// Which bus each effect plays through.
const SFX_BUS = { hit: 'ball', bounce: 'ball', wall: 'ball', score: 'ball', shoot: 'gun' };
function t() { return ctx ? ctx.currentTime : 0; }
export function play(name) {
  if (muted || !unlocked) return;
  ensure();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  const fn = SFX[name];
  if (fn) fn(buses[SFX_BUS[name] || 'sfx']);
}

// ===========================================================================
// Background music — original 8-bit loops scheduled with a look-ahead timer.
// Three tracks: a bouncy game loop, a mellower home-screen loop, and a
// triumphant victory fanfare. Each is a lead arpeggio over a walking bass,
// generated from a chord progression.
// ===========================================================================
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// root = MIDI note of the chord root; third = 3 (minor) or 4 (major) semitones.
const TRACKS = {
  // Home screen: gentle, catchy, a touch wistful (Am–F–C–G).
  menu: {
    step: 0.21, oct: 12, wave: 'triangle', leadVol: 0.55, bassVol: 0.55, hats: true, stab: false,
    prog: [{ root: 57, third: 3 }, { root: 53, third: 4 }, { root: 60, third: 4 }, { root: 55, third: 4 }],
  },
  // In-game: bouncy and driving (C–Am–F–G).
  game: {
    step: 0.15, oct: 12, wave: 'square', leadVol: 0.5, bassVol: 0.6, hats: true, stab: false,
    prog: [{ root: 60, third: 4 }, { root: 57, third: 3 }, { root: 53, third: 4 }, { root: 55, third: 4 }],
  },
  // Victory: fast, bright, triumphant with chord stabs (I–IV–V–I).
  victory: {
    step: 0.125, oct: 12, wave: 'square', leadVol: 0.55, bassVol: 0.66, hats: true, stab: true,
    prog: [{ root: 60, third: 4 }, { root: 53, third: 4 }, { root: 55, third: 4 }, { root: 60, third: 4 }],
  },
};
const STEPS_PER_BAR = 8;
const CROSSFADE = 1.3;    // seconds to blend one track into the next

// Each playing track is a "voice" with its own gain node, so we can crossfade
// between them: the old voice ramps down while the new one ramps up, and both
// keep sequencing during the blend — no hard cut.
let voices = [];

function scheduleStep(cfg, i, when, dest) {
  const bar = Math.floor(i / STEPS_PER_BAR) % cfg.prog.length;
  const s = i % STEPS_PER_BAR;
  const { root, third } = cfg.prog[bar];
  // Lead arpeggio: root, third, fifth, third … bouncing up to the octave.
  const pat = [0, third, 7, third, 12, 7, third, 12];
  tone(midi(root + cfg.oct + pat[s]), when, cfg.step * 0.9, cfg.wave, cfg.leadVol, null, dest);
  // Walking bass on the quarter notes (root / fifth), an octave down.
  if (s % 2 === 0) {
    const bass = midi(root - 12 + (s % 4 === 0 ? 0 : 7));
    tone(bass, when, cfg.step * 1.6, 'triangle', cfg.bassVol, null, dest);
  }
  if (cfg.hats && s % 2 === 1) noise(when, 0.03, 0.12, 6000, dest);
  // Triumphant chord stab at the top of each bar (victory only).
  if (cfg.stab && s === 0) {
    [0, third, 7, 12].forEach((t) => tone(midi(root + t), when, cfg.step * 3.2, 'square', cfg.leadVol * 0.45, null, dest));
  }
}

function makeVoice(track) {
  const cfg = TRACKS[track] || TRACKS.game;
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  gain.connect(buses.music);
  const v = { track, cfg, gain, timer: null, next: ctx.currentTime + 0.06, step: 0, on: true };
  const lookahead = () => {
    if (!v.on) return;
    while (v.next < ctx.currentTime + 0.15) {
      scheduleStep(cfg, v.step, v.next, gain);
      v.next += cfg.step;
      v.step++;
    }
    v.timer = setTimeout(lookahead, 25);
  };
  lookahead();
  return v;
}

function fadeOut(v, fade) {
  if (!v || !v.on) return;
  const t = ctx.currentTime;
  const g = v.gain.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(Math.max(g.value, 0.0001), t);
  g.exponentialRampToValueAtTime(0.0001, t + fade);
  // Keep sequencing through the fade, then tear the voice down.
  setTimeout(() => {
    v.on = false;
    if (v.timer) clearTimeout(v.timer);
    try { v.gain.disconnect(); } catch (e) { /* already gone */ }
    voices = voices.filter((x) => x !== v);
  }, (fade + 0.1) * 1000);
}

export function startMusic(track = 'game', fade = CROSSFADE) {
  ensure();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const cur = voices[voices.length - 1];
  if (cur && cur.on && cur.track === track) return; // already playing this one
  for (const v of voices.slice()) fadeOut(v, fade); // blend all current voices out
  const nv = makeVoice(track);
  const t = ctx.currentTime;
  nv.gain.gain.setValueAtTime(0.0001, t);
  nv.gain.gain.exponentialRampToValueAtTime(1, t + fade); // …and the new one in
  voices.push(nv);
}
export function stopMusic(fade = 0.5) {
  for (const v of voices.slice()) fadeOut(v, fade);
}
