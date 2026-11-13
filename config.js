// config.js - 前端連線設定
// 部署至 Vercel 時，可在此填寫 Render 後端伺服器的 WebSocket 網址
// 例如: "wss://fight-tiandi-server.onrender.com"
window.SERVER_CONFIG = {
  // Render 後端伺服器 WebSocket 網址 (支援 wss:// 或 https://，會自動處理)
  // 若留空，遊戲將優先讀取瀏覽器上次輸入紀錄，或預設連線本地 localhost:3000
  wsUrl: ""
};

