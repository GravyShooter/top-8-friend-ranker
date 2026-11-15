#!/usr/bin/env node
/*
 * Spud Kart — Basement Server
 * ===========================
 * A tiny, zero-dependency, server-authoritative race server for Spud Kart
 * (from the MySpuds / Spud Arcade page). Run it on a spare PC at home and
 * every phone connects to IT instead of syncing through Firebase:
 *
 *   - Phones send only their INPUTS (gas / steer).
 *   - This server steps the karts, decides collisions kart-to-kart, and
 *     broadcasts the official positions ~20x/sec.
 *   - Finish times and the winner come from the server, not the phones.
 *
 * SETUP
 *   1. Install Node.js (free, https://nodejs.org) — any version 14+.
 *   2. Save this file on the PC, e.g. spud-kart-server.js
 *   3. Run it:        node spud-kart-server.js
 *      (optional:     PORT=9000 node spud-kart-server.js)
 *   4. Leave the PC on while you race.
 *
 * CONNECTING
 *   - Same house / same Wi-Fi:  ws://<PC's LAN address>:8787
 *       (the server prints the addresses it finds when it starts)
 *   - Friends in other houses:  install Tailscale on the PC and on each
 *     phone, sign everyone into the same tailnet (or share this PC from
 *     the Tailscale admin console), then use ws://<PC's 100.x address>:8787
 *   Type that address into the "Basement server" box in the Spud Kart
 *   panel on the MySpuds page.
 *
 * No npm install, no accounts, no data leaves the house: the whole game
 * protocol is plain JSON over one WebSocket port.
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const os = require("os");

const PORT = parseInt(process.env.PORT || "8787", 10);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* ---- Track + physics: identical numbers to the Spud Kart game ---- */
const KW = 640, KH = 360, KCX = 320, KCY = 180, KRX = 228, KRY = 118;
const TICK = 1 / 30;              // physics step (s)
const SNAP_MS = 50;               // snapshot broadcast interval (20 Hz)
const KART_R = 14;                // kart radius for collisions
const MAX_PLAYERS = 4;
const COLORS = ["#c1272d", "#2456c8", "#2e8b3a", "#8b30c9"];

function gridSpot(i) {
  const a = Math.PI / 2 + 0.16 + i * 0.17;          // just past the start line
  const f = i % 2 === 0 ? 0.90 : 1.10;              // two staggered rows
  return {
    x: KCX + KRX * f * Math.cos(a),
    y: KCY + KRY * f * Math.sin(a),
    h: Math.atan2(KRY * Math.cos(a), -KRX * Math.sin(a)),
    ang: a
  };
}

function stepPlayer(p, dt) {
  const dxn = (p.x - KCX) / KRX, dyn = (p.y - KCY) / KRY;
  const norm = Math.sqrt(dxn * dxn + dyn * dyn);
  const onRoad = norm > 0.70 && norm < 1.30;
  const maxSpeed = onRoad ? 205 : 72;
  if (p.input.gas) p.speed = Math.min(maxSpeed, p.speed + 150 * dt);
  else p.speed = Math.max(0, p.speed - 110 * dt);
  if (!onRoad && p.speed > maxSpeed) p.speed = Math.max(maxSpeed, p.speed - 260 * dt);
  if (p.speed > 4) {
    const steer = (p.input.left ? -1 : 0) + (p.input.right ? 1 : 0);
    p.h += steer * 2.0 * dt;
  }
  p.x += Math.cos(p.h) * p.speed * dt;
  p.y += Math.sin(p.h) * p.speed * dt;
  p.x = Math.max(14, Math.min(KW - 14, p.x));
  p.y = Math.max(14, Math.min(KH - 14, p.y));
  const ang = Math.atan2((p.y - KCY) / KRY, (p.x - KCX) / KRX);
  let d = ang - p.prevAng;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (d > 0 && p.speed > 20) p.total += d;
  p.prevAng = ang;
}

/* ------------------------- WebSocket plumbing ------------------------- */
const clients = new Set();

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}
function wsSend(sock, str) {
  if (sock.destroyed) return;
  const data = Buffer.from(str, "utf8");
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.from([0x81, len]); }
  else if (len < 65536) { head = Buffer.from([0x81, 126, (len >> 8) & 255, len & 255]); }
  else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127;
    head.writeUInt32BE(Math.floor(len / 4294967296), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  try { sock.write(Buffer.concat([head, data])); } catch (e) { /* gone */ }
}
function send(client, obj) { wsSend(client.sock, JSON.stringify(obj)); }
function broadcastLobby() {
  const rooms = listRooms();
  for (const c of clients) send(c, { t: "rooms", rooms });
}

/* Frame parser: accumulates bytes, yields complete (possibly fragmented) messages. */
function makeParser(onMsg, onClose) {
  let buf = Buffer.alloc(0);
  let frags = [];
  return function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
        if (len > 1048576) { onClose(); return; }
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.slice(off + maskLen + len);
      if (op === 0x8) { onClose(); return; }
      if (op === 0x9) { // ping -> pong
        continue;
      }
      if (op === 0x1 || op === 0x0) {
        frags.push(payload);
        if (fin) {
          onMsg(Buffer.concat(frags).toString("utf8"));
          frags = [];
        }
      }
    }
  };
}

/* ------------------------------ Game state ----------------------------- */
const rooms = new Map();   // roomId -> room
let nextClient = 1;
let nextRoom = 1;

function listRooms() {
  const out = [];
  for (const r of rooms.values()) {
    if (r.status === "waiting") {
      out.push({
        id: r.id,
        hostName: r.hostName,
        count: r.players.size,
        createdAt: r.createdAt
      });
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
}

function snapshot(r) {
  const players = {};
  for (const p of r.players.values()) {
    players[p.id] = {
      name: p.name, color: p.color,
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      h: Math.round(p.h * 1000) / 1000,
      speed: Math.round(p.speed),
      total: Math.round(p.total * 1000) / 1000,
      finished: p.finished, finishMs: p.finishMs,
      bumpAt: p.bumpAt
    };
  }
  return {
    t: "state", room: r.id, status: r.status, startAt: r.startAt,
    hostId: r.hostId, players
  };
}
function sendState(r) {
  const s = JSON.stringify(snapshot(r));
  for (const p of r.players.values()) if (p.client) wsSend(p.client.sock, s);
}

function addPlayer(r, client, name) {
  const i = r.players.size;
  const g = gridSpot(i);
  const p = {
    id: client.id, client, name: String(name || "A Spud").slice(0, 24),
    color: COLORS[i % COLORS.length],
    x: g.x, y: g.y, h: g.h, prevAng: g.ang,
    speed: 0, total: 0,
    input: { gas: false, left: false, right: false },
    finished: false, finishMs: null, bumpAt: 0
  };
  r.players.set(client.id, p);
  client.roomId = r.id;
  return p;
}

function removeFromRoom(client) {
  if (!client.roomId) return;
  const r = rooms.get(client.roomId);
  client.roomId = null;
  if (!r) return;
  const p = r.players.get(client.id);
  r.players.delete(client.id);
  if (p && r.status !== "waiting" && r.status !== "done") {
    // Mid-race departure: keep a ghost record out — race just loses them.
  }
  if (r.players.size === 0) { rooms.delete(r.id); }
  else {
    if (r.hostId === client.id) r.hostId = r.players.keys().next().value;
    sendState(r);
  }
  broadcastLobby();
}

function startRace(r) {
  let i = 0;
  for (const p of r.players.values()) {
    const g = gridSpot(i++);
    p.x = g.x; p.y = g.y; p.h = g.h; p.prevAng = g.ang;
    p.speed = 0; p.total = 0; p.finished = false; p.finishMs = null; p.bumpAt = 0;
    p.input = { gas: false, left: false, right: false };
  }
  r.status = "countdown";
  r.startAt = Date.now() + 3000;
  sendState(r);
  broadcastLobby();
}

function tickRoom(r, now) {
  if (r.status === "countdown") {
    if (now >= r.startAt) r.status = "racing";
    else return;
  }
  if (r.status !== "racing") return;
  const ps = [...r.players.values()];
  for (const p of ps) if (!p.finished) stepPlayer(p, TICK);
  /* Collisions — the whole point of the basement server. Two karts closer
     than a kart-width get pushed apart along the line between them and
     both lose speed; the server stamps bumpAt so phones can flash BUMP!. */
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      const min = KART_R * 2;
      if (dist >= min) continue;
      if (dist < 0.01) { dx = 1; dy = 0; dist = 1; }
      const push = (min - dist) / 2;
      const nx = dx / dist, ny = dy / dist;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      a.x = Math.max(14, Math.min(KW - 14, a.x)); a.y = Math.max(14, Math.min(KH - 14, a.y));
      b.x = Math.max(14, Math.min(KW - 14, b.x)); b.y = Math.max(14, Math.min(KH - 14, b.y));
      a.speed *= 0.5; b.speed *= 0.5;
      a.bumpAt = now; b.bumpAt = now;
    }
  }
  let allDone = ps.length > 0;
  for (const p of ps) {
    if (!p.finished && p.total >= Math.PI * 4) {
      p.finished = true;
      p.finishMs = Math.max(0, Math.round(now - r.startAt));
    }
    if (!p.finished) allDone = false;
  }
  if (allDone) { r.status = "done"; sendState(r); }
}

/* Main loops: physics at 30 Hz for active rooms, snapshots at 20 Hz. */
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) tickRoom(r, now);
}, Math.round(TICK * 1000));
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.status === "countdown" || r.status === "racing") sendState(r);
  }
}, SNAP_MS);

/* ------------------------------ HTTP / WS ------------------------------ */
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Spud Kart basement server is running. Connect a phone to this address with ws:// (not http://) from the MySpuds Spud Kart panel.\n");
});

server.on("upgrade", (req, sock, head) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { sock.destroy(); return; }
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
  );
  const client = { id: "c" + nextClient++, sock, name: "A Spud", roomId: null };
  clients.add(client);
  send(client, { t: "welcome", id: client.id });
  send(client, { t: "rooms", rooms: listRooms() });

  const parse = makeParser((text) => {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    if (m.t === "hello") {
      client.name = String(m.name || "A Spud").slice(0, 24);
    } else if (m.t === "create") {
      if (client.roomId) removeFromRoom(client);
      const r = {
        id: "r" + nextRoom++, hostId: client.id, hostName: client.name,
        status: "waiting", startAt: 0, createdAt: Date.now(),
        players: new Map()
      };
      rooms.set(r.id, r);
      addPlayer(r, client, client.name);
      send(client, { t: "joined", room: r.id, you: client.id });
      sendState(r);
      broadcastLobby();
    } else if (m.t === "join") {
      const r = rooms.get(String(m.room || ""));
      if (!r) { send(client, { t: "error", msg: "That race room is gone." }); return; }
      if (r.status !== "waiting") { send(client, { t: "error", msg: "That race already started." }); return; }
      if (r.players.size >= MAX_PLAYERS) { send(client, { t: "error", msg: "That race is full (4 karts)." }); return; }
      if (client.roomId) removeFromRoom(client);
      addPlayer(r, client, client.name);
      send(client, { t: "joined", room: r.id, you: client.id });
      sendState(r);
      broadcastLobby();
    } else if (m.t === "start") {
      const r = rooms.get(client.roomId || "");
      if (r && r.hostId === client.id && r.status === "waiting") startRace(r);
    } else if (m.t === "input") {
      const r = rooms.get(client.roomId || "");
      if (!r) return;
      const p = r.players.get(client.id);
      if (p) p.input = { gas: !!m.gas, left: !!m.left, right: !!m.right };
    } else if (m.t === "leave") {
      removeFromRoom(client);
      send(client, { t: "left" });
    }
  }, () => {
    clients.delete(client);
    removeFromRoom(client);
    try { sock.destroy(); } catch (e) { /* already gone */ }
  });
  sock.on("data", parse);
  sock.on("error", () => { clients.delete(client); removeFromRoom(client); });
  sock.on("close", () => { clients.delete(client); removeFromRoom(client); });
  if (head && head.length) parse(head);
});

server.listen(PORT, () => {
  console.log("Spud Kart basement server listening on port " + PORT);
  console.log("Connect phones to one of these from the Spud Kart panel:");
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === "IPv4" && !a.internal) {
        const tag = a.address.startsWith("100.") ? "  <- Tailscale address (friends outside the house)" : "  <- same-Wi-Fi address";
        console.log("  ws://" + a.address + ":" + PORT + tag);
      }
    }
  }
  console.log("  ws://127.0.0.1:" + PORT + "  <- this PC itself");
  console.log("Leave this window open while you race. Ctrl+C stops the server.");
});
