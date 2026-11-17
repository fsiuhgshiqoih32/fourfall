// Draws the board, animates discs and turns pointer and key input into columns.
// Discs live in a layer behind the wooden board, so they show through the holes
// and pass behind the wood as they fall.

import { COLS, ROWS, idx } from './game.js';
import * as sound from './sound.js';

const CELL = 100;
const PAD = 30;
const AIR = 104;              // space above the board for the waiting disc
const W = COLS * CELL + PAD * 2;
const HB = ROWS * CELL + PAD * 2;
const HT = AIR + HB;
const HOLE_R = 38;
const DISC_R = 42;
const PREVIEW_Y = AIR / 2;
const PCT = 100 / (DISC_R * 2); // one board unit as a percentage of a disc

export const GEOMETRY = { W, HT };

const cx = (c) => PAD + c * CELL + CELL / 2;
const cy = (r) => AIR + PAD + (ROWS - 1 - r) * CELL + CELL / 2;
const pct = (v) => `${v}%`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function boardMarkup() {
  let holes = '', rims = '', cavities = '';
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const x = PAD + c * CELL + CELL / 2, y = PAD + r * CELL + CELL / 2;
      holes += `<circle cx="${x}" cy="${y}" r="${HOLE_R}"/>`;
      cavities += `<circle cx="${x}" cy="${y}" r="${HOLE_R}"/>`;
      rims += `<circle cx="${x}" cy="${y}" r="${HOLE_R + 1.3}"/>`;
    }
  }
  const screws = [[17, 17], [W - 17, 17], [17, HB - 17], [W - 17, HB - 17]]
    .map(([x, y], i) => `<g transform="translate(${x} ${y}) rotate(${[28, -40, 65, 12][i]})">
      <circle r="7" fill="url(#ff-brass)"/><circle r="7" fill="none" stroke="#3b2208" stroke-opacity=".55" stroke-width="1"/>
      <rect x="-5" y="-0.9" width="10" height="1.8" rx=".9" fill="#4a2d0c" fill-opacity=".75"/></g>`).join('');
  return `
  <defs>
    <linearGradient id="ff-wood" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#83533a"/>
      <stop offset=".5" stop-color="#5e3826"/>
      <stop offset="1" stop-color="#3b2217"/>
    </linearGradient>
    <filter id="ff-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0032 0.075" numOctaves="4" seed="11"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.13  0 0 0 0 0.06  0 0 0 0 0.03  2.1 0 0 0 -0.86"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="ff-figure" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0016 0.028" numOctaves="3" seed="4"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.98  0 0 0 0 0.72  0 0 0 0 0.48  0 1.7 0 0 -0.78"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <radialGradient id="ff-sheen" cx=".28" cy="-.05" r="1">
      <stop offset="0" stop-color="#fff2df" stop-opacity=".2"/>
      <stop offset=".5" stop-color="#fff2df" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ff-edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd8ab" stop-opacity=".6"/>
      <stop offset=".07" stop-color="#ffd8ab" stop-opacity="0"/>
      <stop offset=".93" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity=".55"/>
    </linearGradient>
    <linearGradient id="ff-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#120803" stop-opacity=".8"/>
      <stop offset=".45" stop-color="#120803" stop-opacity="0"/>
      <stop offset=".7" stop-color="#ffd9aa" stop-opacity="0"/>
      <stop offset="1" stop-color="#ffd9aa" stop-opacity=".5"/>
    </linearGradient>
    <linearGradient id="ff-cavity" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#050302" stop-opacity=".6"/>
      <stop offset=".42" stop-color="#050302" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="ff-brass" cx=".35" cy=".3" r=".8">
      <stop offset="0" stop-color="#fbe4a4"/>
      <stop offset=".5" stop-color="#c8963c"/>
      <stop offset="1" stop-color="#7a5218"/>
    </radialGradient>
    <mask id="ff-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${HB}">
      <rect width="${W}" height="${HB}" fill="#fff"/>
      <g fill="#000">${holes}</g>
    </mask>
  </defs>
  <g mask="url(#ff-holes)">
    <rect width="${W}" height="${HB}" rx="30" fill="url(#ff-wood)"/>
    <rect width="${W}" height="${HB}" rx="30" filter="url(#ff-figure)" opacity=".55"/>
    <rect width="${W}" height="${HB}" rx="30" filter="url(#ff-grain)" opacity=".9"/>
    <rect width="${W}" height="${HB}" rx="30" fill="url(#ff-sheen)"/>
    <rect x="1.5" y="1.5" width="${W - 3}" height="${HB - 3}" rx="29" fill="none" stroke="url(#ff-edge)" stroke-width="3"/>
  </g>
  <g fill="url(#ff-cavity)">${cavities}</g>
  <g fill="none" stroke="url(#ff-rim)" stroke-width="2.6">${rims}</g>
  ${screws}`;
}

export class BoardView {
  constructor(root) {
    this.root = root;
    this.discs = new Map();      // cell index -> element
    this.reduced = false;
    this.silent = false;
    this.inputOn = false;
    this.hoverCol = 3;
    this.onDrop = () => {};
    this.onHover = () => {};
    this.build();
  }

  build() {
    const root = this.root;
    root.style.setProperty('--ratio', `${W} / ${HT}`);
    root.innerHTML = `
      <div class="disc-layer"></div>
      <svg class="board" viewBox="0 0 ${W} ${HB}" aria-hidden="true" focusable="false"
        style="top:${pct((AIR / HT) * 100)};height:${pct((HB / HT) * 100)}">${boardMarkup()}</svg>
      <svg class="overlay" viewBox="0 0 ${W} ${HT}" aria-hidden="true" focusable="false">
        <defs>
          <filter id="ff-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${HT}">
            <feGaussianBlur stdDeviation="6" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <linearGradient id="ff-hint" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ffe2a8" stop-opacity=".16"/>
            <stop offset="1" stop-color="#ffe2a8" stop-opacity=".03"/>
          </linearGradient>
        </defs>
        <rect class="col-hint" x="${PAD + 4}" y="${AIR + 6}" width="${CELL - 8}" height="${ROWS * CELL + PAD * 2 - 12}" rx="20" fill="url(#ff-hint)"/>
        <g class="notes"></g>
        <g class="win"></g>
      </svg>
      <canvas class="sparks" aria-hidden="true"></canvas>
      <div class="cols" role="group" aria-label="Board columns"></div>`;
    this.layer = root.querySelector('.disc-layer');
    this.overlay = root.querySelector('.overlay');
    this.hint = root.querySelector('.col-hint');
    this.winGroup = root.querySelector('.win');
    this.notes = root.querySelector('.notes');
    this.canvas = root.querySelector('.sparks');
    this.cols = root.querySelector('.cols');

    this.preview = document.createElement('div');
    this.preview.className = 'disc preview';
    this.place(this.preview, cx(0), PREVIEW_Y);
    this.layer.append(this.preview);

    this.buttons = [];
    for (let c = 0; c < COLS; c++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'col';
      b.tabIndex = c === 3 ? 0 : -1;
      b.style.left = pct(((PAD + c * CELL) / W) * 100);
      b.style.width = pct((CELL / W) * 100);
      b.addEventListener('keydown', (e) => this.key(e, c));
      b.addEventListener('focus', () => { if (this.inputOn) this.onHover(c); });
      b.addEventListener('click', (e) => { if (e.detail === 0 && this.inputOn) this.onDrop(c); });
      this.cols.append(b);
      this.buttons.push(b);
    }
    this.labelColumns();
    this.bindPointer();
  }

  place(el, x, y) {
    el.style.left = pct(((x - DISC_R) / W) * 100);
    el.style.top = pct(((y - DISC_R) / HT) * 100);
  }

  // ----- input

  colAt(e) {
    const rect = this.root.getBoundingClientRect();
    const u = ((e.clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(COLS - 1, Math.floor((u - PAD) / CELL)));
  }

  bindPointer() {
    const el = this.cols;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.inputOn || (e.pointerType === 'mouse' && e.button !== 0)) return;
      sound.unlock();
      down = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      this.onHover(this.colAt(e));
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.inputOn) return;
      const c = this.colAt(e);
      if (c !== this.hoverCol || !this.root.classList.contains('hovering')) this.onHover(c);
    });
    el.addEventListener('pointerup', (e) => {
      if (down !== e.pointerId) return;
      down = null;
      const rect = this.root.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top - 40 && e.clientY <= rect.bottom;
      if (this.inputOn && inside) this.onDrop(this.colAt(e));
    });
    el.addEventListener('pointercancel', () => { down = null; });
    el.addEventListener('pointerleave', (e) => {
      if (down === null && e.pointerType === 'mouse') this.onHover(-1);
    });
  }

  key(e, c) {
    if (!this.inputOn) return;
    let next = null;
    if (e.key === 'ArrowLeft') next = (c + COLS - 1) % COLS;
    else if (e.key === 'ArrowRight') next = (c + 1) % COLS;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = COLS - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      sound.unlock();
      this.onDrop(c);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      this.focusColumn(next);
    }
  }

  focusColumn(c) {
    this.buttons.forEach((b, i) => { b.tabIndex = i === c ? 0 : -1; });
    this.buttons[c].focus();
  }

  setInput(on) {
    this.inputOn = on;
    this.root.classList.toggle('live', on);
    if (!on) this.root.classList.remove('hovering');
  }

  labelColumns(heights) {
    this.buttons.forEach((b, c) => {
      const h = heights ? heights[c] : 0;
      b.setAttribute('aria-label', h >= ROWS ? `Column ${c + 1}, full` : `Column ${c + 1}`);
    });
  }

  // ----- the waiting disc above the board

  // Shows the waiting disc for `player` above `col` (0 hides it).
  setPreview(player, col = this.hoverCol) {
    const p = this.preview;
    if (player) {
      p.classList.toggle('p1', player === 1);
      p.classList.toggle('p2', player === 2);
      p.style.transform = `translateX(${col * CELL * PCT}%)`;
    }
    p.classList.toggle('hidden', !player);
  }

  // The pointer or keyboard is on a column: light it and move the waiting disc.
  moveHover(col) {
    this.hoverCol = col;
    this.hint.style.transform = `translateX(${col * CELL}px)`;
    this.root.classList.add('hovering');
    if (!this.preview.classList.contains('hidden')) this.preview.style.transform = `translateX(${col * CELL * PCT}%)`;
    this.buttons.forEach((b, i) => { b.tabIndex = i === col ? 0 : -1; });
    // Keep keyboard focus on the column being shown.
    const active = document.activeElement;
    if (active && this.cols.contains(active) && active !== this.buttons[col]) this.buttons[col].focus({ preventScroll: true });
  }

  unhover() {
    this.root.classList.remove('hovering');
  }

  hideHover() {
    this.preview.classList.add('hidden');
    this.root.classList.remove('hovering');
  }

  bump() {
    sound.bump();
    if (this.reduced) return;
    this.preview.animate([
      { translate: '0 0' }, { translate: '-6% 0' }, { translate: '6% 0' }, { translate: '-3% 0' }, { translate: '0 0' },
    ], { duration: 260, easing: 'ease-out' });
  }

  // ----- discs

  makeDisc(player, col, row) {
    this.discs.get(idx(col, row))?.remove(); // never two discs in one square
    const d = document.createElement('div');
    d.className = `disc p${player}`;
    this.place(d, cx(col), cy(row));
    this.layer.insertBefore(d, this.preview);
    this.discs.set(idx(col, row), d);
    return d;
  }

  // Drops a disc from above the board. Resolves once it has landed and bounced.
  drop(col, row, player) {
    const d = this.makeDisc(player, col, row);
    const fall = cy(row) - PREVIEW_Y;
    const cellsFell = fall / CELL;
    const tFall = Math.round(150 + 290 * Math.sqrt(cellsFell / 6.5));
    const strength = Math.min(1, 0.35 + cellsFell / 7);
    const pitch = 0.92 + row * 0.03;
    if (this.reduced) {
      d.animate([{ transform: `translateY(${-fall * PCT}%)` }, { transform: 'none' }],
        { duration: tFall, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'backwards' });
      if (!this.silent) setTimeout(() => sound.clack(strength, pitch), tFall);
      return sleep(tFall + 30);
    }
    const bh = Math.min(16, 4 + cellsFell * 2.2);
    const b2 = bh * 0.32;
    const t1 = Math.round(60 + bh * 3.2), t2 = Math.round(t1 * 0.6);
    const total = tFall + 2 * t1 + 2 * t2;
    const at = (ms) => ms / total;
    const down = 'cubic-bezier(.55,0,1,.45)', up = 'cubic-bezier(0,.55,.45,1)';
    d.animate([
      { offset: 0, transform: `translateY(${-fall * PCT}%)`, easing: down },
      { offset: at(tFall), transform: 'translateY(0)', easing: up },
      { offset: at(tFall + t1), transform: `translateY(${-bh * PCT}%)`, easing: down },
      { offset: at(tFall + 2 * t1), transform: 'translateY(0)', easing: up },
      { offset: at(tFall + 2 * t1 + t2), transform: `translateY(${-b2 * PCT}%)`, easing: down },
      { offset: 1, transform: 'translateY(0)' },
    ], { duration: total, fill: 'backwards' });
    if (!this.silent) {
      setTimeout(() => { sound.clack(strength, pitch); this.thud(cellsFell); }, tFall);
      setTimeout(() => sound.clack(strength * 0.22, pitch * 1.05), tFall + 2 * t1);
    }
    return sleep(tFall + 2 * t1);
  }

  thud(cellsFell) {
    if (this.reduced || cellsFell < 2.5) return;
    this.root.animate([{ transform: 'none' }, { transform: 'translateY(0.25%)' }, { transform: 'none' }],
      { duration: 140, easing: 'ease-out' });
  }

  // Takes the top disc of a column back out (undo).
  async lift(col, row) {
    const d = this.discs.get(idx(col, row));
    if (!d) return;
    this.discs.delete(idx(col, row));
    const rise = cy(row) - PREVIEW_Y;
    const a = d.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${-rise * PCT}%)`, opacity: 0 }],
      { duration: this.reduced ? 120 : 280, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
    await a.finished.catch(() => {});
    d.remove();
  }

  // Shows a position at once, without animation.
  setPosition(state) {
    this.clearWin();
    for (const d of this.discs.values()) d.remove();
    this.discs.clear();
    if (!state) return;
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const p = state.cells[idx(c, r)];
        if (p) this.makeDisc(p, c, r);
      }
    }
    this.labelColumns(state.heights);
  }

  // Opens the bottom of the board: every disc falls out, column by column.
  async releaseAll() {
    this.clearWin();
    this.clearNotes();
    const list = [...this.discs.entries()];
    this.discs.clear();
    if (!list.length) return;
    if (!this.silent) sound.release(list.length);
    const anims = list.map(([i, d]) => {
      const c = Math.floor(i / ROWS), r = i % ROWS;
      if (this.reduced) {
        return d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
      }
      const dist = HT - cy(r) + DISC_R * 2 + 12;
      const dur = 230 + 230 * Math.sqrt(dist / (ROWS * CELL));
      return d.animate([{ transform: 'none' }, { transform: `translateY(${dist * PCT}%)` }],
        { duration: dur, delay: c * 42, easing: 'cubic-bezier(.5,0,1,.55)', fill: 'forwards' });
    });
    await Promise.all(anims.map((a) => a.finished.catch(() => {})));
    for (const [, d] of list) d.remove();
    this.labelColumns();
  }

  // ----- coaching notes drawn over the board

  svg(tag, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  clearNotes() {
    this.notes.replaceChildren();
  }

  // Outcome tags on the square each column would land on: [{ col, row, label, kind }],
  // kind 'win' | 'draw' | 'loss' | 'unknown' | 'best'.
  showTags(items) {
    this.notes.querySelectorAll('.note-tag').forEach((n) => n.remove());
    for (const it of items) {
      const g = this.svg('g', { class: `note-tag ${it.kind}${it.best ? ' best' : ''}`, transform: `translate(${cx(it.col)} ${cy(it.row)})` });
      g.append(this.svg('circle', { r: HOLE_R - 3 }));
      g.append(this.svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 1 }, it.label));
      this.notes.append(g);
    }
  }

  // Numbered ghost discs showing a line of play: [{ col, row, player, n }].
  // Discs numbered up to `alreadyShown` were drawn before and don't fade in again.
  showGhosts(items, finalLines = null, winner = 0, alreadyShown = 0) {
    this.notes.querySelectorAll('.note-ghost, .note-line').forEach((n) => n.remove());
    if (finalLines && winner) {
      for (const line of finalLines) {
        const [c0, r0] = line[0], [c1, r1] = line[line.length - 1];
        this.notes.append(this.svg('line', {
          class: `note-line p${winner}`, x1: cx(c0), y1: cy(r0), x2: cx(c1), y2: cy(r1),
        }));
      }
    }
    for (const it of items) {
      const old = it.n <= alreadyShown;
      const g = this.svg('g', { class: `note-ghost p${it.player}${old ? ' still' : ''}`, transform: `translate(${cx(it.col)} ${cy(it.row)})` });
      if (!old) g.style.animationDelay = `${(it.n - alreadyShown) * 70}ms`;
      g.append(this.svg('circle', { r: HOLE_R - 1 }));
      g.append(this.svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 1 }, String(it.n)));
      this.notes.append(g);
    }
  }

  // Rings around cells worth looking at: [[col,row], ...].
  showMarks(cells, kind = 'note-mark') {
    this.notes.querySelectorAll(`.${kind}`).forEach((n) => n.remove());
    for (const [c, r] of cells) {
      this.notes.append(this.svg('circle', { class: kind, cx: cx(c), cy: cy(r), r: HOLE_R + 5 }));
    }
  }

  // How many lines of four pass through each empty cell (counts[c][r]).
  showHeat(counts, cells) {
    this.notes.querySelectorAll('.note-heat').forEach((n) => n.remove());
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if (cells && cells[idx(c, r)]) continue;
        const v = counts[c][r];
        const g = this.svg('g', { class: 'note-heat', transform: `translate(${cx(c)} ${cy(r)})` });
        g.style.setProperty('--h', String(v / 13));
        g.append(this.svg('circle', { r: HOLE_R - 4 }));
        g.append(this.svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 1 }, String(v)));
        this.notes.append(g);
      }
    }
  }

  // ----- the result

  showWin(lines, player, quiet = false) {
    this.clearWin();
    const winning = new Set();
    for (const line of lines) for (const [c, r] of line) winning.add(idx(c, r));
    for (const [i, d] of this.discs) d.classList.toggle('dim', !winning.has(i));
    const ns = 'http://www.w3.org/2000/svg';
    for (const line of lines) {
      const [c0, r0] = line[0], [c1, r1] = line[line.length - 1];
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', cx(c0)); l.setAttribute('y1', cy(r0));
      l.setAttribute('x2', cx(c1)); l.setAttribute('y2', cy(r1));
      l.setAttribute('pathLength', '1');
      l.setAttribute('class', `win-line p${player}`);
      this.winGroup.append(l);
    }
    for (const i of winning) {
      const c = Math.floor(i / ROWS), r = i % ROWS;
      const ring = document.createElementNS(ns, 'circle');
      ring.setAttribute('cx', cx(c)); ring.setAttribute('cy', cy(r)); ring.setAttribute('r', HOLE_R + 4);
      ring.setAttribute('class', `win-ring p${player}`);
      this.winGroup.append(ring);
    }
    if (!this.reduced && !quiet) this.sparks(lines, player);
  }

  clearWin() {
    this.winGroup.replaceChildren();
    for (const d of this.discs.values()) d.classList.remove('dim');
  }

  sparks(lines, player) {
    const cv = this.canvas;
    const rect = this.root.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
    const g = cv.getContext('2d');
    const s = (rect.width / W) * dpr;
    const colors = player === 1
      ? ['#fbe3a1', '#e2b450', '#c48a2c', '#fff4cf']
      : ['#ffffff', '#f1ece2', '#e6d9f2', '#d8eef2'];
    const parts = [];
    for (const line of lines) {
      const [c0, r0] = line[0], [c1, r1] = line[line.length - 1];
      for (let k = 0; k < 44; k++) {
        const t = Math.random();
        parts.push({
          x: (cx(c0) + (cx(c1) - cx(c0)) * t) * s,
          y: (cy(r0) + (cy(r1) - cy(r0)) * t) * s,
          vx: (Math.random() - 0.5) * 9 * s,
          vy: (-Math.random() * 9 - 3) * s,
          w: (5 + Math.random() * 7) * s,
          h: (2 + Math.random() * 3) * s,
          a: Math.random() * Math.PI,
          va: (Math.random() - 0.5) * 0.4,
          col: colors[k % colors.length],
        });
      }
    }
    const t0 = performance.now();
    const life = 1300;
    cancelAnimationFrame(this.sparkFrame);
    const step = (now) => {
      const t = now - t0;
      g.clearRect(0, 0, cv.width, cv.height);
      if (t > life) return;
      const fade = 1 - t / life;
      for (const p of parts) {
        p.vy += 0.38 * s;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.a += p.va;
        g.save();
        g.globalAlpha = fade;
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = p.col;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a * 2)) + 0.5);
        g.restore();
      }
      this.sparkFrame = requestAnimationFrame(step);
    };
    this.sparkFrame = requestAnimationFrame(step);
  }
}
