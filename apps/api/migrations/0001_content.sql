-- 編輯中的資料（草稿）：每一列是一件裝備／一台機型／一位駕駛／一個機型的配裝表／一方的預設陣容
CREATE TABLE content (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, id)
);

-- 發佈紀錄：每次發佈把草稿打包成一個不會再變的版本，存進 KV
CREATE TABLE releases (
  version TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
