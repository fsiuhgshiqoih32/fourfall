# Fourfall

Four in a row in the browser, on a walnut board with brass and pearl discs.

**Play:** https://fsiuhgshiqoih32.github.io/fourfall/

![Fourfall home screen](og.jpg)

## Ways to play

- **Pass and play:** two players take turns on one device. Undo is available.
- **Play the computer:** easy, normal or hard. The hard level searches ahead for about a second per move.
- **Play online:** create a room and send a friend the link or the six-character code. Rematches alternate who moves first, and a game survives a page reload.
- **Train with the solver:** play a perfect opponent and get coached on every move:
  - Each move is graded best, good, mistake or blunder, with the reason (a missed win, a missed block, handing over the square on top, two threats at once, odd and even rows).
  - The coach shows who wins with perfect play and in how many moves.
  - Tools: hints, the value of every column, the line of best play drawn as numbered discs, and take-backs.
  - A review at the end of each game.
  - Six lessons and a bank of puzzles, all checked by the solver.

Keys: Left and Right choose a column, Enter or Space drops a disc, 1 to 7 drop straight into a column, U undoes.

## How online play works

There is no game server. Both players connect to three public MQTT relays over secure WebSockets (EMQX, HiveMQ and Mosquitto test brokers) and send every message to all of them, so one relay going down doesn't stop a game. Each message is a full snapshot of the game (game number, who moved first, the move list), re-sent every few seconds, so a lost message fixes itself. Each player can only add moves for their own colour, and the room creator decides when a new game starts.

Moves and names travel through public servers that anyone can listen to, so don't put anything private in your name.

## The solver

Four in a row on a 7 x 6 board is solved: the first player wins by starting in the middle. The training opponent plays perfectly using a solver written in Rust (`solver/`) and compiled to WebAssembly (`js/solver.wasm`, about 30 KB). It follows Pascal Pons' well-known approach from "Solving Connect 4: how to build a perfect AI": bitboards, negamax with alpha-beta pruning, null-window iterative deepening, a transposition table, and threat-based move ordering. The code was written from scratch for this project. It matches all 5,000 positions of his public test sets.

Early positions take a live search seconds to minutes, so `data/tree.bin` (230 KB) stores the bot's reply and the exact score for every position it can face in the first 12 discs. The bot always plays one fixed best move, and you can play anything. The generator solves the bot's very first reply as win, draw or loss only. `tools/exact-opening.mjs` then gives those positions exact scores from the level below. From the empty board this reproduces the known values of the seven first moves: -2, -1, 0, 1, 0, -1, -2.

Rebuilding needs Rust with the `wasm32-unknown-unknown` target. The tree takes about an hour on 12 threads:

```bash
cd solver
cargo build --release --lib --target wasm32-unknown-unknown
cargo run --release -- tree 12 11 ../data/tree.bin 12
cd ..
node tools/exact-opening.mjs data/tree.bin
```

Copy `target/wasm32-unknown-unknown/release/fourfall_solver.wasm` to `js/solver.wasm`. `cargo run --release -- analyze 3344` prints the score of every column for a position, written as columns 0 to 6.

## Running it locally

It's plain HTML, CSS and JavaScript modules with no build step. Serve the folder with any static server, for example:

```bash
python -m http.server 8765
```

Then open http://localhost:8765/.

## Files

- `js/game.js`: the rules (pure functions)
- `js/ai-worker.js`: the computer player for the easy, normal and hard levels
- `js/solver-worker.js`, `js/solver.wasm`, `data/tree.bin`: the perfect solver used for training
- `js/coach.js`: grades and explains moves
- `js/lessons.js`, `js/puzzles.js`: lesson and puzzle data (`tools/make-puzzles.mjs` builds the puzzles)
- `solver/`: the solver's Rust source and command-line tool
- `js/board-view.js`: the board, disc animations and input
- `js/online.js`, `js/mqtt-lite.js`: online rooms and a small MQTT client
- `js/sound.js`: synthesised sounds, no audio files
- `js/main.js`: screens and game flow

## Credits

- Fonts: [Gloock](https://github.com/duartp/gloock) and [Figtree](https://github.com/erikdkennedy/figtree), both under the SIL Open Font License 1.1 (see `fonts/`).
- Code: MIT licence (see `LICENSE`).
