// Visual effects layer. The table is re-rendered from scratch on every state
// update, so effects are driven from diffs between the previous and the new
// view, and long-running card animations are resumed by card id if a re-render
// happens mid-flight.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEAL_MS = 560;
const DEAL_STAGGER = 150;
const FLIP_MS = 520;
const SHUFFLE_MS = 1300;

const cardAnims = new Map(); // card id -> { start, delay, kind }
const done = new Set();      // one-shot effect keys that already played
let seen = new Set();
let hidden = new Set();
let first = true;

const $ = (sel) => document.querySelector(sel);
const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const shoeIndex = (id) => Number(String(id).split('-')[1]) || 0;

function once(key) {
  if (done.has(key)) return false;
  done.add(key);
  if (done.size > 2000) done.clear();
  return true;
}

function layer() {
  let el = $('#fx-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fx-layer';
    document.body.append(el);
  }
  return el;
}

// ---------- before the DOM is replaced ----------

// When a new round is dealt, sweep the previous round's cards into the discard tray.
export function beforeRender(view, prev) {
  if (reduced || !prev || view.round === prev.round) return;
  const tray = $('#discard');
  if (!tray) return;
  const to = center(tray.getBoundingClientRect());
  const cards = [...document.querySelectorAll('#seats .card, #dealerCards .card')];
  cards.forEach((card, i) => {
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('ghost-card');
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    layer().append(ghost);
    const c = center(r);
    const a = ghost.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${(to.x - c.x) * 0.15}px, ${(to.y - c.y) * 0.15 - 20}px) rotate(${(i % 2 ? 1 : -1) * 8}deg)`, opacity: 1, offset: 0.25 },
      { transform: `translate(${to.x - c.x}px, ${to.y - c.y}px) rotate(${90 + (i % 5) * 7}deg) scale(0.6)`, opacity: 0 },
    ], { duration: 600, delay: i * 25, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'both' });
    a.onfinish = () => ghost.remove();
  });
  tray.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
    { duration: 300, delay: 450 + cards.length * 25 });
}

// ---------- after the DOM is replaced ----------

export function afterRender(view, prev, me) {
  const now = performance.now();
  const cardEls = [...document.querySelectorAll('.card[data-cid]')];
  const ids = cardEls.map((el) => el.dataset.cid);

  if (first) {
    first = false;
    ids.forEach((id) => seen.add(id));
    hidden = new Set(cardEls.filter((el) => el.classList.contains('down')).map((el) => el.dataset.cid));
    once(`settle:${view.round}`);
    document.querySelectorAll('.seat [data-betkey]').forEach((chip) => once(`bet:${chip.dataset.betkey}`));
    return 0;
  }

  // A fresh shoe was shuffled: play the riffle before dealing.
  let base = 0;
  if (prev && view.shoe.size && (view.shoe.dealt < prev.shoe.dealt || (!prev.shoe.size && view.shoe.size))) {
    shuffleFx();
    base = reduced ? 0 : SHUFFLE_MS;
  }

  const fresh = cardEls.filter((el) => !seen.has(el.dataset.cid))
    .sort((a, b) => shoeIndex(a.dataset.cid) - shoeIndex(b.dataset.cid));
  fresh.forEach((el, i) => cardAnims.set(el.dataset.cid, { start: now, delay: base + i * DEAL_STAGGER, kind: 'deal' }));
  for (const el of cardEls) {
    const id = el.dataset.cid;
    if (hidden.has(id) && !el.classList.contains('down') && !cardAnims.has(id)) {
      cardAnims.set(id, { start: now, delay: 0, kind: 'flip' });
    }
  }

  // Play (or resume) card animations and hold totals back until the cards land.
  let lastLanding = 0;
  if (!reduced) {
    const shoe = $('#shoeStack')?.getBoundingClientRect();
    for (const el of cardEls) {
      const a = cardAnims.get(el.dataset.cid);
      if (!a) continue;
      const dur = a.kind === 'deal' ? DEAL_MS : FLIP_MS;
      const elapsed = now - a.start;
      if (elapsed > a.delay + dur) { cardAnims.delete(el.dataset.cid); continue; }
      if (a.kind === 'deal' && shoe) playDeal(el, shoe, a.delay, elapsed);
      else playFlip(el, elapsed);
      const remaining = a.delay + dur - elapsed;
      lastLanding = Math.max(lastLanding, remaining);
      holdTotal(el, remaining);
    }
  }

  // Bust shake, result effects, bet chips, dealer bust.
  document.querySelectorAll('.hand[data-key]').forEach((hand) => {
    const key = hand.dataset.key;
    if (hand.classList.contains('busted') && !hand.dataset.result && once(`bust:${key}`)) {
      setTimeout(() => shake(hand), lastLanding);
    }
  });

  if (view.phase === 'betting' && view.players.some((p) => p.hands.some((h) => h.result)) && once(`settle:${view.round}`)) {
    setTimeout(() => settleFx(view, me), lastLanding + 250);
  }

  document.querySelectorAll('.seat [data-betkey]').forEach((chip) => {
    if (once(`bet:${chip.dataset.betkey}`)) dropChip(chip);
  });

  if (view.dealer.revealed && view.phase !== 'betting') {
    const dt = $('#dealerTotal');
    if (dt && /Bust/.test(dt.textContent) && once(`dbust:${view.round}`)) setTimeout(() => shake($('#dealerCards')), lastLanding);
  }

  // Remember what we've seen.
  ids.forEach((id) => seen.add(id));
  if (seen.size > 3000) seen = new Set(ids);
  hidden = new Set(cardEls.filter((el) => el.classList.contains('down')).map((el) => el.dataset.cid));
  return lastLanding;
}

// Keep elements hidden (and unclickable) until the cards in flight have landed.
export function holdUntil(els, ms) {
  if (reduced || ms <= 0) return;
  for (const el of els) {
    if (!el) continue;
    el.getAnimations().filter((a) => a.id === 'hold').forEach((a) => a.cancel());
    const a = el.animate([{ opacity: 0, pointerEvents: 'none' }, { opacity: 0, pointerEvents: 'none' }], { duration: ms });
    a.id = 'hold';
  }
}

function playDeal(el, shoe, delay, elapsed) {
  const r = el.getBoundingClientRect();
  const from = center(shoe);
  const to = center(r);
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const spin = -25 - (shoeIndex(el.dataset.cid) % 3) * 8;
  const opts = { duration: DEAL_MS, delay, easing: 'cubic-bezier(.18,.85,.25,1)', fill: 'backwards' };
  const move = el.animate([
    { transform: `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(0.75)`, boxShadow: '0 2px 4px #0006' },
    { transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 30}px) rotate(${spin / 3}deg) scale(1.08)`, boxShadow: '0 22px 30px #0008', offset: 0.55 },
    { transform: 'none', boxShadow: '0 3px 8px #0006' },
  ], opts);
  move.currentTime = elapsed;
  if (!el.classList.contains('down')) {
    const inner = el.querySelector('.inner');
    const flip = inner.animate([
      { transform: 'rotateY(180deg)' },
      { transform: 'rotateY(180deg)', offset: 0.3 },
      { transform: 'rotateY(0deg)' },
    ], opts);
    flip.currentTime = elapsed;
  }
}

function playFlip(el, elapsed) {
  const opts = { duration: FLIP_MS, easing: 'cubic-bezier(.3,.7,.3,1)' };
  el.animate([
    { transform: 'none' },
    { transform: 'translateY(-18px) scale(1.12)', offset: 0.45 },
    { transform: 'none' },
  ], opts).currentTime = elapsed;
  el.querySelector('.inner').animate([
    { transform: 'rotateY(180deg)' },
    { transform: 'rotateY(0deg)' },
  ], opts).currentTime = elapsed;
}

function holdTotal(cardEl, remaining) {
  const zone = cardEl.closest('.hand') || cardEl.closest('.dealer-zone');
  const badge = zone?.querySelector('.total-badge');
  if (!badge || remaining <= 0) return;
  badge.getAnimations().forEach((a) => a.cancel());
  badge.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.6 }, { opacity: 1, transform: 'none' }],
    { duration: 300, delay: remaining, fill: 'backwards' });
}

function shake(el) {
  if (reduced || !el) return;
  el.animate([
    { transform: 'translateX(0)' }, { transform: 'translateX(-9px) rotate(-2deg)' }, { transform: 'translateX(8px) rotate(2deg)' },
    { transform: 'translateX(-6px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' },
  ], { duration: 480, easing: 'ease-out' });
}

function dropChip(chip) {
  if (reduced) return;
  chip.animate([
    { transform: 'translateY(-70px) scale(1.6) rotate(-180deg)', opacity: 0 },
    { transform: 'translateY(4px) scale(0.95) rotate(0)', opacity: 1, offset: 0.7 },
    { transform: 'none', opacity: 1 },
  ], { duration: 520, easing: 'cubic-bezier(.3,.8,.4,1.2)' });
}

// ---------- shuffle ----------

function shuffleFx() {
  if (reduced) return;
  const shoe = $('#shoeStack');
  const felt = $('.felt');
  if (!shoe || !felt) return;
  const r = shoe.getBoundingClientRect();
  const c = center(r);
  const label = document.createElement('div');
  label.className = 'fx-label';
  label.textContent = 'Shuffling';
  label.style.left = `${c.x}px`;
  label.style.top = `${r.bottom + 14}px`;
  layer().append(label);
  label.animate([{ opacity: 0, transform: 'translate(-50%, 6px)' }, { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.15 },
    { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: SHUFFLE_MS }).onfinish = () => label.remove();
  for (let i = 0; i < 14; i++) {
    const left = i % 2 === 0;
    const card = document.createElement('div');
    card.className = 'fx-card';
    card.style.left = `${c.x - 22}px`;
    card.style.top = `${c.y - 31}px`;
    layer().append(card);
    const side = left ? -58 : 58;
    const k = Math.floor(i / 2);
    card.animate([
      { transform: `translate(${side}px, ${-k * 2}px) rotate(${left ? -14 : 14}deg)`, opacity: 0 },
      { transform: `translate(${side}px, ${-k * 2}px) rotate(${left ? -14 : 14}deg)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${side * 0.6}px, ${-k * 2 - 22}px) rotate(${left ? 22 : -22}deg)`, opacity: 1, offset: 0.35 + k * 0.03 },
      { transform: `translate(0, ${-i * 1.2}px) rotate(0)`, opacity: 1, offset: 0.7 },
      { transform: 'translate(0,0) scale(.9)', opacity: 0 },
    ], { duration: SHUFFLE_MS, easing: 'ease-in-out' }).onfinish = () => card.remove();
  }
  shoe.animate([{ transform: 'none' }, { transform: 'scale(1.1) rotate(-4deg)', offset: 0.5 }, { transform: 'none' }],
    { duration: 400, delay: SHUFFLE_MS - 400 });
}

// ---------- settlement ----------

function settleFx(view, me) {
  const dealer = $('#dealerCards');
  if (!dealer) return;
  const dealerPt = center(dealer.getBoundingClientRect());
  document.querySelectorAll('.hand[data-result]').forEach((hand, i) => {
    const res = hand.dataset.result;
    const chip = hand.querySelector('.bet-chip');
    const badge = hand.querySelector('.result');
    const net = Number(hand.dataset.net);
    const delay = i * 120;
    if (badge && !reduced) {
      badge.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.35)', opacity: 1, offset: 0.6 }, { transform: 'none', opacity: 1 }],
        { duration: 450, delay, easing: 'cubic-bezier(.3,1.6,.5,1)', fill: 'backwards' });
    }
    if (!chip) return;
    const chipPt = center(chip.getBoundingClientRect());
    const color = getComputedStyle(chip).getPropertyValue('--chip');
    setTimeout(() => {
      if (res === 'win' || res === 'blackjack') {
        const n = res === 'blackjack' ? 4 : 3;
        for (let k = 0; k < n; k++) flyChip(dealerPt, chipPt, color, k * 90);
        if (res === 'blackjack') confetti(chipPt.x, chipPt.y, 46);
        else sparkle(chipPt.x, chipPt.y);
      } else if (res === 'lose' || res === 'bust') {
        flyChip(chipPt, dealerPt, color, 0);
        if (!reduced) chip.animate([{ opacity: 1 }, { opacity: 0.25 }], { duration: 300, fill: 'forwards' });
      }
      floatText(chipPt.x, chipPt.y - 30, net > 0 ? `+${fmt(net)}` : net < 0 ? `−${fmt(-net)}` : '±0',
        net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero');
    }, delay);
  });

  const mine = view.players.find((p) => p.id === me);
  if (mine && mine.lastNet !== null && mine.hands.length) {
    const results = mine.hands.map((h) => h.result);
    let text;
    let tone;
    if (results.includes('blackjack')) { text = 'Blackjack!'; tone = 'gold'; }
    else if (mine.lastNet > 0) { text = 'You win!'; tone = 'win'; }
    else if (mine.lastNet === 0) { text = 'Push'; tone = 'push'; }
    else if (results.every((r) => r === 'bust')) { text = 'Bust'; tone = 'lose'; }
    else { text = 'Dealer wins'; tone = 'lose'; }
    const sub = mine.lastNet > 0 ? `+${fmt(mine.lastNet)}` : mine.lastNet < 0 ? `−${fmt(-mine.lastNet)}` : '';
    banner(text, sub, tone);
    if (tone === 'gold' || (tone === 'win' && mine.lastNet >= 2 * (mine.lastBet || 1))) {
      setTimeout(() => confetti(window.innerWidth / 2, window.innerHeight * 0.42, 90), 150);
    }
  }
}

function fmt(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function flyChip(from, to, color, delay = 0) {
  if (reduced) return;
  const chip = document.createElement('div');
  chip.className = 'fx-chip';
  chip.style.setProperty('--chip', color || '#c0392b');
  chip.style.left = `${from.x - 15}px`;
  chip.style.top = `${from.y - 15}px`;
  layer().append(chip);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const a = chip.animate([
    { transform: 'translate(0,0) scale(.6) rotate(0)', opacity: 0 },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 60}px) scale(1.15) rotate(200deg)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.9) rotate(360deg)`, opacity: 1, offset: 0.92 },
    { transform: `translate(${dx}px, ${dy}px) scale(.9) rotate(360deg)`, opacity: 0 },
  ], { duration: 650, delay, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
  a.onfinish = () => chip.remove();
}

export function rectCenter(el) {
  return center(el.getBoundingClientRect());
}

function floatText(x, y, text, tone) {
  if (reduced) return;
  const el = document.createElement('div');
  el.className = `fx-float ${tone}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  layer().append(el);
  el.animate([
    { transform: 'translate(-50%, 10px) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%, -10px) scale(1.2)', opacity: 1, offset: 0.25 },
    { transform: 'translate(-50%, -60px) scale(1)', opacity: 0 },
  ], { duration: 1600, easing: 'ease-out' }).onfinish = () => el.remove();
}

function banner(text, sub, tone) {
  const el = document.createElement('div');
  el.className = `fx-banner ${tone}`;
  el.innerHTML = '<b></b><span></span>';
  el.querySelector('b').textContent = text;
  el.querySelector('span').textContent = sub;
  layer().append(el);
  const frames = reduced
    ? [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
    : [
      { transform: 'translate(-50%,-50%) scale(.2) rotate(-8deg)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.15) rotate(2deg)', opacity: 1, offset: 0.14 },
      { transform: 'translate(-50%,-50%) scale(1) rotate(0)', opacity: 1, offset: 0.22 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.82 },
      { transform: 'translate(-50%,-80%) scale(.9)', opacity: 0 },
    ];
  el.animate(frames, { duration: 2200, easing: 'ease-out' }).onfinish = () => el.remove();
}

const CONFETTI = ['#f6d27a', '#e3b54a', '#4ade80', '#60a5fa', '#f87171', '#c084fc', '#ffffff'];

function confetti(x, y, n) {
  if (reduced) return;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'fx-confetti';
    el.style.background = CONFETTI[i % CONFETTI.length];
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (i % 3 === 0) el.style.borderRadius = '50%';
    layer().append(el);
    const ang = Math.random() * Math.PI * 2;
    const v = 80 + Math.random() * 180;
    const vx = Math.cos(ang) * v;
    const vy = Math.sin(ang) * v - 140;
    const rot = (Math.random() - 0.5) * 1080;
    el.animate([
      { transform: 'translate(0,0) rotate(0)', opacity: 1 },
      { transform: `translate(${vx * 0.6}px, ${vy * 0.6}px) rotate(${rot * 0.5}deg)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${vx}px, ${vy + 260}px) rotate(${rot}deg)`, opacity: 0 },
    ], { duration: 1300 + Math.random() * 900, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = () => el.remove();
  }
}

function sparkle(x, y) {
  if (reduced) return;
  for (let i = 0; i < 10; i++) {
    const el = document.createElement('div');
    el.className = 'fx-spark';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    layer().append(el);
    const ang = (i / 10) * Math.PI * 2;
    el.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * 50}px), calc(-50% + ${Math.sin(ang) * 50}px)) scale(0)`, opacity: 0 },
    ], { duration: 650, easing: 'ease-out' }).onfinish = () => el.remove();
  }
}

// Bounce an element (status line, pending bet number…) when its content changes.
export function bump(el) {
  if (reduced || !el) return;
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
}
