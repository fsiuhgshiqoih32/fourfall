// The perfect solver, in a worker. WebAssembly does the searching (solver/src/lib.rs);
// data/tree.bin holds the bot's precomputed replies for the opening, where a live
// search would take seconds.
//
// Scores are for the player to move: 0 draw, s > 0 the mover wins with their
// (22 - s)-th disc, s < 0 the opponent wins with their (22 - |s|)-th disc.
//
// Messages in:  { id, type: 'analyze' | 'botMove' | 'line' | 'warm', moves: number[] , plies? }
// Messages out: { id, ok: true, ...result } or { id, ok: false, error }

const PREFERENCE = [3, 2, 4, 1, 5, 0, 6];
const CELLS = 42;
const LIMIT_COLUMN = 60e6;   // nodes per column before giving up on an exact score
const LIMIT_MOVE = 150e6;

let wasm = null;
let tree = null;
const cache = new Map();

// Both downloads give up after 20 s. The tree is optional: without it the
// opening is searched live, just more slowly.
const timeout = () => (typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(20000) } : {});
const ready = (async () => {
  const [wasmBytes, treeBytes] = await Promise.all([
    fetch(new URL('./solver.wasm', import.meta.url), timeout()).then((r) => { if (!r.ok) throw new Error('solver.wasm ' + r.status); return r.arrayBuffer(); }),
    fetch(new URL('../data/tree.bin', import.meta.url), timeout()).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  wasm = instance.exports;
  if (treeBytes) tree = parseTree(treeBytes);
})();

function parseTree(buf) {
  const head = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...head) !== 'FFT1') return null;
  const count = new DataView(buf).getUint32(4, true);
  return {
    count,
    keys: new Float64Array(buf, 8, count),
    moves: new Uint8Array(buf, 8 + count * 8, count),
    vals: new Int8Array(buf, 8 + count * 9, count),
  };
}

// Bitboard key (current player's discs + all discs), and the mirror image's key,
// computed with exact integer arithmetic on doubles (keys stay below 2^50).
function keysOf(moves) {
  const heights = [0, 0, 0, 0, 0, 0, 0];
  const toMove = moves.length % 2;
  let cur = 0, mask = 0, mcur = 0, mmask = 0;
  for (let i = 0; i < moves.length; i++) {
    const c = moves[i];
    const r = heights[c]++;
    const v = 2 ** (c * 7 + r);
    const mv = 2 ** ((6 - c) * 7 + r);
    mask += v;
    mmask += mv;
    if (i % 2 === toMove) { cur += v; mcur += mv; }
  }
  return [cur + mask, mcur + mmask];
}

function treeLookup(moves) {
  if (!tree) return null;
  const [k, mk] = keysOf(moves);
  const key = Math.min(k, mk);
  let lo = 0, hi = tree.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = tree.keys[mid];
    if (v === key) {
      const stored = tree.moves[mid];
      return { col: k <= mk ? stored : 6 - stored, score: tree.vals[mid] };
    }
    if (v < key) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

// --- tiny rules helpers (same board layout as js/game.js) ---
function board(moves) {
  const cells = new Uint8Array(42);
  const heights = new Uint8Array(7);
  for (let i = 0; i < moves.length; i++) {
    const c = moves[i];
    cells[c * 6 + heights[c]++] = (i % 2) + 1;
  }
  return { cells, heights };
}

function makesFour(cells, heights, c, p) {
  const r = heights[c];
  if (r >= 6) return false;
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let n = 1;
    for (const s of [1, -1]) {
      for (let k = 1; k < 4; k++) {
        const cc = c + dc * k * s, rr = r + dr * k * s;
        if (cc < 0 || cc > 6 || rr < 0 || rr > 5 || cells[cc * 6 + rr] !== p) break;
        n++;
      }
    }
    if (n >= 4) return true;
  }
  return false;
}

function writeMoves(moves) {
  new Uint8Array(wasm.memory.buffer, wasm.moves_ptr(), 64).set(moves);
  return moves.length;
}

function liveSolve(moves, limit) {
  const v = wasm.solve(writeMoves(moves), 0, limit);
  if (v === 1000) throw new Error('bad position');
  return v === 1001 ? null : v;
}

// Scores of every column for the player to move. null = full column; undefined
// would never be returned: a column the search gave up on is NaN.
function analyze(moves) {
  const key = moves.join('');
  if (cache.has(key)) return cache.get(key);
  const { cells, heights } = board(moves);
  const n = moves.length;
  const mover = (n % 2) + 1;
  const scores = new Array(7).fill(null);
  let exact = true;
  for (const c of PREFERENCE) {
    if (heights[c] >= 6) continue;
    if (makesFour(cells, heights, c, mover)) { scores[c] = Math.floor((CELLS + 1 - n) / 2); continue; }
    if (n + 1 >= CELLS) { scores[c] = 0; continue; }
    const child = moves.concat(c);
    const t = treeLookup(child);
    if (t) { scores[c] = -t.score; continue; }
    const v = liveSolve(child, LIMIT_COLUMN);
    if (v === null) { scores[c] = NaN; exact = false; } else scores[c] = -v;
  }
  const result = { scores, exact };
  if (exact) cache.set(key, result);
  return result;
}

function bestOf(scores) {
  let col = -1, best = -Infinity;
  for (const c of PREFERENCE) {
    const s = scores[c];
    if (s !== null && !Number.isNaN(s) && s > best) { best = s; col = c; }
  }
  return { col, score: best };
}

function botMove(moves) {
  // Opening the game: the middle column is the only winning first move.
  if (moves.length === 0) return { col: 3, score: 1, source: 'theory' };
  const t = treeLookup(moves);
  if (t) return { col: t.col, score: t.score, source: 'book' };
  const { scores, exact } = analyze(moves);
  let { col, score } = bestOf(scores);
  if (col < 0) {
    // Nothing finished in time: fall back to a quick win / draw / loss search.
    const n = writeMoves(moves);
    if (wasm.analyze(n, 1, LIMIT_MOVE) === 0) {
      const out = Array.from(new Int32Array(wasm.memory.buffer, wasm.out_ptr(), 7)).map((v) => (v === 100 ? null : v));
      ({ col, score } = bestOf(out));
    }
  }
  if (col < 0) col = PREFERENCE.find((c) => board(moves).heights[c] < 6);
  return { col, score, source: exact ? 'search' : 'partial' };
}

// The best line from a position: both sides play their best move.
function line(moves, plies) {
  const out = [];
  const m = moves.slice();
  for (let i = 0; i < plies; i++) {
    if (m.length >= CELLS) break;
    const { cells, heights } = board(m);
    const mover = (m.length % 2) + 1;
    const win = PREFERENCE.find((c) => heights[c] < 6 && makesFour(cells, heights, c, mover));
    if (win !== undefined) { out.push(win); break; }
    const t = treeLookup(m);
    const col = t ? t.col : bestOf(analyze(m).scores).col;
    if (col < 0) break;
    out.push(col);
    m.push(col);
  }
  return out;
}

self.onmessage = async (e) => {
  const { id, type, moves = [], plies = 12 } = e.data;
  try {
    await ready;
    let result;
    if (type === 'analyze') result = analyze(moves);
    else if (type === 'botMove') result = botMove(moves);
    else if (type === 'line') result = { line: line(moves, plies) };
    else if (type === 'warm') result = { tree: tree ? tree.count : 0 };
    else throw new Error('unknown request');
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
