//! Native tool for the solver: analysis, benchmarks, test sets and the opening book.
//!
//!   c4 analyze <moves>             scores of every column (moves: digits 0-6, "-" for empty)
//!   c4 bench <depth> <count> [seed] [weak]
//!   c4 testset <file>              Pons-format test file: "<moves 1-7> <score>" per line
//!   c4 tree <limit_bot_first> <limit_you_first> <out> [threads] [seed.bin]
//!       the perfect bot's replies for every position it can face up to the limits

use fourfall_solver::*;
use std::time::Instant;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
}

fn parse_moves(s: &str) -> Vec<u8> {
    if s == "-" { return vec![]; }
    s.bytes().map(|b| b - b'0').collect()
}

fn random_position(rng: &mut Rng, depth: usize) -> Option<(Vec<u8>, Position)> {
    let mut moves = Vec::new();
    let mut p = Position::new();
    while moves.len() < depth {
        let legal: Vec<usize> = (0..WIDTH).filter(|&c| p.can_play(c) && !p.is_winning_move(c)).collect();
        if legal.is_empty() { return None; }
        let c = legal[rng.below(legal.len() as u64) as usize];
        p.play_col(c);
        moves.push(c as u8);
    }
    if p.can_win_next() { return None; }
    Some((moves, p))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("analyze") => {
            let moves = parse_moves(args.get(2).map(|s| s.as_str()).unwrap_or("-"));
            let Some(p) = Position::from_moves(&moves) else { eprintln!("bad position"); std::process::exit(1) };
            let weak = args.get(3).map(|s| s == "weak").unwrap_or(false);
            let mut s = Solver::new(24);
            let t = Instant::now();
            let scores = s.analyze(&p, weak).unwrap();
            let line: Vec<String> = scores.iter().map(|&v| if v == INVALID { "x".into() } else { v.to_string() }).collect();
            println!("{}", line.join(" "));
            eprintln!("{:.3} s, {} nodes", t.elapsed().as_secs_f64(), s.node_count);
        }
        Some("bench") => {
            let depth: usize = args[2].parse().unwrap();
            let count: usize = args[3].parse().unwrap();
            let seed: u64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1);
            let weak = args.get(5).map(|s| s == "weak").unwrap_or(false);
            let mut rng = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15) | 1);
            let mut s = Solver::new(24);
            let mut times = Vec::new();
            let mut done = 0;
            while done < count {
                let Some((moves, p)) = random_position(&mut rng, depth) else { continue };
                s.reset();
                s.node_count = 0;
                let t = Instant::now();
                let v = s.solve(&p, weak).unwrap();
                let dt = t.elapsed().as_secs_f64();
                times.push((dt, s.node_count, moves.iter().map(|m| (b'0' + m) as char).collect::<String>(), v));
                done += 1;
            }
            times.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let mean: f64 = times.iter().map(|t| t.0).sum::<f64>() / times.len() as f64;
            let worst = times.last().unwrap();
            println!("depth {depth}: n={count} mean {:.4}s median {:.4}s p90 {:.4}s max {:.4}s ({} nodes, {} score {})",
                mean, times[times.len() / 2].0, times[times.len() * 9 / 10].0, worst.0, worst.1, worst.2, worst.3);
        }
        Some("testset") => {
            let text = std::fs::read_to_string(&args[2]).unwrap();
            let mut s = Solver::new(24);
            let (mut ok, mut bad, mut total_t) = (0, 0, 0.0);
            for line in text.lines() {
                let mut it = line.split_whitespace();
                let (Some(m), Some(sc)) = (it.next(), it.next()) else { continue };
                let moves: Vec<u8> = m.bytes().map(|b| b - b'1').collect();
                let expect: i32 = sc.parse().unwrap();
                let Some(p) = Position::from_moves(&moves) else { eprintln!("bad: {line}"); bad += 1; continue };
                s.reset();
                let t = Instant::now();
                let v = s.solve(&p, false).unwrap();
                total_t += t.elapsed().as_secs_f64();
                if v == expect { ok += 1 } else { bad += 1; eprintln!("MISMATCH {m}: got {v}, expected {expect}"); }
            }
            println!("{ok} correct, {bad} wrong, mean {:.5}s", total_t / (ok + bad).max(1) as f64);
        }
        Some("tree") => {
            let limit_a: u32 = args[2].parse().unwrap();
            let limit_b: u32 = args[3].parse().unwrap();
            let out = &args[4];
            let threads: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(4);
            let seed = args.get(6).map(|s| s.as_str());
            tree::generate(limit_a, limit_b, out, threads, seed);
        }
        _ => eprintln!("usage: c4 analyze <moves> | bench <depth> <count> [seed] [weak] | testset <file> | tree <limitA> <limitB> <out> [threads]"),
    }
}

mod tree {
    //! The bot's strategy tree. The bot always plays one fixed best move, the
    //! human may play anything, so only these positions can arise in training.
    //! For every bot-to-move position up to the depth limit we store the bot's
    //! move and the position's exact score (bot's point of view). The scores of
    //! a human's options are the scores of the bot positions they lead to.
    //!
    //! File format "FFT1": u32 count, then the keys, moves and scores as three arrays:
    //!   f64 canonical key (exact, keys are below 2^53), u8 move, i8 score.
    //! The bot's first reply (positions with WEAK_MAX discs or fewer) is solved
    //! only as win / draw / loss, which is far quicker; those scores are stored
    //! as 99 (win), 0 (draw) or -99 (loss) for the bot.
    //! The canonical key is min(key, mirrored key); when the mirror is used the
    //! stored move is mirrored too (6 - move).
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    const PREFERENCE: [usize; WIDTH] = [3, 2, 4, 1, 5, 0, 6];
    const WEAK_MAX: u32 = 2;

    fn canonical(p: &Position) -> (u64, bool) {
        let k = p.key();
        let m = p.mirror().key();
        if k <= m { (k, false) } else { (m, true) }
    }

    /// Every position a human move can lead to (skipping moves that win or fill the board).
    fn human_children(p: &Position) -> Vec<Position> {
        let mut out = Vec::new();
        for c in 0..WIDTH {
            if p.can_play(c) && !p.is_winning_move(c) {
                let mut q = *p;
                q.play_col(c);
                if (q.nb_moves() as i32) < CELLS { out.push(q); }
            }
        }
        out
    }

    fn best_move(scores: &[i32; WIDTH]) -> (usize, i32) {
        let mut best = PREFERENCE[0];
        let mut bv = i32::MIN;
        for &c in &PREFERENCE {
            if scores[c] != INVALID && scores[c] > bv { bv = scores[c]; best = c; }
        }
        (best, bv)
    }

    /// Reads a tree file back into the table, so a deeper run only solves new positions.
    fn load(path: &str, table: &mut HashMap<u64, (u8, i8)>) {
        let b = std::fs::read(path).expect("seed file");
        assert_eq!(&b[0..4], b"FFT1", "not a tree file");
        let n = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
        for i in 0..n {
            let o = 8 + i * 8;
            let key = f64::from_le_bytes(b[o..o + 8].try_into().unwrap()) as u64;
            table.insert(key, (b[8 + n * 8 + i], b[8 + n * 9 + i] as i8));
        }
    }

    pub fn generate(limit_a: u32, limit_b: u32, out_path: &str, threads: usize, seed: Option<&str>) {
        let t0 = Instant::now();
        // Bot moves first: it opens in the centre (the only winning first move).
        let mut after_centre = Position::new();
        after_centre.play_col(3);
        let mut frontier: Vec<(Position, u32)> = human_children(&after_centre).into_iter().map(|p| (p, limit_a)).collect();
        // Human moves first.
        frontier.extend(human_children(&Position::new()).into_iter().map(|p| (p, limit_b)));

        let mut table: HashMap<u64, (u8, i8)> = HashMap::new();
        if let Some(path) = seed {
            load(path, &mut table);
            eprintln!("seeded with {} positions from {path}", table.len());
        }
        let mut seen: HashSet<u64> = HashSet::new();
        while !frontier.is_empty() {
            // One level at a time: dedupe, solve in parallel, then expand.
            let mut level = Vec::new();
            for (p, lim) in frontier.drain(..) {
                if p.nb_moves() > lim { continue; }
                if seen.insert(canonical(&p).0) { level.push((p, lim)); }
            }
            if level.is_empty() { break; }
            let depth_info: Vec<u32> = { let mut d: Vec<u32> = level.iter().map(|x| x.0.nb_moves()).collect(); d.sort(); d.dedup(); d };
            let tl = Instant::now();
            // Positions the seed already knows are not solved again.
            let (known, level): (Vec<_>, Vec<_>) = level.into_iter().partition(|(p, _)| table.contains_key(&canonical(p).0));
            let mut reused = Vec::with_capacity(known.len());
            for (p, lim) in known {
                let (k, mirrored) = canonical(&p);
                let (stored, v) = table[&k];
                let mv = if mirrored { WIDTH - 1 - stored as usize } else { stored as usize };
                reused.push((p, lim, mv, v as i32));
            }
            let n = level.len();
            let queue = Arc::new(Mutex::new(level.clone()));
            let results = Arc::new(Mutex::new(Vec::with_capacity(n)));
            let mut handles = Vec::new();
            for _ in 0..threads {
                let queue = Arc::clone(&queue);
                let results = Arc::clone(&results);
                handles.push(std::thread::spawn(move || {
                    let mut s = Solver::new(23);
                    loop {
                        let item = { queue.lock().unwrap().pop() };
                        let Some((p, lim)) = item else { break };
                        let weak = p.nb_moves() <= WEAK_MAX;
                        let scores = s.analyze(&p, weak).unwrap();
                        let (mv, v) = best_move(&scores);
                        let v = if weak { v.signum() * 99 } else { v };
                        results.lock().unwrap().push((p, lim, mv, v));
                    }
                }));
            }
            for h in handles { h.join().unwrap(); }
            let mut results = Arc::try_unwrap(results).unwrap().into_inner().unwrap();
            let n_reused = reused.len();
            results.extend(reused);
            for (p, lim, mv, v) in results {
                let (k, mirrored) = canonical(&p);
                let stored = if mirrored { WIDTH - 1 - mv } else { mv };
                table.insert(k, (stored as u8, v as i8));
                let mut q = p;
                if q.is_winning_move(mv) { continue; }
                q.play_col(mv);
                if q.nb_moves() as i32 >= CELLS { continue; }
                for child in human_children(&q) { frontier.push((child, lim)); }
            }
            eprintln!("depths {:?}: {} solved, {} from the seed, {:.0} s (total {:.0} s)", depth_info, n, n_reused, tl.elapsed().as_secs_f64(), t0.elapsed().as_secs_f64());
            write(&table, out_path);
        }
        eprintln!("done: {} positions, {:.0} s", table.len(), t0.elapsed().as_secs_f64());
    }

    fn write(table: &HashMap<u64, (u8, i8)>, out_path: &str) {
        let mut entries: Vec<_> = table.iter().collect();
        entries.sort_by_key(|e| *e.0);
        let mut bytes = Vec::with_capacity(8 + entries.len() * 10);
        bytes.extend_from_slice(b"FFT1");
        bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (k, _) in &entries { bytes.extend_from_slice(&(**k as f64).to_le_bytes()); }
        for (_, (m, _)) in &entries { bytes.push(*m); }
        for (_, (_, v)) in &entries { bytes.push(*v as u8); }
        std::fs::write(out_path, &bytes).unwrap();
    }
}
