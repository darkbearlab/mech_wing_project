// 檢查建議配置：node 讀 JSON（[{name, scale, roster:[{chassis,pilot,equipment}]}]），列出每隊的費用與問題
import { readFileSync } from 'node:fs';
import { lineupProblems, rosterCost, entryCost, SCALES, type Scale } from '../src/objectives';
import type { RosterEntry } from '../src/data';

const teams = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { name: string; scale: Scale; roster: RosterEntry[] }[];
let bad = 0;
for (const t of teams) {
  const p = lineupProblems(t.roster, t.scale, { decapitation: true });
  if (p.length) bad++;
  console.log(`${p.length ? 'NG' : 'OK'} ${t.name}：${rosterCost(t.roster)}/${SCALES[t.scale].budget} 分、${t.roster.length} 台（${t.roster.map(entryCost).join('+')}）${p.length ? '\n   ' + p.join('\n   ') : ''}`);
}
process.exit(bad ? 1 : 0);
