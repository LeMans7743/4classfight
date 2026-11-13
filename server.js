/**
 * 吞食天地 2~4人大亂鬥 — 連線對戰房與即時大廳伺服器 (server.js)
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
  } catch (_) {}
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
    // 若在戰鬥中有人斷線，通知房內其他玩家該 slot 已離開
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
      broadcastRoomList();
      break;
    }

    case "return_to_room": {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id) return;
      room.status = "waiting";
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
      // 非房主玩家 (2P / 3P / 4P) 將按鍵狀態傳給房主 (1P)
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.status !== "fighting") return;
      const playerEntry = room.players.find((p) => p.clientId === client.id);
      if (!playerEntry) return;
      const hostClient = clients.get(room.hostId);
      if (hostClient && hostClient.id !== client.id) {
        sendJson(hostClient, {
          type: "remote_player_input",
          slot: playerEntry.slot,
          held: Array.isArray(msg.held) ? msg.held : [],
          pressed: Array.isArray(msg.pressed) ? msg.pressed : []
        });
      }
      break;
    }

    case "game_state": {
      // 房主 (1P) 廣播權威遊戲狀態快照給房內所有其他真人玩家 (2P / 3P / 4P)
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id) return;
      const packet = { type: "game_state", state: msg.state };
      for (const p of room.players) {
        if (p.isCOM || p.clientId === client.id) continue;
        const c = clients.get(p.clientId);
        if (c) sendJson(c, packet);
      }
      break;
    }

    case "game_event": {
      // 房主 (1P) 廣播即時戰鬥特效事件 (打擊火花、傷害跳字、必殺特寫等)
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id) return;
      const packet = { type: "game_event", event: msg.event };
      for (const p of room.players) {
        if (p.isCOM || p.clientId === client.id) continue;
        const c = clients.get(p.clientId);
        if (c) sendJson(c, packet);
      }
      break;
    }
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
        } catch (_) {}
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

// 定期發送 WebSocket Ping 保持長連線
setInterval(() => {
  const pingFrame = encodeWsFrame(0x09, Buffer.alloc(0));
  for (const c of clients.values()) {
    if (!c.closed && c.socket && !c.socket.destroyed) {
      try { c.socket.write(pingFrame); } catch (_) {}
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
  console.log("🔥 吞食天地 2~4人大亂鬥 — 連線對戰伺服器已啟動！");
  console.log(`👉 本機開啟網址: http://localhost:${PORT}`);
  if (lanUrls.length > 0) {
    console.log(`👉 區網/朋友連線網址: ${lanUrls.join(" 或 ")}`);
  }
  console.log("=============================================================");
});
