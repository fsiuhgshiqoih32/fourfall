// Online play through public MQTT relays. No server of our own.
//
// Each player connects to every relay in RELAYS and sends each message to all
// of them; duplicates are dropped by message id, so one relay going down does
// not interrupt a game.
//
// Every message is a full snapshot of the sender's view: game number, who moved
// first and the move list. Snapshots are re-sent every few seconds, so a lost
// message heals itself. The host decides when a new game starts; each player
// may only add moves for their own colour.

import { MqttLite } from './mqtt-lite.js';
import { replay, stringToMoves } from './game.js';

export const RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const TOPIC = 'fourfall-gh/v1/room/';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HEARTBEAT_MS = 2500;
const PEER_TIMEOUT_MS = 9000;
const GUEST_TAKEOVER_MS = 15000;

export function randomId(n = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36];
  return s;
}

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

// Accepts "kq7 px4", "KQ7-PX4" and so on. Returns null unless it is a valid code.
export function normalizeCode(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 6) return null;
  for (const ch of s) if (!CODE_CHARS.includes(ch)) return null;
  return s;
}

export const formatCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

export function cleanName(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

class Relay {
  constructor(code, myId, onMessage, onStatus) {
    this.topic = TOPIC + code;
    this.myId = myId;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.seen = new Map();
    this.clients = [];
  }

  start() {
    const will = { topic: this.topic, payload: JSON.stringify({ v: 1, t: 'bye', from: this.myId, id: randomId() }) };
    this.clients = RELAYS.map((url) => {
      const c = new MqttLite(url, {
        clientId: 'ff' + randomId(14),
        keepalive: 20,
        will,
        onMessage: (topic, text) => { if (topic === this.topic) this.receive(text); },
        onState: () => this.onStatus(this.connected),
      });
      c.subscribe(this.topic);
      c.connect();
      return c;
    });
  }

  get connected() {
    return this.clients.filter((c) => c.connected).length;
  }

  send(msg) {
    const text = JSON.stringify({ v: 1, ...msg, from: this.myId, id: randomId() });
    let sent = 0;
    for (const c of this.clients) if (c.publish(this.topic, text)) sent++;
    return sent;
  }

  receive(text) {
    if (text.length > 1500) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object' || m.v !== 1 || typeof m.id !== 'string' || typeof m.from !== 'string') return;
    if (m.from === this.myId || this.seen.has(m.id)) return;
    this.seen.set(m.id, Date.now());
    if (this.seen.size > 400) {
      const cutoff = Date.now() - 60000;
      for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
    }
    this.onMessage(m);
  }

  stop() {
    for (const c of this.clients) c.close();
    this.clients = [];
  }
}

// One player's side of an online room.
// Events (via the `emit` callback): 'connection', 'start', 'moves', 'newgame',
// 'peer', 'rematch', 'full'.
export class OnlineSession {
  constructor({ code, role, name, myId, saved = null, emit }) {
    this.code = code;
    this.role = role;                       // 'host' or 'guest'
    this.myId = myId;
    this.name = cleanName(name);
    this.emit = emit;
    this.myColor = role === 'host' ? 1 : 2;
    this.game = saved?.game ?? 1;
    this.first = saved?.first ?? 'host';
    this.moves = saved?.moves ?? '';
    this.accepted = saved?.accepted ?? false;
    this.guestId = saved?.guestId ?? null;  // host only
    this.peer = { id: saved?.peerId ?? null, name: saved?.peerName ?? '', lastSeen: 0, present: false, left: false };
    this.wantRematch = false;
    this.peerWantsRematch = false;
    this.relays = 0;
    this.relay = new Relay(code, myId, (m) => this.receive(m), (n) => {
      const before = this.relays;
      this.relays = n;
      if (n > before) this.broadcast();
      this.emit('connection');
    });
  }

  start() {
    this.relay.start();
    this.timer = setInterval(() => this.tick(), 1000);
    this.lastBeat = 0;
  }

  stop() {
    clearInterval(this.timer);
    this.relay.send({ t: 'bye' });
    const relay = this.relay;
    setTimeout(() => relay.stop(), 250);
  }

  // ----- derived state

  get firstColor() { return this.first === 'host' ? 1 : 2; }
  get moveList() { return stringToMoves(this.moves) || []; }
  get state() { return replay(this.moveList, this.firstColor); }
  colorOfMove(i) { return i % 2 === 0 ? this.firstColor : 3 - this.firstColor; }
  canMove() {
    const st = this.state;
    return this.accepted && !st.over && st.turn === this.myColor;
  }

  snapshot() {
    return {
      code: this.code, role: this.role, myId: this.myId, game: this.game, first: this.first,
      moves: this.moves, accepted: this.accepted, guestId: this.guestId,
      peerId: this.peer.id, peerName: this.peer.name,
    };
  }

  // ----- actions

  play(col) {
    if (!this.canMove()) return false;
    const next = this.moves + col;
    if (!replay(stringToMoves(next), this.firstColor)) return false;
    const before = this.moves;
    this.moves = next;
    this.emit('moves', { before, after: next, replaced: false });
    this.broadcast();
    return true;
  }

  requestRematch() {
    if (!this.state.over) return;
    this.wantRematch = true;
    this.maybeStartNextGame();
    this.broadcast();
    this.emit('rematch');
  }

  // ----- networking

  broadcast() {
    this.lastBeat = Date.now();
    const msg = {
      t: 'state', role: this.role, name: this.name, game: this.game, first: this.first,
      moves: this.moves, rematch: this.wantRematch,
    };
    if (this.role === 'host') msg.guest = this.guestId;
    this.relay.send(msg);
  }

  tick() {
    const now = Date.now();
    if (now - this.lastBeat >= HEARTBEAT_MS) this.broadcast();
    const present = this.peer.id !== null && now - this.peer.lastSeen < PEER_TIMEOUT_MS && !this.peer.left;
    if (present !== this.peer.present) {
      this.peer.present = present;
      this.emit('peer');
    }
  }

  receive(m) {
    if (m.t === 'bye') {
      if (m.from === this.peer.id && !this.peer.left) {
        this.peer.left = true;
        this.peer.present = false;
        this.emit('peer');
      }
      return;
    }
    if (m.t === 'full') {
      if (m.to === this.myId && !this.accepted) this.emit('full');
      return;
    }
    if (m.t !== 'state') return;
    if ((m.role !== 'host' && m.role !== 'guest') || m.role === this.role) return;
    if (!Number.isInteger(m.game) || m.game < 1 || m.game > 100000) return;
    if (m.first !== 'host' && m.first !== 'guest') return;
    if (stringToMoves(m.moves) === null) return;
    if (this.role === 'host') this.fromGuest(m); else this.fromHost(m);
  }

  notePeer(m) {
    const wasPresent = this.peer.present;
    const newName = cleanName(m.name);
    const changed = this.peer.id !== m.from || this.peer.name !== newName || this.peer.left;
    this.peer.id = m.from;
    this.peer.name = newName;
    this.peer.lastSeen = Date.now();
    this.peer.left = false;
    this.peer.present = true;
    if (changed || !wasPresent) this.emit('peer');
  }

  fromGuest(m) {
    const now = Date.now();
    const stale = now - this.peer.lastSeen > GUEST_TAKEOVER_MS || this.peer.left;
    if (this.guestId && this.guestId !== m.from && !stale) {
      this.relay.send({ t: 'full', to: m.from });
      return;
    }
    const isNewGuest = this.guestId !== m.from;
    this.guestId = m.from;
    this.notePeer(m);
    if (!this.accepted || isNewGuest) {
      this.accepted = true;
      this.emit('start');
      this.broadcast();
    }
    if (m.game !== this.game) return;
    this.merge(m.moves, false);
    const over = this.state.over;
    const wants = Boolean(m.rematch) && over;
    if (wants !== this.peerWantsRematch) {
      this.peerWantsRematch = wants;
      this.emit('rematch');
    }
    this.maybeStartNextGame();
  }

  fromHost(m) {
    if (m.guest && m.guest !== this.myId) {
      // The host has someone else. Wait a little in case they have gone quiet.
      if (!this.accepted) this.emit('full');
      return;
    }
    this.notePeer(m);
    if (m.guest !== this.myId) return; // not let in yet; our next heartbeat asks again
    if (!this.accepted) {
      this.accepted = true;
      this.emit('start');
    }
    if (m.game > this.game) {
      this.game = m.game;
      this.first = m.first;
      this.wantRematch = false;
      this.peerWantsRematch = false;
      const theirs = stringToMoves(m.moves);
      this.moves = theirs && replay(theirs, this.firstColor) ? m.moves : '';
      this.emit('newgame');
      this.broadcast();
      return;
    }
    if (m.game < this.game) return;
    if (m.first !== this.first) {
      this.first = m.first;
      this.replaceMoves(m.moves);
      return;
    }
    this.merge(m.moves, true);
    const wants = Boolean(m.rematch) && this.state.over;
    if (wants !== this.peerWantsRematch) {
      this.peerWantsRematch = wants;
      this.emit('rematch');
    }
  }

  // Combines the other player's move list with ours.
  merge(theirs, fromHost) {
    const mine = this.moves;
    if (theirs === mine) return;
    if (theirs.startsWith(mine)) {
      const list = stringToMoves(theirs);
      if (!replay(list, this.firstColor)) return;
      if (!fromHost) {
        for (let i = mine.length; i < theirs.length; i++) if (this.colorOfMove(i) === this.myColor) return;
      }
      this.moves = theirs;
      this.emit('moves', { before: mine, after: theirs, replaced: false });
      return;
    }
    if (mine.startsWith(theirs)) {
      // They are behind. If our extra moves are all ours, they will catch up.
      let onlyMine = true;
      for (let i = theirs.length; i < mine.length; i++) if (this.colorOfMove(i) !== this.myColor) onlyMine = false;
      if (onlyMine || !fromHost) { this.broadcast(); return; }
    }
    if (fromHost) this.replaceMoves(theirs);
    else this.broadcast();
  }

  replaceMoves(theirs) {
    const list = stringToMoves(theirs);
    if (!list || !replay(list, this.firstColor)) return;
    const before = this.moves;
    this.moves = theirs;
    this.emit('moves', { before, after: theirs, replaced: true });
  }

  maybeStartNextGame() {
    if (this.role !== 'host' || !this.state.over || !this.wantRematch || !this.peerWantsRematch) return;
    this.game += 1;
    this.first = this.first === 'host' ? 'guest' : 'host';
    this.moves = '';
    this.wantRematch = false;
    this.peerWantsRematch = false;
    this.emit('newgame');
    this.broadcast();
  }
}
