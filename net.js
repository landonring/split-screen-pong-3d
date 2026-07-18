// ===========================================================================
// net.js — tiny WebRTC wrapper over PeerJS for 1v1 online play.
//
// No server of our own: PeerJS's free cloud broker only helps the two peers
// find each other, after which the game data flows directly device-to-device
// over a WebRTC data channel. The "invite code" is a short room id.
//
// Requires the global `Peer` (PeerJS) to be loaded via a <script> tag.
// ===========================================================================
const PREFIX = 'sspong3d-';               // namespace so codes don't collide with other PeerJS apps
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars (I/L/O/0/1)

export function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// ICE servers: STUN for direct hole-punching, plus free public TURN relays so
// peers on strict/different networks (cellular, corporate/school Wi-Fi) can
// still connect by bouncing data through the relay. Both peers use these.
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

function wireData(conn, h) {
  conn.on('data', (d) => h.onData && h.onData(d));
  conn.on('close', () => { log('conn closed'); h.onClose && h.onClose(); });
  conn.on('error', (e) => log('conn error', e && e.type, e));
}

// Host a room. Calls h.onCode(code) once the room is registered, then
// h.onConnected() when a guest joins. Returns { send, close }.
export function hostGame(h) {
  const handle = { conn: null, peer: null, code: null, closed: false,
    send: (o) => { if (handle.conn && handle.conn.open) handle.conn.send(o); },
    close: () => { handle.closed = true; try { handle.peer && handle.peer.destroy(); } catch (e) { /* */ } } };

  function attempt(tries) {
    const code = randomCode();
    const peer = new Peer(PREFIX + code, PEER_OPTS);
    handle.peer = peer; handle.code = code;
    peer.on('open', () => { log('hosting as', code); h.onCode && h.onCode(code); });
    peer.on('connection', (conn) => {
      log('guest connecting…');
      handle.conn = conn;
      conn.on('open', () => { log('guest connected'); h.onConnected && h.onConnected(conn); });
      wireData(conn, h);
    });
    peer.on('disconnected', () => { if (!handle.closed) { log('host broker dropped — reconnecting'); try { peer.reconnect(); } catch (e) { /* */ } } });
    peer.on('error', (e) => {
      log('host peer error', e && e.type);
      if (e && e.type === 'unavailable-id' && tries < 6) { try { peer.destroy(); } catch (er) { /* */ } attempt(tries + 1); }
      else if (e && (e.type === 'network' || e.type === 'disconnected')) { /* transient — reconnect handles it */ }
      else h.onError && h.onError(e);
    });
  }
  attempt(0);
  return handle;
}

// Join a room by code. Retries a few times because the host may still be
// registering with the broker (peer-unavailable) when we first try.
export function joinGame(code, h) {
  const target = PREFIX + (code || '').toUpperCase().trim();
  const peer = new Peer(undefined, PEER_OPTS);
  const handle = { conn: null, peer, closed: false, done: false,
    send: (o) => { if (handle.conn && handle.conn.open) handle.conn.send(o); },
    close: () => { handle.closed = true; handle.done = true; try { peer.destroy(); } catch (e) { /* */ } } };

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
    conn.on('open', () => { opened = true; handle.done = true; log('connected'); h.onConnected && h.onConnected(conn); });
    wireData(conn, h);
    // If this attempt doesn't open, try again (host might not be up yet).
    setTimeout(() => { if (!opened && !handle.done && tries < MAX_TRIES) tryConnect(); }, 2600);
  }

  peer.on('open', () => { log('guest peer ready'); tries = 0; tryConnect(); });
  peer.on('disconnected', () => { if (!handle.closed) { try { peer.reconnect(); } catch (e) { /* */ } } });
  peer.on('error', (e) => {
    log('guest peer error', e && e.type);
    if (e && e.type === 'peer-unavailable') {
      if (tries < MAX_TRIES && !handle.done) { setTimeout(tryConnect, 1500); }
      else if (!handle.done) h.onError && h.onError({ type: 'not-found' });
    } else if (e && (e.type === 'network' || e.type === 'disconnected')) {
      /* transient — reconnect handles it */
    } else if (!handle.done) {
      h.onError && h.onError(e);
    }
  });
  return handle;
}
