# 115士長乙4班格鬥大賽 — 連線格鬥遊戲

本專案包含前端格鬥遊戲介面（支援 2～4 人即時連線大亂鬥、三戰兩勝制）與零外部依賴的 Node.js WebSocket 即時連線伺服器。

---

## 雲端部署指南：前端 (Vercel) + 後端 (Render)

### 架構說明
- **前端 (Vercel)**：託管 `index.html`、`config.js`、`人物角色/` 等靜態資源，提供高速全球 CDN 與 HTTPS。
- **後端 (Render)**：託管 `server.js`，負責即時房間管理、玩家同步與 RFC 6455 原生 WebSocket 長連線。

---

### 第一步：後端部署至 Render (建議先做)

因為前端需要連線到 Render 的 WebSocket 網址，因此建議先取得 Render 的伺服器網址：

1. **將專案推送到 GitHub**：
   ```bash
   git add .
   git commit -m "feat: setup Vercel & Render deployment"
   git remote add origin https://github.com/<你的帳號>/<你的儲存庫名稱>.git
   git branch -M main
   git push -u origin main
   ```
2. 前往 [Render 官網 (render.com)](https://render.com/) 並登入。
3. 點擊右上角 **「New +」** -> 選擇 **「Web Service」**。
4. 選擇連結剛才建立的 GitHub 專案。
5. 設定基本資訊：
   - **Name**: 自訂名稱（例如 `fight-brawl-server`）
   - **Runtime**: `Node`
   - **Build Command**: 留空（零外部依賴，無需 npm install）
   - **Start Command**: `node server.js`
   - **Instance Type**: 選擇 **Free**
   - **Health Check Path** (進階選填): `/health`
6. 點擊 **「Deploy Web Service」**。
7. 部署完成後，在 Render 頁面頂部會看到你的專屬網址，例如：
   `https://fight-brawl-server.onrender.com`
   👉 **對應的 WebSocket 網址為**：`wss://fight-brawl-server.onrender.com`

---

### 第二步：前端設定與部署至 Vercel

1. **設定後端網址 (可選，也可直接在網頁上輸入)**：
   打開本機的 `config.js`，將剛剛取得的 Render WebSocket 網址填入：
   ```javascript
   window.SERVER_CONFIG = {
     wsUrl: "wss://fight-brawl-server.onrender.com"
   };
   ```
   *（提示：若未修改 `config.js`，直接在 Vercel 網頁上的輸入框貼上網址連線亦可，瀏覽器會自動記住。）*
2. 將修改提交並推送至 GitHub：
   ```bash
   git commit -am "chore: update render server url"
   git push
   ```
3. 前往 [Vercel 官網 (vercel.com)](https://vercel.com/) 並登入。
4. 點擊 **「Add New...」** -> **「Project」**。
5. 選擇剛才的 GitHub 專案並點擊 **「Import」**。
6. 設定選項：
   - **Framework Preset**: 選擇 **Other**
   - **Root Directory**: 保持預設 `./`
   - **Build and Output Settings**: 保持預設（靜態網頁無需打包指令）
7. 點擊 **「Deploy」**。
8. 幾秒後即可獲得前端公開網址（例如 `https://fight-brawl.vercel.app`）！

---

### 第三步：開始線上對戰！

1. 打開遊戲網址（手機、電腦皆可；手機請橫向）。
2. 依畫面三個步驟操作：**選模式 → 選角色 → 進房間**。
3. 選「連線對戰」後，一人按「建立房間」，把房號告訴朋友；其他人輸入房號或直接點公開房間加入。房主按「開戰」即可開始。
4. 若前端放在 Vercel 且 `config.js` 未填伺服器網址，可在連線大廳展開「伺服器設定」貼上 Render 網址。
5. 斷線（切到背景、鎖屏、網路瞬斷）後 20 秒內會自動重連並回到原本的席位。
6. iPhone 的 Safari 不支援網頁全螢幕：用分享選單「加入主畫面」後從主畫面開啟，即可全螢幕橫向遊玩。

---

## 本機執行與測試

若要在本機開發測試，直接執行：
```bash
node server.js
```
伺服器將在 `http://localhost:3000` 啟動，瀏覽器開啟 `http://localhost:3000` 或開啟 `index.html` 即可暢玩。
