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

function wire(conn, h) {
  conn.on('open', () => h.onConnected && h.onConnected(conn));
  conn.on('data', (d) => h.onData && h.onData(d));
  conn.on('close', () => h.onClose && h.onClose());
  conn.on('error', (e) => h.onError && h.onError(e));
}

// Host a room. Calls h.onCode(code) once the room is registered, then
// h.onConnected() when a guest joins. Returns { send, close, code }.
export function hostGame(h) {
  const handle = { conn: null, peer: null, code: null,
    send: (o) => { if (handle.conn && handle.conn.open) handle.conn.send(o); },
    close: () => { try { handle.peer && handle.peer.destroy(); } catch (e) { /* */ } } };

  function attempt(tries) {
    const code = randomCode();
    const peer = new Peer(PREFIX + code);
    handle.peer = peer; handle.code = code;
    peer.on('open', () => h.onCode && h.onCode(code));
    peer.on('connection', (conn) => {
      handle.conn = conn;
      wire(conn, h);
    });
    peer.on('error', (e) => {
      if (e && e.type === 'unavailable-id' && tries < 6) { try { peer.destroy(); } catch (er) { /* */ } attempt(tries + 1); }
      else h.onError && h.onError(e);
    });
  }
  attempt(0);
  return handle;
}

// Join a room by code. Calls h.onConnected() when the channel opens.
export function joinGame(code, h) {
  const peer = new Peer();
  const handle = { conn: null, peer,
    send: (o) => { if (handle.conn && handle.conn.open) handle.conn.send(o); },
    close: () => { try { peer.destroy(); } catch (e) { /* */ } } };
  peer.on('open', () => {
    const conn = peer.connect(PREFIX + code.toUpperCase().trim(), { reliable: true });
    handle.conn = conn;
    wire(conn, h);
  });
  peer.on('error', (e) => h.onError && h.onError(e));
  return handle;
}
