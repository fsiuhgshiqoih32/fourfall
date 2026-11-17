// Training mode lessons: six short lessons, each with a few positions to solve
// on the real board while the solver plays the other side.
//
// Each task is a position given as a move list (digits 0-6, column numbers in
// play order) plus `first`, the player number who moved first. `you` is the
// learner's player number and it is always the learner's turn. `accept` holds
// exactly the columns (0-based) whose solver outcome (win, draw or loss) is the
// best one available in that position; `solution` is the one to show on request.
// `marks` are optional [col, row] cells to highlight, row 0 at the bottom.
// Every task is checked against the solver by tests/lessons.test.mjs.

import { WINDOWS, N } from './game.js';

// How many lines of four pass through each cell, indexed like game.js (idx).
// Used for the `heat` overlay in the first lesson. main.js shows that overlay
// only on a heat lesson's first task, so later tasks must not say "the numbers".
export const LINE_COUNTS = (() => {
  const counts = new Uint8Array(N);
  for (let i = 0; i < WINDOWS.length; i++) counts[WINDOWS[i]]++;
  return counts;
})();

export const LESSONS = [
  {
    id: 'middle',
    title: 'Start in the middle',
    intro: [
      'You need four in a row: across, up and down, or on a diagonal. There are 69 possible lines of four on this board, and they are not spread evenly.',
      'The numbers show how many lines pass through each square. Squares in the middle column are part of up to 13 lines, the corners only 3. Added up, the middle column comes to 60 and each edge column to 24.',
      'A disc in the middle helps more of your lines and blocks more of the solver\'s. Start there, and keep coming back to it.',
    ],
    heat: true,
    tasks: [
      {
        moves: '',
        first: 1,
        you: 1,
        prompt: 'The board is empty and you move first. Where do you play?',
        accept: [3],
        solution: 3,
        right: 'Column 4 is the only first move that wins with perfect play; columns 3 and 5 draw and the rest lose. Its bottom square is part of 7 lines, the corners only 3.',
        wrong: 'Compare the numbers on the bottom row. Which square there is part of the most lines?',
      },
      {
        moves: '6433453422',
        first: 1,
        you: 1,
        prompt: 'Nobody has a threat yet, so think of the line counts. Where do you play?',
        accept: [3],
        solution: 3,
        right: 'Column 4 lands on row 4, a square that is part of 13 lines, more than any other move here. The solver says it is the only winning move.',
        wrong: 'Look where each column would land your disc. The middle column has the most lines in every row, and its squares on rows 3 and 4 have the most of all.',
      },
      {
        moves: '44113265443',
        first: 1,
        you: 2,
        prompt: 'You moved second in this game, and nobody has a threat yet. Where do you play?',
        accept: [3],
        solution: 3,
        right: 'Column 4 lands on row 3, a square that is part of 13 lines, more than any other move here. The solver says it is the only winning move.',
        wrong: 'Look where each column would land your disc. The middle column has the most lines in every row, and its squares on rows 3 and 4 have the most of all.',
      },
    ],
  },
  {
    id: 'win-first',
    title: 'Win first, then block',
    intro: [
      'Before every move, ask two questions, in this order. Can I make four right now? Can the solver make four with its next disc?',
      'If you can win, win. Blocking first only gives the solver another move. If you can\'t win, find the square where the solver would finish four and fill it.',
      'Check all four directions each time: across, up and down, and both diagonals. Diagonals are easy to miss.',
    ],
    tasks: [
      {
        moves: '3133131332116242',
        first: 1,
        you: 1,
        prompt: 'The solver has three in column 3. Where do you play?',
        accept: [5],
        solution: 5,
        right: 'Column 6 completes four on row 1. The solver\'s three in column 3 no longer matters once you have won.',
        wrong: 'Before you block, look for a four of your own.',
      },
      {
        moves: '253140430244',
        first: 1,
        you: 1,
        prompt: 'You have no four to make this time. Where do you play?',
        accept: [3],
        solution: 3,
        right: 'The solver\'s diagonal runs from column 2, row 1 to column 5, row 4, with a gap at column 4, row 3. Filling it is the only move that doesn\'t lose.',
        wrong: 'The solver can make four with its next disc. Check the diagonals.',
      },
      {
        moves: '34655024244105223',
        first: 1,
        you: 2,
        prompt: 'The solver threatens four on row 2. Where do you play?',
        accept: [3],
        solution: 3,
        right: 'Column 4 completes your diagonal, from column 3, row 4 down to column 6, row 1. Your own four comes before any block.',
        wrong: 'Check your own lines first, diagonals included.',
      },
    ],
  },
  {
    id: 'under',
    title: 'Don\'t play under a threat',
    intro: [
      'Discs fall to the lowest free square, so a winning square in the air can\'t be used until its column fills up to it.',
      'If the solver has a winning square, the square right below it is poison for you. Fill it, and the solver can drop its disc on top for four.',
      'So before you play a column, look one square above where your disc will land. If that square wins for the solver, play somewhere else.',
    ],
    tasks: [
      {
        moves: '32143343325301522',
        first: 1,
        you: 2,
        prompt: 'The marked square wins for the solver. Where do you play?',
        accept: [0, 1, 2, 4, 5],
        solution: 4,
        right: 'Every column you can play wins here except column 7. Column 7 is empty, so your disc would land on row 1 and the solver would win on top of it.',
        wrong: 'Column 7 is empty, so your disc lands on row 1, right under the solver\'s winning square on row 2.',
        marks: [[6, 1]],
      },
      {
        moves: '314233434421433406110221212',
        first: 1,
        you: 2,
        prompt: 'Three columns are left, and the solver has two winning squares. Where do you play?',
        accept: [6],
        solution: 6,
        right: 'Column 1 would land under the solver\'s square at row 4, and column 6 under its square at row 2. Column 7 is the only safe move, and it wins.',
        wrong: 'Your disc would land right under one of the marked squares.',
        marks: [[0, 3], [5, 1]],
      },
    ],
  },
  {
    id: 'fork',
    title: 'Two threats at once',
    intro: [
      'One threat is easy to stop: the solver blocks it. Two threats at once are different. If both squares can be played, the solver can block only one, and you take the other.',
      'Look for a disc that joins two lines at the same time, such as a row and a diagonal, or a row with both ends open.',
      'It works the other way too. If the solver is one move away from two threats, take that square first.',
    ],
    tasks: [
      {
        moves: '635352341031331',
        first: 1,
        you: 2,
        prompt: 'Make two threats at once. Where do you play?',
        accept: [2],
        solution: 2,
        right: 'Column 3 makes three on row 2 with both ends open, at columns 1 and 5. The solver can block only one of them.',
        wrong: 'Look for a move that gives you two winning squares, both ready to play.',
      },
      {
        moves: '152343433253',
        first: 1,
        you: 1,
        prompt: 'One move here makes two threats at once. Find it.',
        accept: [4],
        solution: 4,
        right: 'Column 5 makes three up column 5 and three on a diagonal at once. You then threaten column 5, row 4 and column 7, row 1, and the solver can block only one.',
        wrong: 'Look for one disc that adds to two of your lines at the same time.',
      },
      {
        moves: '4121356324113',
        first: 1,
        you: 2,
        prompt: 'The solver is one move away from two threats at once. Where do you play?',
        accept: [2],
        solution: 2,
        right: 'From column 3, row 3 the solver would have three up column 3 and three on row 3, with two winning squares ready. Taking that square is the only move that doesn\'t lose.',
        wrong: 'Find the square where a solver disc would make two threats at once, and take it first.',
      },
    ],
  },
  {
    id: 'stack',
    title: 'Stacked threats',
    intro: [
      'Two winning squares in the same column, one right on top of the other, are as strong as two threats side by side.',
      'Once the lower square can be played, the solver has to block it, and its disc becomes the floor for your winning disc above.',
      'A stack works even before it can be played. Whoever fills the square under it, the win is yours.',
    ],
    tasks: [
      {
        moves: '3531232432212623',
        first: 1,
        you: 1,
        prompt: 'You can make two winning squares in one column. Where do you play?',
        accept: [5],
        solution: 5,
        right: 'Column 6 gives you winning squares at rows 2 and 3 of column 5. The solver has to block row 2, and that lets you play row 3.',
        wrong: 'Look for a move that gives you two winning squares in one column, one right above the other.',
      },
      {
        moves: '52116314342443225114103',
        first: 1,
        you: 2,
        prompt: 'Find a move that makes a stack, even one that can\'t be played yet.',
        accept: [5],
        solution: 5,
        right: 'Column 6 gives you winning squares at rows 3 and 4 of column 7. Next you can fill row 2 there yourself: the solver must block row 3, and row 4 is yours.',
        wrong: 'Look for two winning squares in one column, one above the other. They don\'t have to be playable yet.',
      },
      {
        moves: '332324363542103122',
        first: 1,
        you: 1,
        prompt: 'The solver has a winning square at column 2, row 4. Where do you play?',
        accept: [4],
        solution: 4,
        right: 'Column 5, row 3 was the square the solver needed: it would add a winning square at column 2, row 3, right under the one at row 4. Taking it first is the only move that doesn\'t lose.',
        wrong: 'Which square would give the solver a second winning square right below the marked one?',
        marks: [[1, 3]],
      },
    ],
  },
  {
    id: 'parity',
    title: 'Odd and even rows',
    intro: [
      'Rows count from the bottom, 1 to 6. Late in a game, threats that can\'t be played yet often decide who wins, and the row they sit on matters.',
      'Near the end the players run out of safe moves, and someone is forced to play under a threat. When only one column is left, the player who moved first fills its empty squares on odd rows, and the other player the even ones.',
      'So the player who moved first wants threats on odd rows, and the other player wants them on even rows. Then the opponent is the one who has to fill the square underneath.',
    ],
    tasks: [
      {
        moves: '4304422436623433',
        first: 1,
        you: 1,
        prompt: 'You moved first. Two moves here make a new threat. Where do you play?',
        accept: [6],
        solution: 6,
        right: 'Column 7 makes a threat at column 6, row 3. Row 3 is odd, which suits you as the first player; column 1 would make one on row 2, and the solver says that only draws.',
        wrong: 'You moved first, so look for a move that makes a threat on an odd row.',
      },
      {
        moves: '3254225021345524464',
        first: 1,
        you: 2,
        prompt: 'You moved second. Where do you play?',
        accept: [1],
        solution: 1,
        right: 'Column 2 makes a threat at column 4, row 4, an even row, which suits you as the second player. Column 4 would make one on row 3 instead, and the solver says that only draws.',
        wrong: 'You moved second, so look for a move that makes a threat on an even row.',
      },
    ],
  },
];
