// 射擊統計：電腦對打，看各武器打出多少傷害、收掉幾台，以及正面／側面／背後的射擊各打中哪些部位。
// 用法：npx tsx packages/rules/scripts/hitsim.ts [場數]
import { DEFAULT_SETTINGS, EQUIPMENT, Match, Rng, aiOrders, contactAngle, createGame, pickRosters, type AngleClass, type BattleSettings, type GameEvent, type UnitState } from '../src';

const games = Number(process.argv[2] ?? 30);
const maps: [string, BattleSettings][] = [
  ['宇宙', DEFAULT_SETTINGS],
  ['城市', { ...DEFAULT_SETTINGS, terrain: 'city', environment: 'gravity' }],
];

const byWeapon: Record<string, { shots: number; hits: number; damage: number; kills: number }> = {};
const byAngle: Record<AngleClass, { shots: number; hits: number; damage: number; parts: Record<string, number> }> = {
  front: { shots: 0, hits: 0, damage: 0, parts: {} },
  side: { shots: 0, hits: 0, damage: 0, parts: {} },
  back: { shots: 0, hits: 0, damage: 0, parts: {} },
};
let turns = 0;
let total = 0;

for (const [, settings] of maps)
  for (let g = 0; g < games; g++) {
    const seed = 4000 + g;
    const m = new Match(seed, createGame(seed, pickRosters(seed), settings));
    const rng = new Rng(seed * 17 + 3);
    for (let i = 0; i < 600 && m.phase !== 'over'; i++) {
      const before = m.resolvedCount;
      // 射擊時的位置：動作步驟裡位置不變，結算前先記下
      const pose = new Map(m.state.units.map((u) => [u.id, structuredClone(u)] as [string, UnitState]));
      for (const p of [0, 1] as const) {
        const v = m.viewFor(p);
        if (v.submitted[p] || m.phase === ('over' as string)) continue;
        const o = aiOrders(v, rng) as never;
        const ph = m.phase;
        const err = ph === 'move' || ph === 'ace' ? m.submitMoves(p, o) : ph === 'pursuit' ? m.submitPursuits(p, o) : ph === 'deploy' ? m.submitDeploy(p, o) : m.submitActions(p, o);
        if (err.length) throw new Error(err.join('；'));
      }
      if (m.resolvedCount === before) break;
      let cur: { weapon: string; angle: AngleClass } | null = null;
      const lastHit = new Map<string, string>();
      for (const e of m.turnResolvedEvents as GameEvent[]) {
        if (e.type === 'shot') {
          const a = pose.get(e.attacker);
          const t = pose.get(e.target);
          if (!a || !t) {
            cur = null;
            continue;
          }
          const angle = contactAngle(t, e.from ?? a.pos);
          cur = { weapon: EQUIPMENT[e.weapon]?.name ?? e.weapon, angle };
          const w = (byWeapon[cur.weapon] ??= { shots: 0, hits: 0, damage: 0, kills: 0 });
          w.shots += e.shots;
          w.hits += e.hits;
          byAngle[angle].shots += e.shots;
          byAngle[angle].hits += e.hits;
        } else if (e.type === 'damage' && cur && e.amount) {
          byWeapon[cur.weapon].damage += e.amount;
          byAngle[cur.angle].damage += e.amount;
          const part = m.state.units.find((u) => u.id === e.unit)?.parts[e.part];
          const key = part ? (part.kind === 'equip' ? '裝備' : (part.role ?? part.id)) : e.part;
          byAngle[cur.angle].parts[key] = (byAngle[cur.angle].parts[key] ?? 0) + e.amount;
          lastHit.set(e.unit, cur.weapon);
        } else if (e.type === 'status' && e.status === 'destroyed' && lastHit.has(e.unit)) {
          byWeapon[lastHit.get(e.unit)!].kills++;
        } else if (e.type !== 'damage' && e.type !== 'dazzle' && e.type !== 'stress' && e.type !== 'pilot' && e.type !== 'status') cur = null;
      }
    }
    turns += m.state.turn;
  }

for (const a of Object.values(byAngle)) total += a.damage;
console.log(`${games * maps.length} 場，平均 ${(turns / (games * maps.length)).toFixed(1)} 回合`);
console.log('\n== 各武器（命中率、傷害佔比、收掉幾台）==');
for (const [k, w] of Object.entries(byWeapon).sort((a, b) => b[1].damage - a[1].damage))
  console.log(`${k}：${w.hits}/${w.shots} 發（${Math.round((w.hits / Math.max(1, w.shots)) * 100)}%），傷害 ${w.damage}（${Math.round((w.damage / Math.max(1, total)) * 100)}%），收尾 ${w.kills}`);
const ROLE: Record<string, string> = { core: '軀幹', sensor: '頭', propulsion: '背包', legs: '腳', rightHand: '右手', leftHand: '左手', 裝備: '裝備' };
console.log('\n== 射擊方向（從目標看過去）==');
for (const [k, a] of Object.entries(byAngle)) {
  const parts = Object.entries(a.parts)
    .sort((x, y) => y[1] - x[1])
    .map(([p, n]) => `${ROLE[p] ?? p} ${Math.round((n / Math.max(1, a.damage)) * 100)}%`)
    .join('、');
  console.log(`${{ front: '正面', side: '側面', back: '背後' }[k]}：射擊 ${a.shots} 發、命中 ${Math.round((a.hits / Math.max(1, a.shots)) * 100)}%、傷害佔全部 ${Math.round((a.damage / Math.max(1, total)) * 100)}%｜部位：${parts}`);
}
