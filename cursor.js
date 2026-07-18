// ===========================================================================
// cursor.js — a glowing reticle cursor driven by the gamepad's LEFT stick.
// Lets controller players roam the menus / win screens and click buttons with
// R2. While active it hides the OS cursor and tracks the mouse so the two stay
// in sync. Shown only on UI screens (caller passes `uiActive`), hidden in play.
// ===========================================================================
const SPEED = 1000;   // px/sec at full stick deflection
const DEADZONE = 0.2;

function dz(v) { return Math.abs(v) < DEADZONE ? 0 : v; }
function firstPad() {
  const list = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = 0; i < list.length; i++) if (list[i]) return list[i];
  return null;
}

export function createCursor() {
  // ---- Styles (injected once) ----
  const style = document.createElement('style');
  style.textContent = `
    #gamecursor { position: fixed; top: 0; left: 0; width: 46px; height: 46px;
      margin: -23px 0 0 -23px; z-index: 10000; pointer-events: none;
      opacity: 0; transition: opacity .18s ease; }
    #gamecursor.show { opacity: 1; }
    #gamecursor .cur-core { position: absolute; inset: 0; }
    #gamecursor.click .cur-core { animation: curclick .25s ease; }
    #gamecursor .cur-ring { position: absolute; inset: 3px; border-radius: 50%;
      border: 2px solid rgba(88,208,255,.95);
      box-shadow: 0 0 14px rgba(88,208,255,.85), inset 0 0 8px rgba(88,208,255,.5);
      animation: curspin 3s linear infinite; }
    #gamecursor .cur-ring2 { position: absolute; inset: 11px; border-radius: 50%;
      border: 1px dashed rgba(53,224,74,.8);
      animation: curspin 2.2s linear infinite reverse; }
    #gamecursor .cur-dot { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
      margin: -3px 0 0 -3px; border-radius: 50%; background: #fff;
      box-shadow: 0 0 10px #58d0ff, 0 0 4px #fff; animation: curpulse 1.1s ease-in-out infinite; }
    #gamecursor .cur-tick { position: absolute; left: 50%; top: 50%; width: 2px; height: 6px;
      margin: -3px 0 0 -1px; background: rgba(88,208,255,.95); box-shadow: 0 0 6px rgba(88,208,255,.9); }
    #gamecursor .t-n { transform: translateY(-19px); }
    #gamecursor .t-s { transform: translateY(19px); }
    #gamecursor .t-e { transform: translateX(19px) rotate(90deg); }
    #gamecursor .t-w { transform: translateX(-19px) rotate(90deg); }
    @keyframes curspin { to { transform: rotate(360deg); } }
    @keyframes curpulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.5); opacity: .7; } }
    @keyframes curclick { 0% { transform: scale(1); } 40% { transform: scale(.72); } 100% { transform: scale(1); } }
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'gamecursor';
  el.innerHTML = '<div class="cur-core">' +
    '<div class="cur-ring"></div><div class="cur-ring2"></div><div class="cur-dot"></div>' +
    '<div class="cur-tick t-n"></div><div class="cur-tick t-s"></div>' +
    '<div class="cur-tick t-e"></div><div class="cur-tick t-w"></div></div>';
  document.body.appendChild(el);
  const core = el.querySelector('.cur-core');

  let x = window.innerWidth / 2, y = window.innerHeight / 2;
  let clickPrev = false, visible = false;
  let sens = 1; // multiplier on SPEED (set from the settings slider)

  window.addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; place(); });

  function place() { el.style.left = x + 'px'; el.style.top = y + 'px'; }
  function show(v) {
    if (v === visible) return;
    visible = v; el.classList.toggle('show', v);
    document.body.style.cursor = v ? 'none' : ''; // hide the OS cursor while active
  }
  function doClick() {
    const t = document.elementFromPoint(x, y); // el is pointer-events:none, so this hits UI under it
    core.classList.remove('click'); void core.offsetWidth; core.classList.add('click');
    if (t && typeof t.click === 'function') {
      // Click the nearest clickable ancestor (button, etc.).
      let node = t;
      while (node && node !== document.body && !(node.tagName === 'BUTTON' || node.getAttribute?.('data-play') !== null)) {
        if (node.onclick || node.tagName === 'BUTTON') break;
        node = node.parentElement;
      }
      (node && node !== document.body ? node : t).click();
    }
  }

  function update(dt, uiActive) {
    if (!uiActive) { show(false); clickPrev = false; return; }
    const pad = firstPad();
    if (pad) {
      const ax = dz(pad.axes[0] || 0), ay = dz(pad.axes[1] || 0);
      if (ax || ay) {
        const spd = SPEED * sens;
        x = Math.max(0, Math.min(window.innerWidth, x + ax * spd * dt));
        y = Math.max(0, Math.min(window.innerHeight, y + ay * spd * dt));
        place();
      }
      const b = pad.buttons[7]; // R2
      const pressed = !!(b && (b.pressed || b.value > 0.5));
      if (pressed && !clickPrev) doClick();
      clickPrev = pressed;
    }
    show(true);
  }

  // v is 0..1 from the settings slider → 0.3×…2.6× speed.
  function setSensitivity(v) { sens = 0.3 + Math.max(0, Math.min(1, v)) * 2.3; }

  return { update, setSensitivity };
}
