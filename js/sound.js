// Synthesised sounds: no audio files. The context starts on the first tap or key.

let ctx = null;
let out = null;
let noise = null;
let muted = false;

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    out = ctx.createDynamicsCompressor();
    out.threshold.value = -14;
    out.ratio.value = 4;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    out.connect(master).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export const setMuted = (m) => { muted = m; };
const ready = () => ctx && !muted && ctx.state === 'running';

function env(g, t, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

// A disc landing: a sharp click plus a short body thump.
// strength 0..1 scales with the fall height; pitch shifts a little per row.
export function clack(strength = 1, pitch = 1, when = 0) {
  if (!ready()) return;
  const t = ctx.currentTime + when;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600 * pitch;
  bp.Q.value = 1.4;
  const g = ctx.createGain();
  env(g, t, 0.55 * strength + 0.08, 0.002, 0.05);
  src.connect(bp).connect(g).connect(out);
  src.start(t, Math.random() * 0.3);
  src.stop(t + 0.08);

  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(240 * pitch, t);
  o.frequency.exponentialRampToValueAtTime(95 * pitch, t + 0.09);
  const og = ctx.createGain();
  env(og, t, 0.4 * strength + 0.05, 0.004, 0.11);
  o.connect(og).connect(out);
  o.start(t);
  o.stop(t + 0.16);

  const r = ctx.createOscillator();
  r.type = 'triangle';
  r.frequency.value = 1180 * pitch;
  const rg = ctx.createGain();
  env(rg, t, 0.06 * strength + 0.01, 0.002, 0.07);
  r.connect(rg).connect(out);
  r.start(t);
  r.stop(t + 0.1);
}

function tone(freq, t, dur, peak, type = 'triangle') {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  env(g, t, peak, 0.01, dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export function win() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.05;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    tone(f, t + i * 0.09, 0.9 - i * 0.1, 0.14, 'triangle');
    tone(f * 2, t + i * 0.09, 0.4, 0.03, 'sine');
  });
}

export function lose() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.05;
  [392, 329.63, 261.63].forEach((f, i) => tone(f, t + i * 0.14, 0.6, 0.11, 'triangle'));
}

export function draw() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.05;
  tone(392, t, 0.5, 0.1);
  tone(392, t + 0.18, 0.7, 0.1);
}

export function join() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.02;
  tone(659.25, t, 0.35, 0.1);
  tone(987.77, t + 0.12, 0.6, 0.1);
}

// The board emptying: a quick cascade of soft clacks.
export function release(count) {
  if (!ready() || count === 0) return;
  const n = Math.min(count, 14);
  for (let i = 0; i < n; i++) clack(0.25, 0.8 + Math.random() * 0.4, 0.12 + i * 0.035 + Math.random() * 0.02);
}

export function bump() {
  if (!ready()) return;
  tone(140, ctx.currentTime, 0.12, 0.12, 'sine');
}
