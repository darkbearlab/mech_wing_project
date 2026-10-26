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

## 機庫（內容編輯器）

遊戲右上角的「機庫」連到 `editor.html`：左邊選分類與項目，中間編輯，右邊看檢查結果、命中試算、被誰使用、和線上版的差異。不輸入管理金鑰只能瀏覽；輸入後每次修改會自動存進草稿（D1）。「用草稿試玩」開一場用草稿資料的對戰（`?content=draft`），檢查通過後按「發佈」變成新版本。

本機開發：`npm run migrate:local -w @mech/api` 後同時跑 `npm run dev -w @mech/api` 和 `npm run dev`，並在 `apps/client/.env.development.local` 寫 `VITE_CONTENT_API=http://localhost:8788`。本機 API 用 `apps/api/.dev.vars` 裡另一把測試金鑰的雜湊（`ADMIN_TOKEN_SHA256=...`），不要拿正式金鑰在本機測。

## 內容 API（Cloudflare）

`apps/api` 是部署在 https://mech-wing-api.darkbearlab.workers.dev 的 Worker：D1 存編輯中的草稿，發佈時用規則引擎檢查、打包成不會再變的版本存進 KV。版本號是「大.小.修」（例如 `0.1.4`），平常發佈只加修訂號，機庫發佈時可以選小改版或大改版；最早的 `v1`…`v5` 已改名為 `0.1.0`…`0.1.4`（舊網址還能用）。GitHub Pages 版開場時抓最新版，抓不到就用內建資料；網址加 `?content=builtin` 強制用內建資料，`?content=0.1.4` 指定版本。畫面右上角會顯示目前用的資料版本。

- 讀取：`GET /packs/latest`、`GET /packs/v1`、`GET /packs`（發佈紀錄）、`GET /draft`（草稿與檢查結果）、`GET /auth`（確認金鑰）
- 寫入（要管理金鑰）：`PUT|DELETE /draft/:kind/:id`、`POST /draft/import`、`POST /publish`
- 管理金鑰存在 `apps/api/.admin-token`（不進 git），設定檔裡只有它的 SHA-256。換金鑰：產生新金鑰寫進該檔，把雜湊更新到 `wrangler.jsonc`
- 管理指令：`npm run admin -w @mech/api -- status | import [資料包.json] | publish [備註] [--minor|--major]`
- 本機測試：`npm run migrate:local -w @mech/api`、`npm run dev -w @mech/api`，再用 `MECH_API=http://localhost:8788` 跑管理指令
- `main` 上 `apps/api` 或 `packages/rules` 有變動時，[.github/workflows/api.yml](.github/workflows/api.yml) 會跑 D1 遷移並部署（用 repo secrets `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）

## 結構

| 位置 | 內容 |
| --- | --- |
| `packages/rules` | 規則引擎（純 TypeScript、無 I/O、帶種子亂數）。伺服器用它裁決，客戶端用同一份程式碼預覽軌跡與成本 |
| `packages/rules/content` | 遊戲資料（JSON）：武器、機型、駕駛、配裝、預設陣容。`src/content.ts` 負責檢查與切換資料包，每場對戰記下開場時的版本 |
| `packages/rules/src/match.ts` | 一場對戰的權威狀態與階段流程，不依賴傳輸層；日後包進 Durable Object |
| `packages/rules/src/visibility.ts` | 依玩家過濾狀態與事件紀錄（看得到機體、看不到駕駛） |
| `apps/api` | 內容 API（Cloudflare Worker + D1 + KV） |
| `apps/server` | 本機 WebSocket 伺服器（port 8787），替代 Cloudflare |
| `apps/client` | Vite + Canvas 的 2D 俯視除錯畫面；`src/local.ts` 是本機輪流模式 |
