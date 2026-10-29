// Blackjack rules engine. Runs only in the host's browser, which is the
// single source of truth for the party. Clients only ever see sanitized views.

export const DEFAULT_SETTINGS = {
  startingChips: 1000,
  decks: 6,
  minBet: 10,
  maxBet: 500,
  maxPlayers: 7,
  penetration: 0.75,        // fraction of the shoe dealt before reshuffling
  dealerHitsSoft17: false,  // classic rule: dealer stands on all 17s
  blackjackPays: '3:2',
  doubleAfterSplit: true,
  maxSplitHands: 4,
  hitSplitAces: false,      // split aces receive one card each
  resplitAces: false,
  surrender: false,         // late surrender
  insurance: true,
  allowRebuy: true,
  turnSeconds: 30,          // 0 = no turn timer
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const MAX_LOG = 60;

export function cardValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

export function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.hidden) continue;
    total += cardValue(c.r);
    if (c.r === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export function isNatural(hand) {
  return hand.cards.length === 2 && !hand.fromSplit && handTotal(hand.cards).total === 21;
}

function randomInt(n) {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] % n;
}

export function clampSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  const num = (k, lo, hi, int = true) => {
    const v = Number(input[k]);
    if (Number.isFinite(v)) s[k] = Math.min(hi, Math.max(lo, int ? Math.round(v) : v));
  };
  const bool = (k) => { if (typeof input[k] === 'boolean') s[k] = input[k]; };
  num('startingChips', 10, 1_000_000);
  num('decks', 1, 8);
  num('minBet', 1, 100_000);
  num('maxBet', 1, 1_000_000);
  num('maxPlayers', 1, 7);
  num('penetration', 0.5, 0.9, false);
  num('maxSplitHands', 2, 4);
  num('turnSeconds', 0, 300);
  bool('dealerHitsSoft17');
  bool('doubleAfterSplit');
  bool('hitSplitAces');
  bool('resplitAces');
  bool('surrender');
  bool('insurance');
  bool('allowRebuy');
  if (input.blackjackPays === '6:5' || input.blackjackPays === '3:2') s.blackjackPays = input.blackjackPays;
  if (s.maxBet < s.minBet) s.maxBet = s.minBet;
  if (s.startingChips < s.minBet) s.startingChips = s.minBet;
  return s;
}

function newHand(bet) {
  return { cards: [], bet, doubled: false, done: false, busted: false, surrendered: false,
    fromSplit: false, splitAces: false, natural: false, result: null, payout: 0 };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export class GameError extends Error {}

export class Game {
  constructor(state) {
    this.s = state;
  }

  static create({ code, settings }) {
    return new Game({
      code,
      settings: clampSettings(settings),
      phase: 'betting',
      round: 0,
      shoe: [],
      shoePos: 0,
      cut: 0,
      shoeNo: 0,
      players: [],
      dealer: { cards: [], revealed: false },
      turn: null,
      turnStartedAt: null,
      log: [],
      chat: [],
    });
  }

  // ---------- helpers ----------

  log(text) {
    this.s.log.push({ t: Date.now(), text });
    if (this.s.log.length > MAX_LOG) this.s.log.splice(0, this.s.log.length - MAX_LOG);
  }

  player(id) {
    const p = this.s.players.find((x) => x.id === id);
    if (!p) throw new GameError('You are not seated at this table');
    return p;
  }

  shuffle() {
    const s = this.s;
    const cards = [];
    s.shoeNo++;
    for (let d = 0; d < s.settings.decks; d++) {
      for (const suit of SUITS) for (const r of RANKS) cards.push({ r, s: suit });
    }
    for (let i = cards.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    cards.forEach((c, i) => { c.id = `${s.shoeNo}-${i}`; });
    s.shoe = cards;
    s.shoePos = 0;
    s.cut = Math.floor(cards.length * s.settings.penetration);
    this.log(`Shuffled a fresh shoe of ${s.settings.decks} deck${s.settings.decks > 1 ? 's' : ''}.`);
  }

  draw() {
    if (this.s.shoePos >= this.s.shoe.length) this.shuffle();
    return this.s.shoe[this.s.shoePos++];
  }

  inRound() {
    return this.s.players.filter((p) => p.inRound);
  }

  // ---------- seating ----------

  join(token, name) {
    const s = this.s;
    name = String(name || '').trim().slice(0, 20) || 'Player';
    let p = s.players.find((x) => x.token === token);
    if (p) {
      p.connected = true;
      return p;
    }
    if (s.players.length >= s.settings.maxPlayers) throw new GameError('This table is full');
    let unique = name;
    for (let i = 2; s.players.some((x) => x.name.toLowerCase() === unique.toLowerCase()); i++) unique = `${name} ${i}`;
    p = {
      id: Math.random().toString(36).slice(2, 10),
      token,
      name: unique,
      chips: s.settings.startingChips,
      connected: true,
      bet: 0,
      ready: false,
      lastBet: s.settings.minBet,
      inRound: false,
      hands: [],
      insurance: null,
      lastNet: null,
      rebuys: 0,
      leaving: false,
    };
    s.players.push(p);
    this.log(`${p.name} sat down with ${p.chips} chips.`);
    return p;
  }

  setConnected(id, connected) {
    const p = this.s.players.find((x) => x.id === id);
    if (!p) return;
    p.connected = connected;
    this.log(`${p.name} ${connected ? 'reconnected' : 'disconnected'}.`);
    if (!connected) this.handleAbsent(p);
  }

  remove(id) {
    const p = this.s.players.find((x) => x.id === id);
    if (!p) return;
    this.log(`${p.name} left the table.`);
    if (p.inRound && this.s.phase !== 'betting') {
      // Finish their round automatically, then drop them at settlement.
      p.leaving = true;
      p.connected = false;
      this.handleAbsent(p);
    } else {
      this.s.players = this.s.players.filter((x) => x !== p);
      this.maybeDeal();
    }
  }

  // An absent player stands on everything and declines insurance.
  handleAbsent(p) {
    const s = this.s;
    if (s.phase === 'insurance' && p.inRound && p.insurance === null) {
      p.insurance = 0;
      this.maybeResolveInsurance();
    } else if (s.phase === 'playing' && s.turn && s.turn.pid === p.id) {
      this.stand(p.id, true);
    } else if (s.phase === 'betting') {
      this.maybeDeal();
    }
  }

  rebuy(id) {
    const s = this.s;
    const p = this.player(id);
    if (!s.settings.allowRebuy) throw new GameError('Rebuys are disabled at this table');
    if (p.inRound && s.phase !== 'betting') throw new GameError('Wait until the round is over');
    if (p.chips >= s.settings.minBet) throw new GameError('You can only rebuy when you cannot cover the minimum bet');
    p.chips = round2(p.chips + s.settings.startingChips);
    p.rebuys++;
    this.log(`${p.name} rebought for ${s.settings.startingChips} chips.`);
  }

  // ---------- betting ----------

  placeBet(id, amount) {
    const s = this.s;
    if (s.phase !== 'betting') throw new GameError('Betting is closed');
    const p = this.player(id);
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount < 0) throw new GameError('Invalid bet');
    if (amount === 0) {
      p.bet = 0;
      p.ready = true;
    } else {
      if (amount < s.settings.minBet) throw new GameError(`Minimum bet is ${s.settings.minBet}`);
      if (amount > s.settings.maxBet) throw new GameError(`Maximum bet is ${s.settings.maxBet}`);
      if (amount > p.chips) throw new GameError('Not enough chips');
      p.bet = amount;
      p.ready = true;
      p.lastBet = amount;
    }
    this.maybeDeal();
  }

  unready(id) {
    if (this.s.phase !== 'betting') throw new GameError('Betting is closed');
    const p = this.player(id);
    p.ready = false;
    p.bet = 0;
  }

  // Deal automatically once every connected player has bet or chosen to sit out.
  maybeDeal() {
    const s = this.s;
    if (s.phase !== 'betting') return;
    const active = s.players.filter((p) => p.connected);
    if (active.length === 0) return;
    if (!active.every((p) => p.ready)) return;
    if (!active.some((p) => p.bet > 0)) return;
    this.deal();
  }

  deal() {
    const s = this.s;
    if (s.phase !== 'betting') throw new GameError('A round is already in progress');
    const bettors = s.players.filter((p) => p.ready && p.bet > 0 && p.bet <= p.chips);
    if (bettors.length === 0) throw new GameError('Nobody has placed a bet yet');
    if (s.shoe.length === 0 || s.shoePos >= s.cut) this.shuffle();

    s.round++;
    s.dealer = { cards: [], revealed: false };
    for (const p of s.players) {
      p.inRound = bettors.includes(p);
      p.insurance = null;
      p.lastNet = null;
      p.hands = [];
      if (p.inRound) {
        p.chips = round2(p.chips - p.bet);
        p.hands = [newHand(p.bet)];
      }
      p.ready = false;
    }
    for (let i = 0; i < 2; i++) {
      for (const p of bettors) p.hands[0].cards.push(this.draw());
      s.dealer.cards.push(this.draw());
    }
    for (const p of bettors) {
      const h = p.hands[0];
      if (isNatural(h)) {
        h.natural = true;
        h.done = true;
      }
    }
    this.log(`Round ${s.round}: dealing to ${bettors.map((p) => p.name).join(', ')}.`);

    const up = s.dealer.cards[0];
    if (up.r === 'A' && s.settings.insurance) {
      s.phase = 'insurance';
      s.turnStartedAt = Date.now();
      for (const p of bettors) {
        const cost = Math.floor(p.hands[0].bet / 2);
        if (!p.connected || p.chips < cost || cost < 1) p.insurance = 0;
      }
      this.log('Dealer shows an Ace. Insurance is open.');
      this.maybeResolveInsurance();
    } else {
      this.peek();
    }
  }

  // ---------- insurance & peek ----------

  takeInsurance(id, take) {
    const s = this.s;
    if (s.phase !== 'insurance') throw new GameError('Insurance is not being offered');
    const p = this.player(id);
    if (!p.inRound || p.insurance !== null) throw new GameError('You already decided');
    if (take) {
      const cost = Math.floor(p.hands[0].bet / 2);
      if (cost > p.chips) throw new GameError('Not enough chips for insurance');
      p.chips = round2(p.chips - cost);
      p.insurance = cost;
      this.log(`${p.name} takes insurance (${cost}).`);
    } else {
      p.insurance = 0;
    }
    this.maybeResolveInsurance();
  }

  closeInsurance() {
    if (this.s.phase !== 'insurance') return;
    for (const p of this.inRound()) if (p.insurance === null) p.insurance = 0;
    this.maybeResolveInsurance();
  }

  maybeResolveInsurance() {
    if (this.s.phase !== 'insurance') return;
    if (this.inRound().some((p) => p.insurance === null)) return;
    this.peek();
  }

  // American hole-card rule: the dealer checks for blackjack under an Ace or ten.
  peek() {
    const s = this.s;
    const up = s.dealer.cards[0];
    if (cardValue(up.r) >= 10) {
      if (handTotal(s.dealer.cards).total === 21) {
        s.dealer.revealed = true;
        this.log('Dealer has Blackjack!');
        this.settle();
        return;
      }
      this.log('Dealer checks: no Blackjack.');
    }
    this.startTurns();
  }

  // ---------- player turns ----------

  startTurns() {
    const s = this.s;
    s.phase = 'playing';
    s.turn = null;
    this.advance(-1, -1);
  }

  // Move to the next unfinished hand after (playerIndex, handIndex).
  advance(pi, hi) {
    const s = this.s;
    for (let i = Math.max(pi, 0); i < s.players.length; i++) {
      const p = s.players[i];
      if (!p.inRound) continue;
      const start = i === pi ? hi + 1 : 0;
      for (let h = start; h < p.hands.length; h++) {
        if (!p.hands[h].done) {
          s.turn = { pid: p.id, h };
          s.turnStartedAt = Date.now();
          if (!p.connected) this.stand(p.id, true);
          return;
        }
      }
    }
    s.turn = null;
    s.turnStartedAt = null;
    s.phase = 'dealer';
  }

  current(id) {
    const s = this.s;
    if (s.phase !== 'playing' || !s.turn) throw new GameError('It is not your turn');
    if (s.turn.pid !== id) throw new GameError('It is not your turn');
    const p = this.player(id);
    return { p, hand: p.hands[s.turn.h], pi: s.players.indexOf(p), hi: s.turn.h };
  }

  finishHand(p, hand, pi, hi) {
    hand.done = true;
    this.advance(pi, hi);
  }

  allowed(id) {
    // Which actions the player may take right now (used by the UI).
    const res = { hit: false, stand: false, double: false, split: false, surrender: false };
    let cur;
    try { cur = this.current(id); } catch { return res; }
    const { p, hand } = cur;
    const st = this.s.settings;
    const oneCardAces = hand.splitAces && !st.hitSplitAces;
    res.hit = !oneCardAces;
    res.stand = true;
    const two = hand.cards.length === 2;
    res.double = two && !oneCardAces && p.chips >= hand.bet && (!hand.fromSplit || st.doubleAfterSplit);
    res.split = two && cardValue(hand.cards[0].r) === cardValue(hand.cards[1].r)
      && p.hands.length < st.maxSplitHands && p.chips >= hand.bet
      && (!hand.splitAces || st.resplitAces);
    res.surrender = st.surrender && two && p.hands.length === 1 && !hand.fromSplit;
    return res;
  }

  hit(id) {
    if (!this.allowed(id).hit) throw new GameError('You cannot hit now');
    const { p, hand, pi, hi } = this.current(id);
    hand.cards.push(this.draw());
    const { total } = handTotal(hand.cards);
    if (total > 21) {
      hand.busted = true;
      this.log(`${p.name} busts with ${total}.`);
      this.finishHand(p, hand, pi, hi);
    } else if (total === 21) {
      this.finishHand(p, hand, pi, hi);
    }
  }

  stand(id, auto = false) {
    const { p, hand, pi, hi } = this.current(id);
    if (auto) this.log(`${p.name} stands automatically.`);
    this.finishHand(p, hand, pi, hi);
  }

  double(id) {
    if (!this.allowed(id).double) throw new GameError('You cannot double down now');
    const { p, hand, pi, hi } = this.current(id);
    p.chips = round2(p.chips - hand.bet);
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(this.draw());
    const { total } = handTotal(hand.cards);
    if (total > 21) hand.busted = true;
    this.log(`${p.name} doubles down${hand.busted ? ` and busts with ${total}` : ` (${total})`}.`);
    this.finishHand(p, hand, pi, hi);
  }

  split(id) {
    if (!this.allowed(id).split) throw new GameError('You cannot split now');
    const { p, hand, pi, hi } = this.current(id);
    const st = this.s.settings;
    p.chips = round2(p.chips - hand.bet);
    const second = newHand(hand.bet);
    second.cards.push(hand.cards.pop());
    const aces = hand.cards[0].r === 'A';
    for (const h of [hand, second]) {
      h.fromSplit = true;
      h.splitAces = aces;
      h.cards.push(this.draw());
      if ((aces && !st.hitSplitAces) || handTotal(h.cards).total === 21) h.done = true;
    }
    // A pair of aces may be re-split even after the one-card rule applies.
    if (aces && st.resplitAces) {
      for (const h of [hand, second]) {
        if (h.cards[1].r === 'A' && p.hands.length + 1 < st.maxSplitHands) h.done = false;
      }
    }
    p.hands.splice(hi + 1, 0, second);
    this.log(`${p.name} splits ${aces ? 'aces' : 'a pair'}.`);
    if (hand.done) this.advance(pi, hi);
  }

  surrender(id) {
    if (!this.allowed(id).surrender) throw new GameError('You cannot surrender now');
    const { p, hand, pi, hi } = this.current(id);
    hand.surrendered = true;
    this.log(`${p.name} surrenders.`);
    this.finishHand(p, hand, pi, hi);
  }

  // ---------- dealer ----------

  // Performs one dealer action. Returns true while the dealer has more to do,
  // so the host can animate the dealer's play step by step.
  dealerStep() {
    const s = this.s;
    if (s.phase !== 'dealer') return false;
    if (!s.dealer.revealed) {
      s.dealer.revealed = true;
      return true;
    }
    const live = this.inRound().some((p) => p.hands.some((h) => !h.busted && !h.surrendered && !h.natural));
    const { total, soft } = handTotal(s.dealer.cards);
    const mustHit = total < 17 || (total === 17 && soft && s.settings.dealerHitsSoft17);
    if (live && mustHit) {
      s.dealer.cards.push(this.draw());
      return true;
    }
    this.settle();
    return false;
  }

  settle() {
    const s = this.s;
    const st = s.settings;
    s.dealer.revealed = true;
    const dTotal = handTotal(s.dealer.cards).total;
    const dealerNatural = s.dealer.cards.length === 2 && dTotal === 21;
    const ratio = st.blackjackPays === '6:5' ? 1.2 : 1.5;
    const summary = [];
    for (const p of this.inRound()) {
      let wagered = 0;
      let returned = 0;
      if (p.insurance > 0) {
        wagered += p.insurance;
        if (dealerNatural) returned += p.insurance * 3;
      }
      for (const h of p.hands) {
        wagered += h.bet;
        const total = handTotal(h.cards).total;
        if (h.surrendered) { h.result = 'surrender'; h.payout = h.bet / 2; }
        else if (h.busted) { h.result = 'bust'; h.payout = 0; }
        else if (dealerNatural) { h.result = h.natural ? 'push' : 'lose'; h.payout = h.natural ? h.bet : 0; }
        else if (h.natural) { h.result = 'blackjack'; h.payout = h.bet + h.bet * ratio; }
        else if (dTotal > 21 || total > dTotal) { h.result = 'win'; h.payout = h.bet * 2; }
        else if (total === dTotal) { h.result = 'push'; h.payout = h.bet; }
        else { h.result = 'lose'; h.payout = 0; }
        h.payout = round2(h.payout);
        returned += h.payout;
        h.done = true;
      }
      p.chips = round2(p.chips + returned);
      p.lastNet = round2(returned - wagered);
      summary.push(`${p.name} ${p.lastNet >= 0 ? '+' : ''}${p.lastNet}`);
    }
    this.log(`Dealer ${dTotal > 21 ? `busts with ${dTotal}` : `has ${dealerNatural ? 'Blackjack' : dTotal}`}. ${summary.join(', ')}`);

    s.phase = 'betting';
    s.turn = null;
    s.turnStartedAt = null;
    s.players = s.players.filter((p) => !p.leaving);
    for (const p of s.players) {
      p.inRound = false;
      p.ready = false;
      p.bet = 0;
    }
  }

  // ---------- chat ----------

  chat(id, text) {
    const p = this.player(id);
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    this.s.chat.push({ t: Date.now(), name: p.name, text });
    if (this.s.chat.length > 50) this.s.chat.shift();
  }

  // ---------- view ----------

  // A copy of the state that is safe to send to everyone: no shoe order,
  // no reconnect tokens, and the dealer's hole card is hidden until revealed.
  publicView() {
    const s = this.s;
    const dealerCards = s.dealer.cards.map((c, i) =>
      i === 1 && !s.dealer.revealed ? { id: c.id, hidden: true } : c);
    return {
      code: s.code,
      settings: s.settings,
      phase: s.phase,
      round: s.round,
      shoe: { remaining: s.shoe.length - s.shoePos, size: s.shoe.length, cut: s.cut, dealt: s.shoePos },
      dealer: { cards: dealerCards, revealed: s.dealer.revealed },
      players: s.players.map(({ token, ...p }) => p),
      turn: s.turn,
      turnStartedAt: s.turnStartedAt,
      log: s.log.slice(-30),
      chat: s.chat.slice(-50),
    };
  }
}
