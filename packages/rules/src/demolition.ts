// 破壞建築：任何直射武器都能把建築當目標打（要明確選它，流彈不會打到建築）。
// 每層樓有耐久，打光最上面一層就少一層，樓頂上的機體跟著落下；整棟打平變成瓦礫區。
import * as C from './config';
import { radiusOf, roleParts } from './body';
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import { lineOfFire } from './terrain';
import type { DamageType, EquipDef, Obstacle, UnitState, Vec } from './types';

/** 對建築的傷害倍率：化學能（爆炸）拆得快，光束只燒出洞 */
export const BUILDING_TYPE_MULT: Record<DamageType, number> = { chemical: 2, kinetic: 1, energy: 0.5 };

/** 一層樓的耐久（路障比較薄） */
export const levelHp = (o: Obstacle): number => (o.id.startsWith('bar') ? C.BARRICADE_HP : C.BUILDING_LEVEL_HP);

/** 最上面那層還剩的耐久 */
export const topHp = (o: Obstacle): number => o.hp ?? levelHp(o);

/** 從 from 打這棟建築的瞄準點：底面離 from 最近的一點，往外推一點點 */
export function buildingAim(o: Obstacle, from: Vec): Vec {
  const x = Math.max(o.x - o.hx!, Math.min(o.x + o.hx!, from.x));
  const y = Math.max(o.y - o.hy!, Math.min(o.y + o.hy!, from.y));
  const d = Math.hypot(from.x - x, from.y - y) || 1;
  return { x: x + ((from.x - x) / d) * 0.05, y: y + ((from.y - y) / d) * 0.05 };
}

interface Shooter {
  pos: Vec;
  z?: number;
  facing: number;
  chassisId: string;
  blackout?: boolean;
}

/**
 * 打建築的命中率：建築不會閃，命中只看射手（技能、距離、射界）；導引武器打不了建築。
 * 要有射擊線（其他建築或大隕石擋住就打不到）
 */
export function buildingHitChance(s: Shooter, skill: number, def: EquipDef, o: Obstacle, obstacles: Obstacle[], aim: number, shooterMelee: boolean): { band: number; chance: number } | null {
  if (def.kind !== 'ranged' || def.fire || !o.levels) return null;
  const at = buildingAim(o, s.pos);
  const d = dist(s.pos, at) - radiusOf(s);
  const band = d <= C.RANGE_LIMITS.r0 ? 0 : d <= C.RANGE_LIMITS.r1 ? 1 : d <= C.RANGE_LIMITS.r2 ? 2 : d <= C.RANGE_LIMITS.r3 ? 3 : d <= C.RANGE_LIMITS.r4 ? 4 : null;
  if (band === null || (band === 0 && def.pointBlank === false)) return null;
  const rangeMod = band === 0 ? C.ZERO_RANGE_BONUS : def.ranges?.[band as 1 | 2 | 3 | 4];
  if (rangeMod === undefined) return null;
  if (def.arc !== undefined && Math.abs(angleDiff(angleOf(sub(at, s.pos)), s.facing + (def.arcOffset ?? 0) * DEG)) > def.arc * DEG) return null;
  // 瞄準牆面：站得比建築高就打屋頂，不然打牆
  const los = lineOfFire(
    obstacles.filter((x) => x !== o),
    s.pos,
    at,
    s.z ?? 0,
    Math.min(s.z ?? 0, Math.max(0, o.levels - 1)),
  );
  if (los === 'blocked') return null;
  let chance = C.HIT_BASE + aim + skill * C.HIT_PER_SKILL + rangeMod + C.BUILDING_TARGET_BONUS;
  if (shooterMelee) chance -= C.MELEE_STANCE_SHOT_PENALTY;
  if (s.blackout) chance -= C.BLACKOUT_SHOT_PENALTY;
  if (los === 'smoke') chance -= C.SMOKE_SHOT_PENALTY;
  return { band, chance: Math.max(C.HIT_MIN, Math.min(C.HIT_MAX, chance)) };
}

/** 對建築造成 raw 點 type 屬性的傷害：打光一層就少一層，打平就換成瓦礫區。回傳打掉幾層 */
export function damageBuilding(obstacles: Obstacle[], o: Obstacle, raw: number, type: DamageType): { amount: number; lost: number; collapsed: boolean } {
  let amount = Math.round(raw * BUILDING_TYPE_MULT[type]);
  const total = amount;
  let lost = 0;
  while (amount > 0 && o.levels! > 0) {
    const hp = topHp(o);
    if (amount >= hp) {
      amount -= hp;
      o.levels!--;
      lost++;
      delete o.hp;
    } else {
      o.hp = hp - amount;
      amount = 0;
    }
  }
  const collapsed = o.levels === 0;
  if (collapsed) {
    obstacles.splice(obstacles.indexOf(o), 1);
    // 路障打掉就沒了；建築留下一片瓦礫
    if (!o.id.startsWith('bar')) obstacles.push({ id: `rubble-${o.id}`, kind: 'field', x: o.x, y: o.y, r: Math.max(o.hx!, o.hy!) });
  }
  return { amount: total, lost, collapsed };
}

/** 樓塌下來：原本站在這棟上面的機體各掉了幾層（掉多少層就傷多少腳） */
export function collapseVictims(units: UnitState[], before: Map<string, number>): { unit: UnitState; fell: number; legs?: string }[] {
  return units.flatMap((u) => {
    const fell = (before.get(u.id) ?? 0) - (u.z ?? 0);
    return fell > 0 ? [{ unit: u, fell, legs: roleParts(u, 'legs').find((p) => !p.destroyed)?.id }] : [];
  });
}
