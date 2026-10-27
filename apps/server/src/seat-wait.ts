// 等文字座位的下一個提示（給沒辦法被背景通知叫醒的 Agent 用）。
// 用法：npm run seat-wait -- <房間> <席位> <上次看到的提示編號>
//   一直等到 logs/seat/<房間>-<席位>/prompt.json 的編號比給的大（輪到你、對戰結束或伺服器回錯），
//   然後印出提示、最近的結算結果與 view.txt；超過約 9 分鐘沒有新提示就印 TIMEOUT 結束（再呼叫一次繼續等）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [room = 'claude', seat = '1', after = '0'] = process.argv.slice(2);
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), 'logs', 'seat', `${room}-${seat}`);
const last = Number(after) || 0;
const deadline = Date.now() + 9 * 60 * 1000;

const read = (f: string) => (existsSync(resolve(dir, f)) ? readFileSync(resolve(dir, f), 'utf-8') : '');

while (Date.now() < deadline) {
  try {
    const p = JSON.parse(read('prompt.json') || '{"n":0}') as { n: number; line: string };
    if (p.n > last) {
      // 讓 view.txt 寫完
      await new Promise((r) => setTimeout(r, 300));
      const events = read('events.txt').split(/\n--- /).slice(-2).join('\n--- ');
      console.log(`PROMPT n=${p.n} ${p.line}`);
      console.log(`\n=== 最近的結算 ===\n${events.slice(-4000)}`);
      console.log(`\n=== 局面（${resolve(dir, 'view.txt')}）===\n${read('view.txt')}`);
      process.exit(0);
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`TIMEOUT 還沒輪到你（上次的提示編號 ${last}），再執行一次繼續等`);
