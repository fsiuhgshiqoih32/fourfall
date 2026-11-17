// Tests for js/coach.js. Run with: node tests/coach.test.mjs
//
// 1. Helper tests on drawn boards.
// 2. Hand-built positions for every reason and every grade, level 1 hint
//    positions, and a table for gradeMove({ reveal: false }). Their solver
//    scores were recorded from c4.exe and are checked against it again when
//    the solver is available.
// 3. A property test on random positions (10-30 discs, legal, nobody has won)
//    scored by c4.exe. For every legal move it checks the grade against the
//    definition, bestCols, the move counts against the score convention, and
//    every column or cell the text names as a threat or a win, using oracles
//    built only on js/game.js; then the same move with reveal: false (no best
//    column named, no counts, everything else unchanged). Solver results are
//    cached in the temp dir.
// 4. An independent review section with its own oracle (window scan, claims
//    parsed from the text, move counts checked by a forced-win search), edge
//    cases (a win and a block at once, full columns, every move losing, the
//    last move, the human moving second) and 260 positions from other
//    generators, 10 to 41 discs.
//
// Set FOURFALL_C4 to point at another c4.exe. Without the solver, the
// property test is skipped (and says so); everything else still runs.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLS, ROWS, idx, replay, linesThrough } from '../js/game.js';
import {
  gradeMove, verdict, hint, immediateWins, winningCells, lineCountsPerCell, movesToWin,
} from '../js/coach.js';

const C4 = process.env.FOURFALL_C4 || 'C:/Users/Konne/.cache/fourfall-target/release/c4.exe';
const CACHE_FILE = join(tmpdir(), 'fourfall-coach-c4-cache.json');
const PROPERTY_POSITIONS = 150;
const SEED = 20261117;

// ---------------------------------------------------------------- tiny harness

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n        ')}`);
  }
}
const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------- oracles (game.js only)

const toMoves = (key) => Array.from(key, Number);
const inBoard = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;
const TITLE = { best: 'Best move', good: 'Good', mistake: 'Mistake', blunder: 'Blunder' };
const RANK = { loss: 0, draw: 1, win: 2 };
const cls = (s) => (s > 0 ? 'win' : s < 0 ? 'loss' : 'draw');
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

// Would a disc of p on the empty cell (c, r) make four? Uses game.js linesThrough.
function four(cells, c, r, p) {
  if (!inBoard(c, r) || cells[idx(c, r)] !== 0) return false;
  const copy = cells.slice();
  copy[idx(c, r)] = p;
  return linesThrough(copy, c, r, p).length > 0;
}
const playable = (heights) => [...Array(COLS).keys()].filter((c) => heights[c] < ROWS);
const instant = (b, p) => playable(b.heights).filter((c) => four(b.cells, c, b.heights[c], p));
const stacked = (b, p) => playable(b.heights)
  .filter((c) => four(b.cells, c, b.heights[c], p) && four(b.cells, c, b.heights[c] + 1, p));
function put(b, c, p) {
  const cells = b.cells.slice(), heights = b.heights.slice();
  const row = heights[c]++;
  cells[idx(c, row)] = p;
  return { cells, heights, row };
}

// Columns and rows a text names ("column 3", "column 3 or 5", "columns 2 and 6").
function namedCols(text) {
  const out = [];
  for (const m of text.matchAll(/\b[Cc]olumns? (\d(?:(?:, | or | and )\d)*)/g)) {
    for (const d of m[1].match(/\d/g)) out.push(Number(d) - 1);
  }
  return out;
}
const sameSet = (a, b) => assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort());

function checkStyle(s, label) {
  if (s === '') return;
  assert.match(s, /^[A-Z]/, `${label} should start with a capital: "${s}"`);
  assert.match(s, /\.$/, `${label} should end with a full stop: "${s}"`);
  assert.ok(/^[\x20-\x7E]*$/.test(s), `${label} should be plain ASCII: "${s}"`);
  assert.ok(!s.includes('!'), `${label} has an exclamation mark: "${s}"`);
  assert.ok(!s.includes('  '), `${label} has a double space: "${s}"`);
}

// "Best move" over a criticism: in a lost position a best or good move whose
// reason criticises it gets this in front.
const NO_SAVE = 'Nothing saves the game here. ';
const CRITICISM = new Set(['gives-top', 'missed-block', 'allows-double', 'allows-stack']);
const HIDDEN_DETAIL = {
  'win>draw': 'This lets the win slip to a draw.',
  'win>loss': 'This turns a won game into a lost one.',
  'draw>loss': 'Now the solver can force a win.',
};

// gradeMove with reveal: false for the same input. Everything but text and
// detail is unchanged; neither names a best column (nor the middle column when
// it is one), the column that won or blocked is never named, the detail is a
// bare change of result, and no move count appears anywhere.
function checkHidden(input, g) {
  const h = gradeMove({ ...input, reveal: false });
  for (const f of ['grade', 'title', 'bestCols', 'outcomeBefore', 'outcomeAfter', 'movesToEnd', 'marks', 'tags']) {
    assert.deepEqual(h[f], g[f], `reveal: false keeps ${f}`);
  }
  checkStyle(h.text, 'hidden text');
  checkStyle(h.detail, 'hidden detail');
  const best = new Set(g.bestCols);
  const namesBest = (s) => namedCols(s).some((c) => best.has(c)) || (best.has(3) && /middle column/.test(s));
  assert.ok(!namesBest(h.text), `hidden text names a best column: "${h.text}" (best ${[...best].map((c) => c + 1)})`);
  assert.ok(!/next move|\d+ moves|moves? longer/.test(`${h.text} ${h.detail}`), `hidden result gives a move count: "${h.text}" / "${h.detail}"`);
  const kind = g.tags[0];
  const prefix = g.text.startsWith(NO_SAVE) ? NO_SAVE : '';
  assert.ok(h.text.startsWith(prefix), 'the prefix stays');
  if (kind === 'missed-win') assert.equal(h.text, 'There was a four in a row available.');
  else if (kind === 'missed-block') assert.equal(h.text, "This does not stop the solver's four.");
  else if (!namesBest(g.text)) assert.equal(h.text, g.text, 'a text that names no best column is kept');
  else assert.equal(namedCols(h.text).length, 0, `the hidden version names no column at all: "${h.text}"`);
  const change = HIDDEN_DETAIL[`${g.outcomeBefore}>${g.outcomeAfter}`] || '';
  if (g.outcomeBefore === g.outcomeAfter) assert.equal(change, '');
  else assert.ok(change, `a change of result ${g.outcomeBefore} to ${g.outcomeAfter} has a line`);
  // The detail is dropped when it would repeat the text word for word.
  assert.equal(h.detail, change === h.text ? '' : change, 'hidden detail');
  return h;
}

// Checks one gradeMove result against the definitions, from scratch.
// Returns facts the callers count.
function checkGrade({ moves, first, human, move, scores }, g) {
  const st = replay(moves, first);
  const solver = 3 - human;
  const n = moves.length;
  const legal = playable(st.heights);
  const best = Math.max(...legal.map((c) => scores[c]));
  const bestCols = legal.filter((c) => scores[c] === best);
  const s = scores[move];

  assert.deepEqual(g.bestCols, bestCols, 'bestCols');
  assert.equal(g.outcomeBefore, cls(best), 'outcomeBefore');
  assert.equal(g.outcomeAfter, cls(s), 'outcomeAfter');

  // Facts from replaying moves.
  const winsNow = legal.filter((c) => replay([...moves, c], first).winner === human);
  const afterMove = replay([...moves, move], first);
  const madeFour = afterMove.winner === human;
  const solverWinsAfter = afterMove.over ? []
    : playable(afterMove.heights).filter((c) => replay([...moves, move, c], first).winner === solver);
  const givesFour = solverWinsAfter.length > 0;

  // Grade definition.
  let expected;
  if (s === best) expected = 'best';
  else if (cls(s) === cls(best)) expected = 'good';
  else if (RANK[cls(best)] - RANK[cls(s)] === 1) expected = 'mistake';
  else expected = 'blunder';
  // Lost positions: graded by how much sooner the solver wins (22 - t - floor(discs / 2)).
  if (expected === 'good' && cls(best) === 'loss') {
    const solverLeft = (sc) => 22 + sc - Math.floor((moves.length + 1) / 2);
    if (solverLeft(s) <= 2 && solverLeft(best) >= 4) expected = 'blunder';
    else if (solverLeft(best) - solverLeft(s) >= 4) expected = 'mistake';
  }
  if (winsNow.length && !winsNow.includes(move)) expected = 'blunder';
  if (givesFour) {
    const escape = legal.some((c) => {
      if (c === move) return false;
      const b = replay([...moves, c], first);
      if (b.winner === human) return true;
      return !playable(b.heights).some((c2) => replay([...moves, c, c2], first).winner === solver);
    });
    if (escape) expected = 'blunder';
  }
  assert.equal(g.grade, expected, `grade (score ${s}, best ${best})`);
  assert.equal(g.title, TITLE[expected], 'title');

  // movesToEnd from the score convention.
  const end = s > 0 ? (22 - s) - Math.floor(n / 2) - 1 : s < 0 ? (22 + s) - Math.ceil(n / 2) : null;
  assert.equal(g.movesToEnd, end, 'movesToEnd');

  // The convention against the solver's own numbers.
  if (winsNow.length) {
    assert.equal(best, 21 - Math.floor(n / 2), 'a win in one scores 21 - floor(n/2)');
    for (const c of winsNow) assert.equal(scores[c], best, 'every win in one has the best score');
  }
  if (madeFour) assert.equal(s, 21 - Math.floor(n / 2), 'making four scores 21 - floor(n/2)');
  if (givesFour) assert.equal(s, -(21 - Math.ceil(n / 2)), 'an instant loss scores -(21 - ceil(n/2))');

  for (const m of g.marks) {
    assert.ok(Array.isArray(m) && m.length === 2 && inBoard(m[0], m[1]), `mark ${JSON.stringify(m)} is on the board`);
  }
  checkStyle(g.text, 'text');
  checkStyle(g.detail, 'detail');
  assert.ok(g.text.length > 0, 'text is never empty');

  // The reason: every claim must hold on the board.
  const b0 = { cells: st.cells, heights: st.heights };
  const b1 = put(b0, move, human);
  const r = b1.row;
  const threatsBefore = instant(b0, solver);
  const kind = g.tags[0];
  const tagCols = g.tags.filter((t) => t.startsWith('col:')).map((t) => Number(t.slice(4)));
  const cellTag = g.tags.find((t) => t.startsWith('cell:'));
  const allowedCols = new Set(tagCols);

  // The prefix exactly when a best or good move in a lost position gets a criticism.
  const noSave = (g.grade === 'best' || g.grade === 'good') && cls(best) === 'loss' && CRITICISM.has(kind);
  assert.equal(g.text.startsWith(NO_SAVE), noSave, `"${NO_SAVE.trim()}" prefix: "${g.text}"`);
  if (noSave) assert.ok(legal.every((c) => scores[c] < 0), 'nothing saves the game: every move loses');

  switch (kind) {
    case 'win-now':
      assert.ok(madeFour, 'win-now: the move makes four');
      assert.equal(g.text, 'Four in a row.');
      assert.ok(g.marks.length >= 4, 'win-now marks the four');
      for (const [c, rr] of g.marks) assert.equal(b1.cells[idx(c, rr)], human, 'marked cell holds a human disc');
      assert.ok(g.marks.some(([c, rr]) => c === move && rr === r), 'the new disc is marked');
      break;
    case 'missed-win':
      assert.ok(!madeFour && winsNow.length > 0, 'missed-win: a win in one existed');
      sameSet(tagCols, winsNow);
      break;
    case 'double-threat-before':
      assert.ok(threatsBefore.length >= 2, 'the solver had two or more threats');
      sameSet(tagCols, threatsBefore);
      assert.ok(givesFour, 'the solver still makes four');
      assert.ok(g.text.includes(`had ${WORDS[threatsBefore.length]} threats`), 'threat count in words');
      break;
    case 'trapped': {
      assert.deepEqual(threatsBefore, tagCols, 'trapped: exactly one solver threat');
      const [c] = tagCols;
      assert.ok(four(b0.cells, c, b0.heights[c] + 1, solver), 'the square above the threat also wins for the solver');
      for (const alt of legal) {
        const b = replay([...moves, alt], first);
        assert.ok(b.winner !== human && playable(b.heights).some((c2) => replay([...moves, alt, c2], first).winner === solver),
          `"No move could stop both": column ${alt + 1} also loses at once`);
      }
      break;
    }
    case 'missed-block': {
      assert.deepEqual(threatsBefore, tagCols, 'missed-block: exactly one solver threat');
      const [c] = tagCols;
      assert.notEqual(move, c, 'the move did not block');
      assert.ok(solverWinsAfter.includes(c), 'the solver can make four there next move');
      break;
    }
    case 'gives-top':
      assert.equal(threatsBefore.length, 0, 'gives-top: no solver threat before');
      assert.deepEqual(tagCols, [move]);
      assert.ok(four(b1.cells, move, r + 1, solver), 'the square on top wins for the solver');
      assert.ok(solverWinsAfter.includes(move), 'and the solver can play it');
      break;
    case 'allows-double':
    case 'allows-stack': {
      assert.ok(!madeFour && !givesFour, `${kind}: no four on either side yet`);
      assert.ok(tagCols.length > 0, 'names a reply');
      let counts = new Set();
      for (const y of tagCols) {
        assert.ok(b1.heights[y] < ROWS, `reply column ${y + 1} is playable`);
        const b2 = put(b1, y, solver);
        assert.equal(instant(b2, human).length, 0, `after reply ${y + 1} the human cannot make four`);
        if (kind === 'allows-double') {
          const k = instant(b2, solver).length;
          assert.ok(k >= 2, `reply ${y + 1} makes two or more threats`);
          counts.add(k);
        } else {
          assert.ok(stacked(b2, solver).length > 0, `reply ${y + 1} makes a stacked threat`);
        }
      }
      if (kind === 'allows-double' && counts.size === 1) {
        assert.ok(g.text.includes(`make ${WORDS[[...counts][0]]} threats`), 'threat count in words');
      }
      // Forced loss in exactly two solver moves.
      assert.equal(s, -(20 - Math.ceil(n / 2)), `${kind}: the solver wins in two`);
      break;
    }
    case 'double-threat': {
      assert.ok(!madeFour && !givesFour, 'double-threat: no four yet, solver cannot make four');
      const mine = instant(b1, human);
      assert.ok(mine.length >= 2, 'two or more human threats');
      sameSet(tagCols, mine);
      assert.equal(s, 20 - Math.floor(n / 2), 'double-threat: the human wins with the next move');
      break;
    }
    case 'stacked-threat': {
      assert.ok(!madeFour && !givesFour, 'stacked-threat: no four yet, solver cannot make four');
      const [c] = tagCols;
      assert.ok(four(b1.cells, c, b1.heights[c], human) && four(b1.cells, c, b1.heights[c] + 1, human),
        'a playable human threat with another right above it');
      assert.equal(s, 20 - Math.floor(n / 2), 'stacked-threat: the human wins with the next move');
      break;
    }
    case 'block':
      assert.deepEqual(threatsBefore, [move], 'block: the solver had exactly this one threat');
      assert.deepEqual(tagCols, [move]);
      assert.ok(!givesFour, 'the block holds for a move');
      break;
    case 'threat':
      assert.ok(!madeFour && !givesFour, 'threat: no four on either side yet');
      assert.deepEqual(instant(b1, human), tagCols, 'exactly one new human threat');
      break;
    case 'undercut':
      assert.deepEqual(tagCols, [move]);
      assert.ok(four(b0.cells, move, r + 1, human), 'the square above was already a human winning cell');
      assert.ok(instant(b1, human).includes(move), 'and is now playable');
      assert.notEqual(g.grade, 'best');
      assert.ok(g.text.includes(`column ${move + 1}, row ${r + 2}`), 'names the threat cell');
      break;
    case 'new-threat': {
      assert.ok(cellTag, 'new-threat has a cell tag');
      const [c, rr] = cellTag.slice(5).split(',').map(Number);
      allowedCols.add(c);
      assert.ok(four(b1.cells, c, rr, human), 'the cell completes four for the human');
      assert.ok(!four(b0.cells, c, rr, human), 'and did not before the move');
      assert.ok(rr > b1.heights[c], 'and cannot be reached yet');
      assert.ok(g.text.includes(`column ${c + 1}, row ${rr + 1}`), 'names the cell');
      const suits = ((rr + 1) % 2 === 1) === (human === first);
      assert.ok(g.tags.includes(suits ? 'parity-good' : 'parity-other'), 'parity tag');
      // The row advice only when it suits, and only in a long game the human still wins.
      const advice = suits && cls(s) === 'win' && end > 4;
      assert.equal(/-row threats like this are strong for you/.test(g.text), advice, 'parity sentence only when it suits a long win');
      if (advice) assert.ok(g.text.includes(human === first ? 'Odd-row' : 'Even-row'));
      assert.ok(g.grade === 'best' || g.grade === 'good');
      for (const [mc, mr] of g.marks) assert.ok(four(b1.cells, mc, mr, human) && !four(b0.cells, mc, mr, human), 'marks are new winning cells');
      break;
    }
    case 'center':
      assert.ok(n < 8 && move === 3 && (g.grade === 'best' || g.grade === 'good'), 'center: early middle move');
      assert.ok(g.text.includes(`in ${lineCountsPerCell()[3][r]} of them`), 'line count for the square');
      break;
    case 'no-tactic':
      assert.ok(!madeFour && !winsNow.length && !givesFour, 'no-tactic: no four now or next');
      assert.equal(instant(b1, human).length, 0, 'no-tactic: no new threat');
      break;
    default:
      assert.fail(`unknown reason tag ${kind}`);
  }
  for (const c of namedCols(g.text)) assert.ok(allowedCols.has(c), `text names column ${c + 1} without backing: "${g.text}"`);

  // Detail: counts from the convention, columns only the best ones.
  if (madeFour) assert.equal(g.detail, '');
  else if (afterMove.over) assert.match(g.detail, /draw/);
  else {
    const count = g.detail.match(/in (\d+) moves/);
    const next = /with (its|your) next move/.test(g.detail);
    if (end === null) {
      assert.ok(!count && !next && /level|draw/.test(g.detail), `draw detail: "${g.detail}"`);
    } else if (end === 1) {
      assert.ok(next && !count, `one-move detail: "${g.detail}"`);
    } else {
      assert.ok(count && Number(count[1]) === end && !next, `count in detail: "${g.detail}" vs ${end}`);
    }
    if (cls(s) === 'win') assert.match(g.detail, /^You can still /);
    if (cls(s) === 'loss') assert.match(g.detail, /solver/);
    const named = namedCols(g.detail);
    if (named.length) sameSet(named, bestCols);
    if (g.grade === 'good' || g.grade === 'mistake' || (g.grade === 'blunder' && cls(s) === 'loss')) {
      assert.ok(named.length > 0, 'detail names the better column');
    }
  }

  // The verdict after the move agrees.
  const v = verdict({ moves: [...moves, move], first, human, score: -s });
  if (madeFour) assert.deepEqual([v.outcome, v.movesLeft], ['win', 0]);
  else assert.deepEqual([v.outcome, v.movesLeft], [g.outcomeAfter, g.movesToEnd], 'verdict after the move');

  // Swapping which player number moved first changes nothing.
  const swapped = gradeMove({ moves, first: 3 - first, human: 3 - human, move, scores });
  assert.deepEqual(swapped, g, 'same result with the player numbers swapped');
  assert.deepEqual(gradeMove({ moves, first, human, move, scores, reveal: true }), g, 'reveal defaults to true');

  checkHidden({ moves, first, human, move, scores }, g);

  return { kind, grade: g.grade };
}

// Checks hint() at both levels for a position, against the stated order.
function checkHints({ moves, first, human, scores }) {
  const st = replay(moves, first);
  const solver = 3 - human;
  const legal = playable(st.heights);
  const best = Math.max(...legal.map((c) => scores[c]));
  const bestCols = legal.filter((c) => scores[c] === best);
  const b0 = { cells: st.cells, heights: st.heights };

  const h2 = hint({ moves, first, human, scores, level: 2 });
  assert.deepEqual(h2.cols, bestCols, 'level 2 cols are the best columns');
  checkStyle(h2.text, 'hint 2');
  if (bestCols.length > 1 && bestCols.length === legal.length) {
    assert.equal(h2.text, 'Every column gives the same result here.');
  } else {
    const firstSentence = h2.text.split('. ')[0];
    assert.match(firstSentence, /^Play column /);
    sameSet(namedCols(firstSentence), bestCols);
  }

  const h1 = hint({ moves, first, human, scores, level: 1 });
  assert.deepEqual(h1.cols, []);
  checkStyle(h1.text, 'hint 1');
  assert.equal(namedCols(h1.text).length, 0, 'level 1 gives no column away');
  const wins = instant(b0, human);
  const threats = instant(b0, solver);
  const forcing = bestCols.some((c) => {
    const b1 = put(b0, c, human);
    if (four(b0.cells, c, b0.heights[c], human) || instant(b1, solver).length) return false;
    return instant(b1, human).length >= 2 || stacked(b1, human).length > 0;
  });
  const poisoned = legal.filter((c) => four(b0.cells, c, b0.heights[c] + 1, solver));
  // Columns after which some solver reply (one that leaves the human no four)
  // makes two threats at once or a threat with another right above it.
  const forked = legal.filter((c) => {
    const b1 = put(b0, c, human);
    return playable(b1.heights).some((y) => {
      const b2 = put(b1, y, solver);
      if (instant(b2, human).length) return false;
      return instant(b2, solver).length >= 2 || stacked(b2, solver).length > 0;
    });
  });
  let kind;
  if (wins.length) kind = 'win-now';
  else if (threats.length >= 2) kind = 'double-threat-before';
  else if (threats.length === 1) kind = four(b0.cells, threats[0], b0.heights[threats[0]] + 1, solver) ? 'trapped' : 'block';
  else if (forcing) kind = 'double';
  else if (poisoned.length) kind = 'top';
  else if (forked.length && forked.length < legal.length) kind = 'allows-double';
  else kind = moves.length < 8 && bestCols.some((c) => c >= 2 && c <= 4) ? 'center' : 'parity';
  assert.equal(h1.kind, kind, `level 1 hint kind: "${h1.text}"`);
  if (kind === 'double-threat-before') assert.ok(h1.text.includes(`has ${WORDS[threats.length]} threats`));
  if (kind === 'top') {
    assert.ok(h1.text.startsWith(`In ${WORDS[poisoned.length]} column`), `poisoned count: "${h1.text}"`);
    const safe = legal.length - poisoned.length;
    const rest = safe === 0 ? 'No column is safe from that.'
      : safe === 1 ? 'The other column is safe from that.' : `The other ${WORDS[safe]} columns are safe from that.`;
    assert.ok(h1.text.endsWith(` ${rest}`), `safe count: "${h1.text}"`);
  }
  if (kind === 'allows-double') {
    const k = forked.length;
    assert.equal(h1.text, `In ${WORDS[k]} ${k === 1 ? 'column' : 'columns'}, your disc would let the solver set up two threats at once.`);
  }
  // Whenever the hint gets this far, the count agrees with what gradeMove
  // says about each column.
  if (['allows-double', 'center', 'parity'].includes(kind)) {
    for (const c of legal) {
      const tag = gradeMove({ moves, first, human, move: c, scores }).tags[0];
      assert.equal(tag === 'allows-double' || tag === 'allows-stack', forked.includes(c), `column ${c + 1}: gradeMove says ${tag}`);
    }
  }
  if (kind === 'parity') assert.ok(h1.text.includes(human === first ? 'odd rows' : 'even rows'));
  return h1.kind;
}

// ---------------------------------------------------------------- solver access

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function runC4(key) {
  return new Promise((resolve) => {
    execFile(C4, ['analyze', key || '-'], { timeout: 120000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const parts = stdout.trim().split(/\s+/);
      if (parts.length !== COLS) return resolve(null);
      resolve(parts.map((t) => (t === 'x' ? null : Number(t))));
    });
  });
}
// Scores for many positions, two solver processes at a time, cached on disk.
async function solveAll(keys, cache) {
  const todo = [...new Set(keys)].filter((k) => !(k in cache));
  let next = 0, fresh = 0;
  async function worker() {
    while (next < todo.length) {
      const key = todo[next++];
      const scores = await runC4(key);
      if (scores) { cache[key] = scores; fresh++; }
    }
  }
  await Promise.all([worker(), worker()]);
  if (fresh) {
    try { writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch { /* cache is optional */ }
  }
  return fresh;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A random legal game of `len` discs in which nobody has made four.
// Careful players also block a single threat and avoid handing over the
// square on top when they can, which gives quieter positions.
function randomGame(rand, len, careful = false) {
  const moves = [];
  while (moves.length < len) {
    const st = replay(moves, 1);
    const me = st.turn, opp = 3 - me;
    const b = { cells: st.cells, heights: st.heights };
    const options = playable(st.heights).filter((c) => !four(b.cells, c, b.heights[c], me));
    if (!options.length) return null;
    let pool = options;
    if (careful) {
      const threats = instant(b, opp);
      const calm = options.filter((c) => threats.every((t) => t === c) && !four(b.cells, c, b.heights[c] + 1, opp));
      if (calm.length) pool = calm;
    }
    moves.push(pool[Math.floor(rand() * pool.length)]);
  }
  return moves;
}

// ---------------------------------------------------------------- hand-built cases
// Boards: X moved first (player number `first`), O second. Row 1 is the bottom.
// Each case is checked field by field and then by the full oracle check.

const CASES = [
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   O . . . . . .
  //   X X . X . . .
  //   O O O X O X .
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'a) the move makes four',
    moves: '3230005114', move: 2, scores: [4, 5, 16, 15, 6, 5, 3],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 0, bestCols: [2],
    tags: ['win-now'], marks: [[0, 1], [1, 1], [2, 1], [3, 1]],
    text: 'Four in a row.',
    detail: '',
  },
  {
    name: 'b) missed win in one, still winning',
    moves: '3230005114', move: 0, scores: [4, 5, 16, 15, 6, 5, 3],
    grade: 'blunder', before: 'win', after: 'win', movesToEnd: 12, bestCols: [2],
    tags: ['missed-win', 'col:2'], marks: [[2, 1]],
    text: 'You could have won right away in column 3.',
    detail: 'You can still force a win in 12 moves.',
  },
  //   . . . . . . .
  //   . . . . X . .
  //   . . . . O . .
  //   . . . . O . O
  //   . . . . X . O
  //   O X X . X O X
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'b) missed win in one, now a draw',
    moves: '406644251446', move: 6, scores: [-2, 3, 13, 15, -1, -2, 0],
    grade: 'blunder', before: 'win', after: 'draw', movesToEnd: null, bestCols: [3],
    tags: ['missed-win', 'col:3'], marks: [[3, 0]],
    text: 'You could have won right away in column 4.',
    detail: 'With best play it is now a draw.',
  },
  //   . . . . . . .
  //   O . . . . . .
  //   X . . . . . .
  //   X . O . . . .
  //   O . O O . . X
  //   X X O O . X X
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'c) the solver had two threats before the move',
    moves: '02605312030260', move: 0, scores: [-14, -14, -14, -14, -14, -14, -14],
    grade: 'best', before: 'loss', after: 'loss', movesToEnd: 1, bestCols: [0, 1, 2, 3, 4, 5, 6],
    tags: ['double-threat-before', 'col:1', 'col:2'], marks: [[1, 1], [2, 3]],
    text: 'The solver had two threats, in columns 2 and 3. Only one could be blocked.',
    detail: 'Every move loses here; the solver wins with its next move.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . O
  //   . . . . . . X
  //   . X X O O . O
  //   O X X O X O X
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'c) blocking the only threat gives the square on top',
    moves: '40236426651613', move: 0, scores: [-14, -14, -14, -14, -14, -14, -14],
    grade: 'best', before: 'loss', after: 'loss', movesToEnd: 1, bestCols: [0, 1, 2, 3, 4, 5, 6],
    tags: ['trapped', 'col:5'], marks: [[5, 1], [5, 2]],
    text: 'The solver threatened four in column 6, and blocking there gives it the square on top. No move could stop both.',
    detail: 'Every move loses here; the solver wins with its next move.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . X . . . .
  //   . . X . . . .
  //   O . O O . . .
  //   O X X X O . .
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'c) missed block, win to loss',
    moves: '3022142023', move: 0, scores: [-16, 4, -16, -16, -16, -16, -16],
    grade: 'blunder', before: 'win', after: 'loss', movesToEnd: 1, bestCols: [1],
    tags: ['missed-block', 'col:1'], marks: [[1, 1]],
    text: 'You needed to block column 2. The solver can make four there next move.',
    detail: 'Column 2 was the move. The solver can now win with its next move.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . . . O . . .
  //   . O . O . . .
  //   X X X O X X O
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'c) missed block in a lost position is still a blunder',
    moves: '0643231351', move: 0, scores: [-16, -16, -16, -15, -16, -16, -16],
    grade: 'blunder', before: 'loss', after: 'loss', movesToEnd: 1, bestCols: [3],
    tags: ['missed-block', 'col:3'], marks: [[3, 3]],
    text: 'You needed to block column 4. The solver can make four there next move.',
    detail: 'Column 4 was the move. The solver can now win with its next move.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . X . . .
  //   . . . O . . .
  //   . . X X . X X
  //   O O X O X O O
  //   1 2 3 4 5 6 7   (O to move)
  {
    name: 'c) missed block, draw to loss (blunder, not mistake)',
    moves: '2553266041333', move: 0, scores: [-14, -14, -14, -14, 0, -14, -14],
    grade: 'blunder', before: 'draw', after: 'loss', movesToEnd: 1, bestCols: [4],
    tags: ['missed-block', 'col:4'], marks: [[4, 1]],
    text: 'You needed to block column 5. The solver can make four there next move.',
    detail: 'Column 5 was the move. The solver can now win with its next move.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   O . . X . . .
  //   X . . O . . .
  //   O X . O . X .
  //   O X X O X O X
  //   1 2 3 4 5 6 7   (O to move)
  {
    name: 'c) the move gives the solver the square on top',
    moves: '432560501313003', move: 4, scores: [0, -2, -2, -2, -13, -2, -2],
    grade: 'blunder', before: 'draw', after: 'loss', movesToEnd: 1, bestCols: [0],
    tags: ['gives-top', 'col:4'], marks: [[4, 2]],
    text: 'This gives the solver the square on top of your disc, where it can make four.',
    detail: 'Column 1 was the move. The solver can now win with its next move.',
  },
  //   (same board as the lost-position missed block above)
  {
    name: 'd) a solver reply makes two threats (every move loses)',
    moves: '0643231351', move: 3, scores: [-16, -16, -16, -15, -16, -16, -16],
    grade: 'best', before: 'loss', after: 'loss', movesToEnd: 2, bestCols: [3],
    tags: ['allows-double', 'col:2'], marks: [[2, 1], [0, 1], [4, 1]],
    text: 'Nothing saves the game here. After this, the solver can play column 3 and make two threats at once. You can only block one.',
    detail: 'Every move loses here; the solver wins in 2 moves.',
  },
  //   . . . . . . .
  //   . . O . . . .
  //   . . X . . . .
  //   . . O . . . .
  //   . . X X . O .
  //   O X X X O O X
  //   1 2 3 4 5 6 7   (O to move)
  {
    name: 'd) a solver reply makes two threats, draw to loss',
    moves: '2422201565323', move: 2, scores: [-5, 0, -13, -13, -5, -4, -13],
    grade: 'mistake', before: 'draw', after: 'loss', movesToEnd: 2, bestCols: [1],
    tags: ['allows-double', 'col:1'], marks: [[1, 1], [0, 1], [4, 1]],
    text: 'After this, the solver can play column 2 and make two threats at once. You can only block one.',
    detail: 'The solver can now force a win in 2 moves. Column 2 kept it level.',
  },
  //   . . X . . . .
  //   . . X O . . .
  //   O . O X . . .
  //   X . X O . . O
  //   X O X X X O O
  //   O X O O X X O
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'd) a solver reply makes a stacked threat',
    moves: '125320263642430621253300', move: 6, scores: [-9, -9, null, -9, -9, -9, -8],
    grade: 'best', before: 'loss', after: 'loss', movesToEnd: 2, bestCols: [6],
    tags: ['allows-stack', 'col:5'], marks: [[5, 2], [4, 2], [4, 3]],
    text: 'Nothing saves the game here. After this, the solver can play column 6 and make a threat with another one right above it. Blocking the first hands it the second.',
    detail: 'Every move loses here; the solver wins in 2 moves.',
  },
  //   . . . . . . .
  //   . . O . . . .
  //   . X X . . . .
  //   . X O O . . .
  //   X O X X X O .
  //   X X O O X O O
  //   1 2 3 4 5 6 7   (O to move)
  {
    name: 'e) two threats at once',
    moves: '1222034133251542160', move: 4, scores: [-10, -4, -4, -11, 11, 11, -4],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 1, bestCols: [4, 5],
    tags: ['double-threat', 'col:3', 'col:5'], marks: [[3, 3], [5, 2]],
    text: 'This makes two threats at once, in columns 4 and 6. The solver can only block one.',
    detail: 'You can still win with your next move.',
  },
  //   . . . . . O .
  //   X O . . . X .
  //   X X . . . X .
  //   O O . . . O .
  //   X X . . X X O
  //   O X O X O O O
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'e) a threat with another right above it',
    moves: '1550053416505506420111', move: 3, scores: [1, 1, 1, 9, 1, null, 1],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 1, bestCols: [3],
    tags: ['stacked-threat', 'col:2'], marks: [[2, 1], [2, 2]],
    text: 'This makes a threat in column 3 with another right above it. The solver can only block one.',
    detail: 'You can still win with your next move.',
  },
  //   (same board as "missed block, win to loss")
  {
    name: 'f) the move blocks the only threat',
    moves: '3022142023', move: 1, scores: [-16, 4, -16, -16, -16, -16, -16],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 12, bestCols: [1],
    tags: ['block', 'col:1'], marks: [[1, 1]],
    text: "This blocks the solver's threat in column 2.",
    detail: 'You can still force a win in 12 moves.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . . O . X O X
  //   . X X O O O X
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'a single new threat the solver must answer',
    moves: '6364251245', move: 6, scores: [-4, -3, -1, -2, -3, -2, -1],
    grade: 'best', before: 'loss', after: 'loss', movesToEnd: 16, bestCols: [2, 6],
    tags: ['threat', 'col:6'], marks: [[6, 3]],
    text: 'This threatens four in column 7, so the solver has to block there.',
    detail: 'Every move loses here; the solver wins in 16 moves.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . X . . . X
  //   . . O . . . O
  //   X . X O X . O
  //   X O O X O O X
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'the move fills the square under its own threat',
    moves: '6602366321044225', move: 5, scores: [4, -11, 2, 2, 4, 1, 2],
    grade: 'good', before: 'win', after: 'win', movesToEnd: 12, bestCols: [0, 4],
    tags: ['undercut', 'col:5'], marks: [[5, 2]],
    text: 'This fills the square under your own threat in column 6, row 3, so the solver can now block it.',
    detail: 'You can still force a win in 12 moves, but column 1 or 5 wins faster.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   X . . . . . .
  //   X . . O . . .
  //   O . . X . . .
  //   O X O X . . O
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'g) a new threat on an odd row for the first player',
    moves: '3010320603', move: 2, scores: [5, 1, 5, 3, -2, -2, 0],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 11, bestCols: [0, 2],
    tags: ['new-threat', 'cell:1,2', 'parity-good'], marks: [[1, 2]],
    text: 'This sets up a threat at column 2, row 3, which cannot be filled yet. Odd-row threats like this are strong for you later in the game, since you moved first.',
    detail: 'You can still force a win in 11 moves.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   O . . . . . .
  //   X . . O . . .
  //   O . X O X . .
  //   X . O X X . .
  //   1 2 3 4 5 6 7   (O to move)
  {
    name: 'g) a new threat on an even row for the second player',
    moves: '32034000234', move: 4, scores: [0, -1, -1, 4, 5, 0, 1],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 11, bestCols: [4],
    tags: ['new-threat', 'cell:5,3', 'parity-good'], marks: [[5, 3]],
    text: 'This sets up a threat at column 6, row 4, which cannot be filled yet. Even-row threats like this are strong for you later in the game, since you moved second.',
    detail: 'You can still force a win in 11 moves.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   O . . . X O .
  //   O . . . X X .
  //   X . . O O X .
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'g) a new threat on a row that does not suit the player',
    moves: '5455430040', move: 3, scores: [-3, -3, 4, 7, 7, -8, -4],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 9, bestCols: [3, 4],
    tags: ['new-threat', 'cell:2,1', 'parity-other'], marks: [[2, 1], [6, 1]],
    text: 'This sets up a threat at column 3, row 2, which cannot be filled yet.',
    detail: 'You can still force a win in 9 moves.',
  },
  //   (same board as "a solver reply makes two threats, draw to loss")
  {
    name: 'g) an even-row threat for the second player in a level game: no row advice',
    moves: '2422201565323', move: 1, scores: [-5, 0, -13, -13, -5, -4, -13],
    grade: 'best', before: 'draw', after: 'draw', movesToEnd: null, bestCols: [1],
    tags: ['new-threat', 'cell:3,3', 'parity-good'], marks: [[3, 3]],
    text: 'This sets up a threat at column 4, row 4, which cannot be filled yet.',
    detail: 'The game stays level.',
  },
  //   . . . . . . .
  //   . O . . . . .
  //   . X O . . . .
  //   . X X . . . .
  //   O O X . X O O
  //   O X X X O X O
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'g) an odd-row threat for the first player, win in 3: no row advice',
    moves: '301124561511402622', move: 4, scores: [10, 8, 8, 9, 9, 9, 9],
    grade: 'good', before: 'win', after: 'win', movesToEnd: 3, bestCols: [0],
    tags: ['new-threat', 'cell:3,2', 'parity-good'], marks: [[3, 2]],
    text: 'This sets up a threat at column 4, row 3, which cannot be filled yet.',
    detail: 'You can still force a win in 3 moves, but column 1 wins faster.',
  },
  // Empty board: known theory, [-2, -1, 0, 1, 0, -1, -2] for the first player.
  {
    name: 'h) the middle column on the empty board',
    moves: '', move: 3, scores: [-2, -1, 0, 1, 0, -1, -2],
    grade: 'best', before: 'win', after: 'win', movesToEnd: 20, bestCols: [3],
    tags: ['center'], marks: [[3, 0]],
    text: 'The middle column is part of the most lines of four. This square is in 7 of them.',
    detail: 'You can still force a win in 20 moves.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   X O . . . X O
  //   O X X . O O X
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'best move in a level game',
    moves: '1561542006', move: 4, scores: [-3, -3, -3, -3, 0, -2, -2],
    grade: 'best', before: 'draw', after: 'draw', movesToEnd: null, bestCols: [4],
    tags: ['no-tactic'], marks: [],
    text: 'This is the best move.',
    detail: 'The game stays level.',
  },
  {
    name: 'good: a slower win',
    moves: '5455430040', move: 2, scores: [-3, -3, 4, 7, 7, -8, -4],
    grade: 'good', before: 'win', after: 'win', movesToEnd: 12, bestCols: [3, 4],
    tags: ['no-tactic'], marks: [],
    text: 'This still wins, but more slowly.',
    detail: 'You can still force a win in 12 moves, but column 4 or 5 wins faster.',
  },
  {
    name: 'good: a quicker loss',
    moves: '6364251245', move: 0, scores: [-4, -3, -1, -2, -3, -2, -1],
    grade: 'good', before: 'loss', after: 'loss', movesToEnd: 13, bestCols: [2, 6],
    tags: ['no-tactic'], marks: [],
    text: 'This loses sooner than it has to.',
    detail: 'The solver can force a win in 13 moves. Column 3 or 7 holds out longer.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . O X . O . X
  //   X O X . X O O
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'mistake: win to draw',
    moves: '0125462461', move: 4, scores: [-2, -2, 3, -3, 0, -2, -3],
    grade: 'mistake', before: 'win', after: 'draw', movesToEnd: null, bestCols: [2],
    tags: ['no-tactic'], marks: [],
    text: 'This lets the win slip to a draw.',
    detail: 'With best play it is now a draw. Column 3 kept the win.',
  },
  {
    name: 'mistake: win to draw on the empty board',
    moves: '', move: 2, scores: [-2, -1, 0, 1, 0, -1, -2],
    grade: 'mistake', before: 'win', after: 'draw', movesToEnd: null, bestCols: [3],
    tags: ['no-tactic'], marks: [],
    text: 'This lets the win slip to a draw.',
    detail: 'With best play it is now a draw. Column 4 kept the win.',
  },
  {
    name: 'mistake: draw to loss',
    moves: '1561542006', move: 0, scores: [-3, -3, -3, -3, 0, -2, -2],
    grade: 'mistake', before: 'draw', after: 'loss', movesToEnd: 14, bestCols: [4],
    tags: ['no-tactic'], marks: [],
    text: 'This hands the solver a winning position.',
    detail: 'The solver can now force a win in 14 moves. Column 5 kept it level.',
  },
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   X . . . . . .
  //   X . . O O . X
  //   O X O X X O O
  //   1 2 3 4 5 6 7   (X to move)
  {
    name: 'mistake: a lost position ends a lot sooner, two columns hold out longer',
    moves: '354006120364', move: 2, scores: [-9, -5, -10, -14, -14, -5, -14],
    grade: 'mistake', before: 'loss', after: 'loss', movesToEnd: 6, bestCols: [1, 5],
    tags: ['no-tactic'], marks: [],
    text: 'This lets the solver win a lot sooner.',
    detail: 'The solver can now force a win in 6 moves. Column 2 or 6 holds out 5 moves longer.',
  },
  {
    name: 'blunder: win to loss',
    moves: '5455430040', move: 0, scores: [-3, -3, 4, 7, 7, -8, -4],
    grade: 'blunder', before: 'win', after: 'loss', movesToEnd: 14, bestCols: [3, 4],
    tags: ['no-tactic'], marks: [],
    text: 'This turns a won game into a lost one.',
    detail: 'Column 4 or 5 was the move. The solver can now force a win in 14 moves.',
  },
  {
    name: 'blunder: win to loss on the empty board',
    moves: '', move: 0, scores: [-2, -1, 0, 1, 0, -1, -2],
    grade: 'blunder', before: 'win', after: 'loss', movesToEnd: 20, bestCols: [3],
    tags: ['no-tactic'], marks: [],
    text: 'This turns a won game into a lost one.',
    detail: 'Column 4 was the move. The solver can now force a win in 20 moves.',
  },
];

// Level 1 hint positions, with recorded c4 scores (re-checked below).
//   early1  X moved first, X to move; only column 6 keeps the draw:
//       . . . . . . .
//       . . . O . . .
//       . . . X . . .
//       . . . O . . .
//       . . . X . . .
//       . . X O . . .
//       1 2 3 4 5 6 7
//   early2  pearl (2) moved first, so X is pearl and O, player 1, is to move:
//       . . . . . . .
//       . . . . . . .
//       . . . . . . .
//       . . . . . O .
//       . . . X . X .
//       . . X X . O O
//       1 2 3 4 5 6 7
//   oneSafe  O to move; columns 1 and 5 each hand over the square on top:
//       . O O O . X .
//       . X X X . X O
//       . O X O . O X
//       X O X X O X X
//       O O O X O X O
//       O X O X X X O
//       1 2 3 4 5 6 7
const HINT_POSITIONS = {
  early1: { key: '233333', first: 1, scores: [-2, -1, -2, -2, -2, 0, -2] },
  early2: { key: '3555362', first: 2, scores: [-15, -13, -16, -16, -16, -16, -16] },
  oneSafe: { key: '30403652125433245533062161226111565', first: 1, scores: [-3, null, null, null, -3, null, -2] },
};
// Extra positions for the reveal: false table (recorded c4 scores, re-checked
// below), keyed by move string. 13043466554332006: playing column 1 lets the
// solver answer in column 2, the only best column, with a stacked threat.
// 4233362046 is the independent review's wording position.
const REVEAL_POSITIONS = {
  '13043466554332006': [-11, 0, -2, -11, -11, -2, -2],
  '4233362046': [4, 6, 9, 9, 5, 6, 4],
};

// Picture boards for the helper tests: top row first, X = 1, O = 2.
function fromPicture(lines) {
  const cells = new Uint8Array(COLS * ROWS);
  const heights = new Uint8Array(COLS);
  lines.forEach((line, i) => {
    const r = ROWS - 1 - i;
    for (let c = 0; c < COLS; c++) {
      const v = '.XO'.indexOf(line[c]);
      cells[idx(c, r)] = v;
      if (v) heights[c] = Math.max(heights[c], r + 1);
    }
  });
  return { cells, heights };
}

// ---------------------------------------------------------------- run

const started = Date.now();

section('Helpers');

await test('lineCountsPerCell is the standard table', () => {
  const t = lineCountsPerCell();
  const byRow = [
    [3, 4, 5, 7, 5, 4, 3],
    [4, 6, 8, 10, 8, 6, 4],
    [5, 8, 11, 13, 11, 8, 5],
    [5, 8, 11, 13, 11, 8, 5],
    [4, 6, 8, 10, 8, 6, 4],
    [3, 4, 5, 7, 5, 4, 3],
  ];
  assert.equal(t.length, 7);
  for (let c = 0; c < COLS; c++) {
    assert.equal(t[c].length, 6);
    for (let r = 0; r < ROWS; r++) assert.equal(t[c][r], byRow[r][c], `cell ${c},${r}`);
  }
  assert.equal(t.flat().reduce((a, b) => a + b, 0), 69 * 4);
  t[3][2] = 0;
  assert.equal(lineCountsPerCell()[3][2], 13, 'returns a fresh table each call');
});

await test('immediateWins and winningCells on a drawn board', () => {
  const b = fromPicture([
    '.......',
    '.......',
    '.......',
    '..XO...',
    '.XOO...',
    'XOXO...',
  ]);
  // X: diagonal 1,1 - 2,2 - 3,3 open at column 4 row 4 (playable).
  // O: column 4 three high (playable on top), and the diagonal from
  // column 2 row 1 up to column 5 row 4, which no disc can reach yet.
  assert.deepEqual(immediateWins(b.cells, b.heights, 1), [3]);
  assert.deepEqual(immediateWins(b.cells, b.heights, 2), [3]);
  assert.deepEqual(winningCells(b.cells, 1), [[3, 3]]);
  assert.deepEqual(winningCells(b.cells, 2), [[3, 3], [4, 3]]);
});

await test('winningCells finds gaps inside a line and ignores blocked windows', () => {
  const b = fromPicture([
    '.......',
    '.......',
    '.......',
    '.......',
    '.......',
    'XX.XOOO',
  ]);
  assert.deepEqual(winningCells(b.cells, 1), [[2, 0]]);
  assert.deepEqual(immediateWins(b.cells, b.heights, 1), [2]);
  assert.deepEqual(winningCells(b.cells, 2), []);
  assert.deepEqual(immediateWins(b.cells, b.heights, 2), []);
});

await test('immediateWins skips full columns', () => {
  const b = fromPicture([
    'O......',
    'X......',
    'O......',
    'X......',
    'O......',
    'X.XXX..',
  ]);
  assert.deepEqual(immediateWins(b.cells, b.heights, 1), [1, 5]);
  assert.deepEqual(winningCells(b.cells, 1), [[1, 0], [5, 0]]);
});

await test('movesToWin follows the score convention', () => {
  assert.equal(movesToWin(1, 0), 21, 'first player wins with the 21st disc');
  assert.equal(movesToWin(-1, 1), 20, 'second player to move, first player already has 1 disc');
  assert.equal(movesToWin(0, 10), null);
  // 3333332222 then column 2 makes two threats at once: a win in 2.
  assert.equal(movesToWin(15, 10), 2);
  assert.equal(movesToWin(21 - 5, 10), 1, 'a win in one with 10 discs scores 16');
  assert.equal(movesToWin(-(21 - 5), 10), 1, 'losing at once with 10 discs scores -16');
  assert.equal(movesToWin(-(21 - 6), 11), 1, 'losing at once with 11 discs scores -15');
});

section('Hand-built positions');

for (const k of CASES) {
  await test(k.name, () => {
    const moves = toMoves(k.moves);
    const st = replay(moves, 1);
    const input = { moves, first: 1, human: st.turn, move: k.move, scores: k.scores };
    const g = gradeMove(input);
    assert.equal(g.grade, k.grade, 'grade');
    assert.equal(g.title, TITLE[k.grade], 'title');
    assert.equal(g.outcomeBefore, k.before, 'outcomeBefore');
    assert.equal(g.outcomeAfter, k.after, 'outcomeAfter');
    assert.equal(g.movesToEnd, k.movesToEnd, 'movesToEnd');
    assert.deepEqual(g.bestCols, k.bestCols, 'bestCols');
    assert.deepEqual(g.tags, k.tags, 'tags');
    assert.deepEqual(g.marks, k.marks, 'marks');
    assert.equal(g.text, k.text, 'text');
    assert.equal(g.detail, k.detail, 'detail');
    checkGrade(input, g);
    // Same position with pearl (2) moving first.
    const g2 = gradeMove({ ...input, first: 2, human: 3 - st.turn });
    assert.deepEqual(g2, g, 'player numbers do not matter');
  });
}

await test('every reason and every grade is covered by the hand-built cases', () => {
  const kinds = new Set(CASES.map((k) => k.tags[0]));
  for (const want of ['win-now', 'missed-win', 'double-threat-before', 'trapped', 'missed-block', 'gives-top',
    'allows-double', 'allows-stack', 'double-threat', 'stacked-threat', 'block', 'threat', 'undercut',
    'new-threat', 'center', 'no-tactic']) assert.ok(kinds.has(want), `missing reason ${want}`);
  const grades = new Set(CASES.map((k) => `${k.grade}:${k.before}->${k.after}`));
  for (const want of ['best:win->win', 'best:draw->draw', 'best:loss->loss', 'good:win->win', 'good:loss->loss',
    'mistake:win->draw', 'mistake:draw->loss', 'mistake:loss->loss', 'blunder:win->loss', 'blunder:win->win', 'blunder:win->draw',
    'blunder:draw->loss', 'blunder:loss->loss']) assert.ok(grades.has(want), `missing grade ${want}`);
});

await test('hints at both levels on hand-built positions', () => {
  const H = (key, scores, level) => {
    const moves = toMoves(key);
    return hint({ moves, first: 1, human: replay(moves, 1).turn, scores, level });
  };
  const s1 = [4, 5, 16, 15, 6, 5, 3];
  assert.deepEqual(H('3230005114', s1, 1), { text: 'You can make four in a row with this move.', cols: [], kind: 'win-now' });
  assert.deepEqual(H('3230005114', s1, 2), { text: 'Play column 3. Four in a row.', cols: [2], kind: 'best' });
  const s2 = [-16, 4, -16, -16, -16, -16, -16];
  assert.deepEqual(H('3022142023', s2, 1), { text: 'The solver threatens to make four. Block it.', cols: [], kind: 'block' });
  assert.deepEqual(H('3022142023', s2, 2),
    { text: "Play column 2. This blocks the solver's threat in column 2.", cols: [1], kind: 'best' });
  const all14 = [-14, -14, -14, -14, -14, -14, -14];
  assert.deepEqual(H('02605312030260', all14, 1),
    { text: 'The solver has two threats. You can only block one.', cols: [], kind: 'double-threat-before' });
  assert.deepEqual(H('02605312030260', all14, 2),
    { text: 'Every column gives the same result here.', cols: [0, 1, 2, 3, 4, 5, 6], kind: 'best' });
  assert.deepEqual(H('40236426651613', all14, 1),
    { text: 'The solver threatens to make four, and blocking it gives the solver the square on top.', cols: [], kind: 'trapped' });
  assert.deepEqual(H('1550053416505506420111', [1, 1, 1, 9, 1, null, 1], 1),
    { text: 'One of your moves makes two threats at once.', cols: [], kind: 'double' });
  assert.deepEqual(H('1550053416505506420111', [1, 1, 1, 9, 1, null, 1], 2), {
    text: 'Play column 4. This makes a threat in column 3 with another right above it. The solver can only block one.',
    cols: [3], kind: 'best',
  });
  assert.deepEqual(H('1222034133251542160', [-10, -4, -4, -11, 11, 11, -4], 2),
    { text: 'Play column 5 or 6.', cols: [4, 5], kind: 'best' });
  assert.deepEqual(H('432560501313003', [0, -2, -2, -2, -13, -2, -2], 1), {
    text: 'In one column, your disc would let the solver make four right above it. The other six columns are safe from that.',
    cols: [], kind: 'top',
  });
  assert.deepEqual(H('432560501313003', [0, -2, -2, -2, -13, -2, -2], 2), { text: 'Play column 1.', cols: [0], kind: 'best' });
  assert.deepEqual(H('', [-2, -1, 0, 1, 0, -1, -2], 1),
    { text: 'Discs in the middle columns are part of the most lines of four.', cols: [], kind: 'center' });
  assert.deepEqual(H('', [-2, -1, 0, 1, 0, -1, -2], 2), {
    text: 'Play column 4. The middle column is part of the most lines of four. This square is in 7 of them.',
    cols: [3], kind: 'best',
  });
  assert.deepEqual(H('1561542006', [-3, -3, -3, -3, 0, -2, -2], 1),
    { text: 'You moved first, so aim for threats on odd rows: 1, 3 and 5.', cols: [], kind: 'parity' });
  assert.deepEqual(H('32034000234', [0, -1, -1, 4, 5, 0, 1], 1),
    { text: 'You moved second, so aim for threats on even rows: 2, 4 and 6.', cols: [], kind: 'parity' });
  // Columns 3, 4 and 7 let the solver reply with two threats at once
  // (column 2 for each); the others do not.
  assert.deepEqual(H('2422201565323', [-5, 0, -13, -13, -5, -4, -13], 1), {
    text: 'In three columns, your disc would let the solver set up two threats at once.',
    cols: [], kind: 'allows-double',
  });
  // A losing best move is named without the losing reason.
  assert.deepEqual(H('0643231351', [-16, -16, -16, -15, -16, -16, -16], 2), { text: 'Play column 4.', cols: [3], kind: 'best' });
  for (const k of CASES) {
    const moves = toMoves(k.moves);
    checkHints({ moves, first: 1, human: replay(moves, 1).turn, scores: k.scores });
  }
});

await test('level 1 hints: middle columns only when a best move is there, set-ups, one safe column', () => {
  const { early1, early2, oneSafe } = HINT_POSITIONS;
  // Under 8 discs, but only column 6 keeps the draw: no middle-columns nudge.
  const h1 = hint({ moves: early1.key, first: early1.first, human: 1, scores: early1.scores });
  assert.deepEqual(h1, { text: 'You moved first, so aim for threats on odd rows: 1, 3 and 5.', cols: [], kind: 'parity' });
  // Under 8 discs, pearl moved first, column 2 holds out longest. Five columns
  // let the solver set up two threats at once; columns 1 and 2 do not.
  const h2 = hint({ moves: early2.key, first: early2.first, human: 1, scores: early2.scores });
  assert.deepEqual(h2, { text: 'In five columns, your disc would let the solver set up two threats at once.', cols: [], kind: 'allows-double' });
  for (let c = 0; c < COLS; c++) {
    const tag = gradeMove({ moves: early2.key, first: early2.first, human: 1, move: c, scores: early2.scores }).tags[0];
    assert.equal(tag === 'allows-double' || tag === 'allows-stack', c >= 2, `column ${c + 1}: ${tag}`);
  }
  // Exactly one safe column: "The other column", not "The other one column".
  const h3 = hint({ moves: oneSafe.key, first: 1, human: replay(toMoves(oneSafe.key), 1).turn, scores: oneSafe.scores });
  assert.deepEqual(h3, {
    text: 'In two columns, your disc would let the solver make four right above it. The other column is safe from that.',
    cols: [], kind: 'top',
  });
  // The middle-columns nudge stays when a middle column is among the best
  // (the independent review's E10, best columns 3, 4, 5 and 7).
  assert.equal(hint({ moves: '334012', first: 1, human: 1, scores: [-5, -3, -2, -2, -2, -4, -2] }).kind, 'center');
  for (const { key, first, scores } of Object.values(HINT_POSITIONS)) {
    for (const f of [first, 3 - first]) {
      const moves = toMoves(key);
      checkHints({ moves, first: f, human: replay(moves, f).turn, scores });
    }
  }
});

await test('reveal: false names no answer and gives no counts', () => {
  const scoresOf = (key) => {
    if (key in REVEAL_POSITIONS) return REVEAL_POSITIONS[key];
    return CASES.find((k) => k.moves === key).scores;
  };
  // [moves, move, text, detail] for reveal: false.
  const table = [
    // The winning or blocking column is never named.
    ['3230005114', 0, 'There was a four in a row available.', ''],
    ['406644251446', 6, 'There was a four in a row available.', 'This lets the win slip to a draw.'],
    ['3022142023', 0, "This does not stop the solver's four.", 'This turns a won game into a lost one.'],
    ['2553266041333', 0, "This does not stop the solver's four.", 'Now the solver can force a win.'],
    // A solver reply in a best column is not named; one elsewhere is.
    ['2422201565323', 2, 'After this, the solver can make two threats at once. You can only block one.', 'Now the solver can force a win.'],
    ['13043466554332006', 0, 'After this, the solver can make a threat with another one right above it. Blocking the first hands it the second.',
      'Now the solver can force a win.'],
    ['0643231351', 3, 'Nothing saves the game here. After this, the solver can play column 3 and make two threats at once. You can only block one.', ''],
    ['125320263642430621253300', 6,
      'Nothing saves the game here. After this, the solver can play column 6 and make a threat with another one right above it. Blocking the first hands it the second.', ''],
    // Every move loses at once, so every column is a best one.
    ['02605312030260', 0, 'The solver had two threats. Only one could be blocked.', ''],
    ['40236426651613', 0, 'The solver threatened four, and blocking it gives the solver the square on top. No move could stop both.', ''],
    // Texts about the move itself lose a column name that is a best column.
    ['1222034133251542160', 4, 'This makes two threats at once. The solver can only block one.', ''],
    ['3022142023', 1, "This blocks the solver's threat.", ''],
    ['6364251245', 6, 'This threatens four, so the solver has to block it.', ''],
    ['4233362046', 5, 'This sets up a threat that cannot be filled yet.', ''],
    ['', 3, 'This square is in 7 lines of four, more than any other square in its row.', ''],
    // ...and keep one that is not (column 2 and column 6 are not best columns here).
    ['3010320603', 2, 'This sets up a threat at column 2, row 3, which cannot be filled yet. Odd-row threats like this are strong for you later in the game, since you moved first.', ''],
    ['6602366321044225', 5, 'This fills the square under your own threat in column 6, row 3, so the solver can now block it.', ''],
    // The detail is the change of result only, and never repeats the text.
    ['1561542006', 0, 'This hands the solver a winning position.', 'Now the solver can force a win.'],
    ['0125462461', 4, 'This lets the win slip to a draw.', ''],
    ['5455430040', 0, 'This turns a won game into a lost one.', ''],
    ['6364251245', 0, 'This loses sooner than it has to.', ''],
    ['354006120364', 2, 'This lets the solver win a lot sooner.', ''],
  ];
  for (const [key, move, text, detail] of table) {
    const moves = toMoves(key);
    for (const first of [1, 2]) {
      const input = { moves, first, human: replay(moves, first).turn, move, scores: scoresOf(key) };
      const g = gradeMove(input);
      assert.deepEqual(gradeMove({ ...input, reveal: true }), g, 'reveal: true changes nothing');
      const h = checkHidden(input, g);
      assert.deepEqual([h.text, h.detail], [text, detail], `${key} column ${move + 1}`);
    }
  }
});

await test('verdict from either side of the board', () => {
  assert.deepEqual(verdict({ moves: [], first: 1, human: 1, score: 1 }),
    { outcome: 'win', movesLeft: 21, text: 'You can force a win in 21 moves.' });
  assert.deepEqual(verdict({ moves: [], first: 1, human: 2, score: 1 }),
    { outcome: 'loss', movesLeft: 21, text: 'The solver can force a win in 21 moves.' });
  assert.deepEqual(verdict({ moves: '1561542006', first: 1, human: 1, score: 0 }),
    { outcome: 'draw', movesLeft: null, text: 'Draw with best play.' });
  // Solver to move after the human blocked: the human still wins in 12.
  assert.deepEqual(verdict({ moves: '30221420231', first: 1, human: 1, score: -4 }),
    { outcome: 'win', movesLeft: 12, text: 'You can force a win in 12 moves.' });
  // Solver to move after two threats at once.
  assert.deepEqual(verdict({ moves: '12220341332515421604', first: 1, human: 2, score: -11 }),
    { outcome: 'win', movesLeft: 1, text: 'You can win with your next move.' });
  // Human to move, every move loses at once.
  assert.deepEqual(verdict({ moves: '02605312030260', first: 1, human: 1, score: -14 }),
    { outcome: 'loss', movesLeft: 1, text: 'The solver can win with its next move.' });
  // Same with pearl moving first.
  assert.deepEqual(verdict({ moves: '02605312030260', first: 2, human: 2, score: -14 }),
    { outcome: 'loss', movesLeft: 1, text: 'The solver can win with its next move.' });
  // Finished games.
  assert.deepEqual(verdict({ moves: '32300051142', first: 1, human: 1 }),
    { outcome: 'win', movesLeft: 0, text: 'You made four in a row.' });
  assert.deepEqual(verdict({ moves: '32300051142', first: 1, human: 2 }),
    { outcome: 'loss', movesLeft: 0, text: 'The solver made four in a row.' });
});

await test('bad input is refused', () => {
  const scores = [4, 5, 16, 15, 6, 5, 3];
  assert.throws(() => gradeMove({ moves: '3230005114', first: 1, human: 2, move: 2, scores }), /turn/);
  assert.throws(() => gradeMove({ moves: '3333333', first: 1, human: 2, move: 2, scores }), /legal game/);
  assert.throws(() => gradeMove({ moves: '32300051142', first: 1, human: 2, move: 2, scores }), /over/);
  assert.throws(() => gradeMove({ moves: '3230005114', first: 1, human: 1, move: 7, scores }), /legal column/);
  assert.throws(() => gradeMove({ moves: '3230005114', first: 1, human: 1, move: 2, scores: [4, 5, null, 15, 6, 5, 3] }), /no score/);
  assert.throws(() => gradeMove({ moves: '3230005114', first: 3, human: 1, move: 2, scores }), /first/);
  assert.throws(() => hint({ moves: '3230005114', first: 1, human: 2, scores }), /turn/);
  assert.throws(() => verdict({ moves: '3230005114', first: 1, human: 1, score: 1.5 }), /integer/);
  // A full column needs no score, and moving there is refused.
  const full = '33333322';
  const st = replay(toMoves(full), 1);
  assert.throws(() => gradeMove({ moves: full, first: 1, human: st.turn, move: 3, scores: [0, 0, 0, null, 0, 0, 0] }), /legal column/);
  assert.doesNotThrow(() => gradeMove({ moves: full, first: 1, human: st.turn, move: 2, scores: [0, 0, 0, null, 0, 0, 0] }));
});

section('Solver checks');

const solverThere = existsSync(C4);
let property = null;
if (!solverThere) {
  console.log(`  SKIP  c4.exe not found at ${C4}; set FOURFALL_C4 to run the solver checks`);
} else {
  const cache = loadCache();

  await test('recorded hand-built scores match the solver (233333 takes a few seconds once)', async () => {
    const keys = [...new Set(CASES.map((k) => k.moves).filter((k) => k.length >= 10))];
    const hintKeys = Object.values(HINT_POSITIONS).map((p) => p.key);
    await solveAll([...keys, ...hintKeys, ...Object.keys(REVEAL_POSITIONS)], cache);
    for (const k of CASES) {
      if (k.moves.length < 10) continue;
      assert.ok(cache[k.moves], `solver answered for ${k.moves}`);
      assert.deepEqual(cache[k.moves], k.scores, `scores for ${k.moves}`);
    }
    for (const { key, scores } of Object.values(HINT_POSITIONS)) assert.deepEqual(cache[key], scores, `scores for ${key}`);
    for (const [key, scores] of Object.entries(REVEAL_POSITIONS)) assert.deepEqual(cache[key], scores, `scores for ${key}`);
  });

  await test(`property test: ${PROPERTY_POSITIONS} wild + ${PROPERTY_POSITIONS} careful random positions, every legal move`, async () => {
    const rand = mulberry32(SEED);
    const picked = [];
    const seen = new Set();
    let fresh = 0;
    for (const careful of [false, true]) {
      const want = picked.length + PROPERTY_POSITIONS;
      while (picked.length < want) {
        const batch = [];
        while (batch.length < (want - picked.length) + 10) {
          const len = 10 + Math.floor(rand() * 21);
          const first = rand() < 0.5 ? 1 : 2;
          const moves = randomGame(rand, len, careful);
          if (!moves) continue;
          const key = moves.join('');
          if (seen.has(key)) continue;
          seen.add(key);
          batch.push({ key, moves, first });
        }
        fresh += await solveAll(batch.map((p) => p.key), cache);
        for (const p of batch) {
          if (cache[p.key] && picked.length < want) picked.push(p);
        }
      }
    }
    const kinds = {}, grades = {}, hintKinds = {};
    let movesChecked = 0;
    for (const { key, moves, first } of picked) {
      const scores = cache[key];
      const st = replay(moves, first);
      assert.ok(st && !st.over && moves.length >= 10 && moves.length <= 30, `position ${key} is legal and open`);
      const human = st.turn;
      for (let c = 0; c < COLS; c++) {
        assert.equal(scores[c] === null, st.heights[c] >= ROWS, `solver marks full columns in ${key}`);
        if (st.heights[c] >= ROWS) continue;
        const input = { moves, first, human, move: c, scores };
        const g = gradeMove(input);
        try {
          const { kind, grade } = checkGrade(input, g);
          kinds[kind] = (kinds[kind] || 0) + 1;
          grades[grade] = (grades[grade] || 0) + 1;
        } catch (err) {
          err.message = `position ${key} (first ${first}), move column ${c + 1}: ${err.message}\n` +
            `  scores ${JSON.stringify(scores)}\n  result ${JSON.stringify(g)}`;
          throw err;
        }
        movesChecked++;
      }
      // The verdict for the position itself.
      const legal = playable(st.heights);
      const best = Math.max(...legal.map((c) => scores[c]));
      const v = verdict({ moves, first, human, score: best });
      const left = best > 0 ? (22 - best) - Math.floor(moves.length / 2)
        : best < 0 ? (22 + best) - Math.ceil(moves.length / 2) : null;
      assert.deepEqual([v.outcome, v.movesLeft], [cls(best), left], `verdict for ${key}`);
      checkStyle(v.text, 'verdict');
      if (left > 1) assert.ok(v.text.includes(`in ${left} moves`), v.text);
      try {
        const k = checkHints({ moves, first, human, scores });
        hintKinds[k] = (hintKinds[k] || 0) + 1;
      } catch (err) {
        err.message = `hints for ${key} (first ${first}): ${err.message}`;
        throw err;
      }
    }
    property = { positions: picked.length, movesChecked, fresh, kinds, grades, hintKinds };
  });
}

// ---------------------------------------------------------------- independent review
// A second, independent set of checks written during review. It shares no
// oracle code with the checks above:
// - fours come from its own scan of the 69 windows (not coach's run counter,
//   not game.js linesThrough);
// - every claim is read back from the text a player sees (regular expressions
//   on text and detail), not from the tags;
// - move counts are checked with a brute-force forced-win search, not with
//   the score formula, for every count up to 3;
// - the positions come from other generators (uniform, threat-seeking and
//   centre-weighted play, 10 to 41 discs, including the last move).

const RV_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const RV_WIN_AT = (() => {
  const at = Array.from({ length: COLS * ROWS }, () => []);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const w = [];
      for (let k = 0; k < 4; k++) {
        const cc = c + dc * k, rr = r + dr * k;
        if (cc >= 0 && cc < COLS && rr >= 0 && rr < ROWS) w.push(cc * ROWS + rr);
      }
      if (w.length === 4) for (const i of w) at[i].push(w);
    }
  }
  return at;
})();
// Empty cell (c, r) where a disc of p completes a window.
function rvWins(cells, c, r, p) {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS || cells[c * ROWS + r] !== 0) return false;
  const i = c * ROWS + r;
  return RV_WIN_AT[i].some((w) => w.every((j) => j === i || cells[j] === p));
}
const rvLegal = (h) => [0, 1, 2, 3, 4, 5, 6].filter((c) => h[c] < ROWS);
const rvNow = (cells, h, p) => rvLegal(h).filter((c) => rvWins(cells, c, h[c], p));
function rvPlay(cells, h, c, p) {
  const c2 = cells.slice(), h2 = h.slice();
  c2[c * ROWS + h2[c]++] = p;
  return [c2, h2];
}
// Can `att` force four within k of its own moves, with `mover` to move?
function rvForce(cells, h, mover, att, k) {
  const legal = rvLegal(h);
  if (!legal.length) return false;
  const def = 3 - att;
  if (mover === att) {
    for (const c of legal) if (rvWins(cells, c, h[c], att)) return true;
    if (k <= 1) return false;
    return legal.some((c) => { const [a, b] = rvPlay(cells, h, c, att); return rvForce(a, b, def, att, k - 1); });
  }
  for (const c of legal) if (rvWins(cells, c, h[c], def)) return false;
  return legal.every((c) => { const [a, b] = rvPlay(cells, h, c, def); return rvForce(a, b, att, att, k); });
}
function rvFastest(cells, h, mover, att, limit) {
  for (let k = 1; k <= limit; k++) if (rvForce(cells, h, mover, att, k)) return k;
  return Infinity;
}
function rvCols(s) {
  const out = [];
  for (const m of s.matchAll(/\b[Cc]olumns? (\d(?:(?:, | or | and )\d)*)/g)) for (const d of m[1].match(/\d/g)) out.push(+d - 1);
  return out;
}
const rvSame = (a, b, msg) => assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort(), msg);

function rvStyle(s, label) {
  assert.equal(typeof s, 'string', `${label} is a string`);
  if (s === '') return;
  assert.match(s, /^[A-Z]/, `${label}: capital first: "${s}"`);
  assert.match(s, /\.$/, `${label}: full stop: "${s}"`);
  assert.ok(/^[\x20-\x7E]*$/.test(s), `${label}: plain ASCII (no emoji, straight quotes): "${s}"`);
  assert.ok(!s.includes('!'), `${label}: no exclamation mark: "${s}"`);
  assert.ok(!/ {2}/.test(s), `${label}: no double space: "${s}"`);
  assert.ok(!/\b(computer|bot|AI|opponent|engine|CPU)\b/i.test(s), `${label}: the opponent is "the solver": "${s}"`);
  for (const m of s.matchAll(/\b[Cc]olumns? ((?:\d+(?:, | or | and )?)+)/g)) {
    for (const d of m[1].match(/\d+/g)) assert.ok(+d >= 1 && +d <= 7, `${label}: column ${d} is 1-based: "${s}"`);
  }
  for (const m of s.matchAll(/\brows? (\d+)/g)) assert.ok(+m[1] >= 1 && +m[1] <= 6, `${label}: row ${m[1]}: "${s}"`);
  for (const m of s.matchAll(/(?<!^)(?<!\. )\b([A-Z][a-z]+)/g)) assert.fail(`${label}: sentence case, "${m[1]}" mid-sentence: "${s}"`);
}

const rvStats = { positions: 0, moves: 0, searched: 0, secondMover: 0, texts: {}, hints: {} };

// Grades one move and checks every claim in its text and detail.
function rvCheckMove(key, first, scores, move) {
  const moves = toMoves(key);
  const st = replay(moves, first);
  const human = st.turn, solver = 3 - human, n = moves.length;
  const g = gradeMove({ moves: key, first, human, move, scores });
  rvStats.moves++;
  if (human !== first) rvStats.secondMover++;
  const legal = rvLegal(st.heights);
  const best = Math.max(...legal.map((c) => scores[c]));
  const bestCols = legal.filter((c) => scores[c] === best);
  const s = scores[move];
  const [a1, h1] = rvPlay(st.cells, st.heights, move, human);
  const r = h1[move] - 1;
  const madeFour = rvWins(st.cells, move, r, human);
  const full = n + 1 === COLS * ROWS;
  const winsNow = rvNow(st.cells, st.heights, human);
  const thr = rvNow(st.cells, st.heights, solver);
  const solverNext = madeFour || full ? [] : rvNow(a1, h1, solver);
  const mine = madeFour ? [] : rvNow(a1, h1, human);

  // Grade: the escape test uses the solver's scores, not the board.
  let want = s === best ? 'best' : cls(s) === cls(best) ? 'good'
    : RANK[cls(best)] - RANK[cls(s)] === 1 ? 'mistake' : 'blunder';
  if (want === 'good' && cls(best) === 'loss') {
    const left = (sc) => 22 + sc - Math.floor((n + 1) / 2);
    if (left(s) <= 2 && left(best) >= 4) want = 'blunder';
    else if (left(best) - left(s) >= 4) want = 'mistake';
  }
  if (winsNow.length && !winsNow.includes(move)) want = 'blunder';
  if (solverNext.length && legal.some((c) => c !== move && scores[c] > s)) want = 'blunder';
  assert.equal(g.grade, want, `grade (score ${s}, best ${best})`);
  assert.equal(g.title, TITLE[want]);
  rvSame(g.bestCols, bestCols, 'bestCols');
  assert.deepEqual([g.outcomeBefore, g.outcomeAfter], [cls(best), cls(s)], 'outcomes');
  if (madeFour) assert.equal(s, Math.floor((43 - n) / 2), 'a four scores (43 - n) div 2');
  if (solverNext.length) assert.equal(s, -Math.floor((42 - n) / 2), 'losing at once scores -((42 - n) div 2)');

  // movesToEnd by search: the position after the move, solver to move.
  const end = g.movesToEnd;
  if (madeFour) assert.equal(end, 0, 'movesToEnd after four');
  else if (full) { assert.equal(end, null, 'last move: a draw'); assert.equal(s, 0, 'last move scores 0'); }
  else if (s === 0) {
    assert.equal(end, null, 'draw has no count');
    assert.ok(!rvForce(a1, h1, solver, solver, 2) && !rvForce(a1, h1, solver, human, 2), 'draw: nobody forces four within 2');
  } else {
    rvStats.searched++;
    const k = rvFastest(a1, h1, solver, s > 0 ? human : solver, Math.min(3, end));
    if (end <= 3) assert.equal(k, end, `movesToEnd ${end} against the search`);
    else assert.equal(k, Infinity, `movesToEnd ${end}, but the search finds a win in ${k}`);
  }

  // The text, claim by claim. A leading "Nothing saves the game here." is
  // read off first and checked once the reason is known.
  const t0 = g.text;
  rvStyle(t0, 'text');
  rvStyle(g.detail, 'detail');
  const rvNoSave = 'Nothing saves the game here. ';
  const saved = t0.startsWith(rvNoSave);
  const t = saved ? t0.slice(rvNoSave.length) : t0;
  const named = rvCols(t);
  let m, kind;
  if (t === 'Four in a row.') {
    kind = 'four';
    assert.ok(madeFour);
  } else if ((m = t.match(/^You could have won right away in (.+)\.$/))) {
    kind = 'missed-win';
    assert.ok(!madeFour && winsNow.length);
    rvSame(named, winsNow, 'the columns that won at once');
  } else if ((m = t.match(/^The solver had (\w+) threats, in (.+)\. Only one could be blocked\.$/))) {
    kind = 'had-threats';
    assert.equal(RV_WORD[m[1]], thr.length);
    assert.ok(thr.length >= 2 && !winsNow.length);
    rvSame(named, thr, 'the threat columns');
    for (const c of legal) assert.ok(rvNow(...rvPlay(st.cells, st.heights, c, human), solver).length, `column ${c + 1} loses at once too`);
  } else if ((m = t.match(/^The solver threatened four in column (\d), and blocking there gives it the square on top\. No move could stop both\.$/))) {
    kind = 'trapped';
    const c = +m[1] - 1;
    assert.deepEqual(thr, [c]);
    assert.ok(rvWins(st.cells, c, st.heights[c] + 1, solver), 'the square on top wins for the solver');
    for (const x of legal) assert.ok(rvNow(...rvPlay(st.cells, st.heights, x, human), solver).length, `"No move could stop both": column ${x + 1}`);
  } else if ((m = t.match(/^You needed to block column (\d)\. The solver can make four there next move\.$/))) {
    kind = 'missed-block';
    const c = +m[1] - 1;
    assert.ok(thr.includes(c) && move !== c && solverNext.includes(c));
    assert.equal(rvNow(...rvPlay(st.cells, st.heights, c, human), solver).length, 0, 'the block would have held for a move');
  } else if (t === 'This gives the solver the square on top of your disc, where it can make four.') {
    kind = 'gives-top';
    assert.equal(thr.length, 0, 'no threat before the move');
    assert.ok(rvWins(a1, move, r + 1, solver) && h1[move] === r + 1);
  } else if ((m = t.match(/^After this, the solver can play (.+?) and make (\w+(?: or more)?) threats at once\. You can only block one\.$/))) {
    kind = 'allows-double';
    const counts = new Set();
    for (const y of named) {
      assert.ok(h1[y] < ROWS && !rvWins(a1, y, h1[y], solver), `reply ${y + 1} is playable and is not itself four`);
      const [b, hh] = rvPlay(a1, h1, y, solver);
      assert.equal(rvNow(b, hh, human).length, 0, `after reply ${y + 1} you cannot make four`);
      const k = rvNow(b, hh, solver).length;
      assert.ok(k >= 2, `reply ${y + 1} makes ${k} threats`);
      counts.add(k);
    }
    if (m[2] === 'two or more') assert.ok(counts.size > 1);
    else assert.deepEqual([...counts], [RV_WORD[m[2]]], 'threat count in words');
    const all = rvLegal(h1).filter((y) => {
      const [b, hh] = rvPlay(a1, h1, y, solver);
      return !rvWins(a1, y, h1[y], solver) && !rvNow(b, hh, human).length && rvNow(b, hh, solver).length >= 2;
    });
    rvSame(named, all, 'every such reply is named');
    assert.ok(rvForce(a1, h1, solver, solver, 2), 'the solver forces four within two moves');
  } else if ((m = t.match(/^After this, the solver can play (.+?) and make a threat with another one right above it\. Blocking the first hands it the second\.$/))) {
    kind = 'allows-stack';
    for (const y of named) {
      const [b, hh] = rvPlay(a1, h1, y, solver);
      assert.equal(rvNow(b, hh, human).length, 0, `after reply ${y + 1} you cannot make four`);
      assert.ok(rvLegal(hh).some((c) => rvWins(b, c, hh[c], solver) && rvWins(b, c, hh[c] + 1, solver)), `reply ${y + 1} stacks two threats`);
      assert.ok(rvForce(b, hh, human, solver, 1), `reply ${y + 1} wins next move whatever you do`);
    }
    assert.ok(rvForce(a1, h1, solver, solver, 2));
  } else if ((m = t.match(/^This makes (\w+) threats at once, in (.+)\. The solver can only block one\.$/))) {
    kind = 'double-threat';
    assert.equal(RV_WORD[m[1]], mine.length);
    rvSame(named, mine);
    assert.ok(mine.length >= 2 && !solverNext.length);
    assert.ok(rvForce(a1, h1, solver, human, 1), 'you win with your next move whatever the solver does');
  } else if ((m = t.match(/^This makes a threat in column (\d) with another right above it\. The solver can only block one\.$/))) {
    kind = 'stacked-threat';
    const c = +m[1] - 1;
    assert.ok(rvWins(a1, c, h1[c], human) && rvWins(a1, c, h1[c] + 1, human) && !solverNext.length);
    assert.ok(rvForce(a1, h1, solver, human, 2));
  } else if ((m = t.match(/^This blocks the solver's threat in column (\d)\.$/))) {
    kind = 'block';
    assert.equal(+m[1] - 1, move);
    assert.deepEqual(thr, [move], 'the solver had this one threat');
  } else if ((m = t.match(/^This threatens four in column (\d), (?:so the solver has to block there|but the solver can block it and (hold a draw|then force a win))\.$/))) {
    kind = 'threat';
    assert.deepEqual(mine, [+m[1] - 1]);
    assert.equal(solverNext.length, 0, 'the solver cannot win first, so it has to block');
    // A threat on a mistake or blunder must not read like praise.
    const bad = g.grade === 'mistake' || g.grade === 'blunder';
    assert.equal(Boolean(m[2]), bad, `threat wording fits the grade: "${t}"`);
    if (m[2]) assert.equal(m[2], cls(s) === 'draw' ? 'hold a draw' : 'then force a win', 'what the block leaves');
    if (m[2] === 'then force a win') assert.equal(cls(s), 'loss');
  } else if ((m = t.match(/^This fills the square under your own threat in column (\d), row (\d), so the solver can now block it\.$/))) {
    kind = 'undercut';
    assert.deepEqual([+m[1] - 1, +m[2] - 1], [move, r + 1]);
    assert.ok(rvWins(st.cells, move, r + 1, human), 'it was your winning square before');
    assert.ok(mine.includes(move) && !solverNext.length && g.grade !== 'best');
  } else if ((m = t.match(/^This sets up a threat at column (\d), row (\d), which cannot be filled yet\.(?: (Odd|Even)-row threats like this are strong for you later in the game, since you moved (first|second)\.)?$/))) {
    kind = 'new-threat';
    const c = +m[1] - 1, rr = +m[2] - 1;
    assert.ok(rvWins(a1, c, rr, human) && !rvWins(st.cells, c, rr, human), 'a new winning square for you');
    assert.ok(rr > h1[c], 'no disc can reach it yet');
    const firstMover = human === first;
    const longWin = cls(s) === 'win' && end > 4;
    assert.equal(Boolean(m[3]), ((rr + 1) % 2 === 1) === firstMover && longWin, 'row advice only when it suits you in a long win');
    if (m[3]) assert.deepEqual([m[3], m[4]], firstMover ? ['Odd', 'first'] : ['Even', 'second']);
    assert.ok((g.grade === 'best' || g.grade === 'good') && !mine.length && !solverNext.length);
  } else if ((m = t.match(/^The middle column is part of the most lines of four\. This square is in (\d+) of them\.$/))) {
    kind = 'center';
    assert.ok(move === 3 && n < 8);
    assert.equal(+m[1], RV_WIN_AT[3 * ROWS + r].length);
    for (let c = 0; c < COLS; c++) assert.ok(RV_WIN_AT[c * ROWS + r].length <= +m[1], 'the most in its row');
  } else {
    kind = 'plain';
    const fits = {
      'This is the best move.': g.grade === 'best' && bestCols.length === 1,
      'This still wins, but more slowly.': g.grade === 'good' && cls(s) === 'win',
      'This loses sooner than it has to.': g.grade === 'good' && cls(s) === 'loss',
      'This lets the win slip to a draw.': cls(best) === 'win' && cls(s) === 'draw',
      'This hands the solver a winning position.': cls(best) === 'draw' && cls(s) === 'loss',
      'This turns a won game into a lost one.': cls(best) === 'win' && cls(s) === 'loss',
      'This lets the solver win a lot sooner.': g.grade === 'mistake' && cls(best) === 'loss' && cls(s) === 'loss',
      'This lets the solver win almost at once.': g.grade === 'blunder' && cls(best) === 'loss' && cls(s) === 'loss',
    };
    const several = t.match(/^This is one of the (\w+) best moves\.$/);
    if (several) assert.ok(g.grade === 'best' && RV_WORD[several[1]] === bestCols.length && bestCols.length > 1, t);
    else assert.ok(fits[t], `plain text fits the grade: "${t}" (${g.grade}, ${cls(best)} to ${cls(s)})`);
    assert.ok(!madeFour && !winsNow.length && !solverNext.length && !mine.length, `plain text hides no four or threat: "${t}"`);
  }
  rvStats.texts[kind] = (rvStats.texts[kind] || 0) + 1;
  // Praise over criticism: a best or good move in a lost position never shows
  // a bare criticism.
  const critic = ['gives-top', 'missed-block', 'allows-double', 'allows-stack'].includes(kind);
  assert.equal(saved, critic && (g.grade === 'best' || g.grade === 'good') && cls(best) === 'loss', `"Nothing saves" prefix fits: "${t0}"`);
  if (saved) assert.ok(legal.every((c) => scores[c] < 0), 'nothing saves the game: every move loses');

  // The same move without reveal: the answer stays hidden.
  const hid = gradeMove({ moves: key, first, human, move, scores, reveal: false });
  rvStyle(hid.text, 'hidden text');
  rvStyle(hid.detail, 'hidden detail');
  assert.deepEqual([hid.grade, hid.tags, hid.marks, hid.bestCols, hid.movesToEnd], [g.grade, g.tags, g.marks, g.bestCols, g.movesToEnd], 'hidden: the rest is unchanged');
  for (const c of rvCols(hid.text)) assert.ok(!bestCols.includes(c), `hidden text names best column ${c + 1}: "${hid.text}"`);
  if (bestCols.includes(3)) assert.ok(!/middle column/.test(hid.text), `hidden text names the middle column: "${hid.text}"`);
  if (kind === 'missed-win' || kind === 'missed-block') assert.equal(rvCols(hid.text).length, 0, `hidden ${kind} names a column: "${hid.text}"`);
  assert.ok(!/\d/.test(hid.detail) && !/next move/.test(hid.text), `hidden: no move counts: "${hid.text}" / "${hid.detail}"`);
  const change = cls(best) === cls(s) ? '' : cls(best) === 'win'
    ? (cls(s) === 'draw' ? 'This lets the win slip to a draw.' : 'This turns a won game into a lost one.')
    : 'Now the solver can force a win.';
  assert.ok(hid.detail === change || (hid.detail === '' && hid.text === change), `hidden detail: "${hid.detail}" for ${cls(best)} to ${cls(s)}`);

  // The marks show exactly the squares the text is about.
  const key2 = ([c, rr]) => c * ROWS + rr;
  const markSet = new Set(g.marks.map(key2));
  const exactly = (cells, what) => assert.deepEqual([...markSet].sort((x, y) => x - y),
    [...new Set(cells.map(key2))].sort((x, y) => x - y), `marks for ${what}`);
  const tops = (cols, cells, h) => cols.map((c) => [c, h[c]]);
  if (kind === 'four') {
    for (const [c, rr] of g.marks) assert.equal(a1[c * ROWS + rr], human, 'a marked square holds your disc');
    assert.ok(markSet.has(key2([move, r])), 'the new disc is marked');
    assert.ok(RV_WIN_AT[move * ROWS + r].some((w) => w.every((i) => markSet.has(i))), 'the marks hold a whole four');
  } else if (kind === 'missed-win') exactly(tops(winsNow, st.cells, st.heights), kind);
  else if (kind === 'had-threats') exactly(tops(thr, st.cells, st.heights), kind);
  else if (kind === 'trapped') exactly([[thr[0], st.heights[thr[0]]], [thr[0], st.heights[thr[0]] + 1]], kind);
  else if (kind === 'missed-block') exactly([[named[0], st.heights[named[0]]]], kind);
  else if (kind === 'gives-top' || kind === 'undercut') exactly([[move, r + 1]], kind);
  else if (kind === 'block') exactly([[move, r]], kind);
  else if (kind === 'threat') exactly([[named[0], h1[named[0]]]], kind);
  else if (kind === 'double-threat') exactly(tops(mine, a1, h1), kind);
  else if (kind === 'stacked-threat') exactly([[named[0], h1[named[0]]], [named[0], h1[named[0]] + 1]], kind);
  else if (kind === 'center') exactly([[3, r]], kind);
  else if (kind === 'plain') exactly([], kind);
  else if (kind === 'new-threat') {
    assert.ok(markSet.has(key2([+m[1] - 1, +m[2] - 1])), 'the named square is marked');
    for (const [c, rr] of g.marks) assert.ok(rvWins(a1, c, rr, human) && !rvWins(st.cells, c, rr, human) && rr > h1[c], 'marks are new squares out of reach');
  } else if (kind === 'allows-double' || kind === 'allows-stack') {
    const allowed = new Set();
    for (const y of named) {
      allowed.add(key2([y, h1[y]]));
      assert.ok(markSet.has(key2([y, h1[y]])), `the reply in column ${y + 1} is marked`);
      const [b, hh] = rvPlay(a1, h1, y, solver);
      for (const c of rvLegal(hh)) {
        if (rvWins(b, c, hh[c], solver)) allowed.add(key2([c, hh[c]]));
        if (kind === 'allows-stack' && rvWins(b, c, hh[c], solver) && rvWins(b, c, hh[c] + 1, solver)) allowed.add(key2([c, hh[c] + 1]));
      }
    }
    for (const i of markSet) assert.ok(allowed.has(i), `${kind}: a mark is a reply or a square it wins on`);
  }

  // The detail line.
  const d = g.detail;
  const dn = rvCols(d);
  if (dn.length) rvSame(dn, bestCols, 'the detail names only the best columns');
  if (madeFour) assert.equal(d, '');
  else if (full) assert.equal(d, 'The board is full, so the game is a draw.');
  else {
    const cnt = d.match(/in (\d+) moves/);
    const one = /with (its|your) next move/.test(d);
    if (end === null) assert.ok(!cnt && !one && /level|draw/.test(d), d);
    else if (end === 1) assert.ok(one && !cnt, d);
    else assert.ok(cnt && +cnt[1] === end && !one, `"${d}" vs ${end}`);
    if (cls(s) === 'win') assert.match(d, /^You can still /);
    if (cls(s) === 'loss') assert.ok(/solver/.test(d) && !/^You can/.test(d), d);
    if (/^Every move loses/.test(d)) assert.ok(legal.every((c) => scores[c] < 0), d);
    if (/kept the win/.test(d)) assert.equal(cls(best), 'win');
    if (/kept it level/.test(d)) assert.equal(cls(best), 'draw');
    if (/holds out longer/.test(d)) assert.ok(cls(best) === 'loss' && best > s);
    assert.ok(!/\bhold out\b/.test(d), `"holds out", also for several columns: "${d}"`);
    const longer = d.match(/holds out (\d+) moves longer/);
    if (longer) {
      const left = (sc) => 22 + sc - Math.floor((n + 1) / 2);
      assert.ok(cls(best) === 'loss' && cls(s) === 'loss' && +longer[1] === left(best) - left(s), `"${d}"`);
    }
    if (/wins faster/.test(d)) assert.ok(cls(best) === 'win' && best > s);
    if (g.grade === 'good' || g.grade === 'mistake') assert.ok(dn.length, 'names the better column');
  }
  const keys = g.marks.map(([c, rr]) => {
    assert.ok(c >= 0 && c < COLS && rr >= 0 && rr < ROWS, 'mark on the board');
    return c * ROWS + rr;
  });
  assert.equal(new Set(keys).size, keys.length, 'no duplicate marks');

  const v = verdict({ moves: [...moves, move], first, human, score: -s });
  rvStyle(v.text, 'verdict');
  if (madeFour) assert.deepEqual([v.outcome, v.movesLeft, v.text], ['win', 0, 'You made four in a row.']);
  else if (full) assert.deepEqual([v.outcome, v.movesLeft, v.text], ['draw', null, 'The game ended in a draw.']);
  else assert.deepEqual([v.outcome, v.movesLeft], [cls(s), end], 'verdict after the move');
  return g;
}

// Verdict and both hint levels for the position, claims read from the text.
function rvCheckPosition(key, first, scores) {
  const moves = toMoves(key);
  const st = replay(moves, first);
  const human = st.turn, solver = 3 - human, n = moves.length;
  const legal = rvLegal(st.heights);
  for (let c = 0; c < COLS; c++) assert.equal(scores[c] === null, st.heights[c] >= ROWS, 'solver marks full columns');
  const best = Math.max(...legal.map((c) => scores[c]));
  const bestCols = legal.filter((c) => scores[c] === best);
  rvStats.positions++;

  const v = verdict({ moves: key, first, human, score: best });
  rvStyle(v.text, 'verdict');
  assert.equal(v.outcome, cls(best));
  if (best !== 0 && v.movesLeft <= 3) {
    assert.equal(rvFastest(st.cells, st.heights, human, best > 0 ? human : solver, 3), v.movesLeft, 'verdict count against the search');
  }
  if (v.movesLeft > 1) assert.ok(v.text.includes(`in ${v.movesLeft} moves`), v.text);
  for (const c of legal) {
    try { rvCheckMove(key, first, scores, c); } catch (err) {
      err.message = `column ${c + 1}: ${err.message}`;
      throw err;
    }
  }

  const winsNow = rvNow(st.cells, st.heights, human);
  const thr = rvNow(st.cells, st.heights, solver);
  const h1 = hint({ moves: key, first, human, scores, level: 1 });
  const t = h1.text;
  rvStyle(t, 'hint 1');
  rvStats.hints[h1.kind] = (rvStats.hints[h1.kind] || 0) + 1;
  assert.deepEqual(h1.cols, []);
  assert.ok(!/\d/.test(t.replace(/rows: (1, 3 and 5|2, 4 and 6)\./, '')), `level 1 gives no number away: "${t}"`);
  // Columns that hand over the square on top, and columns after which a solver
  // reply (leaving you no four) makes two threats or a stacked threat.
  const top = legal.filter((c) => rvWins(st.cells, c, st.heights[c] + 1, solver));
  const setUps = legal.filter((c) => {
    const [a, b] = rvPlay(st.cells, st.heights, c, human);
    return rvLegal(b).some((y) => {
      const [a2, b2] = rvPlay(a, b, y, solver);
      if (rvNow(a2, b2, human).length) return false;
      return rvNow(a2, b2, solver).length >= 2 || rvLegal(b2).some((x) => rvWins(a2, x, b2[x], solver) && rvWins(a2, x, b2[x] + 1, solver));
    });
  });
  const setUpHint = setUps.length > 0 && setUps.length < legal.length;
  const middleBest = n < 8 && bestCols.some((c) => c >= 2 && c <= 4);
  let m;
  if (t === 'You can make four in a row with this move.') assert.ok(winsNow.length);
  else if (winsNow.length) assert.fail(`missed the win: "${t}"`);
  else if ((m = t.match(/^The solver has (\w+) threats\. You can only block one\.$/))) assert.ok(thr.length >= 2 && RV_WORD[m[1]] === thr.length);
  else if (thr.length >= 2) assert.fail(`missed two threats: "${t}"`);
  else if (t === 'The solver threatens to make four, and blocking it gives the solver the square on top.') {
    assert.ok(thr.length === 1 && rvWins(st.cells, thr[0], st.heights[thr[0]] + 1, solver));
  } else if (t === 'The solver threatens to make four. Block it.') {
    assert.equal(thr.length, 1);
    assert.equal(rvNow(...rvPlay(st.cells, st.heights, thr[0], human), solver).length, 0, 'the block holds for a move');
  } else if (thr.length) assert.fail(`missed the threat: "${t}"`);
  else if (t === 'One of your moves makes two threats at once.') assert.ok(rvForce(st.cells, st.heights, human, human, 2), 'a forced win in two exists');
  else if ((m = t.match(/^In (\w+) columns?, your disc would let the solver make four right above it\. (.*)$/))) {
    assert.equal(RV_WORD[m[1]], top.length);
    assert.ok(t.startsWith(top.length === 1 ? 'In one column,' : `In ${m[1]} columns,`));
    const safe = legal.length - top.length;
    if (!safe) assert.equal(m[2], 'No column is safe from that.');
    else if (safe === 1) assert.equal(m[2], 'The other column is safe from that.');
    else assert.equal(m[2], `The other ${WORDS[safe]} columns are safe from that.`);
  } else if ((m = t.match(/^In (\w+) columns?, your disc would let the solver set up two threats at once\.$/))) {
    assert.equal(top.length, 0, 'the square-on-top hint comes first');
    assert.equal(RV_WORD[m[1]], setUps.length, 'set-up count');
    assert.ok(t.startsWith(setUps.length === 1 ? 'In one column,' : `In ${m[1]} columns,`));
    assert.ok(setUpHint, 'some column avoids the set-up');
  } else if (t === 'Discs in the middle columns are part of the most lines of four.') {
    assert.ok(middleBest, 'a middle column is among the best');
    assert.ok(!top.length && !setUpHint, 'the sharper hints come first');
  } else if ((m = t.match(/^You moved (first|second), so aim for threats on (odd|even) rows: (1, 3 and 5|2, 4 and 6)\.$/))) {
    const f = human === first;
    assert.deepEqual([m[1], m[2], m[3]], f ? ['first', 'odd', '1, 3 and 5'] : ['second', 'even', '2, 4 and 6']);
    assert.ok(!top.length && !setUpHint && !middleBest, 'the parity line is the last resort');
  } else assert.fail(`unknown level 1 hint: "${t}"`);
  // "Two threats at once": two playable threats, or one with another right
  // above it, and the solver cannot make four first. Such a move always has
  // the best score, so the hint must mention it whenever one exists.
  const forks = legal.filter((c) => {
    if (rvWins(st.cells, c, st.heights[c], human)) return false;
    const [a, b] = rvPlay(st.cells, st.heights, c, human);
    if (rvNow(a, b, solver).length) return false;
    const mine = rvNow(a, b, human);
    return mine.length >= 2 || mine.some((x) => rvWins(a, x, b[x] + 1, human));
  });
  if (!winsNow.length) for (const c of forks) assert.ok(bestCols.includes(c), `a move with two threats at once is a best move (column ${c + 1})`);
  if (!winsNow.length && !thr.length) assert.equal(h1.kind === 'double', forks.length > 0, `two threats at once: "${t}"`);

  const h2 = hint({ moves: key, first, human, scores, level: 2 });
  rvStyle(h2.text, 'hint 2');
  rvSame(h2.cols, bestCols, 'level 2 columns');
  if (h2.text === 'Every column gives the same result here.') assert.ok(bestCols.length === legal.length && legal.length > 1);
  else {
    const mm = h2.text.match(/^Play (column [^.]+)\.(?: (.*))?$/);
    assert.ok(mm, h2.text);
    rvSame(rvCols(mm[1]), bestCols, 'level 2 names the best columns');
    if (mm[2]) {
      assert.equal(bestCols.length, 1);
      const g = gradeMove({ moves: key, first, human, move: bestCols[0], scores });
      assert.equal(mm[2], g.text);
      assert.ok(['win-now', 'double-threat', 'stacked-threat', 'block', 'threat', 'new-threat', 'center'].includes(g.tags[0]), g.tags[0]);
    }
  }
}

// Positions from generators unlike the property test's.
function rvXorshift(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function rvGame(rand, len, style) {
  const moves = [];
  while (moves.length < len) {
    const st = replay(moves, 1);
    const me = st.turn, op = 3 - me;
    const legal = rvLegal(st.heights).filter((c) => !rvWins(st.cells, c, st.heights[c], me));
    if (!legal.length) return null;
    let pool = legal;
    if (style === 'tactical') {
      // Threat-seeking: often block, otherwise prefer moves that add a
      // winning square (reachable or not) for the mover.
      const squares = (cells) => {
        let k = 0;
        for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (rvWins(cells, c, r, me)) k++;
        return k;
      };
      const th = rvNow(st.cells, st.heights, op);
      const blocks = legal.filter((c) => th.includes(c));
      const before = squares(st.cells);
      const makes = legal.filter((c) => squares(rvPlay(st.cells, st.heights, c, me)[0]) > before);
      if (blocks.length && rand() < 0.6) pool = blocks;
      else if (makes.length && rand() < 0.7) pool = makes;
    } else if (style === 'center') {
      pool = legal.flatMap((c) => Array(4 - Math.abs(c - 3)).fill(c));
    }
    moves.push(pool[Math.floor(rand() * pool.length)]);
  }
  return moves;
}

// Edge cases with recorded c4 scores (re-checked against the solver below).
//   E1  a win and a needed block at the same time (X to move):
//       . . . . . . .
//       . . . . . . .
//       . . . . . . .
//       . X . . . O .
//       . X . . . O O
//       X X X . . O O
//       1 2 3 4 5 6 7
//   E2  three solver threats, two full columns (X to move).
//   E3  every move loses, four of them in two moves (X to move, X moved first):
//       . . . . . . .
//       . . . . . . .
//       . . . . . . .
//       . . . . . . .
//       . . O O . X .
//       X X X O O O X
//       1 2 3 4 5 6 7
//   E4  one column left, and it hands over the square on top.
//   E5  the last move makes four; E6 the last move draws; E7 the last move blocks.
//   E8  two threats, three columns left, the human moved second.
//   E9  one solver reply makes three threats at once (X to move):
//       . . . . . . .
//       . . . . . . .
//       . . . X . . .
//       . . O O . . .
//       . X O X O . .
//       . X X O O X .
//       1 2 3 4 5 6 7
const RV_EDGE = {
  E1: { key: '1615150526', scores: [-16, 16, -16, 16, -16, 15, -16] },
  E2: { key: '3244462443530341512512662612', scores: [-7, -7, null, -7, null, -7, -7] },
  E3: { key: '2215536403', scores: [-12, -12, -15, -15, -5, -15, -15] },
  E4: { key: '12141034311343214234435566525625526660', scores: [-2, null, null, null, null, null, null] },
  E5: { key: '65644114303106221225224104346331660005555', scores: [null, null, null, 1, null, null, null] },
  E6: { key: '34340356312222206335045245514004156061161', scores: [null, null, null, null, null, null, 0] },
  E7: { key: '45140542436625551435412326600331131606022', scores: [0, null, null, null, null, null, null] },
  E8: { key: '314443011121336631454403662066500', scores: [-4, null, -4, null, null, -4, null] },
  E9: { key: '233453123412', scores: [-14, 0, -14, -14, 3, -14, -14] },
};
// Early positions (fewer than 8 discs) for the middle-column reason. The
// solver needs a few seconds each, so the test re-checks them once and then
// reads them from the cache. E10: X to move, lost; E11: O (moved second) to move.
const RV_EARLY = {
  E10: { key: '334012', scores: [-5, -3, -2, -2, -2, -4, -2] },
  E11: { key: '34352', scores: [-10, -13, -4, 0, -6, -12, -13] },
};

const RV_WORDING = { key: '4233362046', scores: [4, 6, 9, 9, 5, 6, 4] };

section('Independent review');

await test('board helpers agree with an independent window scan on 3000 random boards', () => {
  const rand = rvXorshift(4242);
  for (let i = 0; i < 3000; i++) {
    // Any reachable board, including ones where someone has four.
    const cells = new Uint8Array(COLS * ROWS), heights = new Uint8Array(COLS);
    const discs = Math.floor(rand() * 43);
    for (let k = 0; k < discs; k++) {
      const open = rvLegal(heights);
      const c = open[Math.floor(rand() * open.length)];
      cells[c * ROWS + heights[c]++] = 1 + (k % 2);
    }
    for (const p of [1, 2]) {
      assert.deepEqual(immediateWins(cells, heights, p), rvNow(cells, heights, p), `immediateWins, board ${i}`);
      const all = [];
      for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (rvWins(cells, c, r, p)) all.push([c, r]);
      assert.deepEqual(winningCells(cells, p), all, `winningCells, board ${i}`);
    }
  }
  const t = lineCountsPerCell();
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) assert.equal(t[c][r], RV_WIN_AT[c * ROWS + r].length);
});

await test('movesToWin matches the convention on worked examples, either side to move', () => {
  // Win in one: the score is (43 - n) div 2, and one move is left.
  for (let n = 0; n <= 41; n++) assert.equal(movesToWin(Math.floor((43 - n) / 2), n), 1, `win in one at n = ${n}`);
  // Losing at once: the opponent's next disc wins.
  for (let n = 0; n <= 40; n++) assert.equal(movesToWin(-Math.floor((42 - n) / 2), n), 1, `loss in one at n = ${n}`);
  // Empty board: the first player wins with the 21st disc, the second loses to it.
  assert.equal(movesToWin(1, 0), 21);
  assert.equal(movesToWin(-1, 1), 20, 'after one disc, the first player has 20 discs to go');
  // The human moved second (n odd) and wins with its 12th disc: 22 - 10 = 12, has 6 of them.
  assert.equal(movesToWin(10, 13), 6);
  // The human moved second (n odd) and loses to the first player's 15th disc: has 7.
  assert.equal(movesToWin(-7, 13), 8);
  assert.equal(movesToWin(0, 20), null);
});

await test('edge cases: win and block at once, full columns, every move loses, the last move', () => {
  const G = (name, move, first = 1) => {
    const { key, scores } = RV_EDGE[name];
    const st = replay(toMoves(key), first);
    return gradeMove({ moves: key, first, human: st.turn, move, scores });
  };
  const H = (name, level, first = 1) => {
    const { key, scores } = RV_EDGE[name];
    return hint({ moves: key, first, human: replay(toMoves(key), first).turn, scores, level });
  };
  // E1: winning beats blocking. Blocking column 6 still wins next move but is a blunder.
  for (const c of [1, 3]) assert.deepEqual([G('E1', c).grade, G('E1', c).tags[0], G('E1', c).movesToEnd], ['best', 'win-now', 0]);
  const e1 = G('E1', 5);
  assert.deepEqual([e1.grade, e1.outcomeAfter, e1.movesToEnd], ['blunder', 'win', 1]);
  assert.equal(e1.text, 'You could have won right away in column 2 or 4.');
  assert.equal(e1.detail, 'You can still win with your next move.');
  assert.equal(G('E1', 0).detail, 'Column 2 or 4 was the move. The solver can now win with its next move.');
  assert.equal(H('E1', 1).kind, 'win-now');
  assert.equal(H('E1', 2).text, 'Play column 2 or 4.');
  // E2: three threats; every legal column is equal; full columns are skipped.
  for (const c of [0, 1, 3, 5, 6]) {
    const g = G('E2', c);
    assert.equal(g.grade, 'best');
    assert.equal(g.text, 'The solver had three threats, in columns 2, 4 and 6. Only one could be blocked.');
    assert.equal(g.detail, 'Every move loses here; the solver wins with its next move.');
  }
  assert.throws(() => G('E2', 2), /legal column/);
  assert.equal(H('E2', 1).text, 'The solver has three threats. You can only block one.');
  assert.deepEqual(H('E2', 2), { text: 'Every column gives the same result here.', cols: [0, 1, 3, 5, 6], kind: 'best' });
  // E3: lost from here; the counts follow the scores.
  assert.deepEqual([G('E3', 4).grade, G('E3', 4).text, G('E3', 4).detail],
    ['best', 'This is the best move.', 'Every move loses here; the solver wins in 12 moves.']);
  assert.deepEqual([G('E3', 0).grade, G('E3', 0).movesToEnd, G('E3', 0).detail],
    ['mistake', 5, 'The solver can now force a win in 5 moves. Column 5 holds out 7 moves longer.']);
  const e3 = G('E3', 2);
  assert.deepEqual([e3.grade, e3.tags, e3.movesToEnd], ['blunder', ['allows-double', 'col:1'], 2]);
  assert.equal(e3.text, 'After this, the solver can play column 2 and make two threats at once. You can only block one.');
  // E4: the only column hands over the square on top, so it is the best move.
  const e4 = G('E4', 0);
  assert.deepEqual([e4.grade, e4.tags[0], e4.detail], ['best', 'gives-top', 'Every move loses here; the solver wins with its next move.']);
  assert.equal(H('E4', 1).text, 'In one column, your disc would let the solver make four right above it. No column is safe from that.');
  assert.equal(H('E4', 2).text, 'Play column 1.');
  // E5: four with the 42nd disc.
  const e5 = G('E5', 3);
  assert.deepEqual([e5.grade, e5.text, e5.detail, e5.movesToEnd], ['best', 'Four in a row.', '', 0]);
  // E6: the last move draws; E7: the last move blocks and draws.
  const e6 = G('E6', 6);
  assert.deepEqual([e6.grade, e6.text, e6.detail, e6.movesToEnd, e6.outcomeAfter],
    ['best', 'This is the best move.', 'The board is full, so the game is a draw.', null, 'draw']);
  const e7 = G('E7', 0);
  assert.deepEqual([e7.text, e7.detail], ["This blocks the solver's threat in column 1.", 'The board is full, so the game is a draw.']);
  assert.equal(H('E7', 1).text, 'The solver threatens to make four. Block it.');
  // E8: the human moved second; the same with either player number first.
  for (const first of [1, 2]) {
    const st = replay(toMoves(RV_EDGE.E8.key), first);
    assert.notEqual(st.turn, first, 'the human moved second');
    const g = G('E8', 0, first);
    assert.equal(g.text, 'The solver had two threats, in columns 3 and 6. Only one could be blocked.');
    assert.deepEqual(H('E8', 2, first).cols, [0, 2, 5]);
  }
  // E9: one reply makes three threats, and the count is said in words.
  const e9 = G('E9', 5);
  assert.equal(e9.text, 'After this, the solver can play column 5 and make three threats at once. You can only block one.');
  assert.deepEqual([e9.grade, e9.movesToEnd], ['blunder', 2]);
  assert.equal(G('E9', 0).text, 'After this, the solver can play column 5 and make two threats at once. You can only block one.');
  // E10, E11: the middle column early on, for either side.
  const early = (name, move) => {
    const { key, scores } = RV_EARLY[name];
    return gradeMove({ moves: key, first: 1, human: replay(toMoves(key), 1).turn, move, scores });
  };
  assert.deepEqual([early('E10', 3).grade, early('E10', 3).text],
    ['best', 'The middle column is part of the most lines of four. This square is in 13 of them.']);
  assert.equal(early('E10', 2).text, 'This is one of the four best moves.');
  assert.deepEqual([early('E11', 3).grade, early('E11', 3).detail], ['best', 'The game stays level.']);
  assert.equal(early('E11', 0).text, 'This hands the solver a winning position.');
  // Every edge position, early position and hand-built case also passes the
  // full independent check, with either player number moving first.
  const all = [...Object.values(RV_EDGE), ...Object.values(RV_EARLY), ...CASES.map((k) => ({ key: k.moves, scores: k.scores }))];
  for (const { key, scores } of all) {
    for (const first of [1, 2]) {
      try { rvCheckPosition(key, first, scores); } catch (err) {
        err.message = `position "${key}" (first ${first}), ${err.message}`;
        throw err;
      }
    }
  }
});

await test('counts come from the board when the scores are rough', () => {
  // The page sends +-1 for openings it only knows as win / draw / loss.
  const g = gradeMove({ moves: '3230005114', first: 1, human: 1, move: 2, scores: [1, 1, 1, 1, 1, 1, 1] });
  assert.equal(g.movesToEnd, 0, 'a four ends the game whatever the score says');
  assert.equal(g.detail, '');
  const last = RV_EDGE.E6;
  const st = replay(toMoves(last.key), 1);
  assert.equal(gradeMove({ moves: last.key, first: 1, human: st.turn, move: 6, scores: last.scores }).movesToEnd, null);
  // Without reveal, the winning or blocking column stays hidden even when
  // rough scores leave it out of the best columns.
  const missedWin = gradeMove({ moves: '3230005114', first: 1, human: 1, move: 0, scores: [1, 1, -1, 1, 1, 1, 1], reveal: false });
  assert.deepEqual([missedWin.tags[0], missedWin.text], ['missed-win', 'There was a four in a row available.']);
  const missedBlock = gradeMove({ moves: '3022142023', first: 1, human: 1, move: 0, scores: [1, -1, 1, 1, 1, 1, 1], reveal: false });
  assert.deepEqual([missedBlock.tags[0], missedBlock.text], ['missed-block', "This does not stop the solver's four."]);
});

await test('wording: counts in words, the solver named, sentences in plain ASCII', () => {
  // Recorded c4 scores; re-checked against the solver with the edge cases.
  const g = gradeMove({ moves: RV_WORDING.key, first: 1, human: 1, move: 2, scores: RV_WORDING.scores });
  assert.equal(g.text, 'This is one of the two best moves.');
  const h = hint({ moves: '40236426651613', first: 1, human: 1, scores: [-14, -14, -14, -14, -14, -14, -14] });
  assert.equal(h.text, 'The solver threatens to make four, and blocking it gives the solver the square on top.');
  for (const k of CASES) {
    const moves = toMoves(k.moves);
    const st = replay(moves, 1);
    for (const c of rvLegal(st.heights)) {
      const r = gradeMove({ moves, first: 1, human: st.turn, move: c, scores: k.scores });
      rvStyle(r.text, `${k.name} text`);
      rvStyle(r.detail, `${k.name} detail`);
    }
    for (const level of [1, 2]) rvStyle(hint({ moves, first: 1, human: st.turn, scores: k.scores, level }).text, `${k.name} hint ${level}`);
  }
});

await test('inputs are left as they were, and string and array moves agree', () => {
  const { key, scores } = RV_EDGE.E9;
  const moves = toMoves(key);
  const movesCopy = moves.slice(), scoresCopy = scores.slice();
  const human = replay(moves, 1).turn;
  for (let c = 0; c < COLS; c++) {
    const a = gradeMove({ moves, first: 1, human, move: c, scores });
    assert.deepEqual(gradeMove({ moves: key, first: 1, human, move: c, scores: Int8Array.from(scores) }), a);
    a.marks.push([9, 9]); a.bestCols.push(9); a.tags.push('x');
    assert.deepEqual(gradeMove({ moves, first: 1, human, move: c, scores }).bestCols, [4], 'results share no arrays');
  }
  hint({ moves, first: 1, human, scores, level: 2 });
  verdict({ moves, first: 1, human, score: 3 });
  assert.deepEqual(moves, movesCopy);
  assert.deepEqual(scores, scoresCopy);
});

let rvSummary = null;
if (solverThere) {
  const cache = loadCache();
  await test('independent review: edge-case scores match the solver (early ones take a few seconds once)', async () => {
    const recorded = [...Object.values(RV_EDGE), ...Object.values(RV_EARLY), RV_WORDING];
    await solveAll(recorded.map((e) => e.key), cache);
    for (const { key, scores } of recorded) assert.deepEqual(cache[key], scores, key);
  });

  await test('independent review: 260 fresh positions (10-41 discs), every legal move, claims read from the text', async () => {
    const rand = rvXorshift(97531);
    const picked = [], seen = new Set();
    const styles = ['uniform', 'tactical', 'center'];
    const plan = [[200, 10, 41], [40, 34, 41], [20, 41, 41]];
    let fresh = 0;
    for (const [count, lo, hi] of plan) {
      const want = picked.length + count;
      while (picked.length < want) {
        const batch = [];
        for (let tries = 0; batch.length < want - picked.length + 5 && tries < 50000; tries++) {
          const len = lo + Math.floor(rand() * (hi - lo + 1));
          const moves = rvGame(rand, len, styles[(picked.length + batch.length) % 3]);
          if (!moves) continue;
          const key = moves.join('');
          if (seen.has(key)) continue;
          seen.add(key);
          batch.push({ key, first: rand() < 0.5 ? 1 : 2 });
        }
        fresh += await solveAll(batch.map((p) => p.key), cache);
        for (const p of batch) if (cache[p.key] && picked.length < want) picked.push(p);
      }
    }
    for (const { key, first } of picked) {
      try { rvCheckPosition(key, first, cache[key]); } catch (err) {
        err.message = `position ${key} (first ${first}), ${err.message}`;
        throw err;
      }
    }
    assert.ok(rvStats.secondMover > 300, 'many moves by a human who moved second');
    for (const want of ['four', 'missed-win', 'had-threats', 'trapped', 'missed-block', 'gives-top', 'allows-double',
      'allows-stack', 'double-threat', 'block', 'threat', 'new-threat', 'plain']) {
      assert.ok(rvStats.texts[want] > 0, `the fresh positions include a "${want}" text: ${JSON.stringify(rvStats.texts)}`);
    }
    rvSummary = { fresh, ...rvStats };
  });
}

// ---------------------------------------------------------------- summary

const failed = results.filter((r) => !r.ok);
console.log('\nSummary');
if (property) {
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`  property test: ${property.positions} positions, ${property.movesChecked} moves graded` +
    ` (${property.fresh} solver runs, the rest from ${CACHE_FILE})`);
  console.log(`  grades:  ${fmt(property.grades)}`);
  console.log(`  reasons: ${fmt(property.kinds)}`);
  console.log(`  hints:   ${fmt(property.hintKinds)}`);
}
if (rvSummary) {
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`  independent review: ${rvSummary.positions} positions, ${rvSummary.moves} moves (${rvSummary.secondMover} by a human who moved second),` +
    ` ${rvSummary.searched} counts checked by search, ${rvSummary.fresh} solver runs`);
  console.log(`  texts:   ${fmt(rvSummary.texts)}`);
  console.log(`  hints:   ${fmt(rvSummary.hints)}`);
}
if (!solverThere) console.log('  property test SKIPPED: solver not found');
console.log(`  ${results.length - failed.length} passed, ${failed.length} failed, ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(failed.length ? '  FAIL' : '  PASS');
process.exitCode = failed.length ? 1 : 0;
