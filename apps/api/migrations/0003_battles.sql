-- 對戰紀錄：本機模式每場結束（或中途重開）時上傳，用來重播與檢討 AI、平衡
-- data 是整場的 JSON（種子、陣容、每一步指令），重播就能還原所有經過
CREATE TABLE battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_version TEXT,
  opponent TEXT,
  winner TEXT,
  turns INTEGER,
  data TEXT NOT NULL
);
