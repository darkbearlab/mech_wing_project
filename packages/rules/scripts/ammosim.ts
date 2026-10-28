// 彈藥夠不夠用：電腦對打，看每台機體打完時剩多少彈藥、有沒有打光，和不限彈藥時比較勝負與回合數。
// 用法：npx tsx packages/rules/scripts/ammosim.ts [場數]
import { DEFAULT_SETTINGS, EQUIPMENT, Match, Rng, aiOrders, createGame, pickRosters, type BattleSettings, type GameEvent, type UnitState } from '../src';

const games = Number(process.argv[2] ?? 20);
const maps: [string, BattleSettings][] = [
  ['宇宙', { ...DEFAULT_SETTINGS, turnLimit: 25 }],
  ['城市', { ...DEFAULT_SETTINGS, terrain: 'city', environment: 'gravity', turnLimit: 25 }],
];

/** 射擊武器剩下的彈藥比例（有彈數的才算） */
function ammoLeft(u: UnitState): number | null {
  let left = 0;
  let max = 0;
  for (const e of u.equipment) {
    const def = EQUIPMENT[e.defId];
    if (def.kind !== 'ranged' || def.ammo === undefined) continue;
    left += e.ammo ?? 0;
    max += def.ammo;
  }
  return max ? left / max : null;
}

function run(settings: BattleSettings, unlimited: boolean) {
  const saved = Object.fromEntries(Object.values(EQUIPMENT).map((d) => [d.id, d.ammo]));
  if (unlimited) for (const d of Object.values(EQUIPMENT)) if (d.kind === 'ranged') delete d.ammo;
  const out = { win: [0, 0, 0], turns: 0, dryFails: 0, shots: 0, units: 0, emptyUnits: 0, lowUnits: 0, leftSum: 0, dry: {} as Record<string, number>, carried: {} as Record<string, number> };
  try {
    for (let g = 0; g < games; g++) {
      const seed = 3000 + g;
      const m = new Match(seed, createGame(seed, pickRosters(seed), settings));
      const rng = new Rng(seed * 13 + 5);
      for (let i = 0; i < 400 && m.phase !== 'over'; i++) {
        const before = m.resolvedCount;
        for (const p of [0, 1] as const) {
          const v = m.viewFor(p);
          if (v.submitted[p] || m.phase === ('over' as string)) continue;
          const o = aiOrders(v, rng) as never;
          const ph = m.phase;
          const err = ph === 'move' || ph === 'ace' ? m.submitMoves(p, o) : ph === 'pursuit' ? m.submitPursuits(p, o) : ph === 'deploy' ? m.submitDeploy(p, o) : m.submitActions(p, o);
          if (err.length) throw new Error(err.join('；'));
        }
        if (m.resolvedCount === before) break;
        for (const e of m.turnResolvedEvents as GameEvent[]) {
          if (e.type === 'shot') out.shots++;
          if (e.type === 'actionFail' && e.reason.includes('彈藥耗盡')) out.dryFails++;
        }
      }
      const w = m.state.winner;
      out.win[w === 0 ? 0 : w === 1 ? 1 : 2]++;
      out.turns += m.state.turn;
      for (const u of m.state.units) {
        for (const e of u.equipment) {
          const def = EQUIPMENT[e.defId];
          if (def.kind !== 'ranged' || def.ammo === undefined) continue;
          out.carried[def.name] = (out.carried[def.name] ?? 0) + 1;
          if (!e.ammo) out.dry[def.name] = (out.dry[def.name] ?? 0) + 1;
        }
        const left = ammoLeft(u);
        if (left === null) continue;
        out.units++;
        out.leftSum += left;
        if (left === 0) out.emptyUnits++;
        if (left < 0.25) out.lowUnits++;
      }
    }
  } finally {
    for (const d of Object.values(EQUIPMENT)) d.ammo = saved[d.id];
  }
  return out;
}

for (const [name, settings] of maps)
  for (const unlimited of [false, true]) {
    const r = run(settings, unlimited);
    const pct = (n: number) => `${Math.round((n / Math.max(1, r.units)) * 100)}%`;
    console.log(
      `${name}${unlimited ? '（不限彈藥）' : ''}：A ${r.win[0]} / B ${r.win[1]} / 平 ${r.win[2]}，平均 ${(r.turns / games).toFixed(1)} 回合，射擊 ${r.shots}` +
        (unlimited ? '' : `，彈藥耗盡而打不了 ${r.dryFails} 次；打完時平均剩 ${Math.round((r.leftSum / Math.max(1, r.units)) * 100)}%，剩不到 25% 的機體 ${pct(r.lowUnits)}，完全打光 ${pct(r.emptyUnits)}
  打光的武器（打光／帶著）：${Object.entries(r.dry).sort((a, b) => b[1] / r.carried[b[0]] - a[1] / r.carried[a[0]]).map(([k, n]) => `${k} ${n}/${r.carried[k]}`).join('、')}`),
    );
  }
