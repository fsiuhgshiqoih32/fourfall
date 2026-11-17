#!/usr/bin/env node
// Builds the training puzzle bank in js/puzzles.js.
//
// It plays practice games with the perfect solver (the native c4 CLI from
// solver/), mostly picking best moves with some random choices and the odd
// mistake, and keeps positions where the player to move has exactly one
// correct column:
//   win  - exactly one column wins (the others draw or lose)
//   save - the best result is a draw, exactly one column keeps it, every other
//          column loses
// Positions that are not a real choice are left out (see classify): fewer than
// four open columns, a forced block, a win in 1 that is also the block, all but
// one wrong column handing over an immediate four, or a save whose wrong
// columns mostly lose only at the very end. At most one puzzle per game and
// level, at most two per game.
// Every number written to js/puzzles.js comes straight from solver scores.
//
// Usage:
//   node tools/make-puzzles.mjs [--games 220] [--seed 20261117] [--jobs 2]
//                               [--cache file.json] [--out js/puzzles.js] [--dry]
// The solver path defaults to ~/.cache/fourfall-target/release/c4(.exe);
// set C4_EXE to override it. The run is deterministic for a given seed.
//
// Score convention of `c4 analyze <moves>` (one score per column, for the
// player to move, n = discs on the board before the move):
//   0      draw with perfect play
//   s > 0  the mover wins with their (22 - s)-th disc; the mover has
//          floor(n/2) discs, so they need (22 - s) - floor(n/2) more moves
//   s < 0  the opponent wins with their (22 - |s|)-th disc; the opponent has
//          ceil(n/2) discs, so they need (22 - |s|) - ceil(n/2) more moves

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLS, ROWS, idx, linesThrough, replay } from '../js/game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- options ----------

function parseArgs(argv) {
  const opt = { games: 220, seed: 20261117, jobs: 2, cache: null, out: path.join(ROOT, 'js', 'puzzles.js'), dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--games') opt.games = Number(next());
    else if (a === '--seed') opt.seed = Number(next());
    else if (a === '--jobs') opt.jobs = Math.max(1, Math.min(2, Number(next())));
    else if (a === '--cache') opt.cache = path.resolve(next());
    else if (a === '--out') opt.out = path.resolve(next());
    else if (a === '--dry') opt.dry = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opt;
}

export function defaultSolverPath() {
  if (process.env.C4_EXE) return process.env.C4_EXE;
  const exe = process.platform === 'win32' ? 'c4.exe' : 'c4';
  const candidates = [
    path.join(os.homedir(), '.cache', 'fourfall-target', 'release', exe),
    path.join(ROOT, 'solver', 'target', 'release', exe),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

// ---------- solver access (at most 2 processes at a time) ----------

const MAX_SOLVERS = 2;
let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_SOLVERS) await new Promise((res) => waiting.push(res));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

// Parses one line of `c4 analyze` output into 7 entries, null for a full column.
export function parseScores(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== COLS) throw new Error(`unexpected solver output: ${line}`);
  return parts.map((t) => {
    if (t === 'x') return null;
    if (!/^-?\d+$/.test(t)) throw new Error(`unexpected solver output: ${line}`);
    return Number(t);
  });
}

export function analyze(exe, moveString, timeoutMs = 180000) {
  return withSlot(() => new Promise((resolve, reject) => {
    const child = execFile(exe, ['analyze', moveString || '-'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`c4 analyze ${moveString || '-'} failed: ${err.message} ${stderr || ''}`.trim()));
      else {
        try { resolve(parseScores(stdout)); } catch (e) { reject(e); }
      }
    });
    // Be polite to the other work on this machine.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not critical */ }
  }));
}

// ---------- small helpers ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const toMoves = (s) => Array.from(s, Number);

// Position key with colours, so different move orders reaching the same
// position collide. `mirror` flips left and right.
export function positionKey(cells, mirror = false) {
  let s = '';
  for (let k = 0; k < COLS; k++) {
    const c = mirror ? COLS - 1 - k : k;
    for (let r = 0; r < ROWS; r++) s += cells[idx(c, r)];
    s += '|';
  }
  return s;
}
export const canonicalKey = (cells) => {
  const a = positionKey(cells), b = positionKey(cells, true);
  return a < b ? a : b;
};

// Columns where player p would make four right now.
function winningColumns(state, p) {
  const out = [];
  for (let c = 0; c < COLS; c++) {
    const r = state.heights[c];
    if (r >= ROWS) continue;
    state.cells[idx(c, r)] = p;
    if (linesThrough(state.cells, c, r, p).length) out.push(c);
    state.cells[idx(c, r)] = 0;
  }
  return out;
}

// Opponent moves needed after a move with score s < 0, n discs before the move.
const oppNeed = (s, n) => (22 - Math.abs(s)) - Math.ceil(n / 2);
// Mover moves needed with score s > 0.
const moverNeed = (s, n) => (22 - s) - Math.floor(n / 2);

// Quality limits (see classify).
export const MIN_OPEN = 4; // open columns a puzzle needs
export const MIN_LIVE_WRONG = 2; // wrong columns that do not hand over an immediate four
export const SAVE_SHOWN_WITHIN = 6; // opponent moves within which a save's wrong columns should lose

// Decides whether a position is a puzzle. Returns null or the puzzle facts.
// Besides "exactly one correct column", a puzzle must be a real choice:
//   - at least MIN_OPEN open columns, so it cannot be solved by elimination
//     on a nearly full board;
//   - except for win in 1, at least MIN_LIVE_WRONG wrong columns that do not
//     simply let the opponent make four at once;
//   - a win in 1 must not be in the column the opponent needs to block
//     anyway (then blocking and winning are the same move);
//   - for a save, at least half of the wrong columns lose within
//     SAVE_SHOWN_WITHIN opponent moves, so the danger can be shown. Saves
//     where nearly every wrong column loses only at the very end of the game
//     cannot be learned from.
export function classify(moveString, scores) {
  const n = moveString.length;
  const cols = [];
  for (let c = 0; c < COLS; c++) if (scores[c] !== null) cols.push(c);
  if (cols.length < MIN_OPEN) return null;
  const best = Math.max(...cols.map((c) => scores[c]));
  if (best < 0) return null;
  const st = replay(toMoves(moveString), 1);
  // The opponent already threatens to make four, so unless you can win at
  // once the answer is simply the block. Such positions are left out.
  const oppWins = winningColumns(st, 3 - st.turn);
  const threat = oppWins.length > 0;
  const correct = cols.filter((c) => scores[c] === best);
  if (correct.length !== 1) return null;
  const solution = correct[0];
  if (best > 0 && cols.some((c) => c !== solution && scores[c] > 0)) return null;
  if (best === 0 && cols.some((c) => c !== solution && scores[c] >= 0)) return null;
  // Opponent moves to win after each wrong column (null when it does not lose).
  const wrong = cols.filter((c) => c !== solution).map((c) => (scores[c] < 0 ? oppNeed(scores[c], n) : null));
  const losses = wrong.filter((k) => k !== null);
  const facts = {
    solution, open: cols.length, threat,
    // Wrong columns that let the opponent make four at once.
    quickLosses: losses.filter((k) => k === 1).length,
    // Slowest loss among the wrong columns, in opponent moves (0 if none lose).
    slowestLoss: losses.length ? Math.max(...losses) : 0,
    wrongCount: wrong.length,
  };
  const live = facts.wrongCount - facts.quickLosses;
  if (best > 0) {
    const inMoves = moverNeed(best, n);
    if (threat && inMoves > 1) return null;
    if (inMoves === 1 && oppWins.includes(solution)) return null;
    if (inMoves > 1 && live < MIN_LIVE_WRONG) return null;
    return { kind: 'win', inMoves, ...facts };
  }
  // best === 0: a save, exactly one column keeps the draw and every other loses.
  if (threat || live < MIN_LIVE_WRONG) return null;
  if (losses.filter((k) => k <= SAVE_SHOWN_WITHIN).length * 2 < losses.length) return null;
  return { kind: 'save', inMoves: null, ...facts };
}

// A save is hard when most wrong columns do not lose at once and at least one
// of them loses only slowly, so the danger is not visible on the board yet.
export const isHardSave = (p) => p.kind === 'save' && p.quickLosses * 2 < p.wrongCount && p.slowestLoss >= 4;

// ---------- playing games ----------

const OPENING_DISCS = 10; // fewer discs are slow to solve, so open without the solver
const MIN_DISCS = 12;
const MAX_DISCS = 34;
const OPENING_WEIGHTS = [1, 2, 4, 7, 4, 2, 1];

// Opening moves: centre-weighted random, but take a four when there is one,
// never miss a block and never set up an immediate four for the opponent.
function openingMove(moves, rng) {
  const st = replay(moves, 1);
  const me = st.turn, opp = 3 - me;
  const playable = [];
  for (let c = 0; c < COLS; c++) if (st.heights[c] < ROWS) playable.push(c);
  const wins = winningColumns(st, me);
  if (wins.length) return wins[0];
  const blocks = winningColumns(st, opp);
  if (blocks.length) return blocks[0];
  let safe = playable.filter((c) => {
    const after = replay([...moves, c, c], 1);
    return !(after && after.winner === opp);
  });
  if (!safe.length) safe = playable;
  let total = 0;
  for (const c of safe) total += OPENING_WEIGHTS[c];
  let x = rng() * total;
  for (const c of safe) {
    x -= OPENING_WEIGHTS[c];
    if (x < 0) return c;
  }
  return safe[safe.length - 1];
}

// Solver-guided moves: mostly a best move, sometimes another move with the
// same outcome, now and then a mistake that does not hang an immediate four.
function solverMove(scores, n, rng) {
  const cols = [];
  for (let c = 0; c < COLS; c++) if (scores[c] !== null) cols.push(c);
  const best = Math.max(...cols.map((c) => scores[c]));
  const bestCols = cols.filter((c) => scores[c] === best);
  if (best > 0 && moverNeed(best, n) === 1) return pick(bestCols, rng);
  const r = rng();
  let pool;
  if (r < 0.62) pool = bestCols;
  else if (r < 0.9) pool = cols.filter((c) => Math.sign(scores[c]) === Math.sign(best) || (best < 0 && scores[c] >= best - 2));
  else pool = cols.filter((c) => scores[c] >= best - 8 && !(scores[c] < 0 && oppNeed(scores[c], n) === 1));
  if (!pool.length) pool = bestCols;
  return pick(pool, rng);
}

// Random openings are often already decided, which real games are not. An
// opening is kept only when the solver says the game is still close: the
// best score is small, so any win comes late in the game.
const OPENING_MAX_SCORE = 3;
const OPENING_TRIES = 40;

async function playGame(gameIndex, opt, exe, cache, log) {
  const rng = mulberry32((opt.seed * 1000003 + gameIndex * 7919) >>> 0);
  const found = [];
  const solve = async (s) => {
    let scores = cache.get(s);
    if (!scores) {
      scores = await analyze(exe, s);
      cache.set(s, scores);
    }
    return scores;
  };
  let moves = null;
  for (let attempt = 0; attempt < OPENING_TRIES && !moves; attempt++) {
    const m = [];
    while (m.length < OPENING_DISCS && !replay(m, 1).over) m.push(openingMove(m, rng));
    if (replay(m, 1).over) continue;
    let scores;
    try {
      scores = await solve(m.join(''));
    } catch (e) {
      log(`game ${gameIndex}: ${e.message}`);
      return { found, moves: m.join(''), aborted: 'solver error' };
    }
    const best = Math.max(...scores.filter((x) => x !== null));
    if (Math.abs(best) <= OPENING_MAX_SCORE) moves = m;
  }
  if (!moves) return { found, moves: '', aborted: 'no close opening found' };
  for (;;) {
    const s = moves.join('');
    let scores;
    try {
      scores = await solve(s);
    } catch (e) {
      log(`game ${gameIndex}: ${e.message}`);
      return { found, moves: s, aborted: 'solver error' };
    }
    const n = s.length;
    if (n >= MIN_DISCS && n <= MAX_DISCS) {
      const info = classify(s, scores);
      if (info) found.push({ game: gameIndex, moves: s, n, scores, ...info });
    }
    const chosen = solverMove(scores, n, rng);
    // Short unique wins are rare on the main line, so also look one mistake
    // off it: after a losing column, the parent's score already says how fast
    // the opponent wins, so only those branches are solved.
    if (n + 1 >= MIN_DISCS && n + 1 <= MAX_DISCS) {
      for (let c = 0; c < COLS; c++) {
        const sc = scores[c];
        if (c === chosen || sc === null || sc >= 0 || oppNeed(sc, n) > BRANCH_MAX_MOVES) continue;
        const child = s + c;
        let childScores;
        try {
          childScores = await solve(child);
        } catch (e) {
          log(`game ${gameIndex}: ${e.message}`);
          continue;
        }
        const childBest = Math.max(...childScores.filter((x) => x !== null));
        if (childBest !== -sc) throw new Error(`solver disagrees with itself at ${child}: ${childBest} vs ${-sc}`);
        const info = classify(child, childScores);
        if (info && info.kind === 'win') found.push({ game: gameIndex, moves: child, n: n + 1, scores: childScores, branch: true, ...info });
      }
    }
    moves.push(chosen);
    if (replay(moves, 1).over) return { found, moves: moves.join('') };
  }
}

// Branches are solved only when the opponent would win this fast.
const BRANCH_MAX_MOVES = 6;

// ---------- choosing the bank ----------

// Each level is filled from slots in order; a slot that runs short is topped
// up by the next slot of the same level.
const LEVELS = [
  { level: 1, slots: [
    { name: 'win in 1', count: 5, test: (p) => p.kind === 'win' && p.inMoves === 1 },
    { name: 'win in 2', count: 7, test: (p) => p.kind === 'win' && p.inMoves === 2 },
  ] },
  { level: 2, slots: [
    { name: 'win in 3', count: 12, test: (p) => p.kind === 'win' && p.inMoves === 3 },
  ] },
  { level: 3, slots: [
    { name: 'save', count: 12, test: (p) => p.kind === 'save' && !isHardSave(p) },
  ] },
  { level: 4, slots: [
    { name: 'win in 4', count: 12, test: (p) => p.kind === 'win' && p.inMoves === 4 },
  ] },
  { level: 5, slots: [
    { name: 'win in 5+', count: 7, test: (p) => p.kind === 'win' && p.inMoves >= 5 && p.inMoves <= 8 },
    { name: 'hard save', count: 5, test: (p) => isHardSave(p) },
  ] },
];

function titleFor(p) {
  return p.kind === 'win' ? `Win in ${p.inMoves}` : 'Save the game';
}

function selectPuzzles(candidates, seed) {
  const rng = mulberry32(seed ^ 0x5eed);
  // Deduplicate by position (and its mirror image), keeping the first seen.
  const byKey = new Map();
  for (const p of candidates) {
    const key = canonicalKey(replay(toMoves(p.moves), 1).cells);
    if (!byKey.has(key)) byKey.set(key, { ...p, key });
  }
  const pool = [...byKey.values()];
  // Seeded shuffle for tie-breaks.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const usedKeys = new Set();
  const gameUses = new Map();
  const chosen = [];
  for (const L of LEVELS) {
    const levelPicks = [];
    const colCount = new Array(COLS).fill(0);
    const youCount = { 1: 0, 2: 0 };
    const discBuckets = new Map();
    // One puzzle per game per level: two positions from the same game look
    // almost alike.
    const levelGames = new Set();
    // Spread the lengths of the long wins on level 5.
    const lengthCount = new Map();
    let carry = 0;
    for (const slot of L.slots) {
      const want = slot.count + carry;
      let got = 0;
      while (got < want) {
        let bestP = null, bestCost = Infinity;
        for (const p of pool) {
          if (usedKeys.has(p.key) || !slot.test(p)) continue;
          const you = p.n % 2 === 0 ? 1 : 2;
          const uses = gameUses.get(p.game) || 0;
          if (uses >= 2 || levelGames.has(p.game)) continue;
          const bucket = Math.floor(p.n / 4);
          const cost = uses * 20
            + colCount[p.solution] * 3
            + Math.max(0, youCount[you] - youCount[3 - you]) * 4
            + (discBuckets.get(bucket) || 0) * 2
            + (p.open < 5 ? 4 : 0)
            + (lengthCount.get(p.inMoves) || 0) * 3;
          if (cost < bestCost) { bestCost = cost; bestP = p; }
        }
        if (!bestP) break;
        usedKeys.add(bestP.key);
        gameUses.set(bestP.game, (gameUses.get(bestP.game) || 0) + 1);
        levelGames.add(bestP.game);
        lengthCount.set(bestP.inMoves, (lengthCount.get(bestP.inMoves) || 0) + 1);
        colCount[bestP.solution]++;
        youCount[bestP.n % 2 === 0 ? 1 : 2]++;
        const bucket = Math.floor(bestP.n / 4);
        discBuckets.set(bucket, (discBuckets.get(bucket) || 0) + 1);
        levelPicks.push({ ...bestP, level: L.level, slot: slot.name });
        got++;
      }
      carry = want - got;
    }
    if (carry > 0) console.log(`level ${L.level}: ${carry} short`);
    // Within a level: easier first (fewer moves to win), then fewer discs.
    levelPicks.sort((a, b) => (a.inMoves ?? 99) - (b.inMoves ?? 99) || a.n - b.n || (a.moves < b.moves ? -1 : 1));
    chosen.push(...levelPicks);
  }
  return chosen.map((p, i) => ({
    id: `p${String(i + 1).padStart(2, '0')}`,
    moves: p.moves,
    first: 1,
    you: p.n % 2 === 0 ? 1 : 2,
    kind: p.kind,
    inMoves: p.inMoves,
    solution: p.solution,
    level: p.level,
    title: titleFor(p),
    scores: p.scores,
    _meta: p,
  }));
}

function renderModule(puzzles, opt) {
  const lines = puzzles.map((p) => {
    const scores = `[${p.scores.map((s) => (s === null ? 'null' : String(s))).join(', ')}]`;
    return `  { id: '${p.id}', moves: '${p.moves}', first: ${p.first}, you: ${p.you}, kind: '${p.kind}', `
      + `inMoves: ${p.inMoves === null ? 'null' : p.inMoves}, solution: ${p.solution}, level: ${p.level}, `
      + `title: '${p.title}', scores: ${scores} },`;
  });
  return `// Training puzzles. Generated by tools/make-puzzles.mjs (seed ${opt.seed}, ${opt.games} games);
// do not edit by hand, run the generator again instead.
//
// Every puzzle is a position from a practice game where the player to move has
// exactly one correct column, checked with the perfect solver. Every puzzle has
// at least four open columns, and (except win in 1) at least two wrong columns
// that do not simply hand the opponent an immediate four.
//   moves     columns 0-6 in play order, replay with replay(moves, first) from game.js
//   first     the player who moved first (1 brass, 2 pearl)
//   you       the player to move (1 brass, 2 pearl)
//   kind      'win': only this column wins; 'save': the best result is a draw,
//             only this column keeps it and every other column loses
//   inMoves   for 'win', moves you need to win with best play, counting the
//             winning one; null for 'save'
//   solution  the one correct column, 0-6 (column 1-7 for players)
//   level     1 win in 1-2, 2 win in 3, 3 save, 4 win in 4, 5 win in 5-8 or hard save
//   scores    solver scores of the 7 columns for the player to move (null: full).
//             0 draw; s > 0 you win with your (22 - s)-th disc; s < 0 the
//             opponent wins with their (22 - |s|)-th disc.

export const PUZZLES = [
${lines.join('\n')}
];
`;
}

// ---------- main ----------

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const exe = defaultSolverPath();
  if (!existsSync(exe)) throw new Error(`solver not found at ${exe} (set C4_EXE)`);
  const cache = new Map();
  if (opt.cache && existsSync(opt.cache)) {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(opt.cache, 'utf8')))) cache.set(k, v);
    console.log(`cache: ${cache.size} positions from ${opt.cache}`);
  }
  const saveCache = () => {
    if (opt.cache) writeFileSync(opt.cache, JSON.stringify(Object.fromEntries(cache)));
  };

  const t0 = Date.now();
  const results = new Array(opt.games);
  let nextGame = 0, done = 0;
  const log = (msg) => console.log(msg);
  async function worker() {
    for (;;) {
      const g = nextGame++;
      if (g >= opt.games) return;
      results[g] = await playGame(g, opt, exe, cache, log);
      done++;
      if (done % 10 === 0) {
        const total = results.reduce((a, r) => a + (r ? r.found.length : 0), 0);
        console.log(`games ${done}/${opt.games}, candidates ${total}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        saveCache();
      }
    }
  }
  await Promise.all(Array.from({ length: opt.jobs }, worker));
  saveCache();

  const candidates = results.flatMap((r) => r.found);
  const aborted = results.filter((r) => r.aborted).length;
  console.log(`\n${opt.games} games (${aborted} stopped early), ${candidates.length} candidate positions`);
  const tally = new Map();
  for (const p of candidates) {
    const k = p.kind === 'win' ? `win in ${String(p.inMoves).padStart(2)}` : (isHardSave(p) ? 'hard save' : 'save');
    const t = tally.get(k) || [0, 0];
    t[p.n % 2]++;
    tally.set(k, t);
  }
  console.log('candidates (first player to move / second player to move):');
  console.log([...tally.entries()].sort().map(([k, [a, b]]) => `  ${k}: ${a} / ${b}`).join('\n'));

  const puzzles = selectPuzzles(candidates, opt.seed);
  console.log(`\nkept ${puzzles.length} puzzles:`);
  console.log('id   lvl kind  in  discs to-move  answer  source    moves');
  for (const p of puzzles) {
    const m = p._meta;
    const extra = p.kind === 'save'
      ? `  (threat ${m.threat ? 'yes' : 'no'}, quick losses ${m.quickLosses}/${m.wrongCount}, slowest loss ${m.slowestLoss})`
      : '';
    console.log(`${p.id}  ${p.level}  ${p.kind.padEnd(4)}  ${String(p.inMoves ?? "-").padStart(2)}  ${String(p.moves.length).padStart(5)}  ${(p.you === 1 ? "brass" : "pearl").padEnd(7)}  col ${p.solution + 1}  game ${String(m.game).padStart(3)}${m.branch ? "b" : " "}  ${p.moves}${extra}`);
  }
  const perLevel = [1, 2, 3, 4, 5].map((l) => puzzles.filter((p) => p.level === l).length);
  const brass = puzzles.filter((p) => p.you === 1).length;
  console.log(`\nper level: ${perLevel.join(' / ')}; brass to move ${brass}, pearl to move ${puzzles.length - brass}`);
  if (opt.dry) {
    console.log('dry run, nothing written');
  } else {
    writeFileSync(opt.out, renderModule(puzzles, opt));
    console.log(`wrote ${path.relative(ROOT, opt.out)}`);
  }
  console.log(`time ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
