// Rules for four in a row on a 7 x 6 board. Pure functions, shared by the
// page, the computer player (a worker) and the tests.

export const COLS = 7;
export const ROWS = 6;
export const N = COLS * ROWS;

// Cell index: column-major, row 0 is the bottom row.
export const idx = (c, r) => c * ROWS + r;

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// Every window of four cells in a line (69 of them), flattened.
export const WINDOWS = (() => {
  const out = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      for (const [dc, dr] of DIRS) {
        const c3 = c + 3 * dc, r3 = r + 3 * dr;
        if (c3 < 0 || c3 >= COLS || r3 < 0 || r3 >= ROWS) continue;
        for (let k = 0; k < 4; k++) out.push(idx(c + k * dc, r + k * dr));
      }
    }
  }
  return Int8Array.from(out);
})();

// All lines of four or more through (c, r) for player p, each a list of
// [col, row] pairs ordered from one end to the other.
export function linesThrough(cells, c, r, p) {
  const lines = [];
  for (const [dc, dr] of DIRS) {
    const back = [], fwd = [];
    for (let s = 1; ; s++) {
      const cc = c - dc * s, rr = r - dr * s;
      if (cc < 0 || cc >= COLS || rr < 0 || rr >= ROWS || cells[idx(cc, rr)] !== p) break;
      back.push([cc, rr]);
    }
    for (let s = 1; ; s++) {
      const cc = c + dc * s, rr = r + dr * s;
      if (cc < 0 || cc >= COLS || rr < 0 || rr >= ROWS || cells[idx(cc, rr)] !== p) break;
      fwd.push([cc, rr]);
    }
    if (back.length + fwd.length + 1 >= 4) lines.push([...back.reverse(), [c, r], ...fwd]);
  }
  return lines;
}

// Replays a move list (column numbers 0-6). Player 1 is brass, 2 is pearl.
// Returns null if any move is illegal, including a move after the game ended.
export function replay(moves, first = 1) {
  const cells = new Uint8Array(N);
  const heights = new Uint8Array(COLS);
  let turn = first, winner = 0, lines = [], last = null;
  for (let i = 0; i < moves.length; i++) {
    const c = moves[i];
    if (winner || !Number.isInteger(c) || c < 0 || c >= COLS || heights[c] >= ROWS) return null;
    const r = heights[c]++;
    cells[idx(c, r)] = turn;
    last = { col: c, row: r, player: turn };
    const found = linesThrough(cells, c, r, turn);
    if (found.length) { winner = turn; lines = found; }
    turn = 3 - turn;
  }
  const full = moves.length === N;
  return {
    cells, heights, last, winner, lines,
    turn: winner || full ? 0 : turn,
    draw: !winner && full,
    over: Boolean(winner) || full,
    count: moves.length,
  };
}

export const canPlay = (state, c) => !state.over && c >= 0 && c < COLS && state.heights[c] < ROWS;

// Online games send moves as a string of digits.
export const movesToString = (moves) => moves.join('');
export function stringToMoves(s) {
  if (typeof s !== 'string' || !/^[0-6]{0,42}$/.test(s)) return null;
  return Array.from(s, Number);
}
