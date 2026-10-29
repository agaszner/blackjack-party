import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, handTotal } from '../js/engine.js';

const C = (r) => ({ r, s: '♠' });

// Builds a game whose shoe deals the given ranks in order.
// Deal order: p1, p2, ..., dealer up, p1, p2, ..., dealer hole, then hits.
function rigged(ranks, settings = {}, names = ['A']) {
  const g = Game.create({ code: 'TEST', settings: { turnSeconds: 0, ...settings } });
  const ids = names.map((n) => g.join(`tok-${n}`, n).id);
  g.shuffle = function () {
    this.s.shoe = ranks.map((r, i) => ({ ...C(r), id: `x${i}` }));
    this.s.shoePos = 0;
    this.s.cut = 9999;
  };
  return { g, ids };
}

function runDealer(g) {
  while (g.dealerStep());
}

test('hand totals handle soft aces', () => {
  assert.deepEqual(handTotal([C('A'), C('6')]), { total: 17, soft: true });
  assert.deepEqual(handTotal([C('A'), C('6'), C('10')]), { total: 17, soft: false });
  assert.deepEqual(handTotal([C('A'), C('A'), C('9')]), { total: 21, soft: true });
});

test('natural blackjack pays 3:2', () => {
  const { g, ids: [a] } = rigged(['A', '9', 'K', '8']);
  g.placeBet(a, 100); // auto-deals once everyone is ready
  assert.equal(g.s.phase, 'dealer');
  runDealer(g);
  const p = g.s.players[0];
  assert.equal(p.hands[0].result, 'blackjack');
  assert.equal(p.chips, 1150);
});

test('6:5 payout option', () => {
  const { g, ids: [a] } = rigged(['A', '9', 'K', '8'], { blackjackPays: '6:5' });
  g.placeBet(a, 100);
  runDealer(g);
  assert.equal(g.s.players[0].chips, 1120);
});

test('dealer blackjack via peek ends round; insurance pays 2:1', () => {
  // player 10,9 ; dealer A up, K hole
  const { g, ids: [a] } = rigged(['10', 'A', '9', 'K']);
  g.placeBet(a, 100);
  assert.equal(g.s.phase, 'insurance');
  g.takeInsurance(a, true);
  assert.equal(g.s.phase, 'betting');
  const p = g.s.players[0];
  assert.equal(p.hands[0].result, 'lose');
  // -100 bet, -50 insurance, +150 insurance return
  assert.equal(p.chips, 1000);
  assert.equal(p.lastNet, 0);
});

test('player natural pushes against dealer natural', () => {
  const { g, ids: [a] } = rigged(['A', 'K', 'K', 'A'], { insurance: false });
  g.placeBet(a, 100);
  assert.equal(g.s.players[0].hands[0].result, 'push');
  assert.equal(g.s.players[0].chips, 1000);
});

test('dealer stands on soft 17 by default, hits with H17', () => {
  for (const [h17, expectedCards] of [[false, 2], [true, 3]]) {
    const { g, ids: [a] } = rigged(['10', '6', '8', 'A', '2'], { dealerHitsSoft17: h17, insurance: false });
    g.placeBet(a, 10);
    g.stand(a);
    runDealer(g);
    assert.equal(g.s.dealer.cards.length, expectedCards, `h17=${h17}`);
  }
});

test('bust, double down and turn order across players', () => {
  // A: 10,6 ; B: 5,6 ; dealer 9, 8
  const { g, ids: [a, b] } = rigged(['10', '5', '9', '6', '6', '8', 'K', '9'], {}, ['A', 'B']);
  g.placeBet(a, 50);
  assert.equal(g.s.phase, 'betting');
  g.placeBet(b, 20);
  assert.equal(g.s.turn.pid, a);
  assert.throws(() => g.hit(b));
  g.hit(a); // K -> 26 bust
  assert.equal(g.s.turn.pid, b);
  g.double(b); // 9 -> 20
  runDealer(g);
  const [pa, pb] = g.s.players;
  assert.equal(pa.hands[0].result, 'bust');
  assert.equal(pa.chips, 950);
  assert.equal(pb.hands[0].result, 'win');
  assert.equal(pb.chips, 1040);
});

test('split pair, 21 after split is not blackjack', () => {
  // player 8,8 ; dealer 10,7 ; split: hand1 gets 3, hand2 gets A... then hand1 hits 10 -> 21
  const { g, ids: [a] } = rigged(['8', '10', '8', '7', '3', 'A', '10'], { insurance: false });
  g.placeBet(a, 100);
  g.split(a);
  const p = g.s.players[0];
  assert.equal(p.hands.length, 2);
  assert.equal(p.chips, 800);
  g.hit(a); // 8,3,10 = 21 -> auto advance
  assert.equal(g.s.turn.h, 1);
  g.stand(a); // 8,A = 19
  runDealer(g);
  assert.deepEqual(p.hands.map((h) => h.result), ['win', 'win']);
  assert.equal(p.chips, 1200);
});

test('split aces get one card each', () => {
  const { g, ids: [a] } = rigged(['A', '9', 'A', '7', 'K', '5'], { insurance: false });
  g.placeBet(a, 100);
  g.split(a);
  assert.equal(g.s.phase, 'dealer');
  runDealer(g);
  const p = g.s.players[0];
  assert.equal(p.hands[0].result, 'win'); // A,K = 21 but paid 1:1
  assert.equal(p.hands[0].payout, 200);
  assert.equal(p.hands[1].result, 'lose'); // A,5 = 16 vs 16? dealer 9,7 = 16 -> dealer draws
});

test('late surrender returns half', () => {
  const { g, ids: [a] } = rigged(['10', '10', '6', '7'], { surrender: true });
  g.placeBet(a, 100);
  g.surrender(a);
  runDealer(g);
  assert.equal(g.s.players[0].chips, 950);
});

test('cannot double after split when DAS is off', () => {
  const { g, ids: [a] } = rigged(['5', '10', '5', '7', '6', '6'], { doubleAfterSplit: false });
  g.placeBet(a, 10);
  g.split(a);
  assert.equal(g.allowed(a).double, false);
  assert.throws(() => g.double(a));
});

test('bet limits and chip checks', () => {
  const { g, ids: [a] } = rigged([], { minBet: 10, maxBet: 100 });
  assert.throws(() => g.placeBet(a, 5));
  assert.throws(() => g.placeBet(a, 500));
});

test('disconnected player is skipped automatically', () => {
  const { g, ids: [a, b] } = rigged(['10', '10', '9', '7', '8', '8'], { insurance: false }, ['A', 'B']);
  g.placeBet(a, 10);
  g.placeBet(b, 10);
  g.setConnected(a, false);
  assert.equal(g.s.turn.pid, b);
});

test('real shuffle uses the configured number of decks and reshuffles at the cut', () => {
  const g = Game.create({ code: 'X', settings: { decks: 2, penetration: 0.5 } });
  g.shuffle();
  assert.equal(g.s.shoe.length, 104);
  assert.equal(g.s.cut, 52);
  const counts = {};
  for (const c of g.s.shoe) counts[c.r + c.s] = (counts[c.r + c.s] || 0) + 1;
  assert.ok(Object.values(counts).every((n) => n === 2));
});

test('public view hides the hole card and tokens', () => {
  const { g, ids: [a] } = rigged(['10', '9', '7', '8']);
  g.placeBet(a, 10);
  const v = g.publicView();
  assert.equal(v.dealer.cards[1].hidden, true);
  assert.equal(v.dealer.cards[1].r, undefined);
  assert.equal(v.players[0].token, undefined);
  assert.equal(v.shoe.order, undefined);
});

test('random games never lose or create chips incorrectly', () => {
  for (let n = 0; n < 300; n++) {
    const g = Game.create({ code: 'R', settings: { decks: 1, surrender: true, turnSeconds: 0 } });
    const ids = ['a', 'b', 'c'].map((x) => g.join(x, x).id);
    for (let r = 0; r < 20; r++) {
      for (const id of ids) {
        const p = g.s.players.find((x) => x.id === id);
        if (p.chips < 10) g.rebuy(id);
        g.placeBet(id, 10 + Math.floor(Math.random() * 50));
      }
      if (g.s.phase === 'insurance') for (const id of ids) {
        try { g.takeInsurance(id, Math.random() < 0.5); } catch {}
      }
      let guard = 0;
      while (g.s.phase === 'playing' && guard++ < 100) {
        const id = g.s.turn.pid;
        const al = g.allowed(id);
        const opts = Object.keys(al).filter((k) => al[k]);
        g[opts[Math.floor(Math.random() * opts.length)]](id);
      }
      runDealer(g);
      assert.equal(g.s.phase, 'betting');
      for (const p of g.s.players) assert.ok(p.chips >= 0);
    }
  }
});
