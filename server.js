/**
 * 115士長乙4班格鬥大賽 2~4人大亂鬥 — 連線對戰房與即時大廳伺服器 (server.js)
 * -------------------------------------------------------------------------
 * 零外部套件依賴 (Zero Dependencies)：直接使用 Node.js 內建 http / crypto / fs 模組
 * 啟動方式：
 *   node server.js
 *   (或 npm start)
 * 預設連接埠：3000 (可透過環境變數 PORT 指定)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// =========================================================================
// 1. HTTP 靜態檔案伺服器 (支援中文路徑如 /人物角色/吊車大王.jpg)
// =========================================================================
const server = http.createServer((req, res) => {
  // CORS 標頭，允許跨網域或本地 file:// 測試
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let reqPath = "/";
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    reqPath = decodeURIComponent(parsedUrl.pathname);
  } catch (_) {
    reqPath = "/";
  }

  if (reqPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
    return;
  }

  if (reqPath === "/") reqPath = "/index.html";

  // 防止目錄穿越攻擊
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(ROOT_DIR, safePath);
  if (!fullPath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(fullPath).pipe(res);
  });
});

// =========================================================================
// 2. 原生 RFC 6455 WebSocket 協定編解碼器
// =========================================================================
const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeWsFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

function sendJson(client, data) {
  if (!client || client.closed || !client.socket || client.socket.destroyed) return;
  try {
    const payload = Buffer.from(JSON.stringify(data), "utf8");
    const frame = encodeWsFrame(0x01, payload);
    client.socket.write(frame);
  } catch (_) { }
}

// =========================================================================
// 3. 大廳與對戰房狀態管理 (支援 2～4 人同場大亂鬥)
// =========================================================================
const clients = new Map(); // clientId -> ClientObject
const rooms = new Map();   // roomId -> RoomObject
let nextClientSeq = 1;

function serializeRoomSummary(room) {
  const hostPlayer = room.players.find((p) => p.isHost) || room.players[0];
  return {
    roomId: room.roomId,
    hostName: hostPlayer ? hostPlayer.name : "房主",
    playerCount: room.players.length,
    maxPlayers: room.maxPlayers,
    mapIndex: room.mapIndex,
    status: room.status, // "waiting" | "fighting"
    players: room.players.map((p) => ({
      slot: p.slot,
      name: p.name,
      charIndex: p.charIndex,
      isHost: !!p.isHost,
      isCOM: !!p.isCOM,
      comDiff: p.comDiff || "normal"
    }))
  };
}

function broadcastRoomList() {
  const list = Array.from(rooms.values()).map(serializeRoomSummary);
  const msg = { type: "room_list", rooms: list };
  for (const c of clients.values()) {
    sendJson(c, msg);
  }
}

function broadcastRoomState(room) {
  if (!room) return;
  const summary = serializeRoomSummary(room);
  for (const p of room.players) {
    if (p.isCOM) continue;
    const c = clients.get(p.clientId);
    if (c) {
      sendJson(c, {
        type: "room_state",
        room: summary,
        mySlot: p.slot,
        isHost: !!p.isHost
      });
    }
  }
}

function removeClientFromRoom(client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  client.roomId = null;
  if (!room) return;

  const leavingPlayer = room.players.find((p) => p.clientId === client.id);
  const leavingSlot = leavingPlayer ? leavingPlayer.slot : null;
  room.players = room.players.filter((p) => p.clientId !== client.id);

  // 檢查是否還有真人玩家
  const humanPlayers = room.players.filter((p) => !p.isCOM);
  if (humanPlayers.length === 0) {
    room.match = null;
    rooms.delete(room.roomId);
    broadcastRoomList();
    return;
  }

  // 若原房主離開，將第一位真人玩家升為新房主并重新整理 slot (若在等待中)
  if (!room.players.some((p) => p.isHost && !p.isCOM)) {
    humanPlayers[0].isHost = true;
    room.hostId = humanPlayers[0].clientId;
  }

  if (room.status === "waiting") {
    // 重新排序 slot 為 1..N，確保房主為 1P
    room.players.sort((a, b) => (b.isHost ? 1 : 0) - (a.isHost ? 1 : 0) || a.slot - b.slot);
    room.players.forEach((p, idx) => { p.slot = idx + 1; });
  } else {
    // 若在戰鬥中有人斷線，伺服器端改由 COM 接手該 slot，並通知房內其他玩家
    if (room.match && leavingSlot) {
      room.match.convertSlotToCOM(leavingSlot, leavingPlayer ? leavingPlayer.name : `${leavingSlot}P`);
    }
    for (const p of humanPlayers) {
      const c = clients.get(p.clientId);
      if (c) {
        sendJson(c, {
          type: "player_left_match",
          slot: leavingSlot,
          leaverName: leavingPlayer ? leavingPlayer.name : `${leavingSlot}P`,
          newHostSlot: humanPlayers[0].slot
        });
      }
    }
  }

  broadcastRoomState(room);
  broadcastRoomList();
}

function handleClientMessage(client, msg) {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "get_rooms": {
      const list = Array.from(rooms.values()).map(serializeRoomSummary);
      sendJson(client, { type: "room_list", rooms: list });
      break;
    }

    case "create_room": {
      removeClientFromRoom(client);
      let rawId = String(msg.roomId || "").trim();
      if (!rawId) {
        rawId = String(Math.floor(1000 + Math.random() * 9000));
      }
      rawId = rawId.slice(0, 20);

      if (rooms.has(rawId)) {
        sendJson(client, {
          type: "room_error",
          message: `房號「${rawId}」已經存在！您可以直接從下方房間列表點擊加入，或換一個房號。`
        });
        return;
      }

      const nickname = String(msg.name || "").trim().slice(0, 12) || `玩家${client.id}`;
      client.name = nickname;
      const charIndex = Number.isInteger(msg.charIndex) ? msg.charIndex : 0;
      const mapIndex = Number.isInteger(msg.mapIndex) ? msg.mapIndex : 0;

      const room = {
        roomId: rawId,
        hostId: client.id,
        mapIndex,
        status: "waiting",
        maxPlayers: 4,
        players: [
          {
            clientId: client.id,
            slot: 1,
            name: nickname,
            charIndex,
            isHost: true,
            isCOM: false
          }
        ]
      };

      rooms.set(rawId, room);
      client.roomId = rawId;
      broadcastRoomState(room);
      broadcastRoomList();
      break;
    }

    case "join_room": {
      const targetId = String(msg.roomId || "").trim();
      const room = rooms.get(targetId);
      if (!room) {
        sendJson(client, { type: "room_error", message: `找不到房號「${targetId}」，該房間可能已關閉。` });
        return;
      }
      if (room.status !== "waiting") {
        sendJson(client, { type: "room_error", message: `房號「${targetId}」目前正在對戰中，請稍候再加入！` });
        return;
      }
      if (room.players.length >= room.maxPlayers) {
        // 如果房間滿了但裡面有 COM，自動替換掉最後一個 COM 讓真人進來
        const comIdx = room.players.findIndex((p) => p.isCOM);
        if (comIdx !== -1) {
          room.players.splice(comIdx, 1);
        } else {
          sendJson(client, { type: "room_error", message: `房號「${targetId}」人數已滿 (4/4)！` });
          return;
        }
      }

      removeClientFromRoom(client);

      const nickname = String(msg.name || "").trim().slice(0, 12) || `玩家${client.id}`;
      client.name = nickname;
      const charIndex = Number.isInteger(msg.charIndex) ? msg.charIndex : (room.players.length % 6);

      // 找出最小的可用 slot (1~4)
      const usedSlots = new Set(room.players.map((p) => p.slot));
      let slot = 1;
      while (usedSlots.has(slot) && slot <= 4) slot++;

      room.players.push({
        clientId: client.id,
        slot,
        name: nickname,
        charIndex,
        isHost: false,
        isCOM: false
      });
      room.players.sort((a, b) => a.slot - b.slot);

      client.roomId = room.roomId;
      broadcastRoomState(room);
      broadcastRoomList();
      break;
    }

    case "leave_room": {
      removeClientFromRoom(client);
      sendJson(client, { type: "left_room" });
      break;
    }

    case "update_room_player": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      const p = room.players.find((pl) => pl.clientId === client.id);
      if (!p) return;
      if (Number.isInteger(msg.charIndex) && msg.charIndex >= 0 && msg.charIndex < 6) {
        p.charIndex = msg.charIndex;
      }
      if (typeof msg.name === "string" && msg.name.trim()) {
        p.name = msg.name.trim().slice(0, 12);
      }
      broadcastRoomState(room);
      broadcastRoomList();
      break;
    }

    case "update_room_settings": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id) return;
      if (Number.isInteger(msg.mapIndex) && msg.mapIndex >= 0) {
        room.mapIndex = msg.mapIndex;
      }
      broadcastRoomState(room);
      broadcastRoomList();
      break;
    }

    case "add_room_com": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id || room.status !== "waiting") return;
      if (room.players.length >= room.maxPlayers) return;

      const usedSlots = new Set(room.players.map((p) => p.slot));
      let slot = 1;
      while (usedSlots.has(slot) && slot <= 4) slot++;

      const comDiff = ["easy", "normal", "hard"].includes(msg.comDiff) ? msg.comDiff : "normal";
      const diffLabel = comDiff === "easy" ? "簡單" : (comDiff === "hard" ? "困難" : "普通");
      const charIndex = Number.isInteger(msg.charIndex) ? msg.charIndex : ((slot - 1) % 6);

      room.players.push({
        clientId: `com_${slot}_${Date.now()}`,
        slot,
        name: `COM(${diffLabel})`,
        charIndex,
        isHost: false,
        isCOM: true,
        comDiff
      });
      room.players.sort((a, b) => a.slot - b.slot);
      broadcastRoomState(room);
      broadcastRoomList();
      break;
    }

    case "remove_room_com": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id || room.status !== "waiting") return;
      if (Number.isInteger(msg.slot)) {
        room.players = room.players.filter((p) => !(p.isCOM && p.slot === msg.slot));
      } else {
        // 移除最後一個 COM
        for (let i = room.players.length - 1; i >= 0; i--) {
          if (room.players[i].isCOM) {
            room.players.splice(i, 1);
            break;
          }
        }
      }
      room.players.forEach((p, idx) => { p.slot = idx + 1; });
      broadcastRoomState(room);
      broadcastRoomList();
      break;
    }

    case "start_online_match": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id) return;
      if (room.players.length < 2) {
        sendJson(client, {
          type: "room_error",
          message: "至少需要 2 名參戰者才能開戰！（可等待其他玩家加入，或點擊「＋加入電腦 COM」湊人數）"
        });
        return;
      }

      // 正規化 slot 1..N
      room.players.sort((a, b) => (b.isHost ? 1 : 0) - (a.isHost ? 1 : 0) || a.slot - b.slot);
      room.players.forEach((p, idx) => { p.slot = idx + 1; });
      room.status = "fighting";
      room.match = new ServerMatch(room);

      const summary = serializeRoomSummary(room);
      for (const p of room.players) {
        if (p.isCOM) continue;
        const c = clients.get(p.clientId);
        if (c) {
          sendJson(c, {
            type: "match_started",
            room: summary,
            mySlot: p.slot,
            isHost: !!p.isHost
          });
        }
      }
      // 開戰瞬間立即推送第一份權威狀態
      broadcastMatchState(room);
      broadcastRoomList();
      break;
    }

    case "return_to_room": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id) return;
      room.status = "waiting";
      room.match = null;
      room.players.sort((a, b) => (b.isHost ? 1 : 0) - (a.isHost ? 1 : 0) || a.slot - b.slot);
      room.players.forEach((p, idx) => { p.slot = idx + 1; });
      const summary = serializeRoomSummary(room);
      for (const p of room.players) {
        if (p.isCOM) continue;
        const c = clients.get(p.clientId);
        if (c) {
          sendJson(c, {
            type: "returned_to_room",
            room: summary,
            mySlot: p.slot,
            isHost: !!p.isHost
          });
        }
      }
      broadcastRoomList();
      break;
    }

    case "player_input": {
      // 嚴格伺服器權威：1P ~ 4P 所有玩家皆將按鍵狀態直接送交伺服器運算
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.status !== "fighting" || !room.match) return;
      const playerEntry = room.players.find((p) => p.clientId === client.id);
      if (!playerEntry) return;
      room.match.applyPlayerInput(playerEntry.slot, msg.held, msg.pressed);
      break;
    }

    case "rematch_request": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id || !room.match) return;
      if (room.match.matchWinner && room.match.victoryTime > 1.1) {
        room.match.startMatch();
        broadcastMatchState(room);
      }
      break;
    }

    case "game_state":
    case "game_event": {
      // 嚴格伺服器權威模式下，伺服器不接受客戶端偽造的狀態或事件
      break;
    }
  }
}

// =========================================================================
// 3.5 嚴格伺服器權威：遊戲物理、碰撞判定、道具與 60 FPS 迴圈
// =========================================================================
const GAME_CONFIG = {
  canvasWidth: 960,
  canvasHeight: 540,
  arenaTopY: 315,
  arenaBottomY: 522,
  gravity: 1850,
  moveSpeedX: 295,
  moveSpeedY: 215,
  jumpVelocity: 660,
  groundFriction: 2200,
  airFriction: 650,
  dashSpeed: 760,
  dashDuration: 0.14,
  dashCooldown: 0.55,
  playerWidth: 54,
  playerHeight: 92,
  winsToMatch: 2,
  roundDuration: 60.0,
  rageTimeThreshold: 10.0,
  rageDamageMult: 1.15,
  maxEnergy: 100,
  passiveEnergyPerSec: 1.56,
  hitEnergyGain: 15.6,
  hurtEnergyGain: 18.2,
  roundTransitionDelay: 2.2,
  matchOverDelay: 9.0,
  dashInvulnTime: 0.08,
  knockdownLaunchZ: 300,
  comboKnockdownHits: 6,
  comboResetTime: 0.9,
  knockdownDuration: 0.55,
  wakeupInvulnTime: 0.6,
  gangUpWindow: 1.2,
  gangUpDamageMult: 0.8,
  gangUpEnergyMult: 1.5
};

const MAP_BOUNDS = [
  { arenaTopY: 325, arenaBottomY: 522 },
  { arenaTopY: 245, arenaBottomY: 522 }
];

const COM_DIFFICULTIES = {
  easy: { reactionMin: 0.45, reactionVar: 0.20, attackInterval: 0.95, aggression: 0.28, ultUseChance: 0.35, dodgeChance: 0.05, dashChaseChance: 0.06, depthAccuracy: 36 },
  normal: { reactionMin: 0.28, reactionVar: 0.14, attackInterval: 0.65, aggression: 0.46, ultUseChance: 0.65, dodgeChance: 0.24, dashChaseChance: 0.18, depthAccuracy: 20 },
  hard: { reactionMin: 0.16, reactionVar: 0.08, attackInterval: 0.44, aggression: 0.68, ultUseChance: 0.90, dodgeChance: 0.52, dashChaseChance: 0.35, depthAccuracy: 12 }
};

const CHARACTER_SPECS = [
  {
    id: "crane_king", name: "吊車大王", maxHp: 126, speedMult: 1.0, themeColor: "#e63946", ultTitle: "萬噸天吊・皇室滿天金雨",
    attacks: {
      light: { name: "light", startup: 0.05, active: 0.08, recovery: 0.11, isProjectile: true, projType: "coins", projCount: 3, projSpeed: 580, projLife: 0.36, width: 30, height: 28, offsetX: 8, offsetZ: 18, depthTolerance: 36, damage: 5, hitstun: 0.16, knockbackX: 140, knockbackZ: 0, hitstop: 0.04 },
      heavy: { name: "heavy", startup: 0.20, active: 0.16, recovery: 0.22, width: 116, height: 84, offsetX: 14, offsetZ: 0, depthTolerance: 52, damage: 25, hitstun: 0.38, knockbackX: 640, knockbackZ: 320, hitstop: 0.10 },
      ult: { name: "ult", startup: 0.18, active: 0.28, recovery: 0.24, superArmor: true, alsoSpawnProjectiles: { name: "ult_proj", projType: "coins", projCount: 5, projSpeed: 640, projLife: 0.65, width: 34, height: 30, offsetX: 10, offsetZ: 18, depthTolerance: 48, damage: 8, hitstun: 0.24, knockbackX: 260, knockbackZ: 120, hitstop: 0.05 }, width: 220, height: 110, offsetX: 8, offsetZ: 0, depthTolerance: 74, damage: 42, hitstun: 0.50, knockbackX: 780, knockbackZ: 430, hitstop: 0.14 }
    }
  },
  {
    id: "monster_boo", name: "噁心", maxHp: 114, speedMult: 1.14, themeColor: "#9d4edd", ultTitle: "深淵狂暴・萬魔六連噬",
    attacks: {
      light: { name: "light", startup: 0.04, active: 0.12, recovery: 0.10, centeredHitbox: true, width: 128, height: 44, offsetX: 0, offsetZ: 14, depthTolerance: 40, damage: 8, hitstun: 0.20, knockbackX: 220, knockbackZ: 0, hitstop: 0.05 },
      heavy: { name: "heavy", startup: 0.13, active: 0.32, recovery: 0.19, width: 78, height: 54, offsetX: 0, offsetZ: 6, depthTolerance: 44, lungeX: 470, multiHitInterval: 0.09, damage: 8, hitstun: 0.26, knockbackX: 340, knockbackZ: 130, hitstop: 0.045 },
      ult: { name: "ult", startup: 0.12, active: 0.46, recovery: 0.20, superArmor: true, width: 115, height: 74, offsetX: 0, offsetZ: 2, depthTolerance: 62, lungeX: 590, multiHitInterval: 0.075, damage: 9, hitstun: 0.34, knockbackX: 420, knockbackZ: 190, hitstop: 0.05 }
    }
  },
  {
    id: "hell_judge", name: "地獄黑面潔", maxHp: 114, speedMult: 0.98, themeColor: "#b5179e", ultTitle: "無間煉獄・閻羅萬鬼陣",
    attacks: {
      light: { name: "light", startup: 0.06, active: 0.08, recovery: 0.14, isProjectile: true, projType: "ink_slash", projSpeed: 640, projLife: 0.58, width: 36, height: 44, offsetX: 8, offsetZ: 12, depthTolerance: 36, damage: 8, hitstun: 0.20, knockbackX: 180, knockbackZ: 0, hitstop: 0.05 },
      heavy: { name: "heavy", startup: 0.25, active: 0.18, recovery: 0.24, trackOpponent: true, width: 86, height: 110, offsetX: 0, offsetZ: 0, depthTolerance: 48, damage: 23, hitstun: 0.36, knockbackX: 480, knockbackZ: 360, hitstop: 0.095 },
      ult: { name: "ult", startup: 0.20, active: 0.28, recovery: 0.24, superArmor: true, trackOpponent: true, alsoSpawnProjectiles: { name: "ult_proj", projType: "ink_slash", projCount: 3, projSpeed: 680, projLife: 0.70, width: 42, height: 50, offsetX: 10, offsetZ: 12, depthTolerance: 48, damage: 10, hitstun: 0.26, knockbackX: 280, knockbackZ: 140, hitstop: 0.055 }, width: 190, height: 140, offsetX: 0, offsetZ: 0, depthTolerance: 78, damage: 44, hitstun: 0.48, knockbackX: 680, knockbackZ: 450, hitstop: 0.14 }
    }
  },
  {
    id: "life_warrior", name: "生話戰士", maxHp: 120, speedMult: 1.04, themeColor: "#588157", ultTitle: "家政奧義・終極龍捲大掃除",
    attacks: {
      light: { name: "light", startup: 0.06, active: 0.08, recovery: 0.13, isProjectile: true, projType: "boomerang", projSpeed: 650, projLife: 0.72, width: 30, height: 30, offsetX: 8, offsetZ: 16, depthTolerance: 36, damage: 7, hitstun: 0.18, knockbackX: 160, knockbackZ: 0, hitstop: 0.045 },
      heavy: { name: "heavy", startup: 0.16, active: 0.34, recovery: 0.22, centeredHitbox: true, lungeX: 340, multiHitInterval: 0.10, width: 158, height: 56, offsetX: 0, offsetZ: 6, depthTolerance: 48, damage: 8, hitstun: 0.28, knockbackX: 480, knockbackZ: 220, hitstop: 0.055 },
      ult: { name: "ult", startup: 0.14, active: 0.44, recovery: 0.22, superArmor: true, centeredHitbox: true, lungeX: 440, multiHitInterval: 0.085, alsoSpawnProjectiles: { name: "ult_proj", projType: "boomerang", projCount: 3, projSpeed: 700, projLife: 0.85, width: 32, height: 32, offsetX: 8, offsetZ: 16, depthTolerance: 46, damage: 9, hitstun: 0.22, knockbackX: 220, knockbackZ: 90, hitstop: 0.045 }, width: 220, height: 84, offsetX: 0, offsetZ: 0, depthTolerance: 68, damage: 10, hitstun: 0.34, knockbackX: 560, knockbackZ: 310, hitstop: 0.06 }
    }
  },
  {
    id: "slaking_king", name: "請假王", maxHp: 144, speedMult: 0.90, themeColor: "#a47148", ultTitle: "無敵病假單・泰山崩裂震",
    attacks: {
      light: { name: "light", startup: 0.06, active: 0.14, recovery: 0.12, lungeX: 300, width: 68, height: 48, offsetX: 0, offsetZ: 8, depthTolerance: 40, damage: 11, hitstun: 0.24, knockbackX: 380, knockbackZ: 140, hitstop: 0.06 },
      heavy: { name: "heavy", startup: 0.25, active: 0.18, recovery: 0.32, centeredHitbox: true, superArmor: true, width: 215, height: 70, offsetX: 0, offsetZ: 0, depthTolerance: 66, damage: 30, hitstun: 0.42, knockbackX: 720, knockbackZ: 360, hitstop: 0.115 },
      ult: { name: "ult", startup: 0.22, active: 0.26, recovery: 0.26, centeredHitbox: true, superArmor: true, width: 330, height: 95, offsetX: 0, offsetZ: 0, depthTolerance: 95, damage: 48, hitstun: 0.52, knockbackX: 840, knockbackZ: 460, hitstop: 0.15 }
    }
  },
  {
    id: "wind_lion", name: "風濕爺", maxHp: 132, speedMult: 0.95, themeColor: "#bc6c25", ultTitle: "金門狂風獅吼・天降星隕陣",
    attacks: {
      light: { name: "light", startup: 0.06, active: 0.11, recovery: 0.12, width: 86, height: 52, offsetX: 4, offsetZ: 8, depthTolerance: 40, damage: 8, hitstun: 0.24, knockbackX: 460, knockbackZ: 120, hitstop: 0.06 },
      heavy: { name: "heavy", startup: 0.18, active: 0.08, recovery: 0.22, isProjectile: true, projType: "bouncing_orb", projSpeed: 470, projLife: 1.25, width: 44, height: 44, offsetX: 8, offsetZ: 0, depthTolerance: 42, damage: 21, hitstun: 0.35, knockbackX: 580, knockbackZ: 280, hitstop: 0.09 },
      ult: { name: "ult", startup: 0.16, active: 0.26, recovery: 0.22, superArmor: true, alsoSpawnProjectiles: { name: "ult_proj", projType: "bouncing_orb", projCount: 3, projSpeed: 520, projLife: 1.35, width: 46, height: 46, offsetX: 10, offsetZ: 0, depthTolerance: 50, damage: 15, hitstun: 0.34, knockbackX: 560, knockbackZ: 280, hitstop: 0.08 }, width: 195, height: 86, offsetX: 4, offsetZ: 0, depthTolerance: 68, damage: 38, hitstun: 0.46, knockbackX: 740, knockbackZ: 380, hitstop: 0.14 }
    }
  }
];

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

class ServerInputBuffer {
  constructor() {
    this.held = new Set();
    this.pressed = new Set();
  }
  applyPacket(heldList, pressedList) {
    this.held.clear();
    if (Array.isArray(heldList)) for (const k of heldList) this.held.add(k);
    if (Array.isArray(pressedList)) for (const k of pressedList) this.pressed.add(k);
  }
  isHeld(code) { return this.held.has(code); }
  wasPressed(code) { return this.pressed.has(code); }
  endTick() { this.pressed.clear(); }
}

class ServerCOM {
  constructor(diffKey) {
    this.thinkTimer = 0;
    this.attackCooldown = 0;
    this.held = new Set();
    this.pressed = new Set();
    this.difficulty = COM_DIFFICULTIES[diffKey] || COM_DIFFICULTIES.normal;
  }
  update(dt, comPlayer, targetPlayer) {
    this.pressed.clear();
    if (this.attackCooldown > 0) this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.thinkTimer -= dt;
    if (this.thinkTimer > 0) return;

    const d = this.difficulty;
    this.thinkTimer = d.reactionMin + Math.random() * d.reactionVar;
    this.held.clear();
    if (comPlayer.state === "ko" || targetPlayer.state === "ko") return;

    const targetProtected = targetPlayer.state === "knockdown" || targetPlayer.invulnTimer > 0.12;
    const dx = (targetPlayer.x + targetPlayer.width / 2) - (comPlayer.x + comPlayer.width / 2);
    const dy = targetPlayer.y - comPlayer.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (targetProtected) {
      if (absDx < 85) this.held.add(dx > 0 ? "ACT_LEFT" : "ACT_RIGHT");
      else if (absDx > 160) this.held.add(dx > 0 ? "ACT_RIGHT" : "ACT_LEFT");
      return;
    }

    const heavy = comPlayer.charDef.attacks.heavy;
    const light = comPlayer.charDef.attacks.light;
    const ult = comPlayer.charDef.attacks.ult;
    const idealRange = (heavy.isProjectile || heavy.trackOpponent) ? 230 : (heavy.offsetX || 0) + heavy.width * 0.72;

    if (absDy > d.depthAccuracy) this.held.add(dy > 0 ? "ACT_DOWN" : "ACT_UP");
    if (absDx > idealRange + 15) {
      this.held.add(dx > 0 ? "ACT_RIGHT" : "ACT_LEFT");
      if (absDx > 220 && comPlayer.dashCooldownTimer <= 0 && Math.random() < d.dashChaseChance) this.pressed.add("ACT_DASH");
    } else if (absDx < 36 && Math.random() < 0.35) {
      this.held.add(dx > 0 ? "ACT_LEFT" : "ACT_RIGHT");
    }

    const facingMatch = (dx >= 0 && comPlayer.facing === 1) || (dx < 0 && comPlayer.facing === -1);
    if (!facingMatch && absDx > 10) {
      this.held.add(dx > 0 ? "ACT_RIGHT" : "ACT_LEFT");
    } else if (this.attackCooldown <= 0 && targetPlayer.invulnTimer <= 0.05) {
      if (comPlayer.energy >= GAME_CONFIG.maxEnergy && ult && absDy <= (ult.depthTolerance || 65) && (ult.trackOpponent || absDx <= (ult.width || 200) + 60) && Math.random() < d.ultUseChance) {
        this.pressed.add("ACT_ULT");
        this.attackCooldown = (d.attackInterval || 0.65) * 1.4;
        return;
      }
      if (absDy <= light.depthTolerance + 8 && Math.random() < d.aggression) {
        if (((heavy.isProjectile || heavy.trackOpponent) && absDx > 90 && absDx < 450 && Math.random() < 0.42) || (!heavy.isProjectile && !heavy.trackOpponent && absDx <= (heavy.offsetX || 0) + heavy.width + 20 && Math.random() < 0.40)) {
          this.pressed.add("ACT_HEAVY");
          this.attackCooldown = (d.attackInterval || 0.65) * (1.1 + Math.random() * 0.4);
        } else if ((light.isProjectile && absDx < 290) || (!light.isProjectile && absDx <= light.width + 28)) {
          this.pressed.add("ACT_LIGHT");
          this.attackCooldown = (d.attackInterval || 0.65) * (0.75 + Math.random() * 0.35);
        }
      }
    }

    if ((targetPlayer.state === "attack_startup" || targetPlayer.state === "attack_active") && absDx < 135 && absDy < 48 && Math.random() < d.dodgeChance) {
      if (comPlayer.dashCooldownTimer <= 0) this.pressed.add("ACT_DASH");
      else if (comPlayer.z === 0) this.pressed.add("ACT_JUMP");
    }
  }
  isHeld(code) { return this.held.has(code); }
  wasPressed(code) { return this.pressed.has(code); }
}

class ServerProjectile {
  constructor({ id, owner, x, groundY, z, facing, attackData, vz = 0, speedMult = 1 }) {
    this.id = id;
    this.owner = owner; this.x = x; this.groundY = groundY; this.z = z;
    this.facing = facing; this.attackData = attackData;
    this.projType = attackData.projType || "orb";
    this.width = attackData.width; this.height = attackData.height;
    this.vx = facing * attackData.projSpeed * speedMult;
    this.vz = vz;
    this.life = attackData.projLife;
    this.maxLife = attackData.projLife;
    this.active = true; this.angle = 0;
    this.hasReturned = false;
    this.hitTargets = new Set();
  }
  getHitbox() {
    return { x: this.x, y: this.groundY - this.z - this.attackData.offsetZ - this.height, width: this.width, height: this.height, groundY: this.groundY, depthTolerance: this.attackData.depthTolerance };
  }
  update(dt) {
    if (this.projType === "boomerang") {
      if (this.life < this.maxLife * 0.52 && !this.hasReturned) {
        this.hasReturned = true; this.hitTargets.clear();
      }
      if (this.hasReturned) {
        const targetX = this.owner.x + this.owner.width / 2;
        const dir = targetX >= this.x ? 1 : -1;
        this.vx += dir * 2400 * dt;
        this.vx = Math.max(-720, Math.min(720, this.vx));
        if (Math.abs(targetX - this.x) < 28) this.active = false;
      }
    }
    if (this.projType === "bouncing_orb") {
      this.vz -= 1500 * dt;
      this.z += this.vz * dt;
      if (this.z <= 0) { this.z = 0; this.vz = 420; }
    } else if (this.vz !== 0) {
      this.z = Math.max(0, this.z + this.vz * dt);
    }
    this.x += this.vx * dt;
    this.angle += this.facing * 16 * dt;
    this.life -= dt;
    if (this.life <= 0 || this.x < -80 || this.x > GAME_CONFIG.canvasWidth + 80) this.active = false;
  }
}

class ServerPickup {
  constructor({ type, x, groundY, z = 250 }) {
    this.type = type; this.x = x; this.groundY = groundY; this.z = z;
    this.vz = 0;
    this.fuseTimer = type === "bomb" ? 2.0 : 12.0;
    this.active = true;
  }
  update(dt, match) {
    if (this.z > 0) {
      this.vz -= 520 * dt;
      this.z = Math.max(0, this.z + this.vz * dt);
      if (this.z === 0) this.vz = 0;
      return;
    }
    this.fuseTimer -= dt;
    if (this.type === "bomb") {
      if (this.fuseTimer <= 0) { this.explode(match); this.active = false; }
      return;
    }
    if (this.fuseTimer <= 0) { this.active = false; return; }
    for (const f of match.fighters) {
      if (f.state === "ko" || f.hp <= 0 || f.z > 55) continue;
      const fx = f.x + f.width / 2;
      if (Math.abs(fx - this.x) < 38 && Math.abs(f.y - this.groundY) < 34) {
        if (this.type === "heal") {
          const healed = Math.min(f.maxHp - f.hp, 28);
          f.hp = Math.min(f.maxHp, f.hp + 28);
          match.emitEvent({ kind: "text", x: fx, y: f.getDrawTopY() - 12, text: healed > 0 ? `+${healed} HP 🍗` : "滿血 🍗", color: "#52b788", scale: 1.15, sfx: "pickup" });
        } else {
          f.addEnergy(40);
          match.emitEvent({ kind: "text", x: fx, y: f.getDrawTopY() - 12, text: "+40% 氣 ⚡", color: "#ffd166", scale: 1.15, sfx: "pickup" });
        }
        this.active = false;
        break;
      }
    }
  }
  explode(match) {
    match.emitEvent({ kind: "hit", hitX: this.x, hitY: this.groundY - 18, isHeavyOrUlt: true, isUlt: false, dmgText: "BOOM!! 💣", color: "#ff4d6d", scale: 1.45, sfx: "bomb" });
    const bombAtk = { name: "heavy", damage: 20, hitstun: 0.36, knockbackX: 520, knockbackZ: 320 };
    for (const f of match.fighters) {
      if (f.state === "ko" || f.hp <= 0 || f.invulnTimer > 0) continue;
      const fx = f.x + f.width / 2;
      if (Math.hypot(fx - this.x, (f.y - this.groundY) * 1.4) <= 130) {
        const dmg = f.takeHit(bombAtk, fx >= this.x ? 1 : -1, 20);
        match.emitEvent({ kind: "text", x: fx, y: f.getDrawTopY() - 8, text: `-${dmg}`, color: "#ff4d6d", scale: 1.2 });
      }
    }
  }
}

class ServerFighter {
  constructor({ id, x, y, facing, charDef, isCOM, comDiff, name }) {
    this.id = id;
    this.spawnX = x; this.spawnY = y; this.spawnFacing = facing;
    this.width = GAME_CONFIG.playerWidth; this.height = GAME_CONFIG.playerHeight;
    this.charDef = charDef;
    this.maxHp = charDef.maxHp;
    this.isCOM = !!isCOM;
    this.comAI = isCOM ? new ServerCOM(comDiff) : null;
    this.customNickname = name || "";
    this.name = `${id}P ${this.customNickname || ""} (${charDef.name})`.replace("  ", " ");
    this.wins = 0;
    this.hitTargetsThisSwing = new Set();
    this.reset(false);
  }
  reset(keepPartialEnergy = false) {
    this.x = this.spawnX; this.y = this.spawnY; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0; this.facing = this.spawnFacing;
    this.hp = this.maxHp; this.trailHp = this.maxHp;
    this.energy = keepPartialEnergy ? Math.min(GAME_CONFIG.maxEnergy, Math.round(this.energy * 0.45)) : 0;
    this.state = "idle"; this.stateTimer = 0; this.hitstunTimer = 0;
    this.invulnTimer = 0; this.attackCooldownTimer = 0;
    this.dashCooldownTimer = 0; this.dashDirX = 0; this.dashDirY = 0;
    this.currentAttack = null; this.hitTargetsThisSwing.clear();
    this.multiHitTimer = 0; this.projectileSpawned = false; this.lockedTargetPos = null;
    this.animTime = 0; this.comboHits = 0; this.comboTimer = 0;
    this.pendingKnockdown = false; this.knockdownForceTimer = 0;
    this.recentAttackers = new Map();
    this._lastGangWarn = 0;
  }
  addEnergy(amount) { this.energy = Math.max(0, Math.min(GAME_CONFIG.maxEnergy, this.energy + amount)); }
  getDrawTopY() { return this.y - this.height - this.z; }
  getHurtbox() { return { x: this.x, y: this.getDrawTopY(), width: this.width, height: this.height, groundY: this.y }; }
  getActiveHitbox() {
    if (this.state !== "attack_active" || !this.currentAttack || this.currentAttack.isProjectile) return null;
    const atk = this.currentAttack;
    if (atk.trackOpponent && this.lockedTargetPos) {
      return { x: this.lockedTargetPos.x - atk.width / 2, y: this.lockedTargetPos.y - atk.height, width: atk.width, height: atk.height, groundY: this.lockedTargetPos.y, depthTolerance: atk.depthTolerance };
    }
    if (atk.centeredHitbox) {
      const cx = this.x + this.width / 2;
      return { x: cx - atk.width / 2, y: this.y - this.z - atk.offsetZ - atk.height, width: atk.width, height: atk.height, groundY: this.y, depthTolerance: atk.depthTolerance };
    }
    const offsetX = atk.offsetX || 0;
    const hx = this.facing === 1 ? this.x + this.width + offsetX : this.x - atk.width - offsetX;
    return { x: hx, y: this.y - this.z - atk.offsetZ - atk.height, width: atk.width, height: atk.height, groundY: this.y, depthTolerance: atk.depthTolerance };
  }
  isGangedUp(now) {
    let count = 0;
    for (const [atk, t] of this.recentAttackers) {
      if (now - t <= GAME_CONFIG.gangUpWindow) count++;
      else this.recentAttackers.delete(atk);
    }
    return count >= 2;
  }
  update(dt, inputSource, match) {
    this.animTime += dt;
    if (this.trailHp > this.hp) this.trailHp = Math.max(this.hp, this.trailHp - 45 * dt);
    if (this.dashCooldownTimer > 0) this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - dt);
    if (this.invulnTimer > 0) this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    if (this.attackCooldownTimer > 0) this.attackCooldownTimer = Math.max(0, this.attackCooldownTimer - dt);
    if (this.comboHits > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0) this.comboHits = 0; }

    if (this.state === "ko") { this.applyPhysics(dt, true, match.mapBounds); return; }
    const passiveRate = match.isRageTime() ? GAME_CONFIG.passiveEnergyPerSec * 2.0 : GAME_CONFIG.passiveEnergyPerSec;
    this.addEnergy(passiveRate * dt);

    if (this.state === "hitstun") {
      this.hitstunTimer -= dt;
      if (this.pendingKnockdown) this.knockdownForceTimer -= dt;
      const forceDown = this.pendingKnockdown && this.knockdownForceTimer <= 0;
      if ((this.hitstunTimer <= 0 || forceDown) && (!this.pendingKnockdown || this.z <= 0)) {
        if (this.pendingKnockdown) {
          this.pendingKnockdown = false;
          this.state = "knockdown"; this.stateTimer = GAME_CONFIG.knockdownDuration;
          this.comboHits = 0;
          this.invulnTimer = Math.max(this.invulnTimer, GAME_CONFIG.knockdownDuration + GAME_CONFIG.wakeupInvulnTime);
        } else {
          this.state = this.z > 0 ? "jump" : "idle";
        }
      }
      this.applyPhysics(dt, true, match.mapBounds);
      return;
    }
    if (this.state === "knockdown") {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) this.state = "idle";
      this.applyPhysics(dt, true, match.mapBounds);
      return;
    }
    if (this.state === "dash") {
      this.stateTimer -= dt;
      const mult = this.charDef.speedMult;
      this.vx = this.dashDirX * GAME_CONFIG.dashSpeed * mult;
      this.vy = this.dashDirY * (GAME_CONFIG.dashSpeed * 0.72 * mult);
      if (this.stateTimer <= 0) { this.vx *= 0.35; this.vy *= 0.35; this.state = this.z > 0 ? "jump" : "idle"; }
      this.applyPhysics(dt, false, match.mapBounds);
      return;
    }
    if (this.state === "attack_startup" || this.state === "attack_active" || this.state === "attack_recovery") {
      if (!this.currentAttack) { this.state = this.z > 0 ? "jump" : "idle"; this.applyPhysics(dt, true, match.mapBounds); return; }
      this.stateTimer -= dt;
      if (this.state === "attack_active" && this.currentAttack.multiHitInterval) {
        this.multiHitTimer -= dt;
        if (this.multiHitTimer <= 0) { this.hitTargetsThisSwing.clear(); this.multiHitTimer = this.currentAttack.multiHitInterval; }
      }
      if (this.state === "attack_active" && this.currentAttack.lungeX) {
        this.vx = this.facing * this.currentAttack.lungeX; this.vy = 0;
      } else if (this.z === 0) { this.vx = 0; this.vy = 0; }

      if (this.state === "attack_active" && (this.currentAttack.isProjectile || this.currentAttack.alsoSpawnProjectiles) && !this.projectileSpawned) {
        this.projectileSpawned = true;
        const projSpec = this.currentAttack.alsoSpawnProjectiles || this.currentAttack;
        const px = this.facing === 1 ? this.x + this.width + (projSpec.offsetX || 0) : this.x - projSpec.width - (projSpec.offsetX || 0);
        const count = projSpec.projCount || 1;
        for (let i = 0; i < count; i++) {
          const mid = (count - 1) / 2;
          const vz = count > 1 ? (i - mid) * 90 + (projSpec.projType === "bouncing_orb" ? 280 : 0) : (projSpec.projType === "bouncing_orb" ? 260 : 0);
          const speedMult = count > 1 ? (0.85 + i * 0.14) : 1;
          match.projectiles.push(new ServerProjectile({ id: ++match.nextProjId, owner: this, x: px, groundY: this.y, z: this.z, facing: this.facing, attackData: projSpec, vz, speedMult }));
        }
      }

      if (this.stateTimer <= 0) {
        if (this.state === "attack_startup") {
          this.state = "attack_active"; this.stateTimer = this.currentAttack.active || 0.1;
          this.hitTargetsThisSwing.clear();
          this.multiHitTimer = this.currentAttack.multiHitInterval || 99;
          this.projectileSpawned = false;
        } else if (this.state === "attack_active") {
          this.state = "attack_recovery"; this.stateTimer = this.currentAttack.recovery || 0.12;
        } else {
          const finishedAtk = this.currentAttack;
          this.currentAttack = null; this.lockedTargetPos = null;
          this.attackCooldownTimer = finishedAtk?.name === "ult" ? 0.35 : (finishedAtk?.name === "heavy" ? 0.12 : 0.04);
          this.state = this.z > 0 ? "jump" : "idle";
        }
      }
      this.applyPhysics(dt, true, match.mapBounds);
      return;
    }

    // 移動與按鍵處理
    let dirX = 0; let dirY = 0;
    if (inputSource.isHeld("ACT_LEFT")) dirX -= 1;
    if (inputSource.isHeld("ACT_RIGHT")) dirX += 1;
    if (inputSource.isHeld("ACT_UP")) dirY -= 1;
    if (inputSource.isHeld("ACT_DOWN")) dirY += 1;
    const mult = this.charDef.speedMult;
    if (dirX !== 0 && dirY !== 0) {
      const inv = 1 / Math.SQRT2;
      this.vx = dirX * inv * GAME_CONFIG.moveSpeedX * mult;
      this.vy = dirY * inv * GAME_CONFIG.moveSpeedY * mult;
    } else {
      this.vx = dirX * GAME_CONFIG.moveSpeedX * mult;
      this.vy = dirY * GAME_CONFIG.moveSpeedY * mult;
    }
    if (dirX !== 0) this.facing = dirX;
    if (this.z === 0) this.state = (dirX !== 0 || dirY !== 0) ? "move" : "idle";

    if (inputSource.wasPressed("ACT_JUMP") && this.z === 0) {
      this.vz = GAME_CONFIG.jumpVelocity; this.state = "jump";
    }
    if (inputSource.wasPressed("ACT_DASH") && this.dashCooldownTimer <= 0) {
      this.state = "dash"; this.stateTimer = GAME_CONFIG.dashDuration;
      this.invulnTimer = Math.max(this.invulnTimer, GAME_CONFIG.dashInvulnTime);
      this.dashCooldownTimer = GAME_CONFIG.dashCooldown;
      if (dirX !== 0 || dirY !== 0) {
        const len = Math.hypot(dirX, dirY);
        this.dashDirX = dirX / len; this.dashDirY = dirY / len;
      } else { this.dashDirX = this.facing; this.dashDirY = 0; }
      this.applyPhysics(dt, false, match.mapBounds);
      return;
    }
    if (inputSource.wasPressed("ACT_ULT")) {
      if (Math.floor(this.energy) >= GAME_CONFIG.maxEnergy && this.charDef.attacks.ult) {
        this.energy = 0;
        this.startAttack(this.charDef.attacks.ult, match);
        match.emitEvent({ kind: "ult", slot: this.id, fighterName: this.name, ultTitle: this.charDef.ultTitle, color: this.charDef.themeColor });
        this.applyPhysics(dt, true, match.mapBounds);
        return;
      }
    }
    if (this.attackCooldownTimer <= 0) {
      if (inputSource.wasPressed("ACT_LIGHT")) this.startAttack(this.charDef.attacks.light, match);
      else if (inputSource.wasPressed("ACT_HEAVY")) this.startAttack(this.charDef.attacks.heavy, match);
    }
    this.applyPhysics(dt, true, match.mapBounds);
  }
  startAttack(atk, match) {
    if (!atk) return;
    this.currentAttack = atk; this.state = "attack_startup"; this.stateTimer = atk.startup;
    this.hitTargetsThisSwing.clear(); this.projectileSpawned = false;
    if (atk.trackOpponent && match) {
      const opp = match.getNearestOpponent(this, false);
      this.lockedTargetPos = opp ? { x: opp.x + opp.width / 2, y: opp.y } : { x: this.x + this.facing * 140, y: this.y };
    } else {
      this.lockedTargetPos = null;
    }
  }
  takeHit(attackData, attackerFacing, finalDamage, hurtEnergyMult = 1.0) {
    const hasArmor = this.currentAttack?.superArmor && (this.state === "attack_startup" || this.state === "attack_active");
    const baseDmg = finalDamage !== undefined ? finalDamage : attackData.damage;
    const dmg = hasArmor ? Math.ceil(baseDmg * 0.5) : baseDmg;
    this.hp = Math.max(0, this.hp - dmg);
    this.addEnergy(GAME_CONFIG.hurtEnergyGain * hurtEnergyMult);
    this.invulnTimer = Math.max(this.invulnTimer, attackData.multiHitInterval ? attackData.multiHitInterval - 0.015 : 0.06);
    if (this.hp <= 0) {
      this.currentAttack = null; this.state = "ko";
      this.vx = attackerFacing * 380; this.vy = 0; this.vz = 340;
      return dmg;
    }
    if (hasArmor) return dmg;
    this.currentAttack = null; this.lockedTargetPos = null;
    this.state = "hitstun"; this.hitstunTimer = attackData.hitstun || 0.2;
    this.comboHits += 1; this.comboTimer = GAME_CONFIG.comboResetTime;
    const isLauncher = !attackData.multiHitInterval && (attackData.knockbackZ || 0) >= GAME_CONFIG.knockdownLaunchZ;
    const wasPending = this.pendingKnockdown;
    const juggleLocked = wasPending && this.knockdownForceTimer <= 0;
    if (isLauncher || this.comboHits >= GAME_CONFIG.comboKnockdownHits) {
      if (!wasPending) this.knockdownForceTimer = 0.6;
      this.pendingKnockdown = true;
      if (!wasPending && !isLauncher && !(attackData.knockbackZ > 0)) this.vz = 220;
    }
    this.vx = attackData.knockbackX > 0 ? attackerFacing * attackData.knockbackX : 0;
    this.vy = 0;
    if (attackData.knockbackZ > 0 && !juggleLocked) this.vz = attackData.knockbackZ;
    return dmg;
  }
  applyPhysics(dt, applyGravity, mapBounds) {
    if (this.state === "hitstun" || this.state === "ko" || this.state === "knockdown") {
      const friction = this.z === 0 ? GAME_CONFIG.groundFriction : GAME_CONFIG.airFriction;
      if (this.vx > 0) this.vx = Math.max(0, this.vx - friction * dt);
      else if (this.vx < 0) this.vx = Math.min(0, this.vx + friction * dt);
    }
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (applyGravity && (this.z > 0 || this.vz !== 0)) {
      this.vz -= GAME_CONFIG.gravity * dt; this.z += this.vz * dt;
      if (this.z <= 0) { this.z = 0; this.vz = 0; if (this.state === "jump") this.state = "idle"; }
    }
    this.x = Math.max(0, Math.min(GAME_CONFIG.canvasWidth - this.width, this.x));
    this.y = Math.max(mapBounds.arenaTopY, Math.min(mapBounds.arenaBottomY, this.y));
  }
}

class ServerMatch {
  constructor(room) {
    this.room = room;
    this.mapBounds = MAP_BOUNDS[room.mapIndex] || MAP_BOUNDS[0];
    this.worldTime = 0;
    this.nextProjId = 0;
    this.inputs = new Map();
    const midY = (this.mapBounds.arenaTopY + this.mapBounds.arenaBottomY) / 2;
    const count = room.players.length;
    const positions = count === 2
      ? [{ x: 200, y: midY, facing: 1 }, { x: 706, y: midY, facing: -1 }]
      : count === 3
        ? [{ x: 170, y: midY - 40, facing: 1 }, { x: 736, y: midY - 40, facing: -1 }, { x: 453, y: midY + 55, facing: -1 }]
        : [{ x: 165, y: midY - 45, facing: 1 }, { x: 741, y: midY - 45, facing: -1 }, { x: 245, y: midY + 50, facing: 1 }, { x: 661, y: midY + 50, facing: -1 }];

    this.fighters = room.players.map((rp, i) => {
      const pos = positions[i] || positions[0];
      const charDef = CHARACTER_SPECS[rp.charIndex] || CHARACTER_SPECS[0];
      if (!rp.isCOM) this.inputs.set(rp.slot, new ServerInputBuffer());
      return new ServerFighter({ id: rp.slot, x: pos.x, y: pos.y, facing: pos.facing, charDef, isCOM: rp.isCOM, comDiff: rp.comDiff, name: rp.name });
    });
    this.startMatch();
  }
  startMatch() {
    for (const f of this.fighters) f.wins = 0;
    this.roundNumber = 1;
    this.matchWinner = null;
    this.championSlot = 0;
    this.victoryTime = 0;
    this.resetRound(false);
  }
  resetRound(keepPartialEnergy = true) {
    for (const f of this.fighters) f.reset(keepPartialEnergy);
    this.projectiles = [];
    this.pickups = [];
    this.pickupSpawnTimer = 8.5;
    this.hitstopTimer = 0;
    this.roundTimer = GAME_CONFIG.roundDuration;
    this.roundIntroTimer = 1.1;
    this.roundEndReason = "";
    this.koWinner = null;
    this.resetTimer = 0;
  }
  convertSlotToCOM(slot, leaverName) {
    const f = this.fighters.find((ft) => ft.id === slot);
    if (!f) return;
    f.isCOM = true;
    f.comAI = new ServerCOM("normal");
    f.name = `${slot}P ${leaverName}(COM)`;
    this.inputs.delete(slot);
  }
  applyPlayerInput(slot, held, pressed) {
    const buf = this.inputs.get(slot);
    if (buf) buf.applyPacket(held, pressed);
  }
  isRageTime() { return this.roundTimer <= GAME_CONFIG.rageTimeThreshold && !this.koWinner; }
  emitEvent(event) { broadcastMatchEvent(this.room, event); }
  getNearestOpponent(fighter, preferVulnerable = false) {
    let best = null, bestDist = Infinity, fallback = null, fallbackDist = Infinity;
    for (const other of this.fighters) {
      if (other === fighter || other.state === "ko" || other.hp <= 0) continue;
      const d = Math.hypot((other.x + other.width / 2) - (fighter.x + fighter.width / 2), (other.y - fighter.y) * 1.4);
      if (d < fallbackDist) { fallbackDist = d; fallback = other; }
      if (preferVulnerable && (other.state === "knockdown" || other.invulnTimer > 0.15)) continue;
      if (d < bestDist) { bestDist = d; best = other; }
    }
    return best || fallback;
  }
  update(dt) {
    this.worldTime += dt;
    if (this.roundIntroTimer > 0) this.roundIntroTimer = Math.max(0, this.roundIntroTimer - dt);
    if (this.hitstopTimer > 0) { this.hitstopTimer = Math.max(0, this.hitstopTimer - dt); return; }
    if (!this.koWinner) this.roundTimer = Math.max(0, this.roundTimer - dt);

    for (const f of this.fighters) {
      if (f.isCOM) {
        const target = this.getNearestOpponent(f, true);
        if (target && f.comAI) { f.comAI.update(dt, f, target); f.update(dt, f.comAI, this); }
        else f.applyPhysics(dt, true, this.mapBounds);
      } else {
        const inp = this.inputs.get(f.id);
        if (inp) { f.update(dt, inp, this); inp.endTick(); }
      }
    }

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      this.projectiles[i].update(dt);
      if (!this.projectiles[i].active) this.projectiles.splice(i, 1);
    }

    if (this.roundIntroTimer <= 0 && !this.koWinner) {
      this.pickupSpawnTimer -= dt;
      if (this.pickupSpawnTimer <= 0 && this.pickups.length < 2) {
        this.pickupSpawnTimer = 8.5 + Math.random() * 3.5;
        const types = ["heal", "energy", "bomb"];
        const type = types[Math.floor(Math.random() * types.length)];
        const px = 140 + Math.random() * (GAME_CONFIG.canvasWidth - 280);
        const py = this.mapBounds.arenaTopY + 18 + Math.random() * (this.mapBounds.arenaBottomY - this.mapBounds.arenaTopY - 36);
        this.pickups.push(new ServerPickup({ type, x: px, groundY: py }));
      }
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      this.pickups[i].update(dt, this);
      if (!this.pickups[i].active) this.pickups.splice(i, 1);
    }

    if (!this.koWinner) {
      this.checkCombatHits();
      const alive = this.fighters.filter((f) => f.hp > 0);
      if (alive.length <= 1) {
        this.concludeRound(alive.length === 1 ? alive[0] : "DRAW", "K.O.!");
      } else if (this.roundTimer <= 0) {
        let bestRatio = -1, winners = [];
        for (const f of this.fighters) {
          const r = f.hp / f.maxHp;
          if (r > bestRatio + 0.001) { bestRatio = r; winners = [f]; }
          else if (Math.abs(r - bestRatio) <= 0.001) winners.push(f);
        }
        this.concludeRound(winners.length === 1 ? winners[0] : "DRAW", "TIME OVER!");
      }
    } else {
      if (this.matchWinner) this.victoryTime += dt;
      this.resetTimer -= dt;
      if (this.resetTimer <= 0) {
        if (this.matchWinner) this.startMatch();
        else { this.roundNumber++; this.resetRound(true); }
      }
    }
  }
  checkCombatHits() {
    for (let i = 0; i < this.fighters.length; i++) {
      for (let j = 0; j < this.fighters.length; j++) {
        if (i === j) continue;
        const att = this.fighters[i], def = this.fighters[j];
        if (att.hitTargetsThisSwing.has(def) || def.state === "ko" || def.invulnTimer > 0) continue;
        const hb = att.getActiveHitbox();
        if (!hb) continue;
        const hurt = def.getHurtbox();
        if (Math.abs(hb.groundY - hurt.groundY) <= hb.depthTolerance && rectsOverlap(hb, hurt)) {
          att.hitTargetsThisSwing.add(def);
          const pushDir = (def.x + def.width / 2 >= att.x + att.width / 2) ? 1 : -1;
          const hitX = pushDir === 1 ? hurt.x + 8 : hurt.x + hurt.width - 8;
          this.applyHitEffects(att, def, att.currentAttack, att.currentAttack.centeredHitbox ? pushDir : att.facing, hitX, hb.y + hb.height / 2);
        }
      }
    }
    for (const proj of this.projectiles) {
      if (!proj.active) continue;
      for (const def of this.fighters) {
        if (def === proj.owner || def.state === "ko" || def.invulnTimer > 0 || proj.hitTargets.has(def)) continue;
        const hb = proj.getHitbox(), hurt = def.getHurtbox();
        if (Math.abs(hb.groundY - hurt.groundY) <= hb.depthTolerance && rectsOverlap(hb, hurt)) {
          if (proj.projType === "boomerang") proj.hitTargets.add(def);
          else proj.active = false;
          const hitX = proj.facing === 1 ? hurt.x + 8 : hurt.x + hurt.width - 8;
          this.applyHitEffects(proj.owner, def, proj.attackData, proj.facing, hitX, hb.y + hb.height / 2);
          if (!proj.active) break;
        }
      }
    }
  }
  applyHitEffects(attacker, defender, attackData, facing, hitX, hitY) {
    const rageMult = this.isRageTime() ? GAME_CONFIG.rageDamageMult : 1.0;
    const now = this.worldTime;
    if (attacker) defender.recentAttackers.set(attacker, now);
    const gangedUp = defender.isGangedUp(now);
    const scaledDmg = Math.max(1, Math.round((attackData.damage || 5) * rageMult * (gangedUp ? GAME_CONFIG.gangUpDamageMult : 1.0)));
    const actualDmg = defender.takeHit(attackData, facing, scaledDmg, gangedUp ? GAME_CONFIG.gangUpEnergyMult : 1.0);
    if (attacker && attackData.name !== "ult" && attackData.name !== "ult_proj") {
      const eGain = attackData.multiHitInterval ? GAME_CONFIG.hitEnergyGain * 0.45 : GAME_CONFIG.hitEnergyGain;
      attacker.addEnergy(eGain * (this.isRageTime() ? 1.5 : 1.0));
    }
    this.hitstopTimer = Math.max(this.hitstopTimer, attackData.hitstop || 0.04);
    const isUlt = attackData.name === "ult" || attackData.name === "ult_proj";
    const isHeavyOrUlt = attackData.name === "heavy" || isUlt;
    const tag = isUlt ? " 必殺!!" : (isHeavyOrUlt ? "!" : "");
    this.emitEvent({
      kind: "hit", hitX, hitY, isHeavyOrUlt, isUlt,
      dmgText: `-${actualDmg}${tag}`,
      color: isUlt ? "#ff0054" : (isHeavyOrUlt ? "#ffbe0b" : "#ffffff"),
      scale: isUlt ? 1.55 : (isHeavyOrUlt ? 1.35 : 1.0),
      sfx: defender.hp <= 0 ? "ko" : (isUlt ? "ult" : (isHeavyOrUlt ? "heavy" : "light"))
    });
    if (gangedUp && now - defender._lastGangWarn > 1.2) {
      defender._lastGangWarn = now;
      this.emitEvent({ kind: "text", x: defender.x + defender.width / 2, y: defender.getDrawTopY() - 22, text: "圍毆減傷! 氣+50%", color: "#00f5d4", scale: 1.05 });
    }
  }
  concludeRound(winnerFighter, reasonText) {
    this.roundEndReason = reasonText;
    if (!winnerFighter || winnerFighter === "DRAW") {
      this.koWinner = "DRAW";
      if (!this.fighters.some((f) => f.wins + 1 >= GAME_CONFIG.winsToMatch)) {
        for (const f of this.fighters) f.wins = Math.min(GAME_CONFIG.winsToMatch - 1, f.wins + 1);
      }
    } else {
      winnerFighter.wins++;
      this.koWinner = `${winnerFighter.id}P`;
    }
    const champ = this.fighters.find((f) => f.wins >= GAME_CONFIG.winsToMatch);
    if (champ) {
      this.matchWinner = champ.name;
      this.championSlot = champ.id;
      this.victoryTime = 0;
      this.resetTimer = GAME_CONFIG.matchOverDelay;
    } else {
      this.matchWinner = null;
      this.championSlot = 0;
      this.resetTimer = GAME_CONFIG.roundTransitionDelay;
    }
  }
  serializeState() {
    return {
      rn: this.roundNumber,
      rt: Number(this.roundTimer.toFixed(2)),
      ri: Number(this.roundIntroTimer.toFixed(2)),
      kw: this.koWinner,
      re: this.roundEndReason,
      mw: this.matchWinner,
      cs: this.championSlot,
      vt: Number(this.victoryTime.toFixed(2)),
      rst: Number(this.resetTimer.toFixed(2)),
      fs: this.fighters.map((f) => ({
        id: f.id, x: Math.round(f.x), y: Math.round(f.y), z: Math.round(f.z), fc: f.facing,
        hp: f.hp, thp: Math.round(f.trailHp), en: Math.round(f.energy), w: f.wins,
        st: f.state, stt: Number(f.stateTimer.toFixed(2)), at: Number(f.animTime.toFixed(2)),
        inv: Number(f.invulnTimer.toFixed(2)), ak: f.currentAttack ? f.currentAttack.name : null,
        lt: f.lockedTargetPos ? [Math.round(f.lockedTargetPos.x), Math.round(f.lockedTargetPos.y)] : null
      })),
      ps: this.projectiles.map((p) => ({
        id: p.id, x: Math.round(p.x), gy: Math.round(p.groundY), z: Math.round(p.z), fc: p.facing,
        pt: p.projType, w: p.width, h: p.height, ang: Number(p.angle.toFixed(2))
      })),
      pk: this.pickups.map((pk) => ({
        t: pk.type, x: Math.round(pk.x), gy: Math.round(pk.groundY), z: Math.round(pk.z), ft: Number(pk.fuseTimer.toFixed(1))
      }))
    };
  }
}

function broadcastMatchState(room) {
  if (!room || !room.match) return;
  const packet = { type: "game_state", state: room.match.serializeState() };
  for (const p of room.players) {
    if (p.isCOM) continue;
    const c = clients.get(p.clientId);
    // 防止慢速連線堆積過時影格造成延遲雪球
    if (c && c.socket && (c.socket.writableLength || 0) <= 16384) sendJson(c, packet);
  }
}

function broadcastMatchEvent(room, event) {
  if (!room) return;
  const packet = { type: "game_event", event };
  for (const p of room.players) {
    if (p.isCOM) continue;
    const c = clients.get(p.clientId);
    if (c) sendJson(c, packet);
  }
}

// =========================================================================
// 4. WebSocket Upgrade 握手與連線生命週期
// =========================================================================
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + WS_MAGIC_GUID)
    .digest("base64");

  const responseHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "\r\n"
  ].join("\r\n");

  socket.write(responseHeaders);
  socket.setNoDelay(true);

  const clientId = nextClientSeq++;
  const client = {
    id: clientId,
    name: `玩家${clientId}`,
    socket,
    roomId: null,
    closed: false,
    buffer: Buffer.alloc(0)
  };
  clients.set(clientId, client);

  // 連線成功後立即發送目前所有房間列表
  sendJson(client, {
    type: "welcome",
    clientId,
    rooms: Array.from(rooms.values()).map(serializeRoomSummary)
  });

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (client.buffer.length >= 2) {
      const firstByte = client.buffer[0];
      const secondByte = client.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (client.buffer.length < 4) return;
        payloadLen = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (client.buffer.length < 10) return;
        payloadLen = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (client.buffer.length < totalFrameLen) return;

      const maskKey = isMasked ? client.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(client.buffer.subarray(offset + maskLen, totalFrameLen));
      client.buffer = client.buffer.subarray(totalFrameLen);

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        // Close frame
        client.closed = true;
        socket.end();
        return;
      } else if (opcode === 0x09) {
        // Ping -> Pong
        socket.write(encodeWsFrame(0x0a, payload));
      } else if (opcode === 0x01) {
        // Text frame
        try {
          const text = payload.toString("utf8");
          const parsed = JSON.parse(text);
          handleClientMessage(client, parsed);
        } catch (_) { }
      }
    }
  });

  const cleanup = () => {
    if (client.closed) return;
    client.closed = true;
    removeClientFromRoom(client);
    clients.delete(clientId);
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

// 嚴格伺服器權威：60 FPS 遊戲物理運算迴圈 (約 16.67ms) + 30Hz 狀態廣播 (避免廣域網/代理塞車)
let lastTickMs = Date.now();
let netTickCount = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - lastTickMs) / 1000));
  lastTickMs = now;
  netTickCount++;
  const shouldBroadcast = (netTickCount % 2 === 0);
  for (const room of rooms.values()) {
    if (room.status === "fighting" && room.match) {
      const prevKo = room.match.koWinner;
      room.match.update(dt);
      if (shouldBroadcast || room.match.koWinner !== prevKo) {
        broadcastMatchState(room);
      }
    }
  }
}, 1000 / 60);

// 定期發送 WebSocket Ping 保持長連線
setInterval(() => {
  const pingFrame = encodeWsFrame(0x09, Buffer.alloc(0));
  for (const c of clients.values()) {
    if (!c.closed && c.socket && !c.socket.destroyed) {
      try { c.socket.write(pingFrame); } catch (_) { }
    }
  }
}, 20000).unref();

server.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const lanUrls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        lanUrls.push(`http://${net.address}:${PORT}`);
      }
    }
  }
  console.log("=============================================================");
  console.log("🔥 115士長乙4班格鬥大賽 — 連線對戰伺服器已啟動！");
  console.log(`👉 本機開啟網址: http://localhost:${PORT}`);
  if (lanUrls.length > 0) {
    console.log(`👉 區網/朋友連線網址: ${lanUrls.join(" 或 ")}`);
  }
  console.log("=============================================================");
});
