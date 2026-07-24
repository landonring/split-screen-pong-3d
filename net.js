// ===========================================================================
// net.js — tiny WebRTC wrapper over PeerJS for invite-code multiplayer.
//
// One device hosts a "room" (a short invite code); up to three other devices
// join it. No server of our own: PeerJS's free cloud broker only helps peers
// find each other, after which game data flows directly device-to-device over
// WebRTC data channels.
//
// The host keeps one connection per guest and is the only one that talks to
// everyone (guests never talk to each other), so the topology is a star with
// the host — which also runs the physics — at the centre.
//
// Requires the global `Peer` (PeerJS) to be loaded via a <script> tag.
// ===========================================================================
const PREFIX = 'sspong3d-';                        // namespace so codes don't collide with other PeerJS apps
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars (I/L/O/0/1)

export function available() { return typeof Peer !== 'undefined'; }

export function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// ICE servers: STUN for direct hole-punching, plus free public TURN relays so
// peers on strict/different networks (cellular, school/office Wi-Fi) can still
// connect by bouncing data through a relay.
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};

function log(...a) { try { console.log('[net]', ...a); } catch (e) { /* */ } }

// ---------------------------------------------------------------------------
// Host a room. Handlers: onCode(code), onJoin(id), onData(id, msg),
// onLeave(id), onError(err). Returns a handle with per-peer + broadcast sends.
// ---------------------------------------------------------------------------
export function hostRoom(h) {
  const conns = new Map(); // peerId -> DataConnection
  const handle = {
    code: null, peer: null, closed: false,
    ids: () => Array.from(conns.keys()),
    send: (id, msg) => { const c = conns.get(id); if (c && c.open) { try { c.send(msg); } catch (e) { /* */ } } },
    broadcast: (msg) => { for (const c of conns.values()) if (c.open) { try { c.send(msg); } catch (e) { /* */ } } },
    drop: (id) => { const c = conns.get(id); conns.delete(id); if (c) { try { c.close(); } catch (e) { /* */ } } },
    close: () => {
      handle.closed = true;
      for (const c of conns.values()) { try { c.close(); } catch (e) { /* */ } }
      conns.clear();
      try { handle.peer && handle.peer.destroy(); } catch (e) { /* */ }
    },
  };

  function attempt(tries) {
    const code = randomCode();
    const peer = new Peer(PREFIX + code, PEER_OPTS);
    handle.peer = peer; handle.code = code;
    peer.on('open', () => { log('hosting as', code); h.onCode && h.onCode(code); });
    peer.on('connection', (conn) => {
      const id = conn.peer;
      log('guest connecting', id);
      conn.on('open', () => { conns.set(id, conn); h.onJoin && h.onJoin(id); });
      conn.on('data', (d) => h.onData && h.onData(id, d));
      conn.on('close', () => { if (conns.delete(id)) { log('guest left', id); h.onLeave && h.onLeave(id); } });
      conn.on('error', (e) => log('conn error', e && e.type));
    });
    peer.on('disconnected', () => {
      if (!handle.closed) { log('broker dropped — reconnecting'); try { peer.reconnect(); } catch (e) { /* */ } }
    });
    peer.on('error', (e) => {
      log('host peer error', e && e.type);
      // Someone else grabbed this code — roll another one and try again.
      if (e && e.type === 'unavailable-id' && tries < 6) {
        try { peer.destroy(); } catch (er) { /* */ }
        attempt(tries + 1);
      } else if (e && (e.type === 'network' || e.type === 'disconnected' || e.type === 'peer-unavailable')) {
        /* transient — the reconnect handler deals with it */
      } else {
        h.onError && h.onError(e);
      }
    });
  }
  attempt(0);
  return handle;
}

// ---------------------------------------------------------------------------
// Join a room by code. Retries for a while because the host may still be
// registering with the broker (peer-unavailable) when we first knock.
// Handlers: onConnected(), onData(msg), onClose(), onRetry(n), onError(err).
// ---------------------------------------------------------------------------
export function joinRoom(code, h) {
  const target = PREFIX + (code || '').toUpperCase().trim();
  const peer = new Peer(undefined, PEER_OPTS);
  const handle = {
    conn: null, peer, closed: false, done: false,
    send: (msg) => { if (handle.conn && handle.conn.open) { try { handle.conn.send(msg); } catch (e) { /* */ } } },
    close: () => { handle.closed = true; handle.done = true; try { peer.destroy(); } catch (e) { /* */ } },
  };

  let tries = 0;
  const MAX_TRIES = 8;
  function tryConnect() {
    if (handle.done || handle.closed) return;
    tries++;
    log('connecting to', target, 'attempt', tries);
    if (h.onRetry && tries > 1) h.onRetry(tries);
    const conn = peer.connect(target, { reliable: true });
    handle.conn = conn;
    let opened = false;
    conn.on('open', () => {
      opened = true; handle.done = true;
      log('connected');
      h.onConnected && h.onConnected();
    });
    conn.on('data', (d) => h.onData && h.onData(d));
    conn.on('close', () => { if (!handle.closed) h.onClose && h.onClose(); });
    conn.on('error', (e) => log('conn error', e && e.type));
    // If this attempt never opens, knock again — the host may not be up yet.
    setTimeout(() => { if (!opened && !handle.done && tries < MAX_TRIES) tryConnect(); }, 2600);
  }

  peer.on('open', () => { tries = 0; tryConnect(); });
  peer.on('disconnected', () => { if (!handle.closed) { try { peer.reconnect(); } catch (e) { /* */ } } });
  peer.on('error', (e) => {
    log('guest peer error', e && e.type);
    if (e && e.type === 'peer-unavailable') {
      if (tries < MAX_TRIES && !handle.done) setTimeout(tryConnect, 1500);
      else if (!handle.done) h.onError && h.onError({ type: 'not-found' });
    } else if (e && (e.type === 'network' || e.type === 'disconnected')) {
      /* transient — reconnect handles it */
    } else if (!handle.done) {
      h.onError && h.onError(e);
    }
  });
  return handle;
}
