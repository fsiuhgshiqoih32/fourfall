import { replay, canPlay } from './game.js';
import { BoardView } from './board-view.js';
import * as sound from './sound.js';
import { OnlineSession, newCode, normalizeCode, formatCode, cleanName, randomId } from './online.js';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const nextFrame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`fourfall.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`fourfall.${key}`, JSON.stringify(value)); } catch { /* storage blocked */ }
  },
};

// The current online room survives a reload of this tab.
const roomStore = {
  get() { try { return JSON.parse(sessionStorage.getItem('fourfall.room') || 'null'); } catch { return null; } },
  set(v) { try { sessionStorage.setItem('fourfall.room', JSON.stringify(v)); } catch { /* storage blocked */ } },
  clear() { try { sessionStorage.removeItem('fourfall.room'); } catch { /* storage blocked */ } },
};

const app = $('.app');
const view = new BoardView($('#rig'));
const motion = matchMedia('(prefers-reduced-motion: reduce)');
view.reduced = motion.matches;
motion.addEventListener?.('change', (e) => { view.reduced = e.matches; });

// The position the home screen drops in: a game in progress, nobody winning yet.
const DEMO = [3, 3, 2, 4, 4, 2, 5, 3, 2, 2, 4, 5];

const S = {
  screen: 'home',
  mode: 'demo',              // demo | local | ai | online
  level: store.get('level', 'normal'),
  first: 1,
  moves: [],
  gameId: 0,
  scores: { 1: 0, 2: 0, draw: 0 },
  aiReq: 0,
  aiThinking: false,
  aiPreview: false,
  online: null,
  lobbyNote: null,           // null | 'offline' | 'missing' | 'full'
};

let shown = { key: null, first: 1, moves: [] };
let busy = false;
let again = false;
let presented = null;
let demoToken = 0;
let demoRun = Promise.resolve();
let lobbyTimers = [];

const sameMoves = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isPrefix = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);
const shownState = () => replay(shown.moves, shown.first) || replay([], 1);

// ---------------------------------------------------------------- the board follows the game

// What the board should show now.
function target() {
  if (S.mode === 'online' && S.online) {
    const o = S.online;
    return { key: `online:${o.code}:${o.game}`, first: o.firstColor, moves: o.moveList };
  }
  return { key: `${S.mode}:${S.gameId}`, first: S.first, moves: S.moves };
}

// Animates the board from what it shows to the target, one step at a time.
async function reconcile() {
  if (busy) { again = true; return; }
  busy = true;
  refresh();
  try {
    do {
      again = false;
      const t = target();
      if (t.key !== shown.key || t.first !== shown.first) {
        if (view.discs.size) await view.releaseAll(); else view.clearWin();
        shown = { key: t.key, first: t.first, moves: [] };
        const t2 = target();
        if (t2.key === shown.key && t2.moves.length > 1) {
          // Joining or restoring a game in progress: show it at once.
          view.setPosition(replay(t2.moves, t2.first));
          shown.moves = t2.moves.slice();
        }
        again = true;
        continue;
      }
      if (sameMoves(shown.moves, t.moves)) continue;
      if (isPrefix(shown.moves, t.moves)) {
        const next = t.moves.slice(0, shown.moves.length + 1);
        const st = replay(next, shown.first);
        if (!st) { view.setPosition(replay(t.moves, t.first)); shown.moves = t.moves.slice(); continue; }
        await view.drop(st.last.col, st.last.row, st.last.player);
        shown.moves = next;
        again = true;
      } else if (isPrefix(t.moves, shown.moves)) {
        view.clearWin();
        presented = null;
        const st = replay(shown.moves, shown.first);
        shown.moves = shown.moves.slice(0, -1);
        await view.lift(st.last.col, st.last.row);
        again = true;
      } else {
        view.setPosition(replay(t.moves, t.first));
        presented = null;
        shown.moves = t.moves.slice();
      }
    } while (again);
  } finally {
    busy = false;
  }
  settled();
}

function settled() {
  const st = shownState();
  view.labelColumns(st.heights);
  if (st.over && presented !== shown.key && S.screen === 'game') {
    presented = shown.key;
    presentResult(st);
  }
  refresh();
  maybeComputer();
}

function presentResult(st) {
  if (st.winner) {
    S.scores[st.winner]++;
    view.showWin(st.lines, st.winner);
    const mine = S.mode === 'ai' ? 1 : S.mode === 'online' ? S.online?.myColor : st.winner;
    if (st.winner === mine) sound.win(); else sound.lose();
  } else {
    S.scores.draw++;
    sound.draw();
  }
}

// ---------------------------------------------------------------- rendering

function names() {
  if (S.mode === 'ai') return { 1: 'You', 2: 'Computer' };
  if (S.mode === 'online' && S.online) {
    const o = S.online;
    const peer = o.peer.name || 'Friend';
    return o.myColor === 1 ? { 1: 'You', 2: peer } : { 1: peer, 2: 'You' };
  }
  return { 1: 'Brass', 2: 'Pearl' };
}

const LEVEL_NAMES = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

function humanCanMove(st) {
  if (S.screen !== 'game' || busy || !st || st.over) return false;
  if (S.mode === 'local') return true;
  if (S.mode === 'ai') return st.turn === 1 && !S.aiThinking;
  if (S.mode === 'online' && S.online) return S.online.canMove() && sameMoves(shown.moves, S.online.moveList);
  return false;
}

function refresh() {
  const st = shownState();
  const live = humanCanMove(st);
  view.setInput(live);
  if (live) view.setPreview(st.turn);
  else if (!S.aiPreview) view.setPreview(0);
  document.body.dataset.turn = S.screen === 'game' ? String(st.over ? st.winner : st.turn) : '0';
  app.dataset.mode = S.mode;
  renderPlates(st);
  renderStatus(st);
  renderControls(st);
  renderLobby();
}

function renderPlates(st) {
  const n = names();
  const o = S.online;
  for (const p of [1, 2]) {
    const plate = $(`#plate-${p}`);
    const away = S.mode === 'online' && o && p !== o.myColor && !o.peer.present;
    let tag = '';
    if (st.winner === p) tag = 'Wins';
    else if (!st.over && st.turn === p) tag = S.mode === 'ai' && p === 2 ? 'Thinking' : 'To move';
    else if (S.mode === 'ai' && p === 2) tag = LEVEL_NAMES[S.level];
    if (away) tag = o.peer.left ? 'Left the room' : 'Offline';
    plate.querySelector('.pname').textContent = n[p];
    plate.querySelector('.ptag').textContent = tag;
    plate.querySelector('.pscore').textContent = String(S.scores[p]);
    plate.classList.toggle('active', st.over ? st.winner === p : st.turn === p);
    plate.classList.toggle('away', away);
  }
  const d = S.scores.draw;
  $('#draws').textContent = d ? `${d} ${d === 1 ? 'draw' : 'draws'}` : '';
}

function renderStatus(st) {
  const el = $('#status');
  let text = '';
  let result = false;
  if (S.screen === 'game') {
    const n = names();
    const o = S.online;
    const peer = o?.peer.name || 'Your friend';
    if (st.winner) {
      result = true;
      if (S.mode === 'ai') text = st.winner === 1 ? 'You win' : 'The computer wins';
      else if (S.mode === 'online' && o) text = st.winner === o.myColor ? 'You win' : `${peer} wins`;
      else text = `${n[st.winner]} wins`;
    } else if (st.draw) {
      result = true;
      text = 'Draw';
    } else if (S.mode === 'local') {
      text = `${n[st.turn]} to move`;
    } else if (S.mode === 'ai') {
      text = st.turn === 1 ? 'Your move' : 'The computer is thinking';
    } else if (o) {
      if (o.relays === 0) text = 'Reconnecting';
      else if (st.turn === o.myColor) text = 'Your move';
      else if (o.peer.left) text = `${peer} left the room`;
      else if (!o.peer.present) text = `Waiting for ${o.peer.name || 'your friend'} to reconnect`;
      else text = `${peer}'s move`;
    }
  }
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('result', result);
}

function canUndo(st) {
  if (S.screen !== 'game' || st.over) return false;
  if (S.mode === 'local') return S.moves.length > 0;
  if (S.mode === 'ai') {
    const humanMoves = S.moves.filter((_, i) => (i % 2 === 0 ? S.first : 3 - S.first) === 1).length;
    return humanMoves > 0;
  }
  return false;
}

function renderControls(st) {
  const btnNew = $('#btn-new');
  const undo = $('#btn-undo');
  const note = $('#note');
  const online = S.mode === 'online' && S.online;
  $('#btn-menu').textContent = online ? 'Leave room' : 'Menu';
  undo.hidden = Boolean(online);
  if (!online) {
    btnNew.hidden = false;
    btnNew.disabled = false;
    btnNew.textContent = 'New game';
    btnNew.classList.toggle('primary', st.over);
    undo.disabled = !canUndo(st);
    note.textContent = '';
    return;
  }
  const o = S.online;
  const peer = o.peer.name || 'Your friend';
  btnNew.hidden = !st.over;
  btnNew.classList.add('primary');
  btnNew.disabled = o.wantRematch;
  btnNew.textContent = o.wantRematch ? 'Rematch requested' : o.peerWantsRematch ? 'Accept rematch' : 'Rematch';
  if (st.over && o.peerWantsRematch && !o.wantRematch) note.textContent = `${peer} wants a rematch.`;
  else if (st.over && o.wantRematch) note.textContent = `Waiting for ${o.peer.name || 'your friend'} to accept.`;
  else note.textContent = '';
  $('#room-code').textContent = formatCode(o.code);
}

function renderLobby() {
  if (S.screen !== 'lobby' || !S.online) return;
  const o = S.online;
  const host = o.role === 'host';
  $('#lobby-title').textContent = host ? 'Your room' : 'Joining room';
  $('#lobby-code').textContent = formatCode(o.code);
  $('#lobby-actions').hidden = !host;
  $('#share-link').hidden = !navigator.share;
  let msg;
  let bad = false;
  if (o.relays === 0) {
    bad = S.lobbyNote === 'offline';
    msg = bad ? "Can't reach the relay servers. Check your internet connection." : 'Connecting';
  } else if (host) {
    msg = 'Waiting for a friend to join.';
  } else if (S.lobbyNote === 'full') {
    bad = true;
    msg = 'This room already has two players.';
  } else if (S.lobbyNote === 'missing') {
    bad = true;
    msg = 'No one is hosting this room right now. Check the code with your friend. This page keeps looking.';
  } else {
    msg = 'Looking for the room';
  }
  const el = $('#lobby-status');
  if (el.textContent !== msg) el.textContent = msg;
  el.classList.toggle('error-text', bad);
}

function setScreen(name) {
  S.screen = name;
  app.dataset.screen = name;
  refresh();
}

function focusBoard() {
  const b = view.buttons[view.hoverCol];
  if (b) b.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- the computer

let worker = null;
const pending = new Map();
let askSeq = 0;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const done = pending.get(e.data.id);
      if (done) { pending.delete(e.data.id); done(e.data.col); }
    };
    worker.onerror = () => {
      for (const done of pending.values()) done(-1);
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function askComputer(moves, first, level) {
  return new Promise((resolve) => {
    const id = ++askSeq;
    pending.set(id, resolve);
    try {
      getWorker().postMessage({ id, moves, first, level });
    } catch {
      pending.delete(id);
      resolve(-1);
      return;
    }
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve(-1); }
    }, 6000);
  });
}

function fallbackMove(st) {
  for (const c of [3, 2, 4, 1, 5, 0, 6]) if (canPlay(st, c)) return c;
  return -1;
}

let lastComputerCol = 3;

async function maybeComputer() {
  if (S.mode !== 'ai' || S.screen !== 'game' || busy || S.aiThinking) return;
  const st = replay(S.moves, S.first);
  if (!st || st.over || st.turn !== 2) return;
  const req = ++S.aiReq;
  S.aiThinking = true;
  refresh();
  const t0 = performance.now();
  let col = await askComputer(S.moves.slice(), S.first, S.level);
  if (req !== S.aiReq) return;
  if (col < 0 || !canPlay(st, col)) col = fallbackMove(st);
  await sleep(Math.max(0, (S.level === 'hard' ? 250 : 600) - (performance.now() - t0)));
  if (req !== S.aiReq) return;
  if (!view.reduced) {
    S.aiPreview = true;
    view.setPreview(2, lastComputerCol);
    await nextFrame();
    view.setPreview(2, col);
    await sleep(Math.abs(col - lastComputerCol) * 40 + 200);
    if (req !== S.aiReq) return;
  }
  lastComputerCol = col;
  S.aiPreview = false;
  S.aiThinking = false;
  S.moves = [...S.moves, col];
  reconcile();
}

function cancelComputer() {
  S.aiReq++;
  S.aiThinking = false;
  S.aiPreview = false;
}

// ---------------------------------------------------------------- actions

function humanDrop(c) {
  sound.unlock();
  const st = shownState();
  if (!humanCanMove(st)) return;
  if (!canPlay(st, c)) { view.bump(); return; }
  if (S.mode === 'online') {
    if (!S.online.play(c)) view.bump();
    return;
  }
  S.moves = [...S.moves, c];
  reconcile();
}

function undo() {
  const st = replay(S.moves, S.first);
  if (!st || !canUndo(st) || S.mode === 'online') return;
  if (S.mode === 'local') {
    S.moves = S.moves.slice(0, -1);
  } else {
    cancelComputer();
    const last = st.last.player;
    S.moves = S.moves.slice(0, last === 2 ? -2 : -1);
  }
  reconcile();
}

function newGame() {
  if (S.screen !== 'game') return;
  sound.unlock();
  if (S.mode === 'online') {
    S.online?.requestRematch();
    refresh();
    return;
  }
  const st = replay(S.moves, S.first);
  cancelComputer();
  if (st && st.over) S.first = 3 - S.first;
  S.gameId++;
  S.moves = [];
  reconcile();
}

async function stopDemo() {
  demoToken++;
  await demoRun;
  view.silent = false;
}

async function startGame(mode) {
  sound.unlock();
  stopOnline();
  cancelComputer();
  await stopDemo();
  S.mode = mode;
  S.first = 1;
  S.gameId++;
  S.moves = [];
  S.scores = { 1: 0, 2: 0, draw: 0 };
  presented = null;
  setScreen('game');
  focusBoard();
  reconcile();
}

function goHome() {
  cancelComputer();
  stopOnline();
  S.mode = 'demo';
  S.gameId++;
  S.moves = [];
  S.scores = { 1: 0, 2: 0, draw: 0 };
  setScreen('home');
  runDemo();
}

function runDemo() {
  const token = ++demoToken;
  demoRun = (async () => {
    while (busy) await sleep(40);
    if (token !== demoToken) return;
    view.silent = false;
    if (view.discs.size) await view.releaseAll();
    if (token !== demoToken) return;
    view.silent = true;
    shown = { key: `demo:${S.gameId}`, first: 1, moves: [] };
    if (view.reduced) {
      view.setPosition(replay(DEMO, 1));
      shown.moves = DEMO.slice();
      S.moves = DEMO.slice();
      return;
    }
    await sleep(220);
    const drops = [];
    for (let i = 0; i < DEMO.length && token === demoToken; i++) {
      const st = replay(DEMO.slice(0, i + 1), 1);
      drops.push(view.drop(st.last.col, st.last.row, st.last.player));
      shown.moves = DEMO.slice(0, i + 1);
      S.moves = shown.moves.slice();
      await sleep(115);
    }
    await Promise.all(drops);
  })();
}

const confirmDialog = $('#dlg-leave');
function confirmLeave(title, text) {
  $('#leave-title').textContent = title;
  $('#leave-text').textContent = text;
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise((res) => {
    confirmDialog.addEventListener('close', () => res(confirmDialog.returnValue === 'leave'), { once: true });
  });
}

async function leave() {
  if (S.screen === 'invite') { dismissInvite(); return; }
  if (S.screen === 'lobby') { goHome(); return; }
  if (S.screen !== 'game') return;
  const st = shownState();
  if (S.mode === 'online') {
    if (!(await confirmLeave('Leave the room?', 'Your friend will see that you left.'))) return;
  } else {
    const played = S.scores[1] + S.scores[2] + S.scores.draw > 0;
    if ((S.moves.length && !st.over) || played) {
      if (!(await confirmLeave('Leave this game?', 'The board and the scores will be cleared.'))) return;
    }
  }
  goHome();
}

// ---------------------------------------------------------------- online

const inviteUrl = (code) => `${location.origin}${location.pathname}#room=${code}`;

function setHash(code) {
  history.replaceState(null, '', `${location.pathname}${location.search}#room=${code}`);
}

async function startOnline({ code, role, myId, saved }) {
  stopOnline();
  cancelComputer();
  await stopDemo();
  S.lobbyNote = null;
  S.scores = { 1: 0, 2: 0, draw: 0 };
  presented = null;
  const o = new OnlineSession({ code, role, myId, name: cleanName($('#in-name').value), saved, emit: onOnline });
  S.online = o;
  S.mode = 'online';
  setHash(code);
  roomStore.set(o.snapshot());
  o.start();
  lobbyTimers = [
    setTimeout(() => { if (S.online === o && o.relays === 0) { S.lobbyNote = 'offline'; refresh(); } }, 12000),
    setTimeout(() => {
      if (S.online === o && !o.accepted && o.role === 'guest' && !S.lobbyNote) { S.lobbyNote = 'missing'; refresh(); }
    }, 15000),
  ];
  setScreen(o.accepted ? 'game' : 'lobby');
  if (o.accepted) focusBoard();
  reconcile();
}

function onOnline(ev) {
  const o = S.online;
  if (!o) return;
  roomStore.set(o.snapshot());
  if (ev === 'start') {
    if (S.screen !== 'game') {
      sound.join();
      S.lobbyNote = null;
      setScreen('game');
      focusBoard();
    }
    reconcile();
    return;
  }
  if (ev === 'moves' || ev === 'newgame') { reconcile(); return; }
  if (ev === 'full') S.lobbyNote = 'full';
  if (ev === 'connection' && o.relays > 0 && S.lobbyNote === 'offline') S.lobbyNote = null;
  if (ev === 'peer' && o.peer.present && S.lobbyNote === 'missing') S.lobbyNote = null;
  refresh();
}

function stopOnline() {
  lobbyTimers.forEach(clearTimeout);
  lobbyTimers = [];
  if (S.online) {
    S.online.stop();
    S.online = null;
  }
  roomStore.clear();
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
}

async function copyInvite(btn) {
  const o = S.online;
  if (!o) return;
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  try {
    await navigator.clipboard.writeText(inviteUrl(o.code));
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = 'Copy blocked. Send the code.';
  }
  clearTimeout(btn.resetTimer);
  btn.resetTimer = setTimeout(() => { btn.textContent = label; }, 2200);
}

// Someone opened an invite link: show the room and a Join button.
let inviteCode = null;
function showInvite(code) {
  inviteCode = code;
  $('#invite-code').textContent = formatCode(code);
  $('#in-name-invite').value = store.get('name', '');
  $('#in-code').value = formatCode(code);
  setScreen('invite');
  $('#invite-join').focus({ preventScroll: true });
}

function joinInvite() {
  if (!inviteCode) return;
  sound.unlock();
  const name = cleanName($('#in-name-invite').value);
  $('#in-name').value = name;
  store.set('name', name);
  startOnline({ code: inviteCode, role: 'guest', myId: randomId(), saved: null });
}

function dismissInvite() {
  inviteCode = null;
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  setScreen('home');
}

// ---------------------------------------------------------------- wiring

function toggleGroup(name, forceOpen = false) {
  for (const g of ['ai', 'online']) {
    const btn = $(`#m-${g}`);
    const opts = $(`#opt-${g}`);
    const open = g === name && (forceOpen || btn.getAttribute('aria-expanded') !== 'true');
    btn.setAttribute('aria-expanded', String(open));
    opts.hidden = !open;
  }
}

view.onHover = (c) => { if (c < 0) view.unhover(); else view.moveHover(c); };
view.onDrop = humanDrop;

$('#m-local').addEventListener('click', () => startGame('local'));
$('#m-ai').addEventListener('click', () => toggleGroup('ai'));
$('#m-online').addEventListener('click', () => toggleGroup('online'));
$('#start-ai').addEventListener('click', () => startGame('ai'));
document.querySelectorAll('input[name="level"]').forEach((r) => {
  r.addEventListener('change', () => { if (r.checked) { S.level = r.value; store.set('level', r.value); } });
});

$('#in-name').value = store.get('name', '');
$('#in-name').addEventListener('input', (e) => store.set('name', cleanName(e.target.value)));
$('#create-room').addEventListener('click', () => {
  sound.unlock();
  startOnline({ code: newCode(), role: 'host', myId: randomId(), saved: null });
});
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  const code = normalizeCode($('#in-code').value);
  if (!code) {
    $('#join-error').textContent = 'Enter the 6-character code your friend sent you.';
    $('#in-code').focus();
    return;
  }
  $('#join-error').textContent = '';
  startOnline({ code, role: 'guest', myId: randomId(), saved: null });
});
$('#in-code').addEventListener('input', () => { $('#join-error').textContent = ''; });

$('#copy-link').addEventListener('click', (e) => copyInvite(e.currentTarget));
$('#room-copy').addEventListener('click', (e) => copyInvite(e.currentTarget));
$('#share-link').addEventListener('click', async () => {
  const o = S.online;
  if (!o || !navigator.share) return;
  try {
    await navigator.share({ title: 'Fourfall', text: `Play four in a row with me. Room ${formatCode(o.code)}.`, url: inviteUrl(o.code) });
  } catch { /* closed the share sheet */ }
});
$('#lobby-cancel').addEventListener('click', () => goHome());
$('#invite-join').addEventListener('click', joinInvite);
$('#invite-cancel').addEventListener('click', dismissInvite);
$('#in-name-invite').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinInvite(); });

$('#btn-new').addEventListener('click', newGame);
$('#btn-undo').addEventListener('click', undo);
$('#btn-menu').addEventListener('click', leave);
$('#mark').addEventListener('click', leave);

const soundBtn = $('#btn-sound');
let muted = store.get('muted', false);
function applyMute() {
  sound.setMuted(muted);
  soundBtn.setAttribute('aria-pressed', String(!muted));
  soundBtn.title = muted ? 'Sound off' : 'Sound on';
}
soundBtn.addEventListener('click', () => {
  muted = !muted;
  store.set('muted', muted);
  sound.unlock();
  applyMute();
});
$('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, dialog')) return;
  if (S.screen !== 'game') return;
  if (/^[1-7]$/.test(e.key)) {
    e.preventDefault();
    const c = Number(e.key) - 1;
    view.moveHover(c);
    humanDrop(c);
  } else if (e.key === 'u' || e.key === 'U') {
    undo();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('.col')) {
    e.preventDefault();
    focusBoard();
  }
});

// Browsers only allow sound after a tap or key press; iOS wants it on the release.
for (const type of ['pointerup', 'keydown', 'touchend']) document.addEventListener(type, () => sound.unlock(), { capture: true, passive: true });

window.addEventListener('pagehide', () => { if (S.online) S.online.relay.send({ t: 'bye' }); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/room=([A-Za-z0-9]{6})/i);
  const code = m && normalizeCode(m[1]);
  if (code && S.online?.code !== code) {
    if (S.screen === 'game' || S.screen === 'lobby') goHome();
    history.replaceState(null, '', `${location.pathname}${location.search}#room=${code}`);
    showInvite(code);
  }
});

function boot() {
  applyMute();
  ($(`#lv-${S.level}`) || $('#lv-normal')).checked = true;
  const m = location.hash.match(/room=([A-Za-z0-9]{6})/i);
  const code = m && normalizeCode(m[1]);
  if (code) {
    const saved = roomStore.get();
    if (saved && saved.code === code && (saved.role === 'host' || saved.role === 'guest') && typeof saved.myId === 'string') {
      startOnline({ code, role: saved.role, myId: saved.myId, saved });
      return;
    }
    goHome();
    history.replaceState(null, '', `${location.pathname}${location.search}#room=${code}`);
    showInvite(code);
    return;
  }
  goHome();
}

boot();

// For automated checks only.
window.__fourfall = { S, view, get shown() { return shown; }, get busy() { return busy; } };
