// 內容 API 管理工具（金鑰讀 apps/api/.admin-token）
//   npm run admin -w @mech/api -- status
//   npm run admin -w @mech/api -- import [資料包.json]   用資料包取代草稿（不帶檔案就用內建資料）
//   npm run admin -w @mech/api -- publish [備註] [--minor|--major]   發佈草稿成新版本（預設只加修訂號，例如 0.1.4 → 0.1.5）
//   npm run admin -w @mech/api -- battles [數量]          最近上傳的對戰紀錄
//   npm run admin -w @mech/api -- battle <id>             下載一場對戰紀錄到 logs/battle-<id>.json（再用 npm run battle -- --replay 重播）
// MECH_API 可以指定 API 位址（例如本機 http://localhost:8788）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTENT } from '@mech/rules';

const API = process.env.MECH_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
// MECH_TOKEN_FILE 可以換金鑰檔（本機測試用 apps/api/.dev-admin-token）
const token = readFileSync(process.env.MECH_TOKEN_FILE ?? new URL('../.admin-token', import.meta.url), 'utf-8').trim();
const args = process.argv.slice(2);
const bump = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch';
const [cmd, arg] = args.filter((a) => !a.startsWith('--'));

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) {
    console.error(`${res.status}`, out);
    process.exit(1);
  }
  return out;
}

if (cmd === 'import') {
  const pack = arg ? JSON.parse(readFileSync(arg, 'utf-8')) : DEFAULT_CONTENT;
  console.log(await call('POST', '/draft/import', pack));
} else if (cmd === 'publish') {
  console.log(await call('POST', '/publish', { note: arg, bump }));
} else if (cmd === 'status') {
  const draft = (await call('GET', '/draft')) as { errors: string[] };
  console.log('發佈紀錄', await call('GET', '/packs'));
  console.log('草稿問題', draft.errors.length ? draft.errors : '沒有');
} else if (cmd === 'battles') {
  console.table(await call('GET', `/battles?limit=${arg ?? 30}`));
} else if (cmd === 'battle' && arg) {
  const dir = new URL('../../../logs/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`battle-${arg}.json`, dir);
  writeFileSync(file, JSON.stringify(await call('GET', `/battles/${arg}`)));
  console.log(`已存到 ${fileURLToPath(file)}`);
} else {
  console.log('用法：status | import [檔案] | publish [備註] [--minor|--major] | battles [數量] | battle <id>');
}
