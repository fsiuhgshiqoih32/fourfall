import { replay, canPlay } from './game.js';
import { BoardView } from './board-view.js';
import * as sound from './sound.js';
import { OnlineSession, newCode, normalizeCode, formatCode, cleanName, randomId } from './online.js';
import * as coach from './coach.js';
import { LESSONS } from './lessons.js';
import { PUZZLES } from './puzzles.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
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
  mode: 'demo',              // demo | local | ai | online | train | task
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
  train: {
    human: 1,                // the learner's colour
    starter: store.get('starter', 'you'),
    analyses: new Map(),     // move list -> solver scores for the player to move
    inflight: new Map(),
    log: [],                 // one entry per learner move: { at, move, scores, result }
    showValues: store.get('values', false),
    hintLevel: 0,
    line: null,              // best line being shown
    review: null,            // index of the log entry being reviewed
    note: '',
    verdict: null,
    lastResult: null,
    recorded: null,
  },
  task: null,                // the lesson task or puzzle on screen
};

let shown = { key: null, first: 1, moves: [] };
let busy = false;
let again = false;
let presented = null;
let demoToken = 0;
let nav = 0;                 // bumped by every navigation; async starters give up when it moves on
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
        if (presented === shown.key) unscoreResult();
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
  } else if (st.over && S.mode === 'task' && presented !== shown.key) {
    presented = shown.key;
    if (st.winner) view.showWin(st.lines, st.winner);
  }
  if (S.mode === 'task' && S.task && sameMoves(shown.moves, S.moves)) decorateTask();
  refresh();
  maybeComputer();
  if (S.mode === 'train') trainTurn();
}

function presentResult(st) {
  S.train.lastResult = st.winner || 'draw';
  if (st.winner) {
    S.scores[st.winner]++;
    view.showWin(st.lines, st.winner);
    const mine = S.mode === 'ai' ? 1 : S.mode === 'online' ? S.online?.myColor : S.mode === 'train' ? S.train.human : st.winner;
    if (st.winner === mine) sound.win(); else sound.lose();
  } else {
    S.scores.draw++;
    sound.draw();
  }
  if (S.mode === 'train') recordTraining(st);
}

function unscoreResult() {
  const r = S.train.lastResult;
  if (r === 'draw') S.scores.draw = Math.max(0, S.scores.draw - 1);
  else if (r) S.scores[r] = Math.max(0, S.scores[r] - 1);
  S.train.lastResult = null;
}

// ---------------------------------------------------------------- rendering

function names() {
  if (S.mode === 'ai') return { 1: 'You', 2: 'Computer' };
  if (S.mode === 'train') return S.train.human === 1 ? { 1: 'You', 2: 'Solver' } : { 1: 'Solver', 2: 'You' };
  if (S.mode === 'online' && S.online) {
    const o = S.online;
    const peer = o.peer.name || 'Friend';
    return o.myColor === 1 ? { 1: 'You', 2: peer } : { 1: peer, 2: 'You' };
  }
  return { 1: 'Brass', 2: 'Pearl' };
}

const LEVEL_NAMES = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

function humanCanMove(st) {
  if (busy || !st || st.over) return false;
  if (S.mode === 'task') return S.screen === 'task' && Boolean(S.task) && !S.task.answered && st.turn === S.task.you;
  if (S.screen !== 'game') return false;
  if (S.mode === 'local') return true;
  if (S.mode === 'train') return st.turn === S.train.human && !S.aiThinking && S.train.review === null;
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
  renderCoach();
  renderTask();
  renderLearn();
}

const switching = () => S.screen === 'game' && shown.key !== target().key;

function renderPlates(st) {
  const n = names();
  const o = S.online;
  const moving = switching();
  for (const p of [1, 2]) {
    const plate = $(`#plate-${p}`);
    const away = S.mode === 'online' && o && p !== o.myColor && !o.peer.present;
    let tag = '';
    if (st.winner === p) tag = 'Wins';
    else if (!st.over && st.turn === p) tag = p === computerColor() ? 'Thinking' : 'To move';
    else if (S.mode === 'ai' && p === 2) tag = LEVEL_NAMES[S.level];
    else if (S.mode === 'train' && p !== S.train.human) tag = 'Perfect play';
    if (away) tag = o.peer.left ? 'Left the room' : 'Offline';
    if (moving) tag = S.mode === 'train' && p !== S.train.human ? 'Perfect play' : '';
    plate.querySelector('.pname').textContent = n[p];
    plate.querySelector('.ptag').textContent = tag;
    plate.querySelector('.pscore').textContent = String(S.scores[p]);
    plate.classList.toggle('active', !moving && (st.over ? st.winner === p : st.turn === p));
    plate.classList.toggle('away', away);
  }
  const d = S.scores.draw;
  $('#draws').textContent = d ? `${d} ${d === 1 ? 'draw' : 'draws'}` : '';
}

function renderStatus(st) {
  const el = $('#status');
  let text = '';
  let result = false;
  if (S.screen === 'game' && !switching()) {
    const n = names();
    const o = S.online;
    const peer = o?.peer.name || 'Your friend';
    if (st.winner) {
      result = true;
      if (S.mode === 'ai') text = st.winner === 1 ? 'You win' : 'The computer wins';
      else if (S.mode === 'train') text = st.winner === S.train.human ? 'You win' : 'The solver wins';
      else if (S.mode === 'online' && o) text = st.winner === o.myColor ? 'You win' : `${peer} wins`;
      else text = `${n[st.winner]} wins`;
    } else if (st.draw) {
      result = true;
      text = 'Draw';
    } else if (S.mode === 'local') {
      text = `${n[st.turn]} to move`;
    } else if (S.mode === 'ai') {
      text = st.turn === 1 ? 'Your move' : 'The computer is thinking';
    } else if (S.mode === 'train') {
      text = st.turn === S.train.human ? 'Your move' : 'The solver is thinking';
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
    if (S.mode === 'train') undo.hidden = true;
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
  if (name !== S.screen) window.scrollTo(0, 0);
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

const computerColor = () => (S.mode === 'ai' ? 2 : S.mode === 'train' ? 3 - S.train.human : 0);

async function maybeComputer() {
  if ((S.mode !== 'ai' && S.mode !== 'train') || S.screen !== 'game' || busy || S.aiThinking) return;
  if (S.mode === 'train' && S.train.review !== null) return;
  const me = computerColor();
  const st = replay(S.moves, S.first);
  if (!st || st.over || st.turn !== me) return;
  const req = ++S.aiReq;
  S.aiThinking = true;
  refresh();
  const t0 = performance.now();
  let col;
  if (S.mode === 'train') col = await solverReply(S.moves, req);
  else col = await askComputer(S.moves.slice(), S.first, S.level);
  if (req !== S.aiReq) return;
  if (!(col >= 0) || !canPlay(st, col)) col = fallbackMove(st);
  if (S.mode === 'train') solverMoved(col);
  const minWait = S.mode === 'train' ? 450 : S.level === 'hard' ? 250 : 600;
  await sleep(Math.max(0, minWait - (performance.now() - t0)));
  if (req !== S.aiReq) return;
  if (!view.reduced) {
    S.aiPreview = true;
    view.setPreview(me, lastComputerCol);
    await nextFrame();
    view.setPreview(me, col);
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
  if (S.mode === 'task') { taskMove(c); return; }
  if (S.mode === 'train') { trainMove(c); return; }
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
  if (S.mode === 'train') { newTrainingGame(); return; }
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
  const my = ++nav;
  sound.unlock();
  stopOnline();
  cancelComputer();
  await stopDemo();
  if (my !== nav) return;
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
  ++nav;
  cancelComputer();
  stopOnline();
  resetSolver();
  S.task = null;
  S.train.review = null;
  S.train.line = null;
  view.clearNotes();
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
    if (token !== demoToken || S.mode !== 'demo') return;
    view.silent = false;
    if (view.discs.size) await view.releaseAll();
    if (token !== demoToken || S.mode !== 'demo') return;
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
    for (let i = 0; i < DEMO.length && token === demoToken && S.mode === 'demo'; i++) {
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
  if (S.screen === 'task') { openLearn(); return; }
  if (S.screen === 'learn') { goHome(); return; }
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

// ---------------------------------------------------------------- training with the solver

const T = S.train;
const movesKey = (m) => m.join('');
const colName = (c) => `column ${c + 1}`;
const ColName = (c) => `Column ${c + 1}`;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const cleanScores = (scores) => scores.map((v) => (finite(v) ? v : null));
const narrow = matchMedia('(max-width: 820px)');

let solverWorker = null;
const solverPending = new Map();
let solverSeq = 0;

function solverAsk(type, moves, extra = {}, timeout = 45000) {
  if (!solverWorker) {
    solverWorker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    solverWorker.onmessage = (e) => {
      const p = solverPending.get(e.data.id);
      if (!p) return;
      solverPending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve(e.data); else p.reject(new Error(e.data.error));
    };
    solverWorker.onerror = () => resetSolver(true);
  }
  return new Promise((resolve, reject) => {
    const id = ++solverSeq;
    // A search that runs this long is stuck behind work nobody needs: start over.
    const timer = setTimeout(() => { if (solverPending.has(id)) resetSolver(true); }, timeout);
    solverPending.set(id, { resolve, reject, timer });
    solverWorker.postMessage({ id, type, moves, ...extra });
  });
}

// Drops every pending solver request (they block the single worker) by
// starting a fresh worker. Cheap: both files come from the cache.
function resetSolver(force = false) {
  if (!solverWorker || (!force && solverPending.size === 0)) return;
  solverWorker.terminate();
  solverWorker = null;
  for (const p of solverPending.values()) { clearTimeout(p.timer); p.reject(new Error('cancelled')); }
  solverPending.clear();
  T.inflight.clear();
  T.prefetch = null;
}

// Solver scores for the player to move, cached per position.
function ensureAnalysis(moves) {
  const key = movesKey(moves);
  if (T.analyses.has(key)) return Promise.resolve(T.analyses.get(key));
  if (T.inflight.has(key)) return T.inflight.get(key);
  const p = solverAsk('analyze', moves.slice())
    .then((r) => {
      if (T.inflight.get(key) === p) T.inflight.delete(key);
      if (r.exact) T.analyses.set(key, r.scores);
      return r.scores;
    })
    .catch(() => { if (T.inflight.get(key) === p) T.inflight.delete(key); return null; });
  T.inflight.set(key, p);
  return p;
}

// Scores of +-99 would come from a tree solved as win / draw / loss only.
const classOnly = (score) => Math.abs(score) >= 99;

// A score for the player to move, with n discs on the board, as an outcome:
// who wins and how many more moves the winner needs (counting the winning one).
function outcomeOf(score, n) {
  if (classOnly(score)) return { kind: score > 0 ? 'win' : 'loss', moves: null };
  if (score > 0) return { kind: 'win', moves: 22 - score - Math.floor(n / 2) };
  if (score < 0) return { kind: 'loss', moves: 22 + score - Math.ceil(n / 2) };
  return { kind: 'draw', moves: null };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function verdictText(kind, moves) {
  if (moves === 0) return kind === 'win' ? 'You win' : kind === 'loss' ? 'The solver wins' : 'A draw';
  if (kind === 'win') return moves ? `You can win in ${plural(moves, 'move')}` : 'You can force a win';
  if (kind === 'loss') return moves ? `The solver wins in ${plural(moves, 'move')}` : 'The solver can force a win';
  return 'A draw';
}

const makeVerdict = (kind, moves) => ({ kind, moves, text: verdictText(kind, moves) });

// The learner's prospects with the learner to move (score for the learner, n discs).
const verdictFor = (score, n) => { const o = outcomeOf(score, n); return makeVerdict(o.kind, o.moves); };

// Right after the learner played a move scoring `score` at n discs: one of the
// learner's moves is now used up.
function verdictAfterMove(score, n) {
  const o = outcomeOf(score, n);
  return makeVerdict(o.kind, o.kind === 'win' && o.moves ? o.moves - 1 : o.moves);
}

function bestScore(scores) {
  let best = -Infinity;
  for (const v of scores) if (finite(v) && v > best) best = v;
  return best;
}

// The coach's verdict line already carries the count, so the feedback card
// drops it (it would go stale once the solver has replied).
function withoutCount(text) {
  return text
    .replace(/; the solver wins in \d+ moves?\./, '.')
    .replace(/ in \d+ moves?(?=[.,])/g, '');
}

const learnerTurn = (st = shownState()) =>
  S.mode === 'train' && S.screen === 'game' && !st.over && st.turn === T.human && T.review === null && !busy && sameMoves(shown.moves, S.moves);

function clearTrainNotes() {
  view.clearNotes();
  T.line = null;
  T.note = '';
}

function resetTrainingLog(base = 0) {
  T.log = [];
  T.base = base;
  T.hintLevel = 0;
  T.hintBusy = false;
  T.line = null;
  T.review = null;
  T.note = '';
  T.recorded = null;
  T.lastResult = null;
  T.verdict = null;
  T.prefetch = null;
  T.reviewStamp = '';
}

async function startTraining() {
  const my = ++nav;
  sound.unlock();
  stopOnline();
  cancelComputer();
  await stopDemo();
  if (my !== nav) return;
  S.mode = 'train';
  T.human = 1;
  S.first = T.starter === 'solver' ? 2 : 1;
  S.gameId++;
  S.moves = [];
  S.scores = { 1: 0, 2: 0, draw: 0 };
  presented = null;
  resetTrainingLog();
  setScreen('game');
  focusBoard();
  reconcile();
}

function newTrainingGame() {
  exitReview(true);
  cancelComputer();
  resetSolver();
  T.human = 1;
  S.first = T.starter === 'solver' ? 2 : 1;
  S.gameId++;
  S.moves = [];
  presented = null;
  resetTrainingLog();
  view.clearNotes();
  reconcile();
}

// The learner's turn: work out the position so grading is instant.
async function trainTurn() {
  const st = shownState();
  if (!learnerTurn(st)) { renderCoach(); return; }
  const key = movesKey(S.moves);
  const scores = await ensureAnalysis(S.moves);
  if (S.mode !== 'train' || movesKey(S.moves) !== key) return;
  if (scores) {
    const b = bestScore(scores);
    if (finite(b)) T.verdict = verdictFor(b, S.moves.length);
  }
  if (T.note === 'Working out the values') T.note = '';
  renderCoach();
}

async function trainMove(c) {
  const before = S.moves.slice();
  clearTrainNotes();
  T.hintLevel = 0;
  const entry = { at: before.length, move: c, scores: null, result: null, pending: true };
  T.log.push(entry);
  S.moves = [...before, c];
  // Start on the solver's reply while the disc falls.
  const after = replay(S.moves, S.first);
  if (after && !after.over) T.prefetch = { key: movesKey(S.moves), promise: solverAsk('botMove', S.moves.slice()).catch(() => null) };
  reconcile();
  const scores = await ensureAnalysis(before);
  if (!T.log.includes(entry)) return;
  entry.pending = false;
  entry.scores = scores;
  if (scores && finite(scores[c])) {
    entry.result = grade(before, S.first, T.human, c, scores);
    T.verdict = verdictAfterMove(scores[c], before.length);
  }
  renderCoach();
}

// The solver's reply in training: from the prefetch when it matches.
async function solverReply(moves, req) {
  const key = movesKey(moves);
  const stale = () => req !== S.aiReq;
  const pf = T.prefetch;
  let r = null;
  if (pf && pf.key === key) r = await pf.promise;
  // Taken back, new game or left: the question no longer matters, so it is
  // not asked again (that would block the fresh worker).
  if (stale()) return -1;
  if (!r) { try { r = await solverAsk('botMove', moves.slice()); } catch { r = null; } }
  if (stale()) return -1;
  if (T.prefetch === pf) T.prefetch = null;
  if (r && r.col >= 0) return r.col;
  // The solver could not answer: the strongest of the other computer players stands in.
  return askComputer(moves.slice(), S.first, 'hard');
}

// The solver has picked its move: its best move keeps the outcome, so the
// verdict only loses one of its moves; and the next analysis can start now.
function solverMoved(col) {
  clearTrainNotes();
  const v = T.verdict;
  if (v && v.kind === 'loss' && v.moves) T.verdict = makeVerdict('loss', v.moves - 1);
  const next = S.moves.concat(col);
  const st = replay(next, S.first);
  if (st && !st.over) ensureAnalysis(next);
}

function canTakeBack() {
  if (S.mode !== 'train' || T.review !== null) return false;
  for (let i = S.moves.length - 1; i >= (T.base || 0); i--) {
    if ((i % 2 === 0 ? S.first : 3 - S.first) === T.human) return true;
  }
  return false;
}

function takeBack() {
  if (!canTakeBack()) return;
  let i = S.moves.length - 1;
  while (i >= 0 && (i % 2 === 0 ? S.first : 3 - S.first) !== T.human) i--;
  cancelComputer();
  resetSolver();
  S.moves = S.moves.slice(0, i);
  T.log = T.log.filter((e) => e.at < i);
  T.recorded = null;
  T.hintLevel = 0;
  clearTrainNotes();
  const scores = T.analyses.get(movesKey(S.moves));
  if (scores && finite(bestScore(scores))) T.verdict = verdictFor(bestScore(scores), S.moves.length);
  reconcile();
}

// Grades a move with the coach. If any score is win / draw / loss only, the
// coach sees it as the slowest win or loss and the counts are left out.
function grade(moves, first, human, move, scores, opts = {}) {
  const rough = scores.some((v) => finite(v) && classOnly(v));
  const input = cleanScores(scores).map((v) => (v !== null && classOnly(v) ? Math.sign(v) : v));
  let r;
  try {
    r = coach.gradeMove({ moves, first, human, move, scores: input, ...opts });
  } catch (err) {
    console.warn('coach', err);
    return null;
  }
  if (rough && r && opts.reveal !== false) {
    const best = r.bestCols.map((c) => colName(c)).join(' or ');
    const Best = best[0].toUpperCase() + best.slice(1);
    const lines = { win: 'You can still force a win.', draw: 'The game stays level.', loss: 'Every move loses here.' };
    if (r.grade === 'best' || r.grade === 'good') r.detail = lines[r.outcomeAfter] || '';
    else if (r.outcomeBefore === 'win' && r.outcomeAfter === 'draw') r.detail = `${Best} kept the win.`;
    else if (r.outcomeBefore === 'draw') r.detail = `The solver can now force a win. ${Best} kept it level.`;
    else r.detail = `${Best} was the move. The solver can now force a win.`;
    r.movesToEnd = null;
  }
  return r;
}

async function giveHint() {
  const st = shownState();
  if (!learnerTurn(st) || T.hintBusy || T.hintLevel >= 2) return;
  T.hintBusy = true;
  const moves = S.moves.slice();
  if (!T.analyses.has(movesKey(moves))) { T.note = 'Working it out'; renderCoach(); }
  const scores = await ensureAnalysis(moves);
  T.hintBusy = false;
  if (T.note === 'Working it out') T.note = '';
  if (!scores || movesKey(S.moves) !== movesKey(moves) || !learnerTurn()) return;
  T.hintLevel += 1;
  let h;
  try {
    h = coach.hint({ moves, first: S.first, human: T.human, level: T.hintLevel,
      scores: cleanScores(scores).map((v) => (v !== null && classOnly(v) ? Math.sign(v) : v)) });
  } catch (err) {
    console.warn('coach', err);
    return;
  }
  T.note = h.text;
  if (T.hintLevel >= 2 && h.cols?.length) view.showMarks(h.cols.map((c) => [c, st.heights[c]]), 'note-best');
  renderCoach();
}

// W / D / L tags on the square each column would land on.
function renderValues() {
  const reviewing = T.review !== null;
  const entry = reviewing ? T.log[T.review] : null;
  const moves = reviewing ? S.moves.slice(0, entry.at) : S.moves;
  const st = replay(moves, S.first);
  const scores = reviewing ? entry.scores : T.analyses.get(movesKey(S.moves));
  const show = S.mode === 'train' && !T.line && (reviewing || (T.showValues && learnerTurn())) && scores && st && !st.over;
  if (!show) { view.showTags([]); return; }
  const best = bestScore(scores);
  const items = [];
  for (let c = 0; c < 7; c++) {
    if (st.heights[c] >= 6) continue;
    const v = scores[c];
    if (!finite(v)) { items.push({ col: c, row: st.heights[c], label: '?', kind: 'unknown' }); continue; }
    const o = outcomeOf(v, moves.length);
    const label = o.kind === 'win' ? `W${o.moves ?? ''}` : o.kind === 'loss' ? `L${o.moves ?? ''}` : 'D';
    items.push({ col: c, row: st.heights[c], label, kind: o.kind, best: v === best });
  }
  view.showTags(items);
}

// Best play from both sides as numbered discs, worked out a few moves at a time.
async function toggleLine() {
  if (S.mode !== 'train') return;
  if (T.line) {
    T.line = null;
    T.note = '';
    view.showGhosts([]);
    renderCoach();
    return;
  }
  const reviewing = T.review !== null;
  if (!reviewing && !learnerTurn()) return;
  const base = reviewing ? S.moves.slice(0, T.log[T.review].at) : S.moves.slice();
  const st = replay(base, S.first);
  if (!st || st.over) return;
  const token = { base: movesKey(base) };
  T.line = token;
  T.note = 'Working out the best line';
  renderCoach();
  const total = 16;
  let line = [];
  let shownCount = 0;
  while (line.length < total) {
    let r;
    try {
      r = await solverAsk('line', base.concat(line), { plies: line.length ? 4 : 6 }, 30000);
    } catch {
      break;
    }
    if (T.line !== token) return;
    if (!r.line.length) break;
    line = line.concat(r.line).slice(0, total);
    shownCount = drawLine(base, st, line, shownCount);
    const end = replay(base.concat(line), S.first);
    if (!end || end.over) break;
  }
  if (T.line !== token) return;
  if (!line.length) { T.line = null; T.note = ''; renderCoach(); return; }
  const end = replay(base.concat(line), S.first);
  if (end && end.winner) {
    const who = end.winner === T.human ? 'you make' : 'the solver makes';
    T.note = `The numbers show best play from both sides: ${who} four with disc ${line.length}.`;
  } else if (end && end.draw) {
    T.note = 'The numbers show best play from both sides. The board fills up: a draw.';
  } else {
    T.note = `The numbers show the next ${line.length} moves of best play from both sides.`;
  }
  renderCoach();
}

function drawLine(base, st, line, alreadyShown) {
  const heights = Array.from(st.heights);
  let p = st.turn;
  const items = line.map((c, k) => {
    const it = { col: c, row: heights[c]++, player: p, n: k + 1 };
    p = 3 - p;
    return it;
  });
  const end = replay(base.concat(line), S.first);
  view.showGhosts(items, end && end.winner ? end.lines : null, end ? end.winner : 0, alreadyShown);
  renderValues();
  return items.length;
}

function recordTraining(st) {
  if (T.recorded === shown.key) return;
  T.recorded = shown.key;
  const p = progress();
  const t = p.train;
  t.games++;
  if (st.winner === T.human) t.wins++; else if (st.winner) t.losses++; else t.draws++;
  const graded = T.log.filter((e) => e.result);
  if (graded.length) {
    const kept = graded.filter((e) => e.result.grade === 'best' || e.result.grade === 'good').length;
    t.bestAccuracy = Math.max(t.bestAccuracy || 0, Math.round((100 * kept) / graded.length));
  }
  saveProgress(p);
}

function enterReview(i) {
  const e = T.log[i];
  if (!e) return;
  T.review = i;
  T.line = null;
  T.note = '';
  const base = S.moves.slice(0, e.at);
  const st = replay(base, S.first);
  view.setPosition(st);
  view.clearNotes();
  if (e.result?.bestCols?.length) view.showMarks(e.result.bestCols.map((c) => [c, st.heights[c]]), 'note-best');
  view.showMarks([[e.move, st.heights[e.move]]], 'note-mark');
  refresh();
  if (narrow.matches) $('#rig').scrollIntoView({ block: 'start', behavior: view.reduced ? 'auto' : 'smooth' });
}

function exitReview(silent = false) {
  if (T.review === null) return;
  const i = T.review;
  T.review = null;
  T.line = null;
  T.note = '';
  view.clearNotes();
  const st = shownState();
  view.setPosition(st);
  if (st.winner) view.showWin(st.lines, st.winner, true);
  if (!silent) {
    refresh();
    $$('.review-item')[i]?.focus({ preventScroll: true });
  }
}

function gradeLine(el, result, prefix = '') {
  el.className = `grade ${result ? result.grade : 'neutral'}`;
  el.textContent = prefix + (result ? result.title : '');
}

// Buttons that are only briefly unavailable keep focus: aria-disabled, and the
// handlers check for themselves.
function setAvailable(el, on) {
  el.setAttribute('aria-disabled', String(!on));
}

function renderCoach() {
  if (S.mode !== 'train' || S.screen !== 'game') return;
  const st = shownState();
  const reviewing = T.review !== null;
  const entry = reviewing ? T.log[T.review] : T.log[T.log.length - 1];
  const over = st.over && sameMoves(shown.moves, S.moves);

  let v = T.verdict;
  if (reviewing && entry.scores && finite(bestScore(entry.scores))) v = verdictFor(bestScore(entry.scores), entry.at);
  if (over && !reviewing) v = makeVerdict(st.winner === T.human ? 'win' : st.winner ? 'loss' : 'draw', 0);
  const ended = Boolean(v && v.moves === 0);
  $('#verdict').className = `verdict ${v ? v.kind : 'pending'}`;
  $('#verdict-label').textContent = ended ? 'Game over' : 'With perfect play from here';
  $('#verdict-text').textContent = v ? v.text : 'Working it out';

  const fb = $('#feedback');
  fb.classList.toggle('empty', !entry);
  if (entry) {
    const prefix = reviewing ? `Move ${entry.at + 1}, ${colName(entry.move)}: ` : '';
    if (entry.result) {
      gradeLine($('#fb-grade'), entry.result, prefix);
      $('#fb-text').textContent = entry.result.text;
      $('#fb-detail').textContent = reviewing ? entry.result.detail : withoutCount(entry.result.detail);
    } else {
      gradeLine($('#fb-grade'), null, prefix);
      $('#fb-grade').textContent = prefix + (entry.pending ? 'Checking your move' : 'This move could not be checked in time');
      $('#fb-text').textContent = '';
      $('#fb-detail').textContent = '';
    }
  }

  const noteEl = $('#coach-note');
  if (noteEl.textContent !== T.note) {
    noteEl.textContent = T.note;
    if (T.note && narrow.matches) {
      requestAnimationFrame(() => noteEl.scrollIntoView({ block: 'nearest', behavior: view.reduced ? 'auto' : 'smooth' }));
    }
  }
  const turn = learnerTurn(st);
  setAvailable($('#btn-hint'), turn && T.hintLevel < 2 && !T.hintBusy);
  $('#btn-values').setAttribute('aria-pressed', String(T.showValues || reviewing));
  setAvailable($('#btn-values'), !reviewing && !over);
  $('#values-legend').hidden = !((T.showValues && !over) || reviewing);
  $('#btn-line').setAttribute('aria-pressed', String(Boolean(T.line)));
  setAvailable($('#btn-line'), Boolean(T.line) || reviewing || turn);
  setAvailable($('#btn-takeback'), canTakeBack());

  $('#review').hidden = !over;
  if (over) renderReview();
  renderValues();
}

function renderReview() {
  const graded = T.log.filter((e) => e.result);
  const kept = graded.filter((e) => e.result.grade === 'best' || e.result.grade === 'good').length;
  const counts = { best: 0, good: 0, mistake: 0, blunder: 0 };
  for (const e of graded) counts[e.result.grade]++;
  let head = graded.length
    ? `${kept} of your ${plural(graded.length, 'move')} ${kept === 1 ? 'was' : 'were'} best or good.`
    : 'No moves to review.';
  const slips = [counts.mistake && plural(counts.mistake, 'mistake'), counts.blunder && plural(counts.blunder, 'blunder')].filter(Boolean);
  if (graded.length) head += slips.length ? ` ${slips.join(' and ')}. Pick a move to see it again.` : ' No mistakes.';
  $('#review-head').textContent = head;
  $('#review-exit').hidden = T.review === null;
  const list = $('#review-list');
  // Rebuild only when the moves change, so focus and hover stay put.
  const stamp = T.log.map((e) => `${e.at}:${e.move}:${e.result ? e.result.grade : '-'}`).join(',');
  if (T.reviewStamp !== stamp || list.children.length !== T.log.length) {
    T.reviewStamp = stamp;
    list.replaceChildren(...T.log.map((e, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'review-item';
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `Move ${e.at + 1}`;
      const what = document.createElement('span');
      what.textContent = ColName(e.move);
      const g = document.createElement('span');
      g.className = `grade ${e.result ? e.result.grade : 'neutral'}`;
      g.textContent = e.result ? e.result.title : 'Not checked';
      b.append(when, what, g);
      b.addEventListener('click', () => enterReview(i));
      li.append(b);
      return li;
    }));
  }
  [...list.querySelectorAll('.review-item')].forEach((b, i) => {
    if (T.review === i) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
}

// ---------------------------------------------------------------- lessons and puzzles

function progress() {
  const p = store.get('progress', null) || {};
  return {
    lessons: p.lessons || {},
    puzzles: p.puzzles || {},
    train: { games: 0, wins: 0, draws: 0, losses: 0, bestAccuracy: 0, ...(p.train || {}) },
  };
}

function saveProgress(p) { store.set('progress', p); }

const STARTER_NOTES = {
  you: 'Moving first, perfect play wins. One slip and the solver will take over.',
  solver: 'The solver opens in the middle and wins with perfect play. Hold out as long as you can.',
};

function renderHomeTraining() {
  $('#starter-note').textContent = STARTER_NOTES[S.train.starter] || STARTER_NOTES.you;
  const p = progress();
  const lessonsDone = LESSONS.filter((l) => p.lessons[l.id]).length;
  const puzzlesDone = PUZZLES.filter((z) => p.puzzles[z.id]).length;
  const parts = [];
  if (lessonsDone) parts.push(`${lessonsDone} of ${LESSONS.length} lessons done.`);
  if (puzzlesDone) parts.push(`${puzzlesDone} of ${PUZZLES.length} puzzles solved.`);
  if (p.train.games) parts.push(`Best accuracy against the solver: ${p.train.bestAccuracy}%.`);
  $('#progress-line').textContent = parts.join(' ');
}

function renderLearn() {
  if (S.screen !== 'learn') return;
  const p = progress();
  const list = $('#lesson-list');
  if (!list.children.length || list.dataset.stamp !== JSON.stringify(p.lessons)) {
    list.dataset.stamp = JSON.stringify(p.lessons);
    list.replaceChildren(...LESSONS.map((l, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lesson-item';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'lesson-name';
      name.textContent = l.title;
      const done = document.createElement('span');
      done.className = 'done';
      done.textContent = p.lessons[l.id] ? 'Done' : '';
      b.append(num, name, done);
      b.addEventListener('click', () => startTask('lesson', i, 0));
      li.append(b);
      return li;
    }));
  }
  const solved = PUZZLES.filter((z) => p.puzzles[z.id]).length;
  $('#puzzle-progress').textContent = solved
    ? `${solved} of ${PUZZLES.length} solved. Each one has a single right move.`
    : `${PUZZLES.length} positions, each with a single right move. They get harder as you go.`;
  $('#start-puzzles').textContent = solved && solved < PUZZLES.length ? 'Continue puzzles' : 'Start puzzles';
}

async function openLearn() {
  ++nav;
  cancelComputer();
  stopOnline();
  resetSolver();
  S.task = null;
  view.clearNotes();
  if (S.mode !== 'demo') {
    S.mode = 'demo';
    S.gameId++;
    S.moves = [];
    S.screen = 'learn';
    app.dataset.screen = 'learn';
    runDemo();
  }
  setScreen('learn');
  $('#learn-title').focus({ preventScroll: true });
}

const toMoves = (str) => Array.from(String(str || ''), Number);

function puzzlePrompt(z) {
  const side = z.you === 1 ? 'Brass' : 'Pearl';
  return z.kind === 'win'
    ? `${side} to move. Find the winning move.`
    : `${side} to move. Find the only move that does not lose.`;
}

async function startTask(kind, i, j = 0) {
  const my = ++nav;
  sound.unlock();
  cancelComputer();
  await stopDemo();
  if (my !== nav) return;
  let t;
  if (kind === 'lesson') {
    const L = LESSONS[i];
    const k = L.tasks[j];
    t = {
      kind, i, j, id: L.id, title: L.title, intro: L.intro || [], heat: Boolean(L.heat) && j === 0,
      prompt: k.prompt, accept: k.accept, solution: k.solution, right: k.right || '', wrong: k.wrong || '',
      marks: k.marks || [], moves: toMoves(k.moves), first: k.first, you: k.you, scores: null,
      count: `Lesson ${i + 1} of ${LESSONS.length}, task ${j + 1} of ${L.tasks.length}`,
    };
  } else {
    const z = PUZZLES[i];
    t = {
      kind, i, id: z.id, title: z.title, intro: [], heat: false, prompt: puzzlePrompt(z),
      accept: [z.solution], solution: z.solution, right: '', wrong: '', marks: [],
      moves: toMoves(z.moves), first: z.first, you: z.you, scores: Array.isArray(z.scores) ? z.scores : null,
      count: `Puzzle ${i + 1} of ${PUZZLES.length}, level ${z.level}`,
    };
  }
  t.answered = false;
  t.correct = false;
  t.feedback = null;
  t.answerShown = false;
  t.attempt = 0;
  S.task = t;
  S.mode = 'task';
  S.first = t.first;
  S.moves = t.moves.slice();
  S.gameId++;
  presented = null;
  setScreen('task');
  $('#task-title').focus({ preventScroll: true });
  reconcile();
  // Lessons have no stored scores: work them out while the learner reads, so
  // the explanation of an answer is ready at once.
  if (!t.scores) ensureAnalysis(t.moves);
}

// Heat numbers on empty squares, the lesson's marked squares, and the answer
// ring until the learner answers.
function decorateTask() {
  const t = S.task;
  if (!t) return;
  view.clearNotes();
  const st = shownState();
  if (t.heat) view.showHeat(coach.lineCountsPerCell(), st.cells);
  if (t.marks.length) view.showMarks(t.marks, 'note-mark');
  if (t.answerShown && !t.answered) {
    const base = replay(t.moves, t.first);
    view.showMarks([[t.solution, base.heights[t.solution]]], 'note-best');
  }
}

const unique = (parts) => [...new Set(parts.filter(Boolean))].join(' ');

async function taskMove(c) {
  const t = S.task;
  if (!t || t.answered) return;
  const attempt = ++t.attempt;
  t.answered = true;
  t.correct = t.accept.includes(c);
  t.played = c;
  S.moves = [...t.moves, c];
  t.feedback = {
    grade: t.correct ? 'best' : 'mistake',
    title: t.correct ? 'Correct' : 'Not this one',
    text: t.correct ? t.right : t.wrong,
  };
  if (t.correct) {
    const p = progress();
    if (t.kind === 'puzzle') p.puzzles[t.id] = true;
    else if (t.j === LESSONS[t.i].tasks.length - 1) p.lessons[t.id] = true;
    saveProgress(p);
  }
  renderTask();
  reconcile();
  // The solver explains the move: why it works, or what it allows. A wrong
  // answer gets the reason without the right column, so a retry still counts.
  if (t.kind !== 'puzzle' && t.correct) return;
  const base = t.feedback.text;
  const scores = t.scores || await ensureAnalysis(t.moves);
  if (S.task !== t || t.attempt !== attempt || !t.feedback || !scores) return;
  const r = grade(t.moves, t.first, t.you, c, scores, t.correct ? {} : { reveal: false });
  if (!r) return;
  t.feedback.text = unique([base, r.text, r.detail]);
  renderTask();
}

function retryTask() {
  const t = S.task;
  if (!t || !t.answered || t.correct) return;
  t.answered = false;
  t.feedback = null;
  S.moves = t.moves.slice();
  presented = null;
  renderTask();
  reconcile();
  focusBoard();
}

function showAnswer() {
  const t = S.task;
  if (!t || t.answered) return;
  t.answerShown = true;
  t.feedback = { grade: 'neutral', title: 'Answer', text: unique([`${ColName(t.solution)}.`, t.right]) };
  decorateTask();
  renderTask();
}

function nextTask() {
  const t = S.task;
  if (!t) return;
  if (t.kind === 'lesson') {
    const L = LESSONS[t.i];
    if (t.j + 1 < L.tasks.length) startTask('lesson', t.i, t.j + 1);
    else if (t.i + 1 < LESSONS.length) startTask('lesson', t.i + 1, 0);
    else openLearn();
  } else {
    const p = progress();
    let k = PUZZLES.findIndex((z, n) => n > t.i && !p.puzzles[z.id]);
    if (k < 0) k = PUZZLES.findIndex((z) => !p.puzzles[z.id]);
    if (k < 0) k = (t.i + 1) % PUZZLES.length;
    startTask('puzzle', k);
  }
}

function startPuzzles() {
  const p = progress();
  let k = PUZZLES.findIndex((z) => !p.puzzles[z.id]);
  if (k < 0) k = 0;
  startTask('puzzle', k);
}

const taskOver = (t) => { const st = replay(S.moves, t.first); return !st || st.over; };

// Keep playing the puzzle position against the solver, with coaching.
function playItOut() {
  const t = S.task;
  if (!t || !t.answered || !t.correct || taskOver(t)) return;
  ++nav;
  const moves = S.moves.slice();
  const scores = t.scores || T.analyses.get(movesKey(t.moves));
  S.task = null;
  S.mode = 'train';
  T.human = t.you;
  S.first = t.first;
  S.gameId++;
  S.moves = moves;
  S.scores = { 1: 0, 2: 0, draw: 0 };
  resetTrainingLog(t.moves.length);
  if (scores && finite(scores[t.played])) T.verdict = verdictAfterMove(scores[t.played], t.moves.length);
  view.clearNotes();
  shown = { key: target().key, first: S.first, moves: moves.slice() };
  presented = null;
  setScreen('game');
  focusBoard();
  settled();
}

function renderTask() {
  const t = S.task;
  if (!t || S.screen !== 'task') return;
  $('#task-count').textContent = t.count;
  $('#task-title').textContent = t.title;
  const intro = $('#task-intro');
  const paras = t.kind === 'lesson' && t.j === 0 ? t.intro : [];
  if (intro.dataset.key !== `${t.kind}${t.i}:${t.j}`) {
    intro.dataset.key = `${t.kind}${t.i}:${t.j}`;
    intro.replaceChildren(...paras.map((text) => { const p = document.createElement('p'); p.textContent = text; return p; }));
  }
  $('#task-prompt').textContent = t.prompt;
  const fb = $('#task-feedback');
  fb.classList.toggle('empty', !t.feedback);
  if (t.feedback) {
    $('#task-grade').className = `grade ${t.feedback.grade}`;
    $('#task-grade').textContent = t.feedback.title;
    $('#task-text').textContent = t.feedback.text || '';
  }
  const last = t.kind === 'lesson' && t.j === LESSONS[t.i].tasks.length - 1;
  $('#task-next').hidden = !(t.answered && t.correct);
  $('#task-next').textContent = t.kind === 'puzzle' ? 'Next puzzle'
    : last ? (t.i + 1 < LESSONS.length ? 'Next lesson' : 'Back to lessons') : 'Next';
  $('#task-retry').hidden = !(t.answered && !t.correct);
  $('#task-show').hidden = t.answered || t.answerShown;
  $('#task-play').hidden = !(t.answered && t.correct && !taskOver(t));
  $('#task-back').textContent = t.kind === 'lesson' ? 'Lessons' : 'Back';
}

// ---------------------------------------------------------------- online

const inviteUrl = (code) => `${location.origin}${location.pathname}#room=${code}`;

function setHash(code) {
  history.replaceState(null, '', `${location.pathname}${location.search}#room=${code}`);
}

async function startOnline({ code, role, myId, saved }) {
  const my = ++nav;
  stopOnline();
  cancelComputer();
  await stopDemo();
  if (my !== nav) return;
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
  if (S.mode !== 'demo') goHome(); else setScreen('home');
}

// ---------------------------------------------------------------- wiring

function toggleGroup(name, forceOpen = false) {
  for (const g of ['ai', 'train', 'online']) {
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
$('#m-train').addEventListener('click', () => { toggleGroup('train'); solverAsk('warm', []).catch(() => {}); renderHomeTraining(); });
document.querySelectorAll('input[name="starter"]').forEach((r) => {
  r.addEventListener('change', () => { if (r.checked) { S.train.starter = r.value; store.set('starter', r.value); renderHomeTraining(); } });
});
$('#start-train').addEventListener('click', () => startTraining());
$('#open-lessons').addEventListener('click', () => openLearn());
$('#open-puzzles').addEventListener('click', () => startPuzzles());
$('#start-puzzles').addEventListener('click', () => startPuzzles());
$('#learn-back').addEventListener('click', () => goHome());
$('#btn-hint').addEventListener('click', () => giveHint());
$('#btn-values').addEventListener('click', () => {
  if ($('#btn-values').getAttribute('aria-disabled') === 'true') return;
  S.train.showValues = !S.train.showValues;
  store.set('values', S.train.showValues);
  const pending = S.mode === 'train' && !S.train.analyses.has(S.moves.join(''));
  if (S.train.showValues && pending) S.train.note = 'Working out the values';
  else if (S.train.note === 'Working out the values') S.train.note = '';
  renderCoach();
});
$('#btn-line').addEventListener('click', () => toggleLine());
$('#btn-takeback').addEventListener('click', () => takeBack());
$('#review-exit').addEventListener('click', () => exitReview());
$('#task-next').addEventListener('click', () => nextTask());
$('#task-retry').addEventListener('click', () => retryTask());
$('#task-show').addEventListener('click', () => showAnswer());
$('#task-play').addEventListener('click', () => playItOut());
$('#task-back').addEventListener('click', () => leave());
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
  if (S.screen !== 'game' && S.screen !== 'task') return;
  if (/^[1-7]$/.test(e.key)) {
    e.preventDefault();
    const c = Number(e.key) - 1;
    view.moveHover(c);
    humanDrop(c);
  } else if (e.key === 'u' || e.key === 'U') {
    if (S.mode === 'train') takeBack(); else undo();
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
    if (S.screen !== 'home' && S.screen !== 'invite') goHome();
    history.replaceState(null, '', `${location.pathname}${location.search}#room=${code}`);
    showInvite(code);
  }
});

function boot() {
  applyMute();
  ($(`#lv-${S.level}`) || $('#lv-normal')).checked = true;
  ($(`#st-${S.train.starter}`) || $('#st-you')).checked = true;
  renderHomeTraining();
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
