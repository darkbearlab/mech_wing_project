// 同種子一致性檢查：固定種子跑電腦對電腦，印出每場的最終狀態與事件雜湊。
// 改動架構前後各跑一次比對；加 --split 時每一方拆成兩個小隊各自送指令，結果應該和不拆一樣。
import { createHash } from 'node:crypto';
import { DEFAULT_SETTINGS, Match, Rng, aiOrders, createGame, pickRosters, type BattleSettings, type GameEvent } from '../src';
import { splitOrders, submitOrders } from './determinism-split';

const split = process.argv.includes('--split');
const games = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 12);
const maps: [string, BattleSettings][] = [
  ['space', DEFAULT_SETTINGS],
  ['city', { ...DEFAULT_SETTINGS, terrain: 'city', environment: 'gravity' }],
  ['free-deploy', { ...DEFAULT_SETTINGS, deploy: 'free' }],
];
/** 小隊欄位是新加的，比對時拿掉 */
const strip = (k: string, v: unknown) => (k === 'squad' || k === 'squads' ? undefined : v);
const all = createHash('sha256');
for (const [name, settings] of maps)
  for (let g = 0; g < games; g++) {
    const seed = 2000 + g;
    const rosters = pickRosters(seed);
    if (split) for (const r of rosters) r.forEach((e, i) => ((e as { squad?: number }).squad = i % 2));
    const m = new Match(seed, createGame(seed, rosters, settings));
    const rng = new Rng(seed * 31 + 7);
    const events: GameEvent[] = [];
    for (let safety = 0; m.phase !== 'over' && safety < 400; safety++) {
      const before = m.resolvedCount;
      for (const p of [0, 1] as const) {
        const v = m.viewFor(p);
        if (v.submitted[p] || m.phase === ('over' as string)) continue;
        const orders = aiOrders(v, rng);
        if (split) splitOrders(m, p, orders);
        else submitOrders(m, p, orders);
      }
      if (m.resolvedCount === before) break;
      events.push(...m.turnResolvedEvents);
    }
    const h = createHash('sha256').update(JSON.stringify(m.state, strip)).update(JSON.stringify(events, strip)).digest('hex').slice(0, 16);
    all.update(h);
    console.log(`${name} seed ${seed}: winner ${m.state.winner} turn ${m.state.turn} ${h}`);
  }
console.log(`ALL ${all.digest('hex').slice(0, 16)}`);
