# 封存的鋼彈資料包

2026-10-28 起遊戲改走完全原創，預設使用 `content/*.json` 的原創內建資料。
這裡保留之前的鋼彈系資料包，仍然可以載入試玩：

- `gundam-0.4.1.json`：線上發佈過的最後一版（一年戰爭 MS、感應炮）。
- `gundam-ships-draft.json`：還沒發佈的戰艦測試版（姆塞、薩拉米斯）。

載入方式：

- 瀏覽器：開發版加上 `?content=/@fs/<repo 路徑>/packages/rules/content/archive/gundam-0.4.1.json`，
  或 `?content=0.4.1` 直接讀線上 API 上的那一版。
- 本機伺服器：`PACK=packages/rules/content/archive/gundam-0.4.1.json npm run dev`。

- `cf-01.json`：CF-01 核心戰機（2026-10-28 從原創內建資料移出）。不是完整資料包，只有機型、機首機砲與配裝；
  測試用 `test/helpers.ts` 的 `withFighter()` 把它加回內建資料，驗證戰機規則（最低速度、飛行高度、沒有手）。
