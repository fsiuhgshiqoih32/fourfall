// A small MQTT 3.1.1 client over WebSocket: QoS 0 publish and subscribe,
// keepalive pings, a last-will message and automatic reconnects.
// Works in browsers and in Node 22+ (both have a global WebSocket).

const enc = new TextEncoder();
const dec = new TextDecoder();

function cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

function str(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 255;
  out.set(b, 2);
  return out;
}

function varint(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    out.push(d);
  } while (n > 0);
  return Uint8Array.from(out);
}

const packet = (first, body) => cat([Uint8Array.of(first), varint(body.length), body]);
const PINGREQ = Uint8Array.of(0xc0, 0x00);
const DISCONNECT = Uint8Array.of(0xe0, 0x00);

export class MqttLite {
  constructor(url, { clientId, keepalive = 20, will = null, onMessage = null, onState = null } = {}) {
    this.url = url;
    this.clientId = clientId;
    this.keepalive = keepalive;
    this.will = will;
    this.onMessage = onMessage;
    this.onState = onState;
    this.subs = new Set();
    this.connected = false;
    this.closed = false;
    this.retry = 0;
    this.pid = 0;
    this.ws = null;
    this.buf = new Uint8Array(0);
  }

  connect() {
    if (this.closed || this.ws) return;
    let ws;
    try {
      ws = new WebSocket(this.url, ['mqtt']);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buf = new Uint8Array(0);
    const timer = setTimeout(() => { if (this.ws === ws && !this.connected) ws.close(); }, 8000);
    ws.onopen = () => { if (this.ws === ws) this.send(this.connectPacket()); };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data === 'string') return;
      this.feed(new Uint8Array(e.data));
    };
    const drop = () => { clearTimeout(timer); this.dropped(ws); };
    ws.onclose = drop;
    ws.onerror = drop;
  }

  subscribe(topic) {
    this.subs.add(topic);
    if (this.connected) this.send(this.subscribePacket(topic));
  }

  publish(topic, text, retain = false) {
    if (!this.connected) return false;
    return this.send(packet(0x30 | (retain ? 1 : 0), cat([str(topic), enc.encode(text)])));
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    const ws = this.ws;
    this.ws = null;
    const was = this.connected;
    this.connected = false;
    if (ws) {
      try { if (ws.readyState === 1) ws.send(DISCONNECT); } catch { /* closing anyway */ }
      try { ws.close(); } catch { /* already closed */ }
    }
    if (was) this.onState?.(this);
  }

  // internals

  send(bytes) {
    try {
      if (this.ws && this.ws.readyState === 1) { this.ws.send(bytes); return true; }
    } catch { /* the close handler reconnects */ }
    return false;
  }

  connectPacket() {
    const w = this.will;
    const flags = 0x02 | (w ? 0x04 : 0); // clean session, will at QoS 0, not retained
    const header = cat([str('MQTT'), Uint8Array.of(4, flags, this.keepalive >> 8, this.keepalive & 255)]);
    const payload = w ? cat([str(this.clientId), str(w.topic), str(w.payload)]) : str(this.clientId);
    return packet(0x10, cat([header, payload]));
  }

  subscribePacket(topic) {
    this.pid = (this.pid % 65535) + 1;
    return packet(0x82, cat([Uint8Array.of(this.pid >> 8, this.pid & 255), str(topic), Uint8Array.of(0)]));
  }

  feed(chunk) {
    this.buf = this.buf.length ? cat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = 0, mult = 1, i = 1, byte;
      do {
        if (i >= b.length) return;
        if (i > 4) { this.ws?.close(); return; }
        byte = b[i++];
        len += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128);
      if (b.length < i + len) return;
      const first = b[0];
      const body = b.subarray(i, i + len);
      this.buf = b.subarray(i + len);
      this.handle(first, body);
    }
  }

  handle(first, body) {
    this.lastRx = Date.now();
    const type = first >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws?.close(); return; }
      this.connected = true;
      this.retry = 0;
      for (const t of this.subs) this.send(this.subscribePacket(t));
      this.startPing();
      this.onState?.(this);
    } else if (type === 3) { // PUBLISH
      const qos = (first >> 1) & 3;
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      let p = 2 + tl;
      if (qos > 0) {
        const id = (body[p] << 8) | body[p + 1];
        p += 2;
        if (qos === 1) this.send(Uint8Array.of(0x40, 0x02, id >> 8, id & 255));
      }
      let text;
      try { text = dec.decode(body.subarray(p)); } catch { return; }
      this.onMessage?.(topic, text);
    }
    // SUBACK (9) and PINGRESP (13) only refresh lastRx.
  }

  startPing() {
    clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastRx > this.keepalive * 1500) { this.ws?.close(); return; }
      this.send(PINGREQ);
    }, (this.keepalive * 1000) / 2);
  }

  dropped(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    clearInterval(this.pinger);
    const was = this.connected;
    this.connected = false;
    if (was) this.onState?.(this);
    if (!this.closed) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(15000, 1000 * 2 ** this.retry) + Math.random() * 500;
    this.retry = Math.min(this.retry + 1, 5);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }
}
