/**
 * Snowball.io — "Офісні сніжки"
 * Один файл сервера. Вся логіка на сервері, клієнт лише рендерить.
 *
 * Запуск:
 *   npm i
 *   npm start
 * Потім відкрий: http://localhost:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined;
const CLIENT_FILE = path.join(__dirname, "client.html");

const ACTION_COOLDOWN_MS = 5000;
const SHIELD_DURATION_MS = 15000;
const SHIELD_HP = 3;
const TEAM_HP = 10;
const TEAM_SNOW = 20;
const LOG_LIMIT = 80;
const DEFAULT_MATCH_SECONDS = 180;
const MIN_MATCH_SECONDS = 30;
const MAX_MATCH_SECONDS = 900;
const COMBO_WINDOW_MS = 6000;

/** @typedef {"A"|"B"} Team */

function now() {
  return Date.now();
}

function clampLog(log) {
  if (log.length <= LOG_LIMIT) return log;
  return log.slice(log.length - LOG_LIMIT);
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pickRandom(arr) {
  if (!arr.length) return null;
  const i = Math.floor(Math.random() * arr.length);
  return arr[i];
}

function otherTeam(t) {
  return t === "A" ? "B" : "A";
}

function createRoom(code) {
  return {
    code,
    createdAt: now(),
    finished: false,
    winner: null,
    match: {
      inProgress: false,
      startedAt: 0,
      endsAt: 0,
      durationSec: DEFAULT_MATCH_SECONDS,
      interval: null,
    },
    combo: {
      lastBy: null,
      count: 0,
      lastAt: 0,
    },
    teams: {
      A: { hp: TEAM_HP, snow: TEAM_SNOW, shield: { active: false, hp: 0, until: 0, timeout: null } },
      B: { hp: TEAM_HP, snow: TEAM_SNOW, shield: { active: false, hp: 0, until: 0, timeout: null } },
    },
    players: new Map(), // id -> {id,nick,team,connected,lastActionAt}
    log: [],
  };
}

/** @type {Map<string, any>} */
const rooms = new Map();

function normalizeRoomCode(code) {
  const raw = String(code || "").trim();
  const cleaned = raw.replace(/[^\d]/g, "");
  // Invite code: exactly 6 digits.
  return cleaned.slice(0, 6);
}

function isValidRoomCode(code) {
  return /^\d{6}$/.test(code);
}

function publicRoomState(room) {
  const players = [];
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    players.push({ id: p.id, nick: p.nick, team: p.team });
  }
  const tA = room.teams.A;
  const tB = room.teams.B;
  return {
    code: room.code,
    finished: room.finished,
    winner: room.winner,
    match: {
      inProgress: !!room.match?.inProgress,
      startedAt: room.match?.startedAt || 0,
      endsAt: room.match?.endsAt || 0,
      durationSec: room.match?.durationSec || DEFAULT_MATCH_SECONDS,
      remainingSec: room.match?.inProgress ? Math.max(0, Math.ceil((room.match.endsAt - now()) / 1000)) : 0,
    },
    teams: {
      A: { hp: tA.hp, snow: tA.snow, shield: { active: tA.shield.active, hp: tA.shield.hp, until: tA.shield.until } },
      B: { hp: tB.hp, snow: tB.snow, shield: { active: tB.shield.active, hp: tB.shield.hp, until: tB.shield.until } },
    },
    players,
    log: room.log,
    serverTime: now(),
  };
}

function roomBroadcast(room, msgObj) {
  const data = JSON.stringify(msgObj);
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    try {
      p.ws.send(data);
    } catch {
      // ignore
    }
  }
}

function pushLog(room, text) {
  room.log.push({ t: now(), text });
  room.log = clampLog(room.log);
}

function broadcastState(room) {
  roomBroadcast(room, { type: "state", state: publicRoomState(room) });
}

function broadcastEvent(room, event) {
  roomBroadcast(room, { type: "event", event: { ...event, t: now() } });
}

function concludeByHp(room) {
  const a = room.teams.A.hp;
  const b = room.teams.B.hp;
  if (a > b) return "A";
  if (b > a) return "B";
  return "draw";
}

function stopMatchTimer(room) {
  if (room.match?.interval) clearInterval(room.match.interval);
  room.match.interval = null;
}

function finishMatch(room, winner) {
  if (room.finished) return;
  room.finished = true;
  room.winner = winner;
  stopMatchTimer(room);
  room.match.inProgress = false;
  broadcastEvent(room, { kind: "finish", winner });
  if (winner === "draw") pushLog(room, "🏁 Ничья по итогам матча.");
  else pushLog(room, `🏁 Победа: Office ${winner}.`);
  broadcastState(room);
}

function startMatch(room, durationSec) {
  const dur = Math.max(MIN_MATCH_SECONDS, Math.min(MAX_MATCH_SECONDS, durationSec | 0));
  // Reset core game state.
  resetRoomInternal(room, { silentEvent: true });
  room.match.durationSec = dur;
  room.match.inProgress = true;
  room.match.startedAt = now();
  room.match.endsAt = room.match.startedAt + dur * 1000;
  pushLog(room, `⏱️ Матч начался: ${dur}с.`);
  broadcastEvent(room, { kind: "start", durationSec: dur });
  broadcastState(room);

  stopMatchTimer(room);
  room.match.interval = setInterval(() => {
    if (!rooms.get(room.code)) return;
    if (!room.match.inProgress) return;
    const remaining = room.match.endsAt - now();
    if (remaining <= 0) {
      const w = concludeByHp(room);
      finishMatch(room, w);
      return;
    }
    // Lightweight sync point for UI progress bars.
    broadcastEvent(room, { kind: "tick", remainingSec: Math.max(0, Math.ceil(remaining / 1000)) });
  }, 1000);
}

function ensureRoom(code) {
  const c = normalizeRoomCode(code);
  if (!isValidRoomCode(c)) return null;
  let room = rooms.get(c);
  if (!room) {
    room = createRoom(c);
    rooms.set(c, room);
  }
  return room;
}

function canAct(player) {
  const last = player.lastActionAt || 0;
  return now() - last >= ACTION_COOLDOWN_MS;
}

function msLeftForCooldown(player) {
  const last = player.lastActionAt || 0;
  return Math.max(0, ACTION_COOLDOWN_MS - (now() - last));
}

function setFinished(room, winnerTeam) {
  finishMatch(room, winnerTeam);
}

function expireShield(room, team) {
  const t = room.teams[team];
  if (!t.shield.active) return;
  t.shield.active = false;
  t.shield.hp = 0;
  t.shield.until = 0;
  if (t.shield.timeout) clearTimeout(t.shield.timeout);
  t.shield.timeout = null;
  pushLog(room, `🛡️ Щит Office ${team} погас.`);
  broadcastState(room);
}

function maybeAutoExpireShields(room) {
  for (const team of /** @type {Team[]} */ (["A", "B"])) {
    const t = room.teams[team];
    if (t.shield.active && t.shield.until && now() >= t.shield.until) {
      expireShield(room, team);
    }
  }
}

function handleThrow(room, player) {
  if (room.finished) return { ok: false, error: "Игра уже закончилась." };
  if (!room.match?.inProgress) return { ok: false, error: "Матч ещё не начался. Нажмите «Старт» в лобби." };
  if (!canAct(player)) return { ok: false, error: `Кулдаун: ${Math.ceil(msLeftForCooldown(player) / 1000)}с.` };

  maybeAutoExpireShields(room);

  const team = player.team;
  const enemy = otherTeam(team);
  const t = room.teams[team];
  const e = room.teams[enemy];

  if (t.snow <= 0) return { ok: false, error: "Снежки закончились. Ждём конца таймера — победит команда с большим HP." };

  // Only "alive" (connected) players can be targets.
  const candidates = [];
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    if (p.team !== enemy) continue;
    candidates.push(p);
  }
  if (!candidates.length) return { ok: false, error: `Нет живых игроков в Office ${enemy}.` };

  t.snow -= 1;
  player.lastActionAt = now();

  const target = pickRandom(candidates);

  if (e.shield.active) {
    e.shield.hp = Math.max(0, e.shield.hp - 1);
    pushLog(room, `❄️ ${player.nick} бросил(а) в Office ${enemy} — 🛡️ щит съел атаку (−1 прочность).`);
    broadcastEvent(room, { kind: "impact", outcome: "shield", team: enemy, byTeam: team });
    // Shield blocks: break combo chain.
    room.combo.count = 0;
    room.combo.lastBy = null;
    room.combo.lastAt = now();
    if (e.shield.hp <= 0) {
      pushLog(room, `🛡️ Щит Office ${enemy} сломался!`);
      expireShield(room, enemy);
    } else {
      broadcastState(room);
    }
    return { ok: true };
  }

  e.hp -= 1;
  pushLog(room, `❄️ ${player.nick} попал(а) по ${target.nick} (Office ${enemy}) — Office ${enemy} HP −1.`);
  broadcastEvent(room, { kind: "impact", outcome: "hit", team: enemy, byTeam: team });

  // Combo logic (server-authoritative, synced in logs).
  {
    const t = now();
    const by = team;
    if (room.combo.lastBy === by && t - room.combo.lastAt <= COMBO_WINDOW_MS) room.combo.count += 1;
    else room.combo.count = 1;
    room.combo.lastBy = by;
    room.combo.lastAt = t;

    if (room.combo.count >= 2) {
      pushLog(room, `🔥 Комбо Office ${by}: x${room.combo.count}!`);
    }
  }

  if (e.hp <= 0) {
    setFinished(room, team);
  } else {
    broadcastState(room);
  }
  return { ok: true };
}

function handleShield(room, player) {
  if (room.finished) return { ok: false, error: "Игра уже закончилась." };
  if (!room.match?.inProgress) return { ok: false, error: "Матч ещё не начался. Нажмите «Старт» в лобби." };
  if (!canAct(player)) return { ok: false, error: `Кулдаун: ${Math.ceil(msLeftForCooldown(player) / 1000)}с.` };

  maybeAutoExpireShields(room);

  const team = player.team;
  const t = room.teams[team];

  if (t.shield.active) return { ok: false, error: "Щит уже активен." };

  player.lastActionAt = now();
  t.shield.active = true;
  t.shield.hp = SHIELD_HP;
  t.shield.until = now() + SHIELD_DURATION_MS;
  if (t.shield.timeout) clearTimeout(t.shield.timeout);
  t.shield.timeout = setTimeout(() => {
    // Re-check in case room was reset.
    const r = rooms.get(room.code);
    if (!r) return;
    expireShield(r, team);
  }, SHIELD_DURATION_MS + 30);

  pushLog(room, `🛡️ ${player.nick} активировал(а) щит Office ${team} (15с, прочность ${SHIELD_HP}).`);
  broadcastState(room);
  return { ok: true };
}

function resetRoomInternal(room, opts) {
  const silentEvent = !!opts?.silentEvent;
  // Clear shield timeouts.
  for (const team of /** @type {Team[]} */ (["A", "B"])) {
    const s = room.teams[team].shield;
    if (s.timeout) clearTimeout(s.timeout);
    s.timeout = null;
  }
  room.finished = false;
  room.winner = null;
  stopMatchTimer(room);
  room.match.inProgress = false;
  room.match.startedAt = 0;
  room.match.endsAt = 0;
  room.teams.A.hp = TEAM_HP;
  room.teams.B.hp = TEAM_HP;
  room.teams.A.snow = TEAM_SNOW;
  room.teams.B.snow = TEAM_SNOW;
  room.teams.A.shield = { active: false, hp: 0, until: 0, timeout: null };
  room.teams.B.shield = { active: false, hp: 0, until: 0, timeout: null };
  room.combo = { lastBy: null, count: 0, lastAt: 0 };
  room.log = [];
  for (const p of room.players.values()) p.lastActionAt = 0;
  pushLog(room, "🎄 Новая игра! Office A vs Office B.");
  if (!silentEvent) broadcastEvent(room, { kind: "reset" });
  broadcastState(room);
}

// --- HTTP: serve one client file ---
const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/" || url.startsWith("/?") || url === "/client.html") {
    fs.readFile(CLIENT_FILE, (err, buf) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Client file not found.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(buf);
    });
    return;
  }

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

// --- WS ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
});

wss.on("connection", (ws) => {
  const id = randomUUID();

  /** @type {{roomCode?:string}} */
  let session = { roomCode: null };
  let room = null;
  let player = null;

  function send(obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  send({ type: "hello", id, serverTime: now() });

  ws.on("message", (raw) => {
    const msg = safeJsonParse(String(raw));
    if (!msg || typeof msg !== "object") return;
    const type = msg.type;

    if (type === "join") {
      const nick = String(msg.nick || "").trim().slice(0, 18);
      const team = msg.team === "B" ? "B" : "A";
      const roomCode = normalizeRoomCode(msg.roomCode);

      if (!nick) return send({ type: "error", error: "Введите ник." });
      if (!isValidRoomCode(roomCode)) return send({ type: "error", error: "Инвайт‑код должен быть 6 цифр." });

      // Leave old room (if any).
      if (room && player) {
        const old = room;
        player.connected = false;
        player.ws = null;
        pushLog(old, `👋 ${player.nick} вышел(ла).`);
        broadcastState(old);
      }

      room = ensureRoom(roomCode);
      if (!room) return send({ type: "error", error: "Некорректный инвайт‑код." });
      session.roomCode = room.code;

      player = {
        id,
        nick,
        team,
        connected: true,
        lastActionAt: 0,
        ws,
      };

      room.players.set(id, player);
      pushLog(room, `✅ ${nick} присоединился(лась) к Office ${team}.`);
      if (room.log.length === 1) {
        // First log entry in a new room — add a "new game" vibe.
        pushLog(room, "🎄 Новая игра! Office A vs Office B.");
      }
      broadcastState(room);
      return;
    }

    if (!room || !player) return send({ type: "error", error: "Сначала присоединитесь по инвайт‑коду." });

    if (type === "start") {
      if (room.match?.inProgress) return send({ type: "error", error: "Матч уже идет." });
      const durationSec = Number(msg.durationSec);
      if (!Number.isFinite(durationSec)) return send({ type: "error", error: "Некорректное время матча." });
      startMatch(room, durationSec);
      return;
    }

    if (type === "action") {
      const action = String(msg.action || "");
      if (action !== "throw" && action !== "shield" && action !== "reset") {
        return send({ type: "error", error: "Неизвестное действие." });
      }

      if (action === "reset") {
        // Keep it simple: anyone can reset.
        resetRoomInternal(room, {});
        return;
      }

      const res = action === "throw" ? handleThrow(room, player) : handleShield(room, player);
      if (!res.ok) send({ type: "error", error: res.error || "Ошибка." });
      return;
    }
  });

  ws.on("close", () => {
    if (!room || !player) return;
    player.connected = false;
    player.ws = null;
    pushLog(room, `👋 ${player.nick} отключился(лась).`);
    broadcastState(room);
  });
});

// Keep connections alive (office Wi‑Fi / VPN can be aggressive).
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }
}, 15000);

wss.on("close", () => clearInterval(pingInterval));

server.listen(PORT, HOST, () => {
  const urls = new Set([`http://localhost:${PORT}`]);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (!net || net.family !== "IPv4") continue;
      if (net.internal) continue;
      urls.add(`http://${net.address}:${PORT}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log("Snowball server running. Open:");
  for (const u of urls) console.log(`- ${u}`);
});


