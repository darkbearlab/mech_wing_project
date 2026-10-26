// AI 對 AI 批次對戰：npm run aisim -- 200
import { readFileSync } from 'node:fs';
import { DEFAULT_ROSTERS, Match, Rng, aiActions, aiMoves, createGame, pickRosters, randomRoster, useContent, type GameEvent, type PlayerId, type RosterEntry } from '../src/index';

// npm run aisim -- 200 [default|swap|mirror|random]；PACK=資料包.json 用指定的資料包
if (process.env.PACK) useContent(JSON.parse(readFileSync(process.env.PACK, 'utf-8')));
const games = Number(process.argv[2] ?? 100);
const mode = process.argv[3] ?? 'config';
function rosters(seed: number): [RosterEntry[], RosterEntry[]] {
  if (mode === 'default') return DEFAULT_ROSTERS;
  if (mode === 'swap') return [DEFAULT_ROSTERS[1], DEFAULT_ROSTERS[0]];
  const rng = new Rng(seed * 2654435761);
  const a = randomRoster(() => rng.next());
  if (mode === 'mirror') return [a, structuredClone(a)];
  if (mode === 'random') return [a, randomRoster(() => rng.next())];
  return pickRosters(seed);
}
const byChassis: Record<string, { games: number; lost: number; side: number }> = {};
const stats = { turns: 0, wins: { 0: 0, 1: 0, draw: 0 } as Record<string, number>, end: {} as Record<string, number>, contacts: {} as Record<string, number>, shots: 0, hits: 0 };
for (let g = 0; g < games; g++) {
  const m = new Match(g + 1, createGame(g + 1, rosters(g + 1)));
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
  if (process.env.BY_CHASSIS) {
    for (const u of m.state.units) {
      const k = u.chassisId;
      byChassis[k] ??= { games: 0, lost: 0, side: 0 };
      byChassis[k].games++;
      if (u.status !== 'active') byChassis[k].lost++;
      if (m.state.winner === u.owner) byChassis[k].side++;
    }
  }
}
console.log(`[${mode}] AI 對戰 ${games} 場，平均結束於第 ${(stats.turns / games).toFixed(1)} 回合`);
console.log('勝負', stats.wins, '退場原因', stats.end);
console.log('接觸', stats.contacts, `射擊 ${stats.shots} 發、命中率 ${((stats.hits / Math.max(1, stats.shots)) * 100).toFixed(1)}%`);
if (process.env.BY_CHASSIS)
  for (const [k, v] of Object.entries(byChassis).sort((a, b) => b[1].side / b[1].games - a[1].side / a[1].games))
    console.log(`${k.padEnd(8)} 出場 ${String(v.games).padStart(4)}  所屬方勝率 ${((v.side / v.games) * 100).toFixed(0).padStart(3)}%  退場率 ${((v.lost / v.games) * 100).toFixed(0).padStart(3)}%`);
