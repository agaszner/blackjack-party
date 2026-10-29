// Transport layer. The party host's browser acts as the game server and every
// other player connects to it directly over WebRTC (via PeerJS). A
// BroadcastChannel transport (?transport=local) lets several tabs of one
// browser play together, which is handy for development and tests.
//
// A connection object looks like: { send(obj), onData(cb), onClose(cb), close() }

const PEER_PREFIX = 'bjparty-v1-';
const useLocal = new URLSearchParams(location.search).get('transport') === 'local';

function makeConn(sendFn, closeFn) {
  const dataCbs = [];
  const closeCbs = [];
  let closed = false;
  return {
    send: (obj) => { if (!closed) sendFn(obj); },
    onData: (cb) => dataCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => { if (!closed) { closed = true; closeFn(); closeCbs.forEach((cb) => cb()); } },
    _data: (obj) => dataCbs.forEach((cb) => cb(obj)),
    _closed: () => { if (!closed) { closed = true; closeCbs.forEach((cb) => cb()); } },
  };
}

// ---------- PeerJS (production) ----------

function peerHost(code, onConnection) {
  return new Promise((resolve, reject) => {
    const peer = new window.Peer(PEER_PREFIX + code, { debug: 1 });
    let opened = false;
    peer.on('open', () => { opened = true; resolve({ destroy: () => peer.destroy() }); });
    peer.on('error', (err) => {
      if (!opened) { peer.destroy(); reject(err); }
      else console.warn('peer error', err);
    });
    // Lost the signalling server: existing player connections keep working,
    // but new players can't join until we re-register.
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1000); });
    peer.on('connection', (dc) => {
      const conn = makeConn((obj) => dc.send(obj), () => dc.close());
      dc.on('data', (obj) => conn._data(obj));
      dc.on('close', () => conn._closed());
      dc.on('error', () => conn._closed());
      dc.on('open', () => onConnection(conn));
    });
  });
}

function peerConnect(code) {
  return new Promise((resolve, reject) => {
    const peer = new window.Peer({ debug: 1 });
    let settled = false;
    const fail = (msg) => { if (!settled) { settled = true; peer.destroy(); reject(new Error(msg)); } };
    const timer = setTimeout(() => fail('Could not reach the party. Check the code and that the host is online.'), 20000);
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') fail(`No party found with code ${code}. Is the host still online?`);
      else fail(`Connection error: ${err.type || err.message}`);
    });
    peer.on('open', () => {
      const dc = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
      const conn = makeConn((obj) => dc.send(obj), () => { dc.close(); peer.destroy(); });
      dc.on('data', (obj) => conn._data(obj));
      dc.on('close', () => { conn._closed(); peer.destroy(); });
      dc.on('error', () => conn._closed());
      dc.on('open', () => { settled = true; clearTimeout(timer); resolve(conn); });
    });
  });
}

// ---------- BroadcastChannel (local testing) ----------

function localHost(code, onConnection) {
  const ch = new BroadcastChannel(`bjparty-local-${code}`);
  const conns = new Map();
  ch.onmessage = ({ data: m }) => {
    if (m.to !== 'host') return;
    if (m.kind === 'open') {
      const conn = makeConn((obj) => ch.postMessage({ to: m.from, kind: 'data', data: obj }),
        () => ch.postMessage({ to: m.from, kind: 'close' }));
      conns.set(m.from, conn);
      ch.postMessage({ to: m.from, kind: 'accept' });
      onConnection(conn);
    } else if (m.kind === 'data') conns.get(m.from)?._data(m.data);
    else if (m.kind === 'close') { conns.get(m.from)?._closed(); conns.delete(m.from); }
  };
  window.addEventListener('pagehide', () => conns.forEach((c) => c.close()));
  return Promise.resolve({ destroy: () => { conns.forEach((c) => c.close()); ch.close(); } });
}

function localConnect(code) {
  return new Promise((resolve, reject) => {
    const ch = new BroadcastChannel(`bjparty-local-${code}`);
    const me = Math.random().toString(36).slice(2);
    const conn = makeConn((obj) => ch.postMessage({ to: 'host', from: me, kind: 'data', data: obj }),
      () => { ch.postMessage({ to: 'host', from: me, kind: 'close' }); ch.close(); });
    const timer = setTimeout(() => { ch.close(); reject(new Error(`No party found with code ${code}.`)); }, 3000);
    ch.onmessage = ({ data: m }) => {
      if (m.to !== me) return;
      if (m.kind === 'accept') { clearTimeout(timer); resolve(conn); }
      else if (m.kind === 'data') conn._data(m.data);
      else if (m.kind === 'close') { conn._closed(); ch.close(); }
    };
    window.addEventListener('pagehide', () => conn.close());
    ch.postMessage({ to: 'host', from: me, kind: 'open' });
  });
}

export const hostParty = useLocal ? localHost : peerHost;
export const joinParty = useLocal ? localConnect : peerConnect;
export const transportName = useLocal ? 'local' : 'peer';
