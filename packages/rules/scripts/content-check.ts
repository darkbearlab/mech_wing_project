// 檢查資料包：npm run content:check [資料包.json]
// 不帶參數就檢查 packages/rules/content/ 裡的內建資料。
import { readFileSync } from 'node:fs';
import { DEFAULT_CONTENT, validateContent, type ContentPack } from '../src/content';

const file = process.argv[2];
const pack: ContentPack = file ? JSON.parse(readFileSync(file, 'utf-8')) : DEFAULT_CONTENT;
const errors = validateContent(pack);
const count = (o: object | undefined) => Object.keys(o ?? {}).length;
console.log(`資料包 ${pack.version}：武器 ${count(pack.equipment)}、機型 ${count(pack.chassis)}、駕駛 ${count(pack.pilots)}、配裝機型 ${count(pack.loadouts)}`);
if (errors.length) {
  for (const e of errors) console.log(`  ✗ ${e}`);
  process.exit(1);
}
console.log('  ✓ 沒有問題');
