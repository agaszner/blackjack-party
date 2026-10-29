// Runs in the party host's browser: owns the Game, applies actions coming from
// players, drives the dealer and turn timers, and broadcasts the table state.
import { Game, GameError } from './engine.js';

const DEALER_DELAY = 900;
const ABSENT_DELAY = 1500;
const SAVE_PREFIX = 'bjparty-host-';
const SAVE_MAX_AGE = 12 * 3600 * 1000;

const PLAYER_ACTIONS = {
  bet: (g, id, m) => g.placeBet(id, m.amount),
  unready: (g, id) => g.unready(id),
  insurance: (g, id, m) => g.takeInsurance(id, !!m.take),
  hit: (g, id) => g.hit(id),
  stand: (g, id) => g.stand(id),
  double: (g, id) => g.double(id),
  split: (g, id) => g.split(id),
  surrender: (g, id) => g.surrender(id),
  rebuy: (g, id) => g.rebuy(id),
  chat: (g, id, m) => g.chat(id, m.text),
  leave: (g, id) => g.remove(id),
};

export function loadSavedHost(code) {
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + code);
    if (!raw) return null;
    const save = JSON.parse(raw);
    if (Date.now() - save.savedAt > SAVE_MAX_AGE) return null;
    return save;
  } catch {
    return null;
  }
}

export function forgetSavedHost(code) {
  try { localStorage.removeItem(SAVE_PREFIX + code); } catch {}
}

export class Host {
  // onView(view, myPlayerId) is called whenever the host's own screen should update.
  constructor({ game, hostToken, hostName, hostPlays, onView }) {
    this.game = game;
    this.hostToken = hostToken;
    this.hostName = hostName;
    this.hostPlays = hostPlays;
    this.onView = onView;
    this.conns = new Map(); // conn -> player id
    this.timers = {};
    this.myId = null;
    if (hostPlays) {
      this.myId = game.join(hostToken, hostName).id;
      game.s.players.find((p) => p.id === this.myId).connected = true;
    }
    // After a reload, nobody is connected until they reconnect.
    for (const p of game.s.players) if (p.id !== this.myId) p.connected = false;
  }

  static fresh({ code, settings, hostToken, hostName, hostPlays, onView }) {
    return new Host({ game: Game.create({ code, settings }), hostToken, hostName, hostPlays, onView });
  }

  static restore(save, onView) {
    return new Host({ game: new Game(save.state), hostToken: save.hostToken, hostName: save.hostName,
      hostPlays: save.hostPlays, onView });
  }

  get code() {
    return this.game.s.code;
  }

  // ---------- connections ----------

  accept(conn) {
    conn.onData((msg) => this.onMessage(conn, msg));
    conn.onClose(() => {
      const id = this.conns.get(conn);
      this.conns.delete(conn);
      if (id && ![...this.conns.values()].includes(id)) {
        this.game.setConnected(id, false);
        this.changed();
      }
    });
  }

  onMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      try {
        const token = String(msg.token || '').slice(0, 64);
        if (!token || token === this.hostToken) throw new GameError('Invalid session, please reload');
        const p = this.game.join(token, msg.name);
        // Only one live connection per player.
        for (const [c, id] of this.conns) if (id === p.id && c !== conn) { this.conns.delete(c); c.close(); }
        this.conns.set(conn, p.id);
        this.changed();
      } catch (e) {
        conn.send({ t: 'error', msg: e.message, fatal: true });
        setTimeout(() => conn.close(), 500);
      }
      return;
    }
    const id = this.conns.get(conn);
    if (!id || msg.t !== 'action') return;
    this.act(id, msg, (err) => conn.send({ t: 'error', msg: err }));
  }

  act(id, msg, onError) {
    const fn = PLAYER_ACTIONS[msg.a];
    if (!fn) return;
    try {
      fn(this.game, id, msg);
      if (msg.a === 'leave') for (const [c, pid] of this.conns) if (pid === id) { this.conns.delete(c); c.send({ t: 'left' }); }
      this.changed();
    } catch (e) {
      if (e instanceof GameError) onError(e.message);
      else { console.error(e); onError('Something went wrong'); }
    }
  }

  // The host's own UI calls this. It may also use the host-only actions.
  local(msg, onError) {
    try {
      if (msg.a === 'deal') { this.game.deal(); this.changed(); return; }
      if (msg.a === 'kick') {
        const conn = [...this.conns].find(([, pid]) => pid === msg.id)?.[0];
        this.game.remove(msg.id);
        if (conn) { this.conns.delete(conn); conn.send({ t: 'kicked' }); setTimeout(() => conn.close(), 300); }
        this.changed();
        return;
      }
      if (msg.a === 'closeInsurance') { this.game.closeInsurance(); this.changed(); return; }
      if (msg.a === 'chat' && !this.myId) {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (text) this.game.s.chat.push({ t: Date.now(), name: `${this.hostName} (dealer)`, text });
        this.changed();
        return;
      }
    } catch (e) {
      onError(e.message);
      return;
    }
    if (this.myId) this.act(this.myId, msg, onError);
  }

  // ---------- state changes ----------

  changed() {
    this.schedule();
    this.save();
    const view = this.game.publicView();
    view.turnElapsed = view.turnStartedAt ? Date.now() - view.turnStartedAt : 0;
    view.hostId = this.myId;
    view.hostName = this.hostName;
    for (const [conn, id] of this.conns) conn.send({ t: 'state', view, you: id });
    this.onView(view, this.myId);
  }

  schedule() {
    const s = this.game.s;
    clearTimeout(this.timers.turn);
    clearTimeout(this.timers.absent);

    if (s.phase === 'dealer' && !this.timers.dealer) {
      this.timers.dealer = setTimeout(() => {
        this.timers.dealer = null;
        this.game.dealerStep();
        this.changed();
      }, DEALER_DELAY);
    }

    const secs = s.settings.turnSeconds;
    if (s.phase === 'playing' && s.turn) {
      const p = s.players.find((x) => x.id === s.turn.pid);
      const { pid, h } = s.turn;
      const autoStand = () => {
        if (s.phase === 'playing' && s.turn && s.turn.pid === pid && s.turn.h === h) {
          this.game.stand(pid, true);
          this.changed();
        }
      };
      if (p && !p.connected) this.timers.absent = setTimeout(autoStand, ABSENT_DELAY);
      else if (secs > 0) this.timers.turn = setTimeout(autoStand, Math.max(0, s.turnStartedAt + secs * 1000 - Date.now()));
    } else if (s.phase === 'insurance' && secs > 0) {
      this.timers.turn = setTimeout(() => { this.game.closeInsurance(); this.changed(); },
        Math.max(0, s.turnStartedAt + secs * 1000 - Date.now()));
    }
  }

  save() {
    try {
      localStorage.setItem(SAVE_PREFIX + this.code, JSON.stringify({
        state: this.game.s, hostToken: this.hostToken, hostName: this.hostName,
        hostPlays: this.hostPlays, savedAt: Date.now(),
      }));
    } catch {}
  }

  shutdown() {
    Object.values(this.timers).forEach(clearTimeout);
    for (const conn of this.conns.keys()) { conn.send({ t: 'closed' }); conn.close(); }
    this.conns.clear();
    forgetSavedHost(this.code);
  }
}
