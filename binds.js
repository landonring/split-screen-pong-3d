// ===========================================================================
// binds.js — editable keyboard bindings, shared by the classic and polygon
// modes and persisted to localStorage. Keys are stored as lowercased
// `KeyboardEvent.key` values (e.g. 'a', ' ', 'arrowup').
// ===========================================================================
const KEY = 'splitpong.binds';

const DEFAULTS = {
  p1Up: 'w', p1Down: 's', p1Left: 'a', p1Right: 'd', p1Shoot: ' ',
  p2Up: 'arrowup', p2Down: 'arrowdown', p2Left: 'arrowleft', p2Right: 'arrowright', p2Shoot: '/',
  fullscreen: 'f', view: 'c', mute: 'm', rematch: 'r',
};

// Layout for the settings UI.
export const BIND_META = [
  { group: 'PLAYER 1', items: [['p1Up', 'Up'], ['p1Down', 'Down'], ['p1Left', 'Left'], ['p1Right', 'Right'], ['p1Shoot', 'Shoot']] },
  { group: 'PLAYER 2', items: [['p2Up', 'Up'], ['p2Down', 'Down'], ['p2Left', 'Left'], ['p2Right', 'Right'], ['p2Shoot', 'Shoot']] },
  { group: 'GENERAL', items: [['fullscreen', 'Fullscreen'], ['view', 'Switch view'], ['mute', 'Mute'], ['rematch', 'Rematch']] },
];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
}
export const binds = { ...DEFAULTS, ...load() };

function save() { try { localStorage.setItem(KEY, JSON.stringify(binds)); } catch (e) { /* ignore */ } }

export function setBind(action, key) {
  if (!(action in binds)) return;
  binds[action] = key;
  save();
}
export function resetBinds() {
  Object.assign(binds, DEFAULTS);
  save();
}

// Human-readable label for a stored key.
export function keyLabel(k) {
  if (k === ' ') return 'Space';
  const map = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
    enter: 'Enter', escape: 'Esc', tab: 'Tab', control: 'Ctrl', shift: 'Shift', ' ': 'Space' };
  if (map[k]) return map[k];
  return k.length === 1 ? k.toUpperCase() : k.replace(/^\w/, (c) => c.toUpperCase());
}
