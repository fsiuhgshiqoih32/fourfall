// The computer player. Runs as a module worker so searching never blocks the page.
// Negamax with alpha-beta pruning, forced-move detection, a transposition table
// and iterative deepening on a time budget for the hard level.

import { COLS, ROWS, N, WINDOWS } from './game.js';

const ORDER = [3, 2, 4, 1, 5, 0, 6];
const WIN = 100000;
const NEAR_WIN = WIN - 100;
const LIMITS = { easy: 0, normal: 5, hard: 42 };
const HARD_MS = 1000;

const cells = new Uint8Array(N);
const heights = new Uint8Array(COLS);
let filled = 0;

// Zobrist hashing: h1 picks the table slot, h2 checks the entry.
let seed = 0x9e3779b9;
const rnd32 = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) | 0;
};
const Z1 = Int32Array.from({ length: 3 * N }, rnd32);
const Z2 = Int32Array.from({ length: 3 * N }, rnd32);
let h1 = 0, h2 = 0;

const TT_SIZE = 1 << 19, TT_MASK = TT_SIZE - 1;
const ttKey = new Int32Array(TT_SIZE);
const ttVal = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE).fill(-1);
const ttFlag = new Int8Array(TT_SIZE); // 0 exact, 1 lower bound, 2 upper bound
const ttMove = new Int8Array(TT_SIZE).fill(-1);

function play(c, p) {
  const i = c * ROWS + heights[c]++;
  cells[i] = p;
  h1 ^= Z1[p * N + i];
  h2 ^= Z2[p * N + i];
  filled++;
}

function unplay(c) {
  const i = c * ROWS + --heights[c];
  const p = cells[i];
  cells[i] = 0;
  h1 ^= Z1[p * N + i];
  h2 ^= Z2[p * N + i];
  filled--;
}

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// Would dropping in column c make four for player p?
function winsAt(c, p) {
  const r = heights[c];
  if (r >= ROWS) return false;
  for (const [dc, dr] of DIRS) {
    let n = 1;
    for (let s = 1; s < 4; s++) {
      const cc = c + dc * s, rr = r + dr * s;
      if (cc < 0 || cc >= COLS || rr < 0 || rr >= ROWS || cells[cc * ROWS + rr] !== p) break;
      n++;
    }
    for (let s = 1; s < 4; s++) {
      const cc = c - dc * s, rr = r - dr * s;
      if (cc < 0 || cc >= COLS || rr < 0 || rr >= ROWS || cells[cc * ROWS + rr] !== p) break;
      n++;
    }
    if (n >= 4) return true;
  }
  return false;
}

// Static score from p's point of view: open windows and the centre column.
function evaluate(p) {
  const o = 3 - p;
  let s = 0;
  for (let w = 0; w < WINDOWS.length; w += 4) {
    let a = 0, b = 0;
    for (let k = 0; k < 4; k++) {
      const v = cells[WINDOWS[w + k]];
      if (v === p) a++; else if (v === o) b++;
    }
    if (a && b) continue;
    if (a === 3) s += 32; else if (a === 2) s += 6; else if (a === 1) s += 1;
    else if (b === 3) s -= 36; else if (b === 2) s -= 6; else if (b === 1) s -= 1;
  }
  for (let r = 0; r < ROWS; r++) {
    const v = cells[3 * ROWS + r];
    if (v === p) s += 3; else if (v === o) s -= 3;
  }
  return s;
}

let nodes = 0, deadline = Infinity, stopped = false;

function negamax(p, depth, alpha, beta, ply) {
  if ((++nodes & 2047) === 0 && performance.now() > deadline) stopped = true;
  if (stopped) return 0;
  const o = 3 - p;
  for (let k = 0; k < COLS; k++) if (winsAt(ORDER[k], p)) return WIN - ply;
  if (filled >= N) return 0;

  // If the opponent threatens to win, the reply is forced; two threats lose.
  let forced = -1, threats = 0;
  for (let c = 0; c < COLS; c++) if (winsAt(c, o)) { threats++; forced = c; }
  if (threats >= 2) return -(WIN - ply - 1);
  if (depth <= 0) return evaluate(p);

  const slot = h1 & TT_MASK;
  let hint = -1;
  if (ttKey[slot] === h2 && ttDepth[slot] >= 0) {
    hint = ttMove[slot];
    if (ttDepth[slot] >= depth) {
      const v = ttVal[slot], f = ttFlag[slot];
      if (f === 0 || (f === 1 && v >= beta) || (f === 2 && v <= alpha)) return v;
    }
  }

  const alpha0 = alpha;
  let best = -Infinity, bestMove = -1;
  for (let k = -1; k < COLS; k++) {
    let c;
    if (forced >= 0) { if (k > -1) break; c = forced; }
    else if (k === -1) { if (hint < 0) continue; c = hint; }
    else { c = ORDER[k]; if (c === hint) continue; }
    if (heights[c] >= ROWS) continue;
    play(c, p);
    const v = -negamax(o, depth - 1, -beta, -alpha, ply + 1);
    unplay(c);
    if (stopped) return 0;
    if (v > best) { best = v; bestMove = c; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }

  ttKey[slot] = h2;
  ttVal[slot] = best;
  ttDepth[slot] = depth;
  ttMove[slot] = bestMove;
  ttFlag[slot] = best <= alpha0 ? 2 : best >= beta ? 1 : 0;
  return best;
}

const playable = () => ORDER.filter((c) => heights[c] < ROWS);

// Exact score for every legal move (used by the normal level).
function scoreMoves(p, depth) {
  return playable().map((c) => {
    if (winsAt(c, p)) return { c, v: WIN };
    play(c, p);
    const v = -negamax(3 - p, depth - 1, -Infinity, Infinity, 1);
    unplay(c);
    return { c, v };
  });
}

function pickEasy(p) {
  const moves = playable();
  const o = 3 - p;
  const win = moves.find((c) => winsAt(c, p));
  if (win !== undefined && Math.random() < 0.7) return win;
  const block = moves.find((c) => winsAt(c, o));
  if (block !== undefined && Math.random() < 0.55) return block;
  const weights = [1, 2, 3, 4, 3, 2, 1];
  let total = 0;
  for (const c of moves) total += weights[c];
  let x = Math.random() * total;
  for (const c of moves) { x -= weights[c]; if (x <= 0) return c; }
  return moves[0];
}

function pickNormal(p, spread) {
  const scored = scoreMoves(p, LIMITS.normal);
  scored.sort((a, b) => b.v - a.v);
  const top = scored[0];
  if (Math.abs(top.v) >= NEAR_WIN) return top.c;
  const close = scored.filter((m) => m.v >= top.v - spread && m.v > -NEAR_WIN);
  return close[Math.floor(Math.random() * close.length)].c;
}

function pickHard(p) {
  const moves = playable();
  for (const c of moves) if (winsAt(c, p)) return c;
  deadline = performance.now() + HARD_MS;
  stopped = false;
  let order = moves.slice();
  let chosen = order[0];
  const maxDepth = Math.min(LIMITS.hard, N - filled);
  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -Infinity, best = -1, bestV = -Infinity;
    for (const c of order) {
      play(c, p);
      const v = -negamax(3 - p, depth - 1, -Infinity, -alpha, 1);
      unplay(c);
      if (stopped) break;
      if (v > bestV) { bestV = v; best = c; }
      if (v > alpha) alpha = v;
    }
    if (stopped) break;
    chosen = best;
    order = [best, ...order.filter((c) => c !== best)];
    if (Math.abs(bestV) >= NEAR_WIN) break;
  }
  deadline = Infinity;
  stopped = false;
  return chosen;
}

self.onmessage = (e) => {
  const { id, moves, first, level } = e.data;
  cells.fill(0);
  heights.fill(0);
  filled = 0;
  h1 = 0;
  h2 = 0;
  let p = first;
  for (const c of moves) { play(c, p); p = 3 - p; }
  let col = -1;
  if (filled < N) {
    if (level === 'easy') col = pickEasy(p);
    else if (level === 'normal') col = pickNormal(p, 6);
    else col = pickHard(p);
  }
  self.postMessage({ id, col, nodes });
  nodes = 0;
};
