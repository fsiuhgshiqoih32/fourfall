// The training coach. It grades a move against the solver's scores and
// explains it in plain words. Pure functions with no DOM access, so the page
// and the Node tests share them. Every claim in the text (threats, wins,
// counts) is computed from the board; nothing is guessed.
//
// Score convention (from the solver, for the player to move, n = discs on the
// board before the move):
//   0      draw with perfect play
//   s > 0  the mover wins with their (22 - s)-th disc
//   s < 0  the opponent wins with their (22 - |s|)-th disc
// The mover has floor(n / 2) discs on the board, the opponent ceil(n / 2).
//
// Columns are 0-based in the API and in tags ('col:3' is column 4 on screen),
// 1-based in every text a player reads. Rows are 0-based in marks (row 0 is
// the bottom), 1-based in text.

import { COLS, ROWS, idx, WINDOWS, replay, linesThrough, stringToMoves } from './game.js';

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
const RANK = { loss: 0, draw: 1, win: 2 };
const TITLES = { best: 'Best move', good: 'Good', mistake: 'Mistake', blunder: 'Blunder' };
// Reasons worth repeating in a level 2 hint: they say what the best move does.
const HINT_REASONS = new Set(['win-now', 'double-threat', 'stacked-threat', 'block', 'threat', 'new-threat', 'center']);
// Reasons that criticise the move. On a best or good move in a lost position
// they get NO_SAVE in front, so "Best move" never sits over a bare criticism.
const CRITICISM = new Set(['gives-top', 'missed-block', 'allows-double', 'allows-stack']);
const NO_SAVE = 'Nothing saves the game here.';

const inBoard = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;
const outcomeOf = (s) => (s > 0 ? 'win' : s < 0 ? 'loss' : 'draw');

// ---------------------------------------------------------------- board helpers

// True if a disc of player p on the empty cell (c, r) would complete four.
function completesFour(cells, c, r, p) {
  for (const [dc, dr] of DIRS) {
    let run = 1;
    for (let s = 1; s < 4; s++) {
      const cc = c + dc * s, rr = r + dr * s;
      if (!inBoard(cc, rr) || cells[idx(cc, rr)] !== p) break;
      run++;
    }
    for (let s = 1; s < 4; s++) {
      const cc = c - dc * s, rr = r - dr * s;
      if (!inBoard(cc, rr) || cells[idx(cc, rr)] !== p) break;
      run++;
    }
    if (run >= 4) return true;
  }
  return false;
}

// True if (c, r) is an empty cell where player p would complete four.
const isWinningCell = (cells, c, r, p) =>
  inBoard(c, r) && cells[idx(c, r)] === 0 && completesFour(cells, c, r, p);

// Returns copies of the board with player p's disc dropped into column c.
function drop(cells, heights, c, p) {
  const nextCells = cells.slice();
  const nextHeights = heights.slice();
  const row = nextHeights[c]++;
  nextCells[idx(c, row)] = p;
  return { cells: nextCells, heights: nextHeights, row };
}

/** Columns where `player` makes four by dropping a disc now. */
export function immediateWins(cells, heights, player) {
  const out = [];
  for (let c = 0; c < COLS; c++) {
    if (heights[c] < ROWS && completesFour(cells, c, heights[c], player)) out.push(c);
  }
  return out;
}

/** Every empty cell [col, row] that would complete a four for `player`,
 *  whether or not a disc can reach it yet. Sorted by column, then row. */
export function winningCells(cells, player) {
  const out = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (cells[idx(c, r)] === 0 && completesFour(cells, c, r, player)) out.push([c, r]);
    }
  }
  return out;
}

/** 7 x 6 table, [col][row]: how many windows of four pass through each cell.
 *  The middle column holds the largest value of every row (13 on rows 3-4). */
export function lineCountsPerCell() {
  const counts = Array.from({ length: COLS }, () => new Array(ROWS).fill(0));
  for (const i of WINDOWS) counts[Math.floor(i / ROWS)][i % ROWS]++;
  return counts;
}

// Columns where player p has a playable winning cell with another of p's
// winning cells straight above it: blocking the first hands over the second.
function stackedThreats(cells, heights, p) {
  const out = [];
  for (let c = 0; c < COLS; c++) {
    const h = heights[c];
    if (h + 1 < ROWS && completesFour(cells, c, h, p) && completesFour(cells, c, h + 1, p)) out.push(c);
  }
  return out;
}

// Solver replies on the board `after` (the human has just moved) that make
// two or more threats at once (doubles) or a threat with another right above
// it (stacks). Replies after which the human can make four are skipped, since
// the human would win first. Callers make sure no reply makes four itself.
function solverForks(after, human, solver) {
  const doubles = [], stacks = [];
  for (let c = 0; c < COLS; c++) {
    if (after.heights[c] >= ROWS) continue;
    const next = drop(after.cells, after.heights, c, solver);
    if (immediateWins(next.cells, next.heights, human).length) continue;
    const threats = immediateWins(next.cells, next.heights, solver);
    if (threats.length >= 2) {
      doubles.push({ c, row: next.row, cells: threats.map((t) => [t, next.heights[t]]), count: threats.length });
      continue;
    }
    const stacked = stackedThreats(next.cells, next.heights, solver);
    if (stacked.length) {
      const t = stacked[0], h = next.heights[t];
      stacks.push({ c, row: next.row, cells: [[t, h], [t, h + 1]] });
    }
  }
  return { doubles, stacks };
}

/** Moves the eventual winner still needs (counting the winning one) when the
 *  player to move, with n discs on the board, has solver score s. null for a
 *  draw. */
export function movesToWin(s, n) {
  if (s > 0) return 22 - s - Math.floor(n / 2);
  if (s < 0) return 22 + s - Math.ceil(n / 2);
  return null;
}

// ---------------------------------------------------------------- text helpers

// [2] -> "column 3"; [2, 4] -> "column 3 or 5" / "columns 3 and 5".
function colList(cols, conj = 'or') {
  const nums = cols.map((c) => c + 1);
  if (nums.length === 1) return `column ${nums[0]}`;
  const head = nums.slice(0, -1).join(', ');
  const last = nums[nums.length - 1];
  return conj === 'and' ? `columns ${head} and ${last}` : `column ${head} or ${last}`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const youWin = (k) => (k === 1 ? 'win with your next move' : `force a win in ${k} moves`);
const solverWins = (k) => (k === 1 ? 'win with its next move' : `force a win in ${k} moves`);
const solverWinsIn = (k) => (k === 1 ? 'wins with its next move' : `wins in ${k} moves`);
const colTags = (cols) => cols.map((c) => `col:${c}`);

function uniqueMarks(list) {
  const seen = new Set();
  const out = [];
  for (const [c, r] of list) {
    const key = c * ROWS + r;
    if (!seen.has(key)) { seen.add(key); out.push([c, r]); }
  }
  return out;
}

// ---------------------------------------------------------------- input checks

function setUp(moves, first, human) {
  if (first !== 1 && first !== 2) throw new Error('coach: first must be 1 or 2');
  if (human !== 1 && human !== 2) throw new Error('coach: human must be 1 or 2');
  let list = moves;
  if (typeof moves === 'string') list = stringToMoves(moves);
  if (!Array.isArray(list)) throw new Error('coach: moves must be an array of columns');
  const state = replay(list, first);
  if (!state) throw new Error('coach: the move list is not a legal game');
  return { state, list };
}

function readScores(scores, heights) {
  if (!scores || scores.length !== COLS) throw new Error('coach: scores must have 7 entries');
  const legal = [];
  for (let c = 0; c < COLS; c++) {
    if (heights[c] >= ROWS) continue;
    if (!Number.isInteger(scores[c])) throw new Error(`coach: no score for column ${c + 1}`);
    legal.push(c);
  }
  if (!legal.length) throw new Error('coach: the board is full');
  const best = Math.max(...legal.map((c) => scores[c]));
  return { legal, best, bestCols: legal.filter((c) => scores[c] === best) };
}

function humanToMove(moves, first, human, scores) {
  const { state, list } = setUp(moves, first, human);
  if (state.over) throw new Error('coach: the game is already over');
  if (state.turn !== human) throw new Error('coach: it is not the human player\'s turn');
  return { state, list, ...readScores(scores, state.heights) };
}

// ---------------------------------------------------------------- grading

/**
 * Grades the human's move and explains it.
 * @param {object} a
 * @param {number[]|string} a.moves columns played before the move
 * @param {1|2} a.first player who moved first
 * @param {1|2} a.human the human's player number (always the one to move)
 * @param {number} a.move the column the human played, 0-6
 * @param {(number|null)[]} a.scores solver scores for the human, per column, before the move
 * @param {boolean} [a.reveal=true] false for wrong answers in lessons and
 *   puzzles: text and detail then never name a best column or the column
 *   that won or blocked, and the detail gives no move count. bestCols, marks
 *   and tags are returned as usual; the page decides what to show.
 */
export function gradeMove({ moves, first, human, move, scores, reveal = true }) {
  const { state, list, legal, best, bestCols } = humanToMove(moves, first, human, scores);
  if (!legal.includes(move)) throw new Error('coach: the move is not a legal column');
  const n = list.length;
  const solver = 3 - human;
  const { cells, heights } = state;
  const s = scores[move];

  const winsNow = immediateWins(cells, heights, human);
  const threatsNow = immediateWins(cells, heights, solver);
  const after = drop(cells, heights, move, human);
  const r = after.row;
  const madeFour = completesFour(cells, move, r, human);
  const full = n + 1 === COLS * ROWS;
  const solverWinsAfter = madeFour || full ? [] : immediateWins(after.cells, after.heights, solver);

  // Grade from the scores, then the two tactical blunder rules.
  const before = outcomeOf(best);
  const outcome = outcomeOf(s);
  let grade;
  if (s === best) grade = 'best';
  else if (RANK[outcome] === RANK[before]) grade = 'good';
  else if (RANK[before] - RANK[outcome] === 1) grade = 'mistake';
  else grade = 'blunder';
  // In a lost position every move loses, so the class alone says little: grade
  // by how much sooner the solver wins than after the best move. Letting it win
  // within two moves when the best move held out four or more is a blunder;
  // shortening the game by four moves or more is a mistake.
  const bestLeft = best < 0 ? movesToWin(-best, n + 1) : null;
  const thisLeft = s < 0 ? movesToWin(-s, n + 1) : null;
  if (grade === 'good' && before === 'loss' && bestLeft !== null && thisLeft !== null) {
    if (thisLeft <= 2 && bestLeft >= 4) grade = 'blunder';
    else if (bestLeft - thisLeft >= 4) grade = 'mistake';
  }
  if (winsNow.length && !winsNow.includes(move)) grade = 'blunder';
  // Letting the solver make four at once is a blunder whenever another move
  // avoided that. Such a move always has a better score (a later loss at
  // worst), so this also applies in lost positions: a human who moves second
  // is lost from the start, and a missed block must still count.
  if (solverWinsAfter.length && grade !== 'blunder') {
    const escape = legal.some((c) => {
      if (c === move) return false;
      if (completesFour(cells, c, heights[c], human)) return true;
      const alt = drop(cells, heights, c, human);
      return immediateWins(alt.cells, alt.heights, solver).length === 0;
    });
    if (escape) grade = 'blunder';
  }

  // A four or a full board settles the count whatever the scores say. The page
  // sends +-1 for openings it only knows as win, draw or loss.
  const left = madeFour ? 0 : full ? null : movesToWin(-s, n + 1);

  const ctx = {
    cells, heights, human, solver, first, n, move, r, after, madeFour,
    winsNow, threatsNow, solverWinsAfter, grade, before, outcome, bestCols, left,
  };
  const reason = explain(ctx);
  let text = reason.text;
  // Without reveal, a text that names a best column (or the column that won
  // or blocked) is swapped for its version without column names.
  if (!reveal && reason.anon && (reason.hide || reason.named.some((c) => bestCols.includes(c)))) text = reason.anon;
  if ((grade === 'best' || grade === 'good') && before === 'loss' && CRITICISM.has(reason.tags[0])) {
    text = `${NO_SAVE} ${text}`;
  }
  let detail;
  if (reveal) detail = detailLine({ grade, before, outcome, left, bestLeft, bestCols, madeFour, full });
  else {
    detail = outcomeLine(before, outcome);
    if (detail === text) detail = '';
  }
  return {
    grade,
    title: TITLES[grade],
    text,
    detail,
    bestCols: bestCols.slice(),
    outcomeBefore: before,
    outcomeAfter: outcome,
    movesToEnd: left,
    marks: uniqueMarks(reason.marks),
    tags: reason.tags,
  };
}

// The main reason for the move, in priority order. Returns
// { text, marks, tags, named, anon, hide }: `named` lists the columns the text
// names (the middle column counts), `anon` says the same without naming them,
// and `hide` asks for `anon` whenever reveal is off, best columns or not.
function explain(x) {
  const { cells, heights, human, solver, move, r, after, grade } = x;

  // a) The move makes four.
  if (x.madeFour) {
    const marks = linesThrough(after.cells, move, r, human).flat();
    return { text: 'Four in a row.', marks, tags: ['win-now'], named: [] };
  }

  // b) A four was available elsewhere.
  if (x.winsNow.length) {
    return {
      text: `You could have won right away in ${colList(x.winsNow)}.`,
      marks: x.winsNow.map((c) => [c, heights[c]]),
      tags: ['missed-win', ...colTags(x.winsNow)],
      named: x.winsNow, anon: 'There was a four in a row available.', hide: true,
    };
  }

  // c) The solver can make four on its next move.
  if (x.solverWinsAfter.length) {
    const t = x.threatsNow;
    if (t.length >= 2) {
      return {
        text: `The solver had ${NUM[t.length]} threats, in ${colList(t, 'and')}. Only one could be blocked.`,
        marks: t.map((c) => [c, heights[c]]),
        tags: ['double-threat-before', ...colTags(t)],
        named: t, anon: `The solver had ${NUM[t.length]} threats. Only one could be blocked.`,
      };
    }
    if (t.length === 1) {
      const c = t[0], h = heights[c];
      if (isWinningCell(cells, c, h + 1, solver)) {
        // Blocking would hand over the square on top, so every move lost.
        return {
          text: `The solver threatened four in column ${c + 1}, and blocking there gives it the square on top. No move could stop both.`,
          marks: [[c, h], [c, h + 1]],
          tags: ['trapped', `col:${c}`],
          named: [c],
          anon: 'The solver threatened four, and blocking it gives the solver the square on top. No move could stop both.',
        };
      }
      // A block here would have held for a move, so the move was elsewhere.
      return {
        text: `You needed to block column ${c + 1}. The solver can make four there next move.`,
        marks: [[c, h]],
        tags: ['missed-block', `col:${c}`],
        named: [c], anon: 'This does not stop the solver\'s four.', hide: true,
      };
    }
    // No threat before: the new disc opened the square above it.
    return {
      text: 'This gives the solver the square on top of your disc, where it can make four.',
      marks: [[move, r + 1]],
      tags: ['gives-top', `col:${move}`],
      named: [],
    };
  }

  // d) A solver reply makes two threats, or a threat with another above it.
  const { doubles, stacks } = solverForks(after, human, solver);
  if (doubles.length) {
    const counts = new Set(doubles.map((d) => d.count));
    const howMany = counts.size === 1 ? NUM[doubles[0].count] : 'two or more';
    const cols = doubles.map((d) => d.c);
    return {
      text: `After this, the solver can play ${colList(cols)} and make ${howMany} threats at once. You can only block one.`,
      marks: doubles.flatMap((d) => [[d.c, d.row], ...d.cells]),
      tags: ['allows-double', ...colTags(cols)],
      named: cols, anon: `After this, the solver can make ${howMany} threats at once. You can only block one.`,
    };
  }
  if (stacks.length) {
    const cols = stacks.map((d) => d.c);
    return {
      text: `After this, the solver can play ${colList(cols)} and make a threat with another one right above it. Blocking the first hands it the second.`,
      marks: stacks.flatMap((d) => [[d.c, d.row], ...d.cells]),
      tags: ['allows-stack', ...colTags(cols)],
      named: cols,
      anon: 'After this, the solver can make a threat with another one right above it. Blocking the first hands it the second.',
    };
  }

  // e) The move makes two threats, or a threat with another above it.
  const mine = immediateWins(after.cells, after.heights, human);
  if (mine.length >= 2) {
    return {
      text: `This makes ${NUM[mine.length]} threats at once, in ${colList(mine, 'and')}. The solver can only block one.`,
      marks: mine.map((c) => [c, after.heights[c]]),
      tags: ['double-threat', ...colTags(mine)],
      named: mine, anon: `This makes ${NUM[mine.length]} threats at once. The solver can only block one.`,
    };
  }
  const myStack = stackedThreats(after.cells, after.heights, human);
  if (myStack.length) {
    const c = myStack[0], h = after.heights[c];
    return {
      text: `This makes a threat in column ${c + 1} with another right above it. The solver can only block one.`,
      marks: [[c, h], [c, h + 1]],
      tags: ['stacked-threat', `col:${c}`],
      named: [c], anon: 'This makes a threat with another right above it. The solver can only block one.',
    };
  }

  // f) The move blocks the solver's only threat.
  if (x.threatsNow.length === 1 && x.threatsNow[0] === move) {
    return {
      text: `This blocks the solver's threat in column ${move + 1}.`,
      marks: [[move, r]],
      tags: ['block', `col:${move}`],
      named: [move], anon: 'This blocks the solver\'s threat.',
    };
  }

  // One new threat the solver must answer. If it sat right above the new disc
  // before this move, the move only made it blockable.
  if (mine.length === 1) {
    const c = mine[0], h = after.heights[c];
    if (c === move && grade !== 'best' && isWinningCell(cells, move, r + 1, human)) {
      return {
        text: `This fills the square under your own threat in column ${c + 1}, row ${h + 1}, so the solver can now block it.`,
        marks: [[c, h]],
        tags: ['undercut', `col:${c}`],
        named: [c], anon: 'This fills the square under your own threat, so the solver can now block it.',
      };
    }
    // On a mistake or a blunder the threat is not the point: say what the
    // block leaves (the solver has no four of its own, so it must block).
    const bad = grade === 'mistake' || grade === 'blunder';
    const leaves = x.outcome === 'draw' ? 'hold a draw' : 'then force a win';
    const text = bad
      ? `This threatens four in column ${c + 1}, but the solver can block it and ${leaves}.`
      : `This threatens four in column ${c + 1}, so the solver has to block there.`;
    const anon = bad
      ? `This threatens four, but the solver can block it and ${leaves}.`
      : 'This threatens four, so the solver has to block it.';
    return { text, marks: [[c, h]], tags: ['threat', `col:${c}`], named: [c], anon };
  }

  const sound = grade === 'best' || grade === 'good';

  // g) A new winning cell that no disc can reach yet.
  if (sound) {
    const old = new Set(winningCells(cells, human).map(([c, rr]) => c * ROWS + rr));
    const fresh = winningCells(after.cells, human)
      .filter(([c, rr]) => !old.has(c * ROWS + rr) && rr > after.heights[c]);
    if (fresh.length) {
      const firstPlayer = human === x.first;
      const suits = (rr) => ((rr + 1) % 2 === 1) === firstPlayer;
      const pick = fresh.slice().sort((a, b) =>
        (suits(b[1]) - suits(a[1])) || (a[1] - b[1]) || (Math.abs(a[0] - 3) - Math.abs(b[0] - 3)))[0];
      const [c, rr] = pick;
      // The row rule only matters in a long game the human still wins.
      const parity = suits(rr) && x.outcome === 'win' && x.left !== null && x.left > 4
        ? ` ${firstPlayer ? 'Odd' : 'Even'}-row threats like this are strong for you later in the game, since you moved ${firstPlayer ? 'first' : 'second'}.`
        : '';
      return {
        text: `This sets up a threat at column ${c + 1}, row ${rr + 1}, which cannot be filled yet.${parity}`,
        marks: fresh,
        tags: ['new-threat', `cell:${c},${rr}`, suits(rr) ? 'parity-good' : 'parity-other'],
        named: [c], anon: `This sets up a threat that cannot be filled yet.${parity}`,
      };
    }
  }

  // h) Early middle column.
  if (sound && x.n < 8 && move === 3) {
    const k = lineCountsPerCell()[3][r];
    return {
      text: `The middle column is part of the most lines of four. This square is in ${k} of them.`,
      marks: [[3, r]],
      tags: ['center'],
      // The middle column is the largest of every row in the table.
      named: [3], anon: `This square is in ${k} lines of four, more than any other square in its row.`,
    };
  }

  return { text: plainReason(x), marks: [], tags: ['no-tactic'], named: [] };
}

// Fallback when no board pattern explains the move.
function plainReason({ grade, before, outcome, bestCols }) {
  if (grade === 'best') {
    return bestCols.length === 1 ? 'This is the best move.' : `This is one of the ${NUM[bestCols.length]} best moves.`;
  }
  if (grade === 'good') return outcome === 'win' ? 'This still wins, but more slowly.' : 'This loses sooner than it has to.';
  if (grade === 'mistake') {
    if (before === 'loss') return 'This lets the solver win a lot sooner.';
    return before === 'win' ? 'This lets the win slip to a draw.' : 'This hands the solver a winning position.';
  }
  if (before === 'win' && outcome === 'loss') return 'This turns a won game into a lost one.';
  if (before === 'loss') return 'This lets the solver win almost at once.';
  return 'A better result was available.';
}

function detailLine({ grade, before, outcome, left, bestLeft, bestCols, madeFour, full }) {
  if (madeFour) return '';
  if (full) return 'The board is full, so the game is a draw.';
  const best = cap(colList(bestCols));
  // A lost position where the move made it end sooner: say by how much.
  if ((grade === 'mistake' || grade === 'blunder') && before === 'loss' && outcome === 'loss'
      && left !== null && bestLeft !== null && bestLeft - left >= 2) {
    return `The solver can now ${solverWins(left)}. ${best} holds out ${bestLeft - left} moves longer.`;
  }
  if (grade === 'best') {
    if (outcome === 'win') return `You can still ${youWin(left)}.`;
    if (outcome === 'draw') return 'The game stays level.';
    return `Every move loses here; the solver ${solverWinsIn(left)}.`;
  }
  if (grade === 'good') {
    if (outcome === 'win') return `You can still ${youWin(left)}, but ${colList(bestCols)} wins faster.`;
    return `The solver can ${solverWins(left)}. ${best} holds out longer.`;
  }
  if (grade === 'mistake') {
    if (outcome === 'draw') return `With best play it is now a draw. ${best} kept the win.`;
    return `The solver can now ${solverWins(left)}. ${best} kept it level.`;
  }
  if (outcome === 'loss') return `${best} was the move. The solver can now ${solverWins(left)}.`;
  if (outcome === 'win') return `You can still ${youWin(left)}.`;
  return 'With best play it is now a draw.';
}

// The detail without reveal: only a change of result, no columns, no counts.
function outcomeLine(before, outcome) {
  if (before === outcome) return '';
  if (before === 'win') return outcome === 'draw' ? 'This lets the win slip to a draw.' : 'This turns a won game into a lost one.';
  return 'Now the solver can force a win.';
}

// ---------------------------------------------------------------- verdict

/**
 * The solver's verdict on a position, from the human's point of view.
 * @param {object} a
 * @param {number[]|string} a.moves
 * @param {1|2} a.first
 * @param {1|2} a.human
 * @param {number} a.score solver score for whoever is to move now
 */
export function verdict({ moves, first, human, score }) {
  const { state, list } = setUp(moves, first, human);
  if (state.over) {
    if (state.winner === human) return { outcome: 'win', movesLeft: 0, text: 'You made four in a row.' };
    if (state.winner) return { outcome: 'loss', movesLeft: 0, text: 'The solver made four in a row.' };
    return { outcome: 'draw', movesLeft: null, text: 'The game ended in a draw.' };
  }
  if (!Number.isInteger(score)) throw new Error('coach: score must be an integer');
  if (score === 0) return { outcome: 'draw', movesLeft: null, text: 'Draw with best play.' };
  const left = movesToWin(score, list.length);
  const winner = score > 0 ? state.turn : 3 - state.turn;
  if (winner === human) return { outcome: 'win', movesLeft: left, text: `You can ${youWin(left)}.` };
  return { outcome: 'loss', movesLeft: left, text: `The solver can ${solverWins(left)}.` };
}

// ---------------------------------------------------------------- hints

/**
 * A hint for the human, who is to move.
 * level 1 nudges without naming a column; level 2 names the best column(s).
 * Returns { text, cols, kind }; kind is a machine code for the nudge used.
 * Level 1 kinds, first match wins: win-now, double-threat-before, trapped,
 * block, double, top, allows-double, center (under 8 discs, and only when a
 * best move is in column 3, 4 or 5), parity.
 */
export function hint({ moves, first, human, scores, level = 1 }) {
  const { state, list, legal, bestCols } = humanToMove(moves, first, human, scores);
  const { cells, heights } = state;
  const solver = 3 - human;

  if (level >= 2) {
    if (bestCols.length > 1 && bestCols.length === legal.length) {
      return { text: 'Every column gives the same result here.', cols: bestCols.slice(), kind: 'best' };
    }
    let text = `Play ${colList(bestCols)}.`;
    if (bestCols.length === 1) {
      // Add the reason when it says what the move achieves.
      const g = gradeMove({ moves: list, first, human, move: bestCols[0], scores });
      if (HINT_REASONS.has(g.tags[0])) text += ` ${g.text}`;
    }
    return { text, cols: bestCols.slice(), kind: 'best' };
  }

  if (immediateWins(cells, heights, human).length) {
    return { text: 'You can make four in a row with this move.', cols: [], kind: 'win-now' };
  }

  const threats = immediateWins(cells, heights, solver);
  if (threats.length >= 2) {
    return {
      text: `The solver has ${NUM[threats.length]} threats. You can only block one.`,
      cols: [], kind: 'double-threat-before',
    };
  }
  if (threats.length === 1) {
    const c = threats[0];
    if (isWinningCell(cells, c, heights[c] + 1, solver)) {
      return {
        text: 'The solver threatens to make four, and blocking it gives the solver the square on top.',
        cols: [], kind: 'trapped',
      };
    }
    return { text: 'The solver threatens to make four. Block it.', cols: [], kind: 'block' };
  }

  const forcing = bestCols.some((c) => {
    const a = drop(cells, heights, c, human);
    if (immediateWins(a.cells, a.heights, solver).length) return false;
    return immediateWins(a.cells, a.heights, human).length >= 2
      || stackedThreats(a.cells, a.heights, human).length > 0;
  });
  if (forcing) return { text: 'One of your moves makes two threats at once.', cols: [], kind: 'double' };

  const poisoned = legal.filter((c) => isWinningCell(cells, c, heights[c] + 1, solver));
  if (poisoned.length) {
    const k = poisoned.length, safe = legal.length - k;
    const rest = safe === 0 ? 'No column is safe from that.'
      : safe === 1 ? 'The other column is safe from that.'
        : `The other ${NUM[safe]} columns are safe from that.`;
    return {
      text: `In ${NUM[k]} ${k === 1 ? 'column' : 'columns'}, your disc would let the solver make four right above it. ${rest}`,
      cols: [], kind: 'top',
    };
  }

  // Columns after which a solver reply makes two threats at once or a stacked
  // threat, exactly as explain() finds them. Here nobody can make four at once
  // and no column hands over the square on top, so explain() reaches that step
  // for every column. Worth saying only when some column avoids it.
  const forked = legal.filter((c) => {
    const { doubles, stacks } = solverForks(drop(cells, heights, c, human), human, solver);
    return doubles.length > 0 || stacks.length > 0;
  });
  if (forked.length && forked.length < legal.length) {
    const k = forked.length;
    return {
      text: `In ${NUM[k]} ${k === 1 ? 'column' : 'columns'}, your disc would let the solver set up two threats at once.`,
      cols: [], kind: 'allows-double',
    };
  }

  // The middle-columns nudge, only when a best move is in one of them.
  if (list.length < 8 && bestCols.some((c) => c >= 2 && c <= 4)) {
    return { text: 'Discs in the middle columns are part of the most lines of four.', cols: [], kind: 'center' };
  }
  return human === first
    ? { text: 'You moved first, so aim for threats on odd rows: 1, 3 and 5.', cols: [], kind: 'parity' }
    : { text: 'You moved second, so aim for threats on even rows: 2, 4 and 6.', cols: [], kind: 'parity' };
}
