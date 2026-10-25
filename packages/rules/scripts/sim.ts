// 批次隨機對戰，用來粗看數值分布：npm run sim -- 500
import { Rng, availableManeuvers, createGame, heldItem, resolveTurn, type ActionPlan, type GameState, type MovePlan } from '../src/index';

type Plans = Record<string, MovePlan & ActionPlan>;

const games = Number(process.argv[2] ?? 200);
const stats = { turns: 0, wins: { 0: 0, 1: 0, draw: 0 } as Record<string, number>, contacts: {} as Record<string, number>, shots: 0, hits: 0, end: {} as Record<string, number> };

function randomPlans(st: GameState, rng: Rng): [Plans, Plans] {
  const out: [Plans, Plans] = [{}, {}];
  for (const u of st.units) {
    if (u.status !== 'active') continue;
    const opts = availableManeuvers(u);
    const enemies = st.units.filter((x) => x.owner !== u.owner && x.status === 'active');
    const weapon = (['right', 'left'] as const).map((h) => heldItem(u, h)).find((e) => e && ['beam_rifle', 'machine_gun', 'sniper', 'bazooka'].includes(e.defId));
    const target = enemies[Math.floor(rng.next() * enemies.length)];
    out[u.owner][u.id] = {
      maneuver: opts[Math.floor(rng.next() * opts.length)].id,
      stance: (['normal', 'charge', 'evade'] as const)[Math.floor(rng.next() * 3)],
      facingOffset: 0,
      limiter: false,
      soften: false,
      action: weapon && target ? { type: 'shoot', weapon: weapon.id, target: target.id } : { type: 'none' },
      grapple: (['slash', 'parry', 'grab', 'push', 'disengage'] as const)[Math.floor(rng.next() * 5)],
    };
  }
  return out;
}

for (let g = 0; g < games; g++) {
  let st = createGame(g + 1);
  const rng = new Rng(g * 97 + 13);
  while (st.winner === null) {
    const plans = randomPlans(st, rng);
    const r = resolveTurn(st, plans, plans);
    for (const e of r.events) {
      if (e.type === 'contact') stats.contacts[e.result] = (stats.contacts[e.result] ?? 0) + 1;
      if (e.type === 'shot') {
        stats.shots += e.shots;
        stats.hits += e.hits;
      }
      if (e.type === 'status') stats.end[e.status] = (stats.end[e.status] ?? 0) + 1;
    }
    st = r.state;
  }
  stats.turns += st.turn;
  stats.wins[String(st.winner)]++;
}

console.log(`對戰 ${games} 場，平均 ${(stats.turns / games).toFixed(1)} 回合`);
console.log('勝負', stats.wins);
console.log('接觸結果', stats.contacts);
console.log(`射擊命中率 ${((stats.hits / Math.max(1, stats.shots)) * 100).toFixed(1)}%`);
console.log('退場原因', stats.end);
