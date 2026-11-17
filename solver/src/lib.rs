//! A perfect solver for four in a row on a 7 x 6 board.
//!
//! It follows Pascal Pons' well-known approach ("Solving Connect 4: how to build
//! a perfect AI", blog.gamesolver.org), written from scratch here:
//! bitboards, negamax with alpha-beta pruning, null-window iterative deepening,
//! a transposition table holding upper and lower bounds, pruning of moves that
//! lose at once, and move ordering by the number of threats a move creates.
//!
//! Scores are from the point of view of the player to move:
//! - 0 means a draw with perfect play;
//! - a positive score means the player to move wins: 22 - score is the number
//!   of discs the winner will have placed when the four is made (18 = win with
//!   the 4th disc, 1 = win with the 21st, the very last);
//! - a negative score means the player to move loses, with the same measure.
//!
//! Moves are columns numbered 0 to 6 from the left.

pub const WIDTH: usize = 7;
pub const HEIGHT: usize = 6;
pub const CELLS: i32 = (WIDTH * HEIGHT) as i32;
pub const MIN_SCORE: i32 = -CELLS / 2 + 3;
pub const MAX_SCORE: i32 = (CELLS + 1) / 2 - 3;
pub const INVALID: i32 = 100;

const H: u32 = HEIGHT as u32;
const H1: u32 = H + 1;

const fn bottom(width: usize) -> u64 {
    if width == 0 { 0 } else { bottom(width - 1) | 1u64 << ((width - 1) * (HEIGHT + 1)) }
}
const BOTTOM_MASK: u64 = bottom(WIDTH);
const BOARD_MASK: u64 = BOTTOM_MASK * ((1u64 << HEIGHT) - 1);

#[inline]
const fn top_mask_col(col: usize) -> u64 { 1u64 << ((HEIGHT - 1) + col * (HEIGHT + 1)) }
#[inline]
const fn bottom_mask_col(col: usize) -> u64 { 1u64 << (col * (HEIGHT + 1)) }
#[inline]
pub const fn column_mask(col: usize) -> u64 { ((1u64 << HEIGHT) - 1) << (col * (HEIGHT + 1)) }

/// Cells where `position` would make four, whether or not they are reachable yet.
#[inline]
fn compute_winning_position(position: u64, mask: u64) -> u64 {
    // vertical
    let mut r = (position << 1) & (position << 2) & (position << 3);

    // horizontal
    let mut p = (position << H1) & (position << (2 * H1));
    r |= p & (position << (3 * H1));
    r |= p & (position >> H1);
    p = (position >> H1) & (position >> (2 * H1));
    r |= p & (position << H1);
    r |= p & (position >> (3 * H1));

    // diagonal one way
    p = (position << H) & (position << (2 * H));
    r |= p & (position << (3 * H));
    r |= p & (position >> H);
    p = (position >> H) & (position >> (2 * H));
    r |= p & (position << H);
    r |= p & (position >> (3 * H));

    // diagonal the other way
    p = (position << (H + 2)) & (position << (2 * (H + 2)));
    r |= p & (position << (3 * (H + 2)));
    r |= p & (position >> (H + 2));
    p = (position >> (H + 2)) & (position >> (2 * (H + 2)));
    r |= p & (position << (H + 2));
    r |= p & (position >> (3 * (H + 2)));

    r & (BOARD_MASK ^ mask)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Position {
    current: u64, // discs of the player to move
    mask: u64,    // all discs
    moves: u32,
}

impl Position {
    pub fn new() -> Self { Self::default() }

    /// Plays columns in order. Returns None if a move is illegal or if a move
    /// makes four (the solver only works on unfinished games).
    pub fn from_moves(cols: &[u8]) -> Option<Self> {
        let mut p = Self::new();
        for &c in cols {
            let c = c as usize;
            if c >= WIDTH || !p.can_play(c) || p.is_winning_move(c) { return None; }
            p.play_col(c);
        }
        Some(p)
    }

    #[inline] pub fn can_play(&self, col: usize) -> bool { self.mask & top_mask_col(col) == 0 }
    #[inline] pub fn play(&mut self, mv: u64) {
        self.current ^= self.mask;
        self.mask |= mv;
        self.moves += 1;
    }
    #[inline] pub fn play_col(&mut self, col: usize) {
        self.play((self.mask + bottom_mask_col(col)) & column_mask(col));
    }
    #[inline] pub fn nb_moves(&self) -> u32 { self.moves }
    #[inline] pub fn key(&self) -> u64 { self.current + self.mask }

    /// The same position seen in a mirror (column 0 swapped with 6 and so on).
    pub fn mirror(&self) -> Self {
        let mut cur = 0u64;
        let mut mask = 0u64;
        for c in 0..WIDTH {
            let shift_from = c * (HEIGHT + 1);
            let shift_to = (WIDTH - 1 - c) * (HEIGHT + 1);
            cur |= ((self.current >> shift_from) & ((1 << H1) - 1)) << shift_to;
            mask |= ((self.mask >> shift_from) & ((1 << H1) - 1)) << shift_to;
        }
        Position { current: cur, mask, moves: self.moves }
    }

    #[inline] fn possible(&self) -> u64 { (self.mask + BOTTOM_MASK) & BOARD_MASK }
    #[inline] fn winning_position(&self) -> u64 { compute_winning_position(self.current, self.mask) }
    #[inline] fn opponent_winning_position(&self) -> u64 { compute_winning_position(self.current ^ self.mask, self.mask) }

    #[inline] pub fn can_win_next(&self) -> bool { self.winning_position() & self.possible() != 0 }
    #[inline] pub fn is_winning_move(&self, col: usize) -> bool {
        self.winning_position() & self.possible() & column_mask(col) != 0
    }

    /// Moves that do not hand the opponent an immediate win. Empty if every move loses.
    pub fn possible_non_losing_moves(&self) -> u64 {
        let mut possible_mask = self.possible();
        let opponent_win = self.opponent_winning_position();
        let forced = possible_mask & opponent_win;
        if forced != 0 {
            if forced & (forced - 1) != 0 { return 0; } // two threats: lost
            possible_mask = forced;
        }
        possible_mask & !(opponent_win >> 1) // never play just below an opponent's winning cell
    }

    /// How many winning cells a move gives us: used to try strong moves first.
    #[inline] pub fn move_score(&self, mv: u64) -> u32 {
        compute_winning_position(self.current | mv, self.mask).count_ones()
    }
}

/// Transposition table: the key is 49 bits; storing its low 32 bits in a table
/// whose size is a prime above 2^17 identifies it exactly (Chinese remainders).
struct TransTable {
    keys: Vec<u32>,
    vals: Vec<u8>,
    size: u64,
}

fn is_prime(n: u64) -> bool {
    if n < 2 { return false; }
    let mut d = 2;
    while d * d <= n {
        if n % d == 0 { return false; }
        d += 1;
    }
    true
}

impl TransTable {
    fn new(log_size: u32) -> Self {
        let mut size = 1u64 << log_size;
        while !is_prime(size) { size += 1; }
        TransTable { keys: vec![0; size as usize], vals: vec![0; size as usize], size }
    }
    #[inline] fn put(&mut self, key: u64, val: u8) {
        let i = (key % self.size) as usize;
        self.keys[i] = key as u32;
        self.vals[i] = val;
    }
    #[inline] fn get(&self, key: u64) -> u8 {
        let i = (key % self.size) as usize;
        if self.keys[i] == key as u32 { self.vals[i] } else { 0 }
    }
    fn reset(&mut self) {
        self.keys.iter_mut().for_each(|k| *k = 0);
        self.vals.iter_mut().for_each(|v| *v = 0);
    }
}

/// Holds up to 7 moves sorted by score; equal scores come out in the order
/// they went in last-first, so adding edge columns first explores the centre first.
struct MoveSorter {
    size: usize,
    moves: [u64; WIDTH],
    scores: [u32; WIDTH],
}

impl MoveSorter {
    #[inline] fn new() -> Self { MoveSorter { size: 0, moves: [0; WIDTH], scores: [0; WIDTH] } }
    #[inline] fn add(&mut self, mv: u64, score: u32) {
        let mut pos = self.size;
        self.size += 1;
        while pos > 0 && self.scores[pos - 1] > score {
            self.moves[pos] = self.moves[pos - 1];
            self.scores[pos] = self.scores[pos - 1];
            pos -= 1;
        }
        self.moves[pos] = mv;
        self.scores[pos] = score;
    }
    #[inline] fn next(&mut self) -> Option<u64> {
        if self.size == 0 { None } else { self.size -= 1; Some(self.moves[self.size]) }
    }
}

const COLUMN_ORDER: [usize; WIDTH] = [3, 2, 4, 1, 5, 0, 6];

pub struct Solver {
    tt: TransTable,
    pub node_count: u64,
    pub node_limit: u64,
    pub aborted: bool,
}

impl Solver {
    pub fn new(log_tt_size: u32) -> Self {
        Solver { tt: TransTable::new(log_tt_size), node_count: 0, node_limit: u64::MAX, aborted: false }
    }

    pub fn reset(&mut self) { self.tt.reset(); }

    fn negamax(&mut self, p: &Position, mut alpha: i32, mut beta: i32) -> i32 {
        self.node_count += 1;
        if self.node_count > self.node_limit { self.aborted = true; return 0; }

        let next = p.possible_non_losing_moves();
        if next == 0 { return -(CELLS - p.nb_moves() as i32) / 2; }
        if p.nb_moves() as i32 >= CELLS - 2 { return 0; }

        let min = -(CELLS - 2 - p.nb_moves() as i32) / 2;
        if alpha < min {
            alpha = min;
            if alpha >= beta { return alpha; }
        }
        let max = (CELLS - 1 - p.nb_moves() as i32) / 2;
        if beta > max {
            beta = max;
            if alpha >= beta { return beta; }
        }

        let key = p.key();
        let val = self.tt.get(key) as i32;
        if val != 0 {
            if val > MAX_SCORE - MIN_SCORE + 1 {
                let lower = val + 2 * MIN_SCORE - MAX_SCORE - 2;
                if alpha < lower {
                    alpha = lower;
                    if alpha >= beta { return alpha; }
                }
            } else {
                let upper = val + MIN_SCORE - 1;
                if beta > upper {
                    beta = upper;
                    if alpha >= beta { return beta; }
                }
            }
        }

        let mut sorter = MoveSorter::new();
        for i in (0..WIDTH).rev() {
            let mv = next & column_mask(COLUMN_ORDER[i]);
            if mv != 0 { sorter.add(mv, p.move_score(mv)); }
        }
        while let Some(mv) = sorter.next() {
            let mut p2 = *p;
            p2.play(mv);
            let score = -self.negamax(&p2, -beta, -alpha);
            if self.aborted { return 0; }
            if score >= beta {
                self.tt.put(key, (score + MAX_SCORE - 2 * MIN_SCORE + 2) as u8);
                return score;
            }
            if score > alpha { alpha = score; }
        }
        self.tt.put(key, (alpha - MIN_SCORE + 1) as u8);
        alpha
    }

    /// Exact score of a position (weak = only win / draw / loss as 1 / 0 / -1).
    /// Returns None if the node limit was hit.
    pub fn solve(&mut self, p: &Position, weak: bool) -> Option<i32> {
        self.aborted = false;
        if p.can_win_next() { return Some((CELLS + 1 - p.nb_moves() as i32) / 2); }
        let mut min = -(CELLS - p.nb_moves() as i32) / 2;
        let mut max = (CELLS + 1 - p.nb_moves() as i32) / 2;
        if weak { min = -1; max = 1; }
        while min < max {
            let mut med = min + (max - min) / 2;
            if med <= 0 && min / 2 < med { med = min / 2; }
            else if med >= 0 && max / 2 > med { med = max / 2; }
            let r = self.negamax(p, med, med + 1);
            if self.aborted { return None; }
            if r <= med { max = r; } else { min = r; }
        }
        Some(min)
    }

    /// Score of each column for the player to move (INVALID for a full column).
    pub fn analyze(&mut self, p: &Position, weak: bool) -> Option<[i32; WIDTH]> {
        let mut scores = [INVALID; WIDTH];
        for col in 0..WIDTH {
            if !p.can_play(col) { continue; }
            if p.is_winning_move(col) {
                scores[col] = (CELLS + 1 - p.nb_moves() as i32) / 2;
            } else {
                let mut p2 = *p;
                p2.play_col(col);
                scores[col] = -self.solve(&p2, weak)?;
            }
        }
        Some(scores)
    }
}

// ---------------------------------------------------------------------------
// WebAssembly interface. No bindings library: plain exported functions and two
// fixed buffers in linear memory.
//   moves_ptr(): 64 bytes, the move list (columns 0-6)
//   out_ptr():   8 i32, analyze() writes the 7 column scores here
// Node limits are f64 so JavaScript can pass plain numbers.

#[cfg(target_arch = "wasm32")]
#[allow(static_mut_refs)]
mod wasm {
    use super::*;

    static mut SOLVER: Option<Solver> = None;
    static mut MOVES: [u8; 64] = [0; 64];
    static mut OUT: [i32; 8] = [0; 8];

    fn solver() -> &'static mut Solver {
        unsafe { SOLVER.get_or_insert_with(|| Solver::new(22)) }
    }

    fn position(n: u32) -> Option<Position> {
        if n > 42 { return None; }
        unsafe { Position::from_moves(&MOVES[..n as usize]) }
    }

    fn limit(node_limit: f64) -> u64 {
        if node_limit <= 0.0 || !node_limit.is_finite() { u64::MAX } else { node_limit as u64 }
    }

    #[no_mangle] pub extern "C" fn moves_ptr() -> *mut u8 { unsafe { MOVES.as_mut_ptr() } }
    #[no_mangle] pub extern "C" fn out_ptr() -> *mut i32 { unsafe { OUT.as_mut_ptr() } }

    /// Fills OUT with the score of each column. Returns 0, -1 for a bad position, -2 if the limit was hit.
    #[no_mangle] pub extern "C" fn analyze(n: u32, weak: u32, node_limit: f64) -> i32 {
        let Some(p) = position(n) else { return -1 };
        let s = solver();
        s.node_count = 0;
        s.node_limit = limit(node_limit);
        match s.analyze(&p, weak != 0) {
            Some(scores) => {
                unsafe { for c in 0..WIDTH { OUT[c] = scores[c]; } }
                0
            }
            None => -2,
        }
    }

    /// Score of the position, or 1000 for a bad position, 1001 if the limit was hit.
    #[no_mangle] pub extern "C" fn solve(n: u32, weak: u32, node_limit: f64) -> i32 {
        let Some(p) = position(n) else { return 1000 };
        let s = solver();
        s.node_count = 0;
        s.node_limit = limit(node_limit);
        s.solve(&p, weak != 0).unwrap_or(1001)
    }

    #[no_mangle] pub extern "C" fn nodes() -> f64 { solver().node_count as f64 }
    #[no_mangle] pub extern "C" fn reset() { solver().reset(); }
}
