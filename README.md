# 日系機器人戰術對戰 · 原型

規格見 [日系機器人戰術對戰 規格草案.md](日系機器人戰術對戰%20規格草案.md)，原型的佔位規則與數值見 [docs/placeholders.md](docs/placeholders.md)。

## 執行

```bash
npm install
npm run dev
```

開啟 http://localhost:5173/?room=test&seat=0（A 方），再用頁面右上角的連結開 B 方視窗。

- `npm test`：規則引擎測試
- `npm run sim -- 500`：批次隨機對戰，粗看數值分布
- `TURN_SECONDS=60 npm run dev`：開啟回合計時

## 結構

| 位置 | 內容 |
| --- | --- |
| `packages/rules` | 規則引擎（純 TypeScript、無 I/O、帶種子亂數）。伺服器用它裁決，客戶端用同一份程式碼預覽軌跡與成本 |
| `packages/rules/src/match.ts` | 一場對戰的權威狀態與階段流程，不依賴傳輸層；日後包進 Durable Object |
| `packages/rules/src/visibility.ts` | 依玩家過濾狀態與事件紀錄（看得到機體、看不到駕駛） |
| `apps/server` | 本機 WebSocket 伺服器（port 8787），替代 Cloudflare |
| `apps/client` | Vite + Canvas 的 2D 俯視除錯畫面 |
