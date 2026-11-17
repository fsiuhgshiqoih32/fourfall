// Checks the training lessons in js/lessons.js: structure, legal positions,
// whose turn it is, that each task accepts exactly the columns in the solver's
// best outcome class (win, draw or loss), and the facts the lesson text states.
// The text is pinned by fingerprints (REVIEWED): change a lesson's words and
// the test fails until its facts check has been re-read and updated.
//
// Run: node tests/lessons.test.mjs
// The perfect solver is the native CLI built from solver/. Its path comes from
// FOURFALL_SOLVER, or defaults to ~/.cache/fourfall-target/release/c4.exe.
// Without it the solver checks are skipped and everything else still runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LESSONS, LINE_COUNTS } from '../js/lessons.js';
import { replay, COLS, ROWS, N, idx, WINDOWS } from '../js/game.js';

const SOLVER = process.env.FOURFALL_SOLVER || join(homedir(), '.cache', 'fourfall-target', 'release', 'c4.exe');
const HAVE_SOLVER = existsSync(SOLVER);

// The page draws the heat numbers from coach.lineCountsPerCell(), so the text
// is checked against that too when coach.js is present.
const coach = await import('../js/coach.js').catch(() => null);

// The standard 7 x 6 line-count table, bottom row first.
const LINE_TABLE = [
  [3, 4, 5, 7, 5, 4, 3],
  [4, 6, 8, 10, 8, 6, 4],
  [5, 8, 11, 13, 11, 8, 5],
  [5, 8, 11, 13, 11, 8, 5],
  [4, 6, 8, 10, 8, 6, 4],
  [3, 4, 5, 7, 5, 4, 3],
];

// Known theory, not recomputed: first-move scores on the empty board.
const EMPTY_BOARD_SCORES = [-2, -1, 0, 1, 0, -1, -2];

const IDS = ['middle', 'win-first', 'under', 'fork', 'stack', 'parity'];
const TITLES = ['Start in the middle', 'Win first, then block', 'Don\'t play under a threat',
  'Two threats at once', 'Stacked threats', 'Odd and even rows'];

// ---------------------------------------------------------------- helpers

const toMoves = (s) => Array.from(s, Number);
const play = (task, extra = '') => replay(toMoves(task.moves + extra), task.first);
const legalCols = (st) => [...Array(COLS).keys()].filter((c) => st.heights[c] < ROWS);
const sameCells = (a, b) => JSON.stringify(sortCells(a)) === JSON.stringify(sortCells(b));
const sortCells = (l) => l.map(([c, r]) => [c, r]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
const hasCell = (l, c, r) => l.some(([cc, rr]) => cc === c && rr === r);
const cellsOf = (st, list, p) => list.every(([c, r]) => st.cells[idx(c, r)] === p);

// Empty cells where player p would complete four, as [col, row].
function winCells(cells, p) {
  const out = new Set();
  for (let w = 0; w < WINDOWS.length; w += 4) {
    let mine = 0, empty = -1, gaps = 0;
    for (let k = 0; k < 4; k++) {
      const v = cells[WINDOWS[w + k]];
      if (v === p) mine++;
      else if (v === 0) { gaps++; empty = WINDOWS[w + k]; }
    }
    if (mine === 3 && gaps === 1) out.add(empty);
  }
  return sortCells([...out].map((i) => [Math.floor(i / ROWS), i % ROWS]));
}
const playable = (heights, list) => list.filter(([c, r]) => heights[c] === r);

// Win cells p would have after dropping a disc into column c, without the
// other side moving (used to test "if the solver got this square...").
function ifTook(st, p, c) {
  const cells = st.cells.slice();
  const heights = Array.from(st.heights);
  cells[idx(c, heights[c])] = p;
  heights[c]++;
  const wins = winCells(cells, p);
  return { wins, playable: playable(heights, wins) };
}
// Win cells the mover gains by playing column c (new ones only).
function newWins(task, st, c) {
  const before = winCells(st.cells, task.you);
  const after = play(task, String(c));
  return winCells(after.cells, task.you).filter(([cc, rr]) => !hasCell(before, cc, rr));
}

const cache = new Map();
function analyze(moves) {
  if (moves === '') return EMPTY_BOARD_SCORES.slice();
  if (cache.has(moves)) return cache.get(moves);
  const res = spawnSync(SOLVER, ['analyze', moves], { encoding: 'utf8', timeout: 180000 });
  assert.equal(res.status, 0, `solver failed on ${moves}: ${res.stderr || res.error}`);
  const scores = res.stdout.trim().split(/\s+/).map((x) => (x === 'x' ? null : Number(x)));
  assert.equal(scores.length, COLS, `solver output for ${moves}: ${res.stdout}`);
  cache.set(moves, scores);
  return scores;
}
// Score convention: who wins and how many more moves the winner needs,
// counting the winning one, with n discs on the board before the move.
function outcome(score, n) {
  if (score > 0) return { who: 'mover', moves: 22 - score - Math.floor(n / 2) };
  if (score < 0) return { who: 'opponent', moves: 22 + score - Math.ceil(n / 2) };
  return { who: 'draw', moves: null };
}
// The mover wins with exactly `k` of their own moves after playing `col`.
function winsIn(task, scores, col, k) {
  assert.deepEqual(outcome(scores[col], task.moves.length), { who: 'mover', moves: k },
    `column ${col + 1}: the mover wins in ${k} (score ${scores[col]})`);
}
// After the mover plays `col`, the solver wins with its very next disc.
function losesAtOnce(task, scores, col) {
  assert.deepEqual(outcome(scores[col], task.moves.length), { who: 'opponent', moves: 1 },
    `column ${col + 1}: the solver wins right away (score ${scores[col]})`);
}
const bestClassSet = (scores) => {
  const best = Math.max(...scores.filter((s) => s !== null).map(Math.sign));
  return scores.map((s, c) => (s !== null && Math.sign(s) === best ? c : -1)).filter((c) => c >= 0);
};
const fmtScores = (sc) => sc.map((s) => (s === null ? 'x' : String(s))).join(' ');
const fmtCols = (cols) => cols.map((c) => c + 1).join(',');

const allTasks = LESSONS.flatMap((lesson, li) => lesson.tasks.map((task, ti) => ({ lesson, li, task, ti, key: `${lesson.id}:${ti}` })));

// ---------------------------------------------------------------- structure

test('six lessons in the planned order', () => {
  assert.ok(Array.isArray(LESSONS));
  assert.deepEqual(LESSONS.map((l) => l.id), IDS);
  assert.deepEqual(LESSONS.map((l) => l.title), TITLES);
});

test('lesson fields', () => {
  for (const l of LESSONS) {
    assert.ok(Array.isArray(l.intro) && l.intro.length >= 2 && l.intro.length <= 4, `${l.id}: 2-4 intro paragraphs`);
    for (const p of l.intro) {
      assert.equal(typeof p, 'string');
      const words = p.trim().split(/\s+/).length;
      assert.ok(words < 60, `${l.id}: intro paragraph has ${words} words`);
    }
    if ('heat' in l) assert.equal(typeof l.heat, 'boolean', `${l.id}: heat is a boolean`);
    assert.ok(Array.isArray(l.tasks) && l.tasks.length >= 2 && l.tasks.length <= 3, `${l.id}: 2-3 tasks`);
  }
  assert.equal(LESSONS[0].heat, true, 'the middle lesson shows line counts');
});

test('task fields', () => {
  for (const { key, task } of allTasks) {
    assert.equal(typeof task.moves, 'string', key);
    assert.match(task.moves, /^[0-6]*$/, `${key}: moves are digits 0-6`);
    assert.ok(task.first === 1 || task.first === 2, `${key}: first is 1 or 2`);
    assert.ok(task.you === 1 || task.you === 2, `${key}: you is 1 or 2`);
    for (const f of ['prompt', 'right', 'wrong']) assert.ok(typeof task[f] === 'string' && task[f].length > 0, `${key}: ${f}`);
    assert.ok(Array.isArray(task.accept) && task.accept.length > 0, `${key}: accept is a non-empty array`);
    for (const c of task.accept) assert.ok(Number.isInteger(c) && c >= 0 && c < COLS, `${key}: accept column ${c}`);
    assert.deepEqual(task.accept, [...new Set(task.accept)].sort((a, b) => a - b), `${key}: accept sorted, no repeats`);
    assert.ok(task.accept.includes(task.solution), `${key}: solution ${task.solution} is in accept`);
    if ('marks' in task) {
      assert.ok(Array.isArray(task.marks) && task.marks.length > 0, `${key}: marks is a non-empty array`);
      for (const m of task.marks) {
        assert.ok(Array.isArray(m) && m.length === 2, `${key}: mark ${JSON.stringify(m)} is [col,row]`);
        const [c, r] = m;
        assert.ok(Number.isInteger(c) && c >= 0 && c < COLS && Number.isInteger(r) && r >= 0 && r < ROWS,
          `${key}: mark ${JSON.stringify(m)} is on the board`);
      }
    }
  }
});

// ---------------------------------------------------------------- positions

test('positions are legal, unfinished, and it is the learner\'s turn', () => {
  for (const { key, task } of allTasks) {
    const st = play(task);
    assert.ok(st, `${key}: moves replay legally`);
    assert.equal(st.winner, 0, `${key}: nobody has four yet`);
    assert.equal(st.over, false, `${key}: game not over`);
    assert.equal(st.turn, task.you, `${key}: learner (player ${task.you}) is to move`);
    const parityTurn = task.moves.length % 2 === 0 ? task.first : 3 - task.first;
    assert.equal(parityTurn, task.you, `${key}: move count parity and first agree`);
    for (const c of task.accept) assert.ok(st.heights[c] < ROWS, `${key}: accepted column ${c + 1} is not full`);
    assert.ok(task.moves === '' || task.moves.length >= 10, `${key}: solver positions need 10 or more discs`);
  }
});

// ---------------------------------------------------------------- solver

const summary = [];

test('accept is exactly the solver\'s best outcome class', { skip: HAVE_SOLVER ? false : `solver not found at ${SOLVER}` }, () => {
  const names = { 1: 'win', 0: 'draw', '-1': 'loss' };
  for (const { key, task } of allTasks) {
    const st = play(task);
    const scores = analyze(task.moves);
    for (let c = 0; c < COLS; c++) {
      assert.equal(scores[c] === null, st.heights[c] >= ROWS, `${key}: solver and rules agree column ${c + 1} is full`);
    }
    const best = bestClassSet(scores);
    const cls = names[Math.sign(scores[best[0]])];
    summary.push(`  ${key.padEnd(12)} ${(task.moves || '-').padEnd(28)} you=${task.you} scores=[${fmtScores(scores)}] best ${cls}: ${fmtCols(best)}  accept: ${fmtCols(task.accept)}`);
    assert.deepEqual(task.accept, best, `${key}: accept ${fmtCols(task.accept)} vs solver best (${cls}) ${fmtCols(best)}`);
    // "Show answer" uses `solution`, so it should be the strongest accepted move.
    const top = Math.max(...task.accept.map((c) => scores[c]));
    assert.equal(scores[task.solution], top, `${key}: solution column ${task.solution + 1} has the best score among accepted columns`);
  }
});

// ---------------------------------------------------------------- facts in the text

// Each entry checks the claims made in that task's prompt, right and wrong text.
// Columns and rows in code are 0-based; the comments use the 1-based names.
const FACTS = {
  'middle:0': ({ scores }) => {
    assert.deepEqual(scores, EMPTY_BOARD_SCORES);
    assert.equal(LINE_COUNTS[idx(3, 0)], 7, 'bottom middle square: 7 lines');
    assert.equal(LINE_COUNTS[idx(0, 0)], 3, 'corner: 3 lines');
    assert.equal(LINE_COUNTS[idx(6, 0)], 3, 'corner: 3 lines');
    for (let c = 0; c < COLS; c++) if (c !== 3) assert.ok(LINE_COUNTS[idx(c, 0)] < 7, 'middle bottom square has the most');
  },
  'middle:1': ({ st, scores }) => { noThreats(st); landsOnMost(st, scores, 3, 13); },
  'middle:2': ({ st, scores }) => { noThreats(st); landsOnMost(st, scores, 2, 13); },

  'win-first:0': ({ task, st, me, op, scores }) => {
    // Column 6 completes four on row 1; the solver has three in column 3.
    assert.ok(sameCells(playable(st.heights, winCells(st.cells, me)), [[5, 0]]));
    const a = play(task, '5');
    assert.ok(a.winner === me && a.last.row === 0 && a.lines.some((l) => l.every(([, r]) => r === 0)), 'four on row 1');
    winsIn(task, scores, 5, 1);
    assert.ok(cellsOf(st, [[2, 0], [2, 1], [2, 2]], op));
    assert.ok(hasCell(playable(st.heights, winCells(st.cells, op)), 2, 3));
  },
  'win-first:1': ({ task, st, me, op, scores }) => {
    // No four for you; the solver's diagonal c2r1-c5r4 has its gap at c4r3.
    assert.equal(winCells(st.cells, me).length, 0);
    assert.ok(sameCells(playable(st.heights, winCells(st.cells, op)), [[3, 2]]));
    assert.ok(cellsOf(st, [[1, 0], [2, 1], [4, 3]], op));
    onlyNonLosing(scores, 3);
    for (const c of legalCols(st)) if (c !== 3) losesAtOnce(task, scores, c);
  },
  'win-first:2': ({ task, st, me, op, scores }) => {
    // The solver threatens four on row 2; your diagonal c3r4-c6r1 finishes at c4r3.
    assert.ok(playable(st.heights, winCells(st.cells, op)).some(([, r]) => r === 1));
    assert.ok(sameCells(playable(st.heights, winCells(st.cells, me)), [[3, 2]]));
    assert.ok(cellsOf(st, [[2, 3], [4, 1], [5, 0]], me));
    const a = play(task, '3');
    assert.ok(a.winner === me && a.lines.some((l) => sameCells(l, [[2, 3], [3, 2], [4, 1], [5, 0]])), 'the diagonal is the four');
    winsIn(task, scores, 3, 1);
  },

  'under:0': ({ task, st, me, op, scores }) => {
    // The marked square c7r2 wins for the solver; column 7 is empty.
    assert.ok(hasCell(winCells(st.cells, op), 6, 1));
    assert.equal(st.heights[6], 0);
    assert.equal(playable(st.heights, winCells(st.cells, me)).length, 0);
    assert.equal(playable(st.heights, winCells(st.cells, op)).length, 0);
    assert.equal(play(task, '66').winner, op, 'the solver wins on top');
    losesAtOnce(task, scores, 6);
    for (const c of legalCols(st)) if (c !== 6) assert.ok(scores[c] > 0, `column ${c + 1} wins`);
  },
  'under:1': ({ task, st, op, scores }) => {
    // Three columns left; the solver has exactly two squares, c1r4 and c6r2, and
    // discs in columns 1 and 6 would land right below them.
    assert.deepEqual(legalCols(st), [0, 5, 6]);
    assert.ok(sameCells(winCells(st.cells, op), [[0, 3], [5, 1]]), 'exactly two solver squares');
    assert.equal(st.heights[0], 2);
    assert.equal(st.heights[5], 0);
    assert.ok(!hasCell(winCells(st.cells, op), 6, st.heights[6] + 1), 'column 7 is not under a solver square');
    assert.ok(scores[6] > 0);
    losesAtOnce(task, scores, 0);
    losesAtOnce(task, scores, 5);
  },

  'fork:0': ({ task, me, op, scores }) => {
    // Column 3 makes three on row 2 with both ends (c1r2, c5r2) ready.
    const a = play(task, '2');
    assert.ok(cellsOf(a, [[1, 1], [2, 1], [3, 1]], me));
    assert.ok(sameCells(playable(a.heights, winCells(a.cells, me)), [[0, 1], [4, 1]]));
    assert.equal(playable(a.heights, winCells(a.cells, op)).length, 0);
    winsIn(task, scores, 2, 2);
  },
  'fork:1': ({ task, me, op, scores }) => {
    // Column 5: three up column 5 and three on a diagonal; threats c5r4 and c7r1.
    const a = play(task, '4');
    assert.ok(cellsOf(a, [[4, 0], [4, 1], [4, 2]], me));
    assert.ok(cellsOf(a, [[3, 3], [4, 2], [5, 1]], me));
    const ready = playable(a.heights, winCells(a.cells, me));
    assert.ok(sameCells(ready, [[4, 3], [6, 0]]), 'exactly c5r4 and c7r1 are ready');
    assert.equal(playable(a.heights, winCells(a.cells, op)).length, 0);
    winsIn(task, scores, 4, 2);
  },
  'fork:2': ({ st, op, scores }) => {
    // From c3r3 the solver would have three up column 3 and three on row 3, two squares ready.
    assert.equal(st.heights[2], 2);
    assert.ok(cellsOf(st, [[2, 0], [2, 1], [1, 2], [3, 2]], op));
    assert.equal(playable(st.heights, winCells(st.cells, op)).length, 0, 'no solver four right now');
    const t = ifTook(st, op, 2);
    assert.ok(sameCells(t.playable, [[2, 3], [4, 2]]), 'exactly two solver squares ready');
    for (const c of legalCols(st)) if (c !== 2) assert.ok(new Set(ifTook(st, op, c).playable.map(([cc]) => cc)).size < 2, 'only that square gives two threats');
    onlyNonLosing(scores, 2);
  },

  'stack:0': ({ task, me, op, scores }) => {
    // Column 6: winning squares at c5r2 and c5r3; the solver must block r2, then r3 wins.
    const a = play(task, '5');
    const w = winCells(a.cells, me);
    assert.ok(hasCell(w, 4, 1) && hasCell(w, 4, 2) && a.heights[4] === 1);
    assert.equal(playable(a.heights, winCells(a.cells, op)).length, 0);
    assert.equal(play(task, '544').winner, me);
    winsIn(task, scores, 5, 2);
  },
  'stack:1': ({ task, me, op, scores }) => {
    winsIn(task, scores, 5, 3);
    // Column 6: winning squares at c7r3 and c7r4, not playable yet. You fill r2,
    // the solver must block r3, and r4 wins, whatever the solver does in between.
    const a = play(task, '5');
    const w = winCells(a.cells, me);
    assert.ok(hasCell(w, 6, 2) && hasCell(w, 6, 3) && a.heights[6] === 1);
    assert.equal(playable(a.heights, winCells(a.cells, op)).length, 0);
    for (const j of legalCols(a)) {
      if (j === 6) { assert.equal(play(task, '566').winner, me); continue; }
      const b = play(task, `5${j}6`);
      assert.ok(b && !b.over, `after solver column ${j + 1}, row 2 of column 7 is free`);
      const solverReady = playable(b.heights, winCells(b.cells, op));
      assert.equal(solverReady.length, 0, `after solver column ${j + 1}, the solver has no four to make`);
      const c = play(task, `5${j}66`);
      assert.ok(!c.over);
      const d = play(task, `5${j}666`);
      assert.ok(d.winner === me && d.last.row === 3, `after solver column ${j + 1}, row 4 wins`);
    }
  },
  'stack:2': ({ st, op, scores }) => {
    // The solver has c2r4; from c5r3 it would add c2r3 right below it.
    assert.ok(hasCell(winCells(st.cells, op), 1, 3) && st.heights[1] === 2);
    assert.equal(st.heights[4], 2);
    assert.ok(!hasCell(winCells(st.cells, op), 1, 2));
    assert.ok(hasCell(ifTook(st, op, 4).wins, 1, 2));
    onlyNonLosing(scores, 4);
  },

  'parity:0': ({ task, st, scores }) => {
    // You moved first. Column 7 makes a threat at c6r3 (odd), column 1 one at c2r2 (even, a draw).
    assert.equal(task.you, task.first);
    for (const c of legalCols(st)) {
      const nw = newWins(task, st, c);
      if (c === 6) assert.ok(sameCells(nw, [[5, 2]]));
      else if (c === 0) assert.ok(sameCells(nw, [[1, 1]]));
      else assert.equal(nw.length, 0, `column ${c + 1} makes no threat`);
    }
    assert.ok(scores[6] > 0 && scores[0] === 0);
  },
  'parity:1': ({ task, st, scores }) => {
    // You moved second. Column 2 makes a threat at c4r4 (even), column 4 one at c2r3 (odd, a draw).
    assert.notEqual(task.you, task.first);
    for (const c of legalCols(st)) {
      const nw = newWins(task, st, c);
      if (c === 1) assert.ok(sameCells(nw, [[3, 3]]));
      else if (c === 3) assert.ok(sameCells(nw, [[1, 2]]));
      else assert.equal(nw.length, 0, `column ${c + 1} makes no threat`);
    }
    assert.ok(scores[1] > 0 && scores[3] === 0);
  },
};

// Column `col4`'s landing square: on `row`, part of `count` lines, strictly the
// most of any move, and the only winning move.
function landsOnMost(st, scores, row, count) {
  assert.equal(st.heights[3], row);
  assert.equal(LINE_COUNTS[idx(3, row)], count);
  for (const c of legalCols(st)) if (c !== 3) assert.ok(LINE_COUNTS[idx(c, st.heights[c])] < count, `column ${c + 1} lands on fewer lines`);
  assert.ok(scores[3] > 0);
  for (const c of legalCols(st)) if (c !== 3) assert.ok(scores[c] <= 0, `column ${c + 1} does not win`);
}
// "Nobody has a threat yet": no empty square completes four for either player.
function noThreats(st) {
  assert.equal(winCells(st.cells, 1).length, 0, 'player 1 has no winning square');
  assert.equal(winCells(st.cells, 2).length, 0, 'player 2 has no winning square');
}
function onlyNonLosing(scores, col) {
  assert.ok(scores[col] >= 0);
  scores.forEach((s, c) => { if (c !== col && s !== null) assert.ok(s < 0, `column ${c + 1} loses`); });
}

test('line counts match the standard table and what the page draws', () => {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) assert.equal(LINE_COUNTS[idx(c, r)], LINE_TABLE[r][c], `column ${c + 1}, row ${r + 1}`);
  }
  if (coach && typeof coach.lineCountsPerCell === 'function') {
    const drawn = coach.lineCountsPerCell();
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      assert.equal(drawn[c][r], LINE_COUNTS[idx(c, r)], `heat overlay column ${c + 1}, row ${r + 1}`);
    }
  }
  // Lesson 1 hint text: the middle column has the most lines in every row, and
  // its squares on rows 3 and 4 have the most of all (13, nowhere else).
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) if (c !== 3) assert.ok(LINE_COUNTS[idx(3, r)] > LINE_COUNTS[idx(c, r)], `row ${r + 1}`);
  }
  const top = [...LINE_COUNTS.keys()].filter((i) => LINE_COUNTS[i] === 13);
  assert.deepEqual(top, [idx(3, 2), idx(3, 3)]);
});

// main.js shows the heat numbers only on the first task of a lesson with
// heat: true (and with its intro). Text elsewhere must not point at them.
test('text mentions the numbers only where they are on screen', () => {
  for (const l of LESSONS) {
    for (const p of l.intro) if (/\bnumbers\b/i.test(p)) assert.ok(l.heat, `${l.id} intro mentions numbers without heat`);
    l.tasks.forEach((t, i) => {
      for (const f of ['prompt', 'right', 'wrong']) {
        if (/\bnumbers\b/i.test(t[f])) assert.ok(l.heat && i === 0, `${l.id}:${i} ${f} mentions numbers, but none are shown there`);
      }
    });
  }
});

test('intro facts', () => {
  assert.equal(WINDOWS.length / 4, 69, '69 lines of four');
  const colSum = (c) => { let s = 0; for (let r = 0; r < ROWS; r++) s += LINE_COUNTS[idx(c, r)]; return s; };
  assert.equal(colSum(3), 60);
  assert.equal(colSum(0), 24);
  assert.equal(colSum(6), 24);
  assert.equal(Math.max(...LINE_COUNTS), 13);
  assert.equal(Math.max(...[0, 1, 2, 4, 5, 6].flatMap((c) => [...Array(ROWS).keys()].map((r) => LINE_COUNTS[idx(c, r)]))), 11, 'only the middle column reaches 13');
  assert.equal(LINE_COUNTS.length, N);
  // When only one column is left, the first player fills its odd rows (1-based).
  for (let k = 0; k < ROWS; k++) {
    const discsBefore = 36 + k;
    const firstToMove = discsBefore % 2 === 0;
    assert.equal(firstToMove, (k + 1) % 2 === 1, `row ${k + 1} of the last column`);
  }
});

// The checks in FACTS (and in 'intro facts') were written against this exact
// text. A fingerprint pins it, so editing a lesson's words, position or marks
// fails here until someone re-checks the claims and updates the fingerprint.
const REVIEWED = {
  'middle': 'e1088137a2', 'middle:0': '8595291908', 'middle:1': 'ad3b2d34d3', 'middle:2': 'd79fdd6252',
  'win-first': '1ba9d53c92', 'win-first:0': 'df7b03668c', 'win-first:1': 'e531f2af2e', 'win-first:2': '0889664d4c',
  'under': '8d32797e89', 'under:0': '909c2301b5', 'under:1': '52684a9e7c',
  'fork': '48cf5ed32e', 'fork:0': 'cfb0cb3dc2', 'fork:1': 'aed84150a4', 'fork:2': '7f1da03653',
  'stack': '1bfc88bea2', 'stack:0': '2f61b0ab91', 'stack:1': '6a1a95c7fd', 'stack:2': '32ab9f4052',
  'parity': '6e01e1ea40', 'parity:0': '0a2a06fac8', 'parity:1': '9e5f6f2e09',
};
const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);

test('text is the reviewed text', () => {
  const seen = [];
  for (const l of LESSONS) {
    seen.push(l.id);
    assert.equal(fingerprint([l.title, ...l.intro].join('\n')), REVIEWED[l.id],
      `${l.id}: title or intro changed; re-check 'intro facts' and update REVIEWED`);
    l.tasks.forEach((t, i) => {
      const key = `${l.id}:${i}`;
      seen.push(key);
      const fp = fingerprint([t.moves, t.prompt, t.right, t.wrong, JSON.stringify(t.marks || [])].join('\n'));
      assert.equal(fp, REVIEWED[key], `${key}: text, position or marks changed; re-check FACTS['${key}'] and update REVIEWED to '${fp}'`);
    });
  }
  assert.deepEqual(Object.keys(REVIEWED).sort(), seen.sort(), 'no stale fingerprints');
});

test('task text matches the position', { skip: HAVE_SOLVER ? false : `solver not found at ${SOLVER}` }, () => {
  for (const { key, task } of allTasks) {
    const fact = FACTS[key];
    assert.ok(fact, `${key}: has a facts check`);
    const st = play(task);
    const text = `${task.prompt} ${task.right} ${task.wrong}`;
    if (/\byou moved first\b|\bas the first player\b/i.test(text)) assert.equal(task.you, task.first, `${key}: you moved first`);
    if (/\byou moved second\b|\bas the second player\b/i.test(text)) assert.notEqual(task.you, task.first, `${key}: you moved second`);
    // Every task with marks uses them for the solver's winning squares.
    for (const [c, r] of task.marks || []) {
      assert.equal(st.cells[idx(c, r)], 0, `${key}: marked square column ${c + 1}, row ${r + 1} is empty`);
      assert.ok(hasCell(winCells(st.cells, 3 - task.you), c, r), `${key}: marked square column ${c + 1}, row ${r + 1} wins for the solver`);
    }
    if (/\bmarked\b/i.test(text)) assert.ok(task.marks && task.marks.length, `${key}: text mentions marked squares, so it needs marks`);
    fact({ task, st, me: task.you, op: 3 - task.you, scores: analyze(task.moves) });
  }
  assert.equal(Object.keys(FACTS).length, allTasks.length, 'no stale facts checks');
});

// ---------------------------------------------------------------- writing style

test('writing style', () => {
  const texts = [];
  for (const l of LESSONS) {
    texts.push([`${l.id} title`, l.title]);
    l.intro.forEach((p, i) => texts.push([`${l.id} intro ${i + 1}`, p]));
    l.tasks.forEach((t, i) => { for (const f of ['prompt', 'right', 'wrong']) texts.push([`${l.id}:${i} ${f}`, t[f]]); });
  }
  for (const [where, s] of texts) {
    assert.match(s, /^[\x20-\x7E]+$/, `${where}: plain ASCII only (no emoji or curly quotes)`);
    assert.ok(!s.includes('!'), `${where}: no exclamation marks`);
    assert.match(s, /^[A-Z]/, `${where}: starts with a capital`);
    assert.ok(!/\s{2}/.test(s) && s === s.trim(), `${where}: no stray spaces`);
    // Every number in "column 3", "columns 3 and 5", "rows 2 and 3", "rows 1 to 6".
    const nums = (word) => [...s.matchAll(new RegExp(`\\b${word}s? (\\d+(?:(?:, | and | or | to )\\d+)*)`, 'gi'))]
      .flatMap((m) => m[1].match(/\d+/g).map(Number));
    for (const n of nums('column')) assert.ok(n >= 1 && n <= 7, `${where}: column ${n}`);
    for (const n of nums('row')) assert.ok(n >= 1 && n <= 6, `${where}: row ${n}`);
    // The perfect computer is always "the solver".
    assert.ok(!/\b(computer|AI|bot|engine|CPU)\b/i.test(s), `${where}: call it the solver`);
  }
  for (const l of LESSONS) {
    assert.ok(!/[A-Z]/.test(l.title.slice(1)), `${l.id}: title in sentence case`);
    for (const [i, t] of l.tasks.entries()) {
      if (t.accept.length === 1) {
        assert.match(t.right, new RegExp(`\\bcolumn ${t.solution + 1}\\b`, 'i'), `${l.id}:${i} right text names column ${t.solution + 1}`);
      }
      const sentences = t.right.split(/(?<=[.?])\s+/).filter(Boolean).length;
      assert.ok(sentences >= 1 && sentences <= 2, `${l.id}: right text has ${sentences} sentences`);
      assert.match(t.right, /[.?]$/, `${l.id}: right text ends a sentence`);
      assert.match(t.wrong, /[.?]$/, `${l.id}: wrong text ends a sentence`);
    }
  }
});

test.after(() => {
  const n = allTasks.length;
  console.log(`\nLessons: ${LESSONS.length}, tasks: ${n}`);
  if (!HAVE_SOLVER) console.log(`Solver not found at ${SOLVER}; solver checks skipped.`);
  else if (summary.length) console.log(`Solver checks (columns 1-based):\n${summary.join('\n')}`);
});
