// Checks the training puzzle bank in js/puzzles.js.
//
//   node --test tests/puzzles.test.mjs     (or: node tests/puzzles.test.mjs)
//
// The rules checks run anywhere. The solver checks need the native c4 CLI
// (built from solver/); its path defaults to ~/.cache/fourfall-target/release
// and can be set with C4_EXE. Without it those checks are skipped. C4_JOBS
// (1 or 2, default 2) sets how many solver processes run at once.
//
// Solver score convention (player to move, n = discs before the move):
// 0 draw; s > 0 the mover wins with their (22 - s)-th disc, which is
// (22 - s) - floor(n/2) more moves; s < 0 the opponent wins with their
// (22 - |s|)-th disc, which is (22 - |s|) - ceil(n/2) more opponent moves.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLS, ROWS, N, idx, linesThrough, replay } from '../js/game.js';
import { PUZZLES } from '../js/puzzles.js';

const toMoves = (s) => Array.from(s, Number);
const colourName = (p) => (p === 1 ? 'brass' : 'pearl');
const moverNeed = (s, n) => (22 - s) - Math.floor(n / 2);
const oppNeed = (s, n) => (22 - Math.abs(s)) - Math.ceil(n / 2);

// Quality limits, the same as in tools/make-puzzles.mjs.
const MIN_OPEN = 4;
const MIN_LIVE_WRONG = 2;
const SAVE_SHOWN_WITHIN = 6;

function solverPath() {
  if (process.env.C4_EXE) return process.env.C4_EXE;
  const exe = process.platform === 'win32' ? 'c4.exe' : 'c4';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = [
    path.join(os.homedir(), '.cache', 'fourfall-target', 'release', exe),
    path.join(root, 'solver', 'target', 'release', exe),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}
const EXE = solverPath();
const HAVE_SOLVER = existsSync(EXE);

// ---------- helpers ----------

function cellsKey(cells, turn, mirror) {
  let s = `${turn}:`;
  for (let k = 0; k < COLS; k++) {
    const c = mirror ? COLS - 1 - k : k;
    for (let r = 0; r < ROWS; r++) s += cells[idx(c, r)];
    s += '|';
  }
  return s;
}

function makesFour(cells, heights, c, p) {
  const r = heights[c];
  cells[idx(c, r)] = p;
  const win = linesThrough(cells, c, r, p).length > 0;
  cells[idx(c, r)] = 0;
  return win;
}

function immediateWins(cells, heights, p) {
  const out = [];
  for (let c = 0; c < COLS; c++) if (heights[c] < ROWS && makesFour(cells, heights, c, p)) out.push(c);
  return out;
}

// Plays column c for p, runs fn, takes the disc back.
function withMove(cells, heights, c, p, fn) {
  const r = heights[c];
  cells[idx(c, r)] = p; heights[c]++;
  try {
    return fn();
  } finally {
    heights[c]--; cells[idx(c, r)] = 0;
  }
}

const openColumns = (heights) => [...Array(COLS).keys()].filter((c) => heights[c] < ROWS);

// Exact search, independent of the solver: can `me` (to move) make four
// within k of their own moves, whatever the opponent does? With `only`, the
// first move is restricted to that column.
function canForceWin(cells, heights, count, me, k, only = -1) {
  if (k <= 0) return false;
  const opp = 3 - me;
  for (let c = 0; c < COLS; c++) {
    if ((only >= 0 && c !== only) || heights[c] >= ROWS) continue;
    if (makesFour(cells, heights, c, me)) return true;
  }
  if (k === 1) return false;
  for (let c = 0; c < COLS; c++) {
    if ((only >= 0 && c !== only) || heights[c] >= ROWS) continue;
    const r = heights[c];
    cells[idx(c, r)] = me; heights[c]++;
    let forced = count + 1 < N;
    if (forced && immediateWins(cells, heights, opp).length) forced = false;
    if (forced) {
      const threats = immediateWins(cells, heights, me);
      if (threats.length >= 2) {
        forced = true; // two threats in different columns: one stays open
      } else {
        // With one threat the opponent must block it (anything else loses at
        // once); otherwise every reply has to be answered.
        const replies = threats.length === 1 ? threats : [];
        if (!threats.length) for (let d = 0; d < COLS; d++) if (heights[d] < ROWS) replies.push(d);
        for (const d of replies) {
          const rr = heights[d];
          cells[idx(d, rr)] = opp; heights[d]++;
          const ok = canForceWin(cells, heights, count + 2, me, k - 1);
          heights[d]--; cells[idx(d, rr)] = 0;
          if (!ok) { forced = false; break; }
        }
      }
    }
    heights[c]--; cells[idx(c, r)] = 0;
    if (forced) return true;
  }
  return false;
}

// Wins up to this many moves are re-proved without the solver.
const SEARCH_MAX = 8;
// Losses after a wrong column up to this many opponent moves are re-proved too.
const LOSS_SEARCH_MAX = 6;

// What the stored scores say the puzzle is, by the documented scheme.
function readScores(scores, n) {
  const open = [];
  for (let c = 0; c < COLS; c++) if (scores[c] !== null) open.push(c);
  const best = Math.max(...open.map((c) => scores[c]));
  const correct = open.filter((c) => scores[c] === best);
  const wrong = open.filter((c) => c !== correct[0]);
  const losses = wrong.filter((c) => scores[c] < 0).map((c) => oppNeed(scores[c], n));
  const out = { open, best, correct, wrong, losses };
  if (best > 0) {
    out.kind = 'win';
    out.inMoves = moverNeed(best, n);
    out.level = out.inMoves <= 2 ? 1 : out.inMoves === 3 ? 2 : out.inMoves === 4 ? 4 : out.inMoves <= 8 ? 5 : 0;
  } else if (best === 0) {
    out.kind = 'save';
    out.inMoves = null;
    const quick = losses.filter((k) => k === 1).length;
    const hard = quick * 2 < wrong.length && Math.max(...losses) >= 4;
    out.level = hard ? 5 : 3;
  } else {
    out.kind = 'lost';
  }
  return out;
}

async function analyzeAll(moveStrings) {
  const jobs = Math.max(1, Math.min(2, Number(process.env.C4_JOBS) || 2));
  const out = new Array(moveStrings.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= moveStrings.length) return;
      out[i] = await new Promise((resolve, reject) => {
        const child = execFile(EXE, ['analyze', moveStrings[i]], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`c4 analyze ${moveStrings[i]}: ${err.message} ${stderr}`));
          const parts = stdout.trim().split(/\s+/);
          if (parts.length !== COLS || parts.some((t) => t !== 'x' && !/^-?\d+$/.test(t))) {
            return reject(new Error(`bad solver output for ${moveStrings[i]}: ${stdout}`));
          }
          resolve(parts.map((t) => (t === 'x' ? null : Number(t))));
        });
        try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not critical */ }
      });
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  return out;
}

const summary = { rules: 0, search: 0, searchSkipped: 0, losses: 0, lossesSkipped: 0, solver: 0, children: 0 };

// ---------- rules checks ----------

test('every puzzle is well formed and legal', () => {
  assert.ok(Array.isArray(PUZZLES) && PUZZLES.length >= 45 && PUZZLES.length <= 70, `about 60 puzzles, got ${PUZZLES.length}`);
  const ids = new Set();
  PUZZLES.forEach((p, i) => {
    const where = `${p.id}`;
    assert.equal(p.id, `p${String(i + 1).padStart(2, '0')}`, `${where}: ids run p01, p02, ...`);
    assert.ok(!ids.has(p.id), `${where}: duplicate id`);
    ids.add(p.id);
    assert.match(p.moves, /^[0-6]+$/, `${where}: moves are digits 0-6`);
    assert.ok(p.first === 1 || p.first === 2, `${where}: first is 1 or 2`);
    const st = replay(toMoves(p.moves), p.first);
    assert.ok(st, `${where}: moves are legal`);
    assert.ok(!st.over && st.winner === 0, `${where}: game not finished`);
    // Nobody made four at any point (replay would have refused later moves).
    assert.ok(p.moves.length >= 12 && p.moves.length <= 34, `${where}: 12 to 34 discs`);
    assert.equal(p.you, st.turn, `${where}: you is the player to move`);
    assert.equal(p.you, (p.moves.length % 2 === 0) ? p.first : 3 - p.first, `${where}: you matches the disc count`);
    assert.ok(Number.isInteger(p.solution) && p.solution >= 0 && p.solution < COLS, `${where}: solution is a column`);
    assert.ok(st.heights[p.solution] < ROWS, `${where}: solution column has room`);
    assert.ok(p.kind === 'win' || p.kind === 'save', `${where}: kind`);
    if (p.kind === 'win') {
      assert.ok(Number.isInteger(p.inMoves) && p.inMoves >= 1 && p.inMoves <= 8, `${where}: inMoves is 1 to 8`);
      assert.equal(p.title, `Win in ${p.inMoves}`, `${where}: title`);
      const expected = p.inMoves <= 2 ? 1 : p.inMoves === 3 ? 2 : p.inMoves === 4 ? 4 : 5;
      assert.equal(p.level, expected, `${where}: level for win in ${p.inMoves}`);
    } else {
      assert.equal(p.inMoves, null, `${where}: inMoves is null for a save`);
      assert.equal(p.title, 'Save the game', `${where}: title`);
      assert.ok(p.level === 3 || p.level === 5, `${where}: saves are level 3 or 5`);
    }
    assert.match(p.title, /^[A-Z][a-z0-9 ]*$/, `${where}: plain sentence-case title`);
    assert.ok(Array.isArray(p.scores) && p.scores.length === COLS, `${where}: 7 scores`);
    for (let c = 0; c < COLS; c++) {
      assert.equal(p.scores[c] === null, st.heights[c] >= ROWS, `${where}: null score exactly for full columns`);
      if (p.scores[c] !== null) assert.ok(Number.isInteger(p.scores[c]) && Math.abs(p.scores[c]) <= 21, `${where}: score ${c + 1} is a whole number`);
    }
    // The answer is never just a forced block of an immediate four.
    const blocks = immediateWins(st.cells, st.heights, 3 - st.turn);
    if (!(p.kind === 'win' && p.inMoves === 1)) assert.equal(blocks.length, 0, `${where}: opponent has no immediate four to block`);
    summary.rules++;
  });
});

test('the stored scores give exactly the stated answer', () => {
  for (const p of PUZZLES) {
    const n = p.moves.length;
    const s = readScores(p.scores, n);
    assert.equal(s.kind, p.kind, `${p.id}: kind from the scores`);
    assert.deepEqual(s.correct, [p.solution], `${p.id}: one best column, column ${p.solution + 1}`);
    assert.equal(s.inMoves, p.inMoves, `${p.id}: inMoves from the scores`);
    assert.equal(s.level, p.level, `${p.id}: level from the scores`);
    if (p.kind === 'win') {
      for (const c of s.wrong) assert.ok(p.scores[c] <= 0, `${p.id}: column ${c + 1} does not also win`);
    } else {
      for (const c of s.wrong) assert.ok(p.scores[c] < 0, `${p.id}: column ${c + 1} loses`);
    }
  }
});

test('the stored scores agree with the rules about immediate fours', () => {
  for (const p of PUZZLES) {
    const st = replay(toMoves(p.moves), p.first);
    const { cells, heights } = st;
    const n = p.moves.length, me = st.turn, opp = 3 - me;
    for (const c of openColumns(heights)) {
      const s = p.scores[c];
      const four = makesFour(cells, heights, c, me);
      assert.equal(s > 0 && moverNeed(s, n) === 1, four, `${p.id}: column ${c + 1} makes four exactly when its score says so`);
      if (four) continue;
      const hands = withMove(cells, heights, c, me, () => immediateWins(cells, heights, opp).length > 0);
      assert.equal(s < 0 && oppNeed(s, n) === 1, hands, `${p.id}: column ${c + 1} hands over a four exactly when its score says so`);
    }
  }
});

test('every puzzle is a real choice', () => {
  for (const p of PUZZLES) {
    const st = replay(toMoves(p.moves), p.first);
    const { cells, heights } = st;
    const me = st.turn, opp = 3 - me;
    const open = openColumns(heights);
    assert.ok(open.length >= MIN_OPEN, `${p.id}: at least ${MIN_OPEN} open columns (got ${open.length})`);
    const myFours = immediateWins(cells, heights, me);
    if (p.kind === 'win' && p.inMoves === 1) {
      assert.deepEqual(myFours, [p.solution], `${p.id}: the solution is the only immediate four`);
      assert.ok(!immediateWins(cells, heights, opp).includes(p.solution), `${p.id}: the win is not also the forced block`);
      continue;
    }
    assert.equal(myFours.length, 0, `${p.id}: no immediate four for the player to move`);
    // Wrong columns after which the opponent cannot make four at once.
    const live = open.filter((c) => c !== p.solution
      && !withMove(cells, heights, c, me, () => immediateWins(cells, heights, opp).length > 0));
    assert.ok(live.length >= MIN_LIVE_WRONG,
      `${p.id}: at least ${MIN_LIVE_WRONG} wrong columns that do not hand over a four at once (got ${live.length})`);
    if (p.kind === 'save') {
      const { losses } = readScores(p.scores, p.moves.length);
      const shown = losses.filter((k) => k <= SAVE_SHOWN_WITHIN).length;
      assert.ok(shown * 2 >= losses.length,
        `${p.id}: at least half the wrong columns lose within ${SAVE_SHOWN_WITHIN} opponent moves (${shown} of ${losses.length})`);
    }
  }
});

test('no duplicate, mirror-image or same-game positions within a level', () => {
  const seen = new Map();
  for (const p of PUZZLES) {
    const st = replay(toMoves(p.moves), p.first);
    const a = cellsKey(st.cells, st.turn, false), b = cellsKey(st.cells, st.turn, true);
    const key = a < b ? a : b;
    assert.ok(!seen.has(key), `${p.id} repeats ${seen.get(key)} (same position or its mirror image)`);
    seen.set(key, p.id);
  }
  // Two puzzles come from the same game when the shorter one, less its last
  // move, starts the longer one (a later position, or a side branch).
  for (const p of PUZZLES) {
    for (const q of PUZZLES) {
      if (p === q || p.level !== q.level || p.moves.length > q.moves.length) continue;
      if (p.moves.length === q.moves.length && p.id > q.id) continue;
      assert.ok(!q.moves.startsWith(p.moves.slice(0, -1)), `${p.id} and ${q.id} come from the same game on level ${p.level}`);
    }
  }
});

test('levels are balanced and both colours get to move', () => {
  for (let level = 1; level <= 5; level++) {
    const ps = PUZZLES.filter((p) => p.level === level);
    assert.ok(ps.length >= 10 && ps.length <= 14, `level ${level} has about 12 puzzles (got ${ps.length})`);
    const brass = ps.filter((p) => p.you === 1).length;
    assert.ok(brass >= 2 && ps.length - brass >= 2, `level ${level}: both colours to move (brass ${brass} of ${ps.length})`);
  }
  const brass = PUZZLES.filter((p) => p.you === 1).length;
  assert.ok(brass >= PUZZLES.length / 4 && brass <= (PUZZLES.length * 3) / 4, `mix of brass and pearl to move (brass ${brass})`);
  // Easier first within a level: wins sorted by length.
  for (let i = 1; i < PUZZLES.length; i++) {
    const a = PUZZLES[i - 1], b = PUZZLES[i];
    assert.ok(a.level <= b.level, `${b.id}: sorted by level`);
    if (a.level === b.level && a.kind === 'win' && b.kind === 'win') assert.ok(a.inMoves <= b.inMoves, `${b.id}: shorter wins first`);
  }
});

test('every win holds up under an independent exact search', () => {
  // The search is fast with forced-block pruning; longer wins rely on the solver.
  for (const p of PUZZLES) {
    if (p.kind !== 'win') continue;
    if (p.inMoves > SEARCH_MAX) { summary.searchSkipped++; continue; }
    const st = replay(toMoves(p.moves), p.first);
    const { cells, heights } = st;
    assert.ok(canForceWin(cells, heights, st.count, st.turn, p.inMoves, p.solution),
      `${p.id}: column ${p.solution + 1} forces four within ${p.inMoves} moves`);
    assert.ok(!canForceWin(cells, heights, st.count, st.turn, p.inMoves - 1),
      `${p.id}: no column forces four within ${p.inMoves - 1} moves`);
    for (let c = 0; c < COLS; c++) {
      if (c === p.solution || heights[c] >= ROWS) continue;
      assert.ok(!canForceWin(cells, heights, st.count, st.turn, p.inMoves, c),
        `${p.id}: column ${c + 1} does not also win within ${p.inMoves} moves`);
    }
    summary.search++;
  }
});

test('short losses after wrong columns hold up under the same search', () => {
  // For every wrong column whose stored score says the opponent wins within
  // LOSS_SEARCH_MAX moves, the opponent can force four in exactly that many.
  for (const p of PUZZLES) {
    const st = replay(toMoves(p.moves), p.first);
    const { cells, heights } = st;
    const n = p.moves.length, me = st.turn, opp = 3 - me;
    for (const c of openColumns(heights)) {
      const s = p.scores[c];
      if (c === p.solution || s === null || s >= 0) continue;
      const need = oppNeed(s, n);
      if (need > LOSS_SEARCH_MAX) { summary.lossesSkipped++; continue; }
      withMove(cells, heights, c, me, () => {
        assert.ok(canForceWin(cells, heights, n + 1, opp, need), `${p.id}: after column ${c + 1} the opponent wins within ${need}`);
        assert.ok(!canForceWin(cells, heights, n + 1, opp, need - 1), `${p.id}: after column ${c + 1} the opponent needs ${need} moves, not fewer`);
      });
      summary.losses++;
    }
  }
});

// ---------- solver checks ----------

test('solver agrees with every puzzle', { skip: HAVE_SOLVER ? false : `solver not found at ${EXE}` }, async () => {
  const results = await analyzeAll(PUZZLES.map((p) => p.moves));
  PUZZLES.forEach((p, i) => {
    const scores = results[i];
    const n = p.moves.length;
    assert.deepEqual(scores, p.scores, `${p.id}: stored scores match the solver`);
    const s = readScores(scores, n);
    assert.equal(s.kind, p.kind, `${p.id}: kind`);
    assert.deepEqual(s.correct, [p.solution], `${p.id}: exactly one best column, column ${p.solution + 1}`);
    if (p.kind === 'win') {
      const winners = s.open.filter((c) => scores[c] > 0);
      assert.deepEqual(winners, [p.solution], `${p.id}: exactly one winning column, column ${p.solution + 1}`);
      assert.equal(moverNeed(scores[p.solution], n), p.inMoves, `${p.id}: win in ${p.inMoves}`);
    } else {
      assert.equal(s.best, 0, `${p.id}: best result is a draw`);
      for (const c of s.wrong) assert.ok(scores[c] < 0, `${p.id}: column ${c + 1} loses`);
    }
    summary.solver++;
  });
});

test('solver agrees with itself after the solution', { skip: HAVE_SOLVER ? false : `solver not found at ${EXE}` }, async () => {
  // After the solution the opponent is to move; their best score must be the
  // negative of the solution's score (a draw stays a draw, a win stays a win
  // in the same number of moves). A win in 1 ends the game, so it is skipped.
  const todo = PUZZLES.filter((p) => !(p.kind === 'win' && p.inMoves === 1));
  const results = await analyzeAll(todo.map((p) => p.moves + p.solution));
  todo.forEach((p, i) => {
    const best = Math.max(...results[i].filter((x) => x !== null));
    assert.equal(best, 0 - p.scores[p.solution], `${p.id}: opponent's best after column ${p.solution + 1}`);
    summary.children++;
  });
});

test.after(() => {
  const lines = [];
  lines.push(`puzzle bank: ${PUZZLES.length} puzzles`);
  for (let level = 1; level <= 5; level++) {
    const ps = PUZZLES.filter((p) => p.level === level);
    const kinds = new Map();
    for (const p of ps) kinds.set(p.title, (kinds.get(p.title) || 0) + 1);
    lines.push(`  level ${level}: ${ps.length} (${[...kinds.entries()].map(([k, v]) => `${k.toLowerCase()} ${v}`).join(', ')})`);
  }
  const brass = PUZZLES.filter((p) => p.you === 1).length;
  lines.push(`  to move: ${colourName(1)} ${brass}, ${colourName(2)} ${PUZZLES.length - brass}`);
  lines.push(`  rules checked: ${summary.rules}; exact search checked: ${summary.search} wins (${summary.searchSkipped} longer wins left to the solver)`);
  lines.push(`  wrong-column losses re-proved by search: ${summary.losses} (${summary.lossesSkipped} slower ones left to the solver)`);
  lines.push(HAVE_SOLVER ? `  solver checked: ${summary.solver}, positions after the solution: ${summary.children}` : `  solver checks skipped: no solver at ${EXE}`);
  console.log(lines.join('\n'));
});
