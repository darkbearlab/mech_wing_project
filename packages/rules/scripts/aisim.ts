// AI 對 AI 批次對戰：npm run aisim -- 200
import { Match, Rng, aiActions, aiMoves, type GameEvent, type PlayerId } from '../src/index';

const games = Number(process.argv[2] ?? 100);
const stats = { turns: 0, wins: { 0: 0, 1: 0, draw: 0 } as Record<string, number>, end: {} as Record<string, number>, contacts: {} as Record<string, number>, shots: 0, hits: 0 };
for (let g = 0; g < games; g++) {
  const m = new Match(g + 1);
  const rng = new Rng(g * 7919 + 3);
  let guard = 0;
  while (m.phase !== 'over' && guard++ < 100) {
    for (const p of [0, 1] as PlayerId[]) {
      const v = m.viewFor(p);
      if (m.phase === 'move') m.submitMoves(p, aiMoves(v, rng));
      else if (m.phase === 'action') m.submitActions(p, aiActions(v, rng));
    }
    const ev: GameEvent[] = m.turnResolvedEvents;
    for (const e of ev) {
      if (e.type === 'status') stats.end[e.status] = (stats.end[e.status] ?? 0) + 1;
      if (e.type === 'contact') stats.contacts[e.result] = (stats.contacts[e.result] ?? 0) + 1;
      if (e.type === 'shot') {
        stats.shots += e.shots;
        stats.hits += e.hits;
      }
    }
  }
  stats.turns += m.state.turn;
  stats.wins[String(m.state.winner)]++;
}
console.log(`AI 對戰 ${games} 場，平均結束於第 ${(stats.turns / games).toFixed(1)} 回合`);
console.log('勝負', stats.wins, '退場原因', stats.end);
console.log('接觸', stats.contacts, `射擊 ${stats.shots} 發、命中率 ${((stats.hits / Math.max(1, stats.shots)) * 100).toFixed(1)}%`);
