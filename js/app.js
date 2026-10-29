import { handTotal } from './engine.js';
import { Host, loadSavedHost, forgetSavedHost } from './host.js';
import { hostParty, joinParty, transportName } from './net.js';

const $ = (sel) => document.querySelector(sel);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHIPS = [
  { v: 1, c: '#e5e7eb' }, { v: 5, c: '#c0392b' }, { v: 25, c: '#15803d' }, { v: 100, c: '#1f2937' },
  { v: 500, c: '#7e22ce' }, { v: 1000, c: '#b45309' }, { v: 5000, c: '#0e7490' },
];
const RESULT_TEXT = { win: 'Win', lose: 'Lose', push: 'Push', bust: 'Bust', blackjack: 'Blackjack!', surrender: 'Surrendered' };

const app = {
  mode: 'home', // 'home' | 'host' | 'client'
  host: null,
  server: null, // host's transport handle
  conn: null,
  view: null,
  me: null,
  pendingBet: 0,
  seen: new Set(),
  hiddenIds: new Set(),
  firstRender: true,
  turnStartLocal: 0,
  leaving: false,
};

// ---------- utilities ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function token() {
  let t = sessionStorage.getItem('bjparty-token');
  if (!t) {
    t = crypto.getRandomValues(new Uint32Array(4)).join('-');
    sessionStorage.setItem('bjparty-token', t);
  }
  return t;
}

function newCode() {
  const r = crypto.getRandomValues(new Uint32Array(5));
  return [...r].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

function partyUrl(code) {
  const u = new URL(location.pathname, location.origin);
  if (code) u.searchParams.set('party', code);
  if (transportName === 'local') u.searchParams.set('transport', 'local');
  return u.toString();
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function overlay(text, { spinner = true, button = false } = {}) {
  if (text === null) { $('#overlay').hidden = true; return; }
  $('#overlay').hidden = false;
  $('#overlayText').textContent = text;
  $('.spinner').hidden = !spinner;
  $('#overlayBtn').hidden = !button;
}

function waitForPeerJs() {
  if (transportName === 'local' || window.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (window.Peer) { clearInterval(t); resolve(); }
      else if (Date.now() - started > 10000) { clearInterval(t); reject(new Error('Could not load the networking library. Check your connection.')); }
    }, 100);
  });
}

function getName() {
  const name = $('#name').value.trim();
  if (!name) {
    showHomeError('Please enter your name first.');
    $('#name').focus();
    return null;
  }
  localStorage.setItem('bjparty-name', name);
  return name;
}

function showHomeError(msg) {
  const el = $('#homeError');
  el.textContent = msg;
  el.hidden = !msg;
}

function showScreen(which) {
  $('#home').hidden = which !== 'home';
  $('#table').hidden = which !== 'table';
}

// ---------- lobby actions ----------

function readSettings() {
  const f = $('#createForm');
  const data = new FormData(f);
  const settings = {};
  for (const k of ['startingChips', 'decks', 'minBet', 'maxBet', 'maxPlayers', 'turnSeconds', 'penetration']) settings[k] = Number(data.get(k));
  settings.blackjackPays = data.get('blackjackPays');
  for (const k of ['dealerHitsSoft17', 'doubleAfterSplit', 'insurance', 'surrender', 'hitSplitAces', 'resplitAces', 'allowRebuy']) {
    settings[k] = f.elements[k].checked;
  }
  return { settings, hostPlays: data.get('hostPlays') === 'yes' };
}

async function startHosting(makeHost, code, attempts = 1) {
  overlay('Opening the table…');
  await waitForPeerJs();
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      app.server = await hostParty(code(i), (conn) => app.host.accept(conn));
      break;
    } catch (e) {
      lastErr = e;
      if (e.type !== 'unavailable-id') break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!app.server) throw lastErr || new Error('Could not open the table');
  app.mode = 'host';
  app.host = makeHost();
  history.replaceState(null, '', partyUrl(app.host.code));
  showScreen('table');
  overlay(null);
  app.host.changed();
}

async function createParty(e) {
  e.preventDefault();
  const name = getName();
  if (!name) return;
  const { settings, hostPlays } = readSettings();
  let code;
  try {
    await startHosting(
      () => Host.fresh({ code, settings, hostToken: token(), hostName: name, hostPlays, onView: render }),
      () => (code = newCode()),
      3,
    );
  } catch (err) {
    overlay(null);
    showHomeError(`Could not create the party: ${err.message || err.type}`);
  }
}

async function resumeHosting(save) {
  try {
    await startHosting(() => Host.restore(save, render), () => save.state.code, 8);
    toast('Welcome back! Your table has been restored.');
  } catch (err) {
    overlay(null);
    forgetSavedHost(save.state.code);
    showHomeError(`Could not reopen your party: ${err.message || err.type}`);
    history.replaceState(null, '', partyUrl(null));
  }
}

async function join(code, name) {
  code = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) { showHomeError('Enter the party code your host shared.'); return; }
  overlay(`Joining party ${code}…`);
  try {
    await waitForPeerJs();
    await connectClient(code, name);
    history.replaceState(null, '', partyUrl(code));
    showScreen('table');
    overlay(null);
  } catch (err) {
    overlay(null);
    showScreen('home');
    showHomeError(err.message);
  }
}

async function connectClient(code, name) {
  const conn = await joinParty(code);
  app.mode = 'client';
  app.conn = conn;
  app.code = code;
  app.name = name;
  conn.onData(onServerMessage);
  conn.onClose(() => { if (app.conn === conn && !app.leaving) reconnect(); });
  conn.send({ t: 'hello', token: token(), name });
}

async function reconnect() {
  app.conn = null;
  for (let i = 1; i <= 20; i++) {
    overlay(`Lost connection to the host. Reconnecting (${i})…`);
    try {
      await connectClient(app.code, app.name);
      overlay(null);
      toast('Reconnected');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (app.leaving) return;
  }
  overlay('Could not reach the host. The party may have ended.', { spinner: false, button: true });
}

function onServerMessage(msg) {
  if (msg.t === 'state') {
    render(msg.view, msg.you);
  } else if (msg.t === 'error') {
    if (msg.fatal) {
      app.leaving = true;
      overlay(msg.msg, { spinner: false, button: true });
    } else toast(msg.msg, true);
  } else if (msg.t === 'kicked') {
    app.leaving = true;
    overlay('The host removed you from the table.', { spinner: false, button: true });
  } else if (msg.t === 'closed') {
    app.leaving = true;
    overlay('The host has closed the party.', { spinner: false, button: true });
  }
}

function send(a, extra = {}) {
  const msg = { t: 'action', a, ...extra };
  if (app.mode === 'host') app.host.local(msg, (err) => toast(err, true));
  else if (app.conn) app.conn.send(msg);
}

function backToLobby() {
  app.leaving = true;
  if (app.mode === 'host') {
    app.host.shutdown();
    app.server?.destroy();
  } else if (app.conn) {
    app.conn.send({ t: 'action', a: 'leave' });
    const c = app.conn;
    setTimeout(() => c.close(), 200);
  }
  location.href = partyUrl(null);
}

// ---------- rendering ----------

function cardHtml(c) {
  let cls = '';
  if (!app.firstRender) {
    if (!app.seen.has(c.id)) cls = 'deal';
    else if (app.hiddenIds.has(c.id) && !c.hidden) cls = 'flip';
  }
  if (c.hidden) return `<div class="card back ${cls}"></div>`;
  const red = c.s === '♥' || c.s === '♦' ? 'red' : '';
  return `<div class="card ${red} ${cls}" aria-label="${c.r}${c.s}">
    <div class="corner">${c.r}<i>${c.s}</i></div><div class="pip">${c.s}</div><div class="corner br">${c.r}<i>${c.s}</i></div></div>`;
}

function totalLabel(cards) {
  const { total, soft } = handTotal(cards);
  if (cards.length === 2 && total === 21 && !cards.some((c) => c.hidden)) return '21';
  return soft && total < 21 ? `${total - 10} / ${total}` : String(total);
}

function chipColor(amount) {
  let color = CHIPS[0].c;
  for (const ch of CHIPS) if (amount >= ch.v) color = ch.c;
  return color;
}

function rulesSummary(st) {
  return [
    `${st.decks} deck${st.decks > 1 ? 's' : ''}`,
    `Bets ${fmt(st.minBet)}–${fmt(st.maxBet)}`,
    st.dealerHitsSoft17 ? 'H17' : 'S17',
    `BJ ${st.blackjackPays}`,
    st.doubleAfterSplit ? 'DAS' : 'No DAS',
    st.surrender ? 'Surrender' : null,
    st.insurance ? 'Insurance' : null,
    st.turnSeconds ? `${st.turnSeconds}s turns` : null,
  ].filter(Boolean).join(' · ');
}

function render(view, me) {
  app.view = view;
  app.me = me;
  app.turnStartLocal = Date.now() - (view.turnElapsed || 0);
  const st = view.settings;
  const mine = view.players.find((p) => p.id === me);

  $('#partyCode').textContent = view.code;
  $('#rulesSummary').textContent = rulesSummary(st);
  const left = view.shoe.size ? view.shoe.remaining / view.shoe.size : 1;
  $('#shoeFill').style.width = `${left * 100}%`;
  $('#shoeCut').style.left = `${(1 - view.shoe.cut / (view.shoe.size || 1)) * 100}%`;
  $('#shoeText').textContent = view.shoe.size ? `${view.shoe.remaining}` : '—';
  $('#dealerName').textContent = view.hostId ? '' : `· ${view.hostName}`;

  $('#feltPrint').innerHTML = `<b>Blackjack pays ${st.blackjackPays.replace(':', ' to ')}</b>
    Dealer ${st.dealerHitsSoft17 ? 'must hit soft 17' : 'must stand on all 17s'}${st.insurance ? ' · Insurance pays 2 to 1' : ''}`;

  // dealer
  const dCards = view.dealer.cards;
  $('#dealerCards').innerHTML = dCards.map(cardHtml).join('');
  const dt = $('#dealerTotal');
  dt.hidden = dCards.length === 0;
  if (dCards.length) {
    const t = handTotal(dCards).total;
    dt.textContent = view.dealer.revealed ? (t > 21 ? `Bust (${t})` : dCards.length === 2 && t === 21 ? 'Blackjack' : String(t)) : `${totalLabel(dCards)} + ?`;
  }

  // seats
  const seats = view.players.map((p) => seatHtml(p, view, me));
  for (let i = view.players.length; i < st.maxPlayers; i++) seats.push('<div class="empty-seat">Open seat</div>');
  $('#seats').innerHTML = seats.join('');

  $('#status').textContent = statusText(view, mine);
  renderDock(view, mine);
  renderFeeds(view);
  tickTimer();

  for (const c of dCards) app.seen.add(c.id);
  for (const p of view.players) for (const h of p.hands) for (const c of h.cards) app.seen.add(c.id);
  app.hiddenIds = new Set(dCards.filter((c) => c.hidden).map((c) => c.id));
  app.firstRender = false;
}

function seatHtml(p, view, me) {
  const isTurn = view.turn && view.turn.pid === p.id;
  const isHost = app.mode === 'host';
  const showHands = p.hands.length > 0;
  const hands = p.hands.map((h, i) => {
    const current = isTurn && view.turn.h === i && p.hands.length > 1;
    const res = h.result && view.phase === 'betting' ? `<span class="result ${h.result}">${RESULT_TEXT[h.result]}</span>` : '';
    const bust = !h.result && h.busted ? '<span class="result bust">Bust</span>' : '';
    const bj = !h.result && h.natural ? '<span class="result blackjack">Blackjack!</span>' : '';
    return `<div class="hand ${current ? 'current' : ''}">
      <div class="cards">${h.cards.map(cardHtml).join('')}</div>
      <div class="hand-meta"><span class="total-badge">${totalLabel(h.cards)}</span>
        <span class="bet-chip" style="--chip:${chipColor(h.bet)}">${fmt(h.bet)}</span>${h.doubled ? '<span class="muted">×2</span>' : ''}${res}${bust}${bj}</div>
    </div>`;
  }).join('');

  let foot = '';
  if (view.phase === 'betting') {
    if (p.ready && p.bet > 0) foot = `Bet <b>${fmt(p.bet)}</b> ✓`;
    else if (p.ready) foot = 'Sitting out';
    else if (!p.connected) foot = 'Away';
    else foot = p.chips < view.settings.minBet ? 'Out of chips' : 'Choosing a bet…';
    if (p.lastNet !== null && p.lastNet !== undefined) {
      const cls = p.lastNet > 0 ? 'net-pos' : p.lastNet < 0 ? 'net-neg' : '';
      foot = `<span class="${cls}">${p.lastNet > 0 ? '+' : ''}${fmt(p.lastNet)}</span> · ${foot}`;
    }
  } else if (view.phase === 'insurance' && p.inRound) {
    foot = p.insurance === null ? 'Deciding on insurance…' : p.insurance > 0 ? `Insured (${fmt(p.insurance)})` : 'No insurance';
  } else if (!p.inRound) {
    foot = 'Waiting for next round';
  } else if (p.insurance > 0) {
    foot = `Insured (${fmt(p.insurance)})`;
  }

  const timer = (isTurn || (view.phase === 'insurance' && p.inRound && p.insurance === null)) && view.settings.turnSeconds
    ? '<div class="timer"><div></div></div>' : '';
  const kick = isHost && p.id !== me ? `<button class="kick" data-kick="${esc(p.id)}" title="Remove ${esc(p.name)}">✕</button>` : '';

  return `<div class="seat ${p.id === me ? 'me' : ''} ${isTurn ? 'active' : ''} ${p.connected ? '' : 'offline'}">
    <div class="seat-head"><span class="seat-name">${esc(p.name)}${p.id === me ? '<span class="you">(you)</span>' : ''}${p.connected ? '' : ' <span class="muted">· offline</span>'}</span>
      <span class="chips">${fmt(p.chips)}</span>${kick}</div>
    ${showHands ? `<div class="seat-hands">${hands}</div>` : ''}
    ${timer}
    <div class="seat-foot">${foot}</div>
  </div>`;
}

function names(list) {
  return list.map((p) => p.name).join(', ');
}

function statusText(view, mine) {
  const st = view.settings;
  switch (view.phase) {
    case 'betting': {
      const waiting = view.players.filter((p) => p.connected && !p.ready);
      if (view.players.length === 0) return 'Waiting for players to join…';
      if (mine && !mine.ready) return mine.chips < st.minBet ? 'You are out of chips.' : 'Place your bet';
      if (waiting.length) return `Waiting for ${names(waiting)} to bet…`;
      return 'Waiting for bets…';
    }
    case 'insurance': {
      if (mine && mine.inRound && mine.insurance === null) return 'Dealer shows an Ace. Take insurance?';
      const waiting = view.players.filter((p) => p.inRound && p.insurance === null);
      return `Insurance? Waiting for ${names(waiting)}…`;
    }
    case 'playing': {
      const p = view.players.find((x) => x.id === view.turn.pid);
      const handNo = p.hands.length > 1 ? ` (hand ${view.turn.h + 1} of ${p.hands.length})` : '';
      if (p.id === app.me) return `Your turn${handNo}: ${totalLabel(p.hands[view.turn.h].cards)}`;
      return `${p.name} is playing${handNo}…`;
    }
    case 'dealer':
      return 'Dealer plays…';
    default:
      return '';
  }
}

function renderDock(view, mine) {
  const st = view.settings;
  const dock = $('#dock');
  const parts = [];
  const isHost = app.mode === 'host';
  const someoneBet = view.players.some((p) => p.ready && p.bet > 0);

  if (view.phase === 'betting' && mine) {
    if (!mine.ready) {
      if (mine.chips < st.minBet) {
        parts.push(st.allowRebuy
          ? `<button class="btn gold big" data-act="rebuy">Rebuy ${fmt(st.startingChips)} chips</button>`
          : '<span class="info">You are out of chips. Rebuys are disabled at this table.</span>');
      } else {
        const max = Math.min(st.maxBet, Math.floor(mine.chips));
        app.pendingBet = Math.min(app.pendingBet, max);
        for (const ch of CHIPS) {
          if (ch.v > st.maxBet || (ch.v < st.minBet / 10 && ch.v !== 1)) continue;
          if (ch.v === 1 && st.minBet > 5) continue;
          parts.push(`<button class="chip-btn" style="--chip:${ch.c}" data-chip="${ch.v}" ${app.pendingBet + ch.v > max ? 'disabled' : ''}>${ch.v >= 1000 ? `${ch.v / 1000}K` : ch.v}</button>`);
        }
        const valid = app.pendingBet >= st.minBet && app.pendingBet <= max;
        parts.push(`<div class="pending-bet"><b>${fmt(app.pendingBet)}</b><small>min ${fmt(st.minBet)} · max ${fmt(st.maxBet)}</small></div>`);
        parts.push('<button class="btn small ghost" data-act="clear">Clear</button>');
        const rebet = Math.min(mine.lastBet, max);
        if (rebet >= st.minBet) parts.push(`<button class="btn small" data-act="rebet" data-amount="${rebet}">Rebet ${fmt(rebet)}</button>`);
        parts.push(`<button class="btn gold big" data-act="bet" ${valid ? '' : 'disabled'}>Place bet</button>`);
        parts.push('<button class="btn small ghost" data-act="sitout">Sit out</button>');
      }
    } else {
      app.pendingBet = 0;
      parts.push(`<span class="info">${mine.bet > 0 ? `Your bet: <b>${fmt(mine.bet)}</b>.` : 'Sitting out this round.'} The cards are dealt when everyone is ready.</span>`);
      parts.push('<button class="btn small" data-act="unready">Change</button>');
    }
  } else if (view.phase === 'insurance' && mine && mine.inRound && mine.insurance === null) {
    const cost = Math.floor(mine.hands[0].bet / 2);
    const hasBj = mine.hands[0].natural;
    parts.push(`<span class="info">${hasBj ? 'You have Blackjack! Insurance here is "even money".' : 'Insurance costs half your bet and pays 2 to 1 if the dealer has Blackjack.'}</span>`);
    parts.push(`<button class="btn gold big" data-act="insure">Take insurance (${fmt(cost)})</button>`);
    parts.push('<button class="btn big" data-act="noinsure">No thanks</button>');
  } else if (view.phase === 'playing' && view.turn?.pid === app.me && mine) {
    const hand = mine.hands[view.turn.h];
    const al = allowedActions(view, mine, hand);
    parts.push(`<button class="btn primary big" data-act="hit" ${al.hit ? '' : 'disabled'}>Hit<kbd>H</kbd></button>`);
    parts.push(`<button class="btn gold big" data-act="stand">Stand<kbd>S</kbd></button>`);
    parts.push(`<button class="btn big" data-act="double" ${al.double ? '' : 'disabled'}>Double<kbd>D</kbd></button>`);
    parts.push(`<button class="btn big" data-act="split" ${al.split ? '' : 'disabled'}>Split<kbd>P</kbd></button>`);
    if (st.surrender) parts.push(`<button class="btn big danger" data-act="surrender" ${al.surrender ? '' : 'disabled'}>Surrender<kbd>R</kbd></button>`);
  } else if (!mine && app.mode === 'client') {
    parts.push('<span class="info">You are watching this table.</span>');
  } else if (!mine) {
    parts.push('<span class="info">You are the dealer. The house plays by the rules; you keep the game moving.</span>');
  } else if (!mine.inRound && view.phase !== 'betting') {
    parts.push('<span class="info">You will be dealt in next round.</span>');
  } else {
    parts.push('<span class="info">Waiting…</span>');
  }

  if (isHost && view.phase === 'betting' && someoneBet) {
    parts.push('<button class="btn small primary" data-act="deal" title="Deal now; anyone who has not bet sits this round out">Deal now</button>');
  }
  if (isHost && view.phase === 'insurance') {
    parts.push('<button class="btn small" data-act="closeInsurance">Close insurance</button>');
  }

  dock.innerHTML = parts.join('');
}

// Mirrors Game.allowed() for the client side, which only has the public view.
function allowedActions(view, p, hand) {
  const st = view.settings;
  const two = hand.cards.length === 2;
  const oneCardAces = hand.splitAces && !st.hitSplitAces;
  const val = (r) => (r === 'A' ? 11 : ['J', 'Q', 'K'].includes(r) ? 10 : Number(r));
  return {
    hit: !oneCardAces,
    double: two && !oneCardAces && p.chips >= hand.bet && (!hand.fromSplit || st.doubleAfterSplit),
    split: two && val(hand.cards[0].r) === val(hand.cards[1].r) && p.hands.length < st.maxSplitHands
      && p.chips >= hand.bet && (!hand.splitAces || st.resplitAces),
    surrender: st.surrender && two && p.hands.length === 1 && !hand.fromSplit,
  };
}

function timeStr(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderFeeds(view) {
  const chat = $('#chatList');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = view.chat.length
    ? view.chat.map((m) => `<li><span class="time">${timeStr(m.t)}</span><span class="who">${esc(m.name)}:</span> ${esc(m.text)}</li>`).join('')
    : '<li class="muted">Say hi to the table 👋</li>';
  if (atBottom) chat.scrollTop = chat.scrollHeight;

  const log = $('#logList');
  log.innerHTML = view.log.map((m) => `<li><span class="time">${timeStr(m.t)}</span>${esc(m.text)}</li>`).join('');
  log.scrollTop = log.scrollHeight;

  const sorted = [...view.players].sort((a, b) => (b.chips - b.rebuys * view.settings.startingChips) - (a.chips - a.rebuys * view.settings.startingChips));
  $('#board').innerHTML = sorted.map((p) => {
    const net = p.chips - view.settings.startingChips * (1 + p.rebuys);
    return `<li>${esc(p.name)} <span>${fmt(p.chips)} <small class="${net >= 0 ? 'net-pos' : 'net-neg'}">(${net >= 0 ? '+' : ''}${fmt(net)})</small></span>${p.rebuys ? `<div class="muted">${p.rebuys} rebuy${p.rebuys > 1 ? 's' : ''}</div>` : ''}</li>`;
  }).join('');
}

function tickTimer() {
  const v = app.view;
  if (!v || !v.settings.turnSeconds) return;
  const frac = Math.max(0, 1 - (Date.now() - app.turnStartLocal) / (v.settings.turnSeconds * 1000));
  document.querySelectorAll('.timer > div').forEach((el) => { el.style.width = `${frac * 100}%`; });
}

// ---------- events ----------

function onDockClick(e) {
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    app.pendingBet += Number(chip.dataset.chip);
    render(app.view, app.me);
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  switch (act) {
    case 'clear': app.pendingBet = 0; render(app.view, app.me); break;
    case 'rebet': app.pendingBet = Number(btn.dataset.amount); send('bet', { amount: app.pendingBet }); break;
    case 'bet': send('bet', { amount: app.pendingBet }); break;
    case 'sitout': send('bet', { amount: 0 }); break;
    case 'insure': send('insurance', { take: true }); break;
    case 'noinsure': send('insurance', { take: false }); break;
    default: send(act);
  }
}

function onKey(e) {
  if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const map = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender' };
  const act = map[e.key.toLowerCase()];
  if (!act) return;
  const btn = document.querySelector(`#dock [data-act="${act}"]`);
  if (btn && !btn.disabled) btn.click();
}

function bindEvents() {
  $('#showCreate').addEventListener('click', () => {
    if (!getName()) return;
    showHomeError('');
    $('#createForm').hidden = false;
    $('#createForm').scrollIntoView({ behavior: 'smooth' });
  });
  $('#cancelCreate').addEventListener('click', () => { $('#createForm').hidden = true; });
  $('#createForm').addEventListener('submit', createParty);
  $('#createForm').elements.penetration.addEventListener('input', (e) => {
    $('#penOut').textContent = `${Math.round(e.target.value * 100)}%`;
  });
  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = getName();
    if (name) join($('#joinCode').value, name);
  });
  $('#joinCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  $('#copyLink').addEventListener('click', async () => {
    const link = partyUrl(app.view?.code);
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    } catch {
      prompt('Share this link with your friends:', link);
    }
  });
  $('#leaveBtn').addEventListener('click', () => {
    const q = app.mode === 'host' ? 'Close the party for everyone?' : 'Leave the table? Any hand you have in play will stand automatically.';
    if (confirm(q)) backToLobby();
  });
  $('#overlayBtn').addEventListener('click', () => { location.href = partyUrl(null); });

  $('#dock').addEventListener('click', onDockClick);
  $('#seats').addEventListener('click', (e) => {
    const k = e.target.closest('[data-kick]');
    if (!k) return;
    const p = app.view.players.find((x) => x.id === k.dataset.kick);
    if (p && confirm(`Remove ${p.name} from the table?`)) app.host.local({ a: 'kick', id: p.id }, (err) => toast(err, true));
  });
  document.addEventListener('keydown', onKey);

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.id !== `tab-${tab.dataset.tab}`; });
  }));
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    send('chat', { text });
    $('#chatInput').value = '';
  });

  window.addEventListener('beforeunload', (e) => {
    if (app.mode === 'host' && !app.leaving) { e.preventDefault(); e.returnValue = ''; }
  });
  setInterval(tickTimer, 200);
}

function init() {
  bindEvents();
  const params = new URLSearchParams(location.search);
  const code = (params.get('party') || '').toUpperCase();
  const savedName = localStorage.getItem('bjparty-name') || '';
  $('#name').value = savedName;
  if (code) $('#joinCode').value = code;

  const save = code && loadSavedHost(code);
  if (save && save.hostToken === token()) {
    resumeHosting(save);
  } else if (code && savedName) {
    join(code, savedName);
  } else {
    showScreen('home');
    (savedName ? $('#joinCode') : $('#name')).focus();
  }
}

init();
