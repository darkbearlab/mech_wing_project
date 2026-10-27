# 封存的鋼彈資料包

2026-10-28 起遊戲改走完全原創，預設使用 `content/*.json` 的原創內建資料。
這裡保留之前的鋼彈系資料包，仍然可以載入試玩：

- `gundam-0.4.1.json`：線上發佈過的最後一版（一年戰爭 MS、感應炮）。
- `gundam-ships-draft.json`：還沒發佈的戰艦測試版（姆塞、薩拉米斯）。

載入方式：

- 瀏覽器：開發版加上 `?content=/@fs/<repo 路徑>/packages/rules/content/archive/gundam-0.4.1.json`，
  或 `?content=0.4.1` 直接讀線上 API 上的那一版。
- 本機伺服器：`PACK=packages/rules/content/archive/gundam-0.4.1.json npm run dev`。
