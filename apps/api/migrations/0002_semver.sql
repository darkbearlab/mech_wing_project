-- 版本號改成 0.主.次：原本的 v1…v5 依序變成 0.1.0…0.1.4（KV 裡的舊資料仍用舊鍵，讀取時換算）
UPDATE releases SET version = '0.1.' || (seq - 1) WHERE version LIKE 'v%';
