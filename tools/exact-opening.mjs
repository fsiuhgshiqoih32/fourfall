// Gives the opening tree's first level exact scores.
//
// The tree generator solves the bot's first reply (positions with 1 or 2 discs)
// as win / draw / loss only, stored as +-99, because exact solves there take far
// too long. Every position one bot move and one human move later is stored with
// an exact score, so the exact value of the line the bot actually plays follows:
//   value(bot node) = -max over human replies c of (-value(node + bot move + c)).
//
// usage: node tools/exact-opening.mjs data/tree.bin [out.bin]

import fs from 'node:fs';

const [, , inPath, outPath = inPath] = process.argv;
const buf = fs.readFileSync(inPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
if (String.fromCharCode(...new Uint8Array(ab, 0, 4)) !== 'FFT1') throw new Error('not a tree file');
const count = new DataView(ab).getUint32(4, true);
const keys = new Float64Array(ab, 8, count);
const moves = new Uint8Array(ab, 8 + count * 8, count);
const vals = new Int8Array(ab, 8 + count * 9, count);

function keysOf(list) {
  const heights = [0, 0, 0, 0, 0, 0, 0];
  const toMove = list.length % 2;
  let cur = 0, mask = 0, mcur = 0, mmask = 0;
  list.forEach((c, i) => {
    const r = heights[c]++;
    const v = 2 ** (c * 7 + r), mv = 2 ** ((6 - c) * 7 + r);
    mask += v; mmask += mv;
    if (i % 2 === toMove) { cur += v; mcur += mv; }
  });
  return [cur + mask, mcur + mmask];
}

function find(list) {
  const [k, mk] = keysOf(list);
  const key = Math.min(k, mk);
  let lo = 0, hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] === key) return { i: mid, col: k <= mk ? moves[mid] : 6 - moves[mid], val: vals[mid] };
    if (keys[mid] < key) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

// The first-level bot nodes: after each human first move, and after the bot's
// centre opening plus each human reply. No fours are possible this early.
const nodes = [];
for (let c = 0; c < 7; c++) nodes.push([c], [3, c]);

let changed = 0;
for (const node of nodes) {
  const e = find(node);
  if (!e) throw new Error(`missing ${node.join('')}`);
  if (Math.abs(e.val) !== 99) continue;
  const h = node.concat(e.col);
  let best = -Infinity;
  for (let c = 0; c < 7; c++) {
    const child = find(h.concat(c));
    if (!child || Math.abs(child.val) === 99) throw new Error(`no exact score for ${h.concat(c).join('')}`);
    best = Math.max(best, -child.val);
  }
  const exact = -best;
  if (Math.sign(exact) !== Math.sign(e.val)) throw new Error(`outcome changed for ${node.join('')}: ${e.val} -> ${exact}`);
  vals[e.i] = exact;
  changed++;
  console.log(`${node.join('')}: bot plays ${e.col}, score ${exact}`);
}
fs.writeFileSync(outPath, Buffer.from(ab));
console.log(`${changed} scores made exact, wrote ${outPath}`);
