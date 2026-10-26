# 日系機器人戰術對戰 · 原型

規格見 [日系機器人戰術對戰 規格草案.md](日系機器人戰術對戰%20規格草案.md)，原型的佔位規則與數值見 [docs/placeholders.md](docs/placeholders.md)。

## 執行

```bash
npm install
npm run dev
```

開啟 http://localhost:5173/?room=test&seat=0（A 方），再用頁面右上角的連結開 B 方視窗。

### 兩種模式

- **伺服器模式**（`npm run dev` 的預設）：連本機 WebSocket 伺服器，A、B 各開一個視窗。
- **本機模式**（建置版與 GitHub Pages 的預設，或網址加 `?mode=local`）：對戰直接跑在瀏覽器裡。右上角可選對手：對戰電腦、同機輪流（換手時會先蓋住畫面）、電腦對戰電腦（觀戰）；也可以用網址 `?opponent=ai|hotseat|aivai` 指定。對戰結束後可以重播整場的結算演出。

### 其他指令

- `npm test`：規則引擎測試
- `npm run sim -- 500`：批次隨機對戰，粗看數值分布
- `npm run aisim -- 200`：批次 AI 對 AI，看勝負與退場原因
- `npm run content:check [資料包.json]`：檢查機型／武器／駕駛／配裝資料
- `TURN_SECONDS=60 npm run dev`：開啟回合計時

## GitHub Pages

推到 `main` 後，[.github/workflows/pages.yml](.github/workflows/pages.yml) 會跑測試、建置 `apps/client` 並發佈。第一次需要在 repo 的 Settings → Pages 把 Source 設成 **GitHub Actions**。

## 結構

| 位置 | 內容 |
| --- | --- |
| `packages/rules` | 規則引擎（純 TypeScript、無 I/O、帶種子亂數）。伺服器用它裁決，客戶端用同一份程式碼預覽軌跡與成本 |
| `packages/rules/content` | 遊戲資料（JSON）：武器、機型、駕駛、配裝、預設陣容。`src/content.ts` 負責檢查與切換資料包，每場對戰記下開場時的版本 |
| `packages/rules/src/match.ts` | 一場對戰的權威狀態與階段流程，不依賴傳輸層；日後包進 Durable Object |
| `packages/rules/src/visibility.ts` | 依玩家過濾狀態與事件紀錄（看得到機體、看不到駕駛） |
| `apps/server` | 本機 WebSocket 伺服器（port 8787），替代 Cloudflare |
| `apps/client` | Vite + Canvas 的 2D 俯視除錯畫面；`src/local.ts` 是本機輪流模式 |
